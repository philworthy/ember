// The driver: polls the device, feeds the state machine, carries out its effects, and turns its
// events into a typed emitter for the rest of the server (M3 stores readings and sessions).

import { EventEmitter } from "node:events";
import type { DeviceClient } from "./client.ts";
import { type Clock, systemClock } from "./clock.ts";
import {
  type Command,
  type DeviceEvent,
  type Effect,
  initialState,
  type MachineState,
  type Restore,
  type SendReason,
  step,
  TIMING,
} from "./machine.ts";
import { type Payload, stopCook } from "./protocol.ts";

type EventMap = { [E in DeviceEvent as E["type"]]: [Omit<E, "type">] };

export type DeviceEvents = EventMap & {
  /** A POST went out (ok) or failed on the wire. Read-back decides whether it was applied. */
  sent: [{ payload: Payload; reason: SendReason; ok: boolean; error?: string }];
  /** The state machine threw. */
  fault: [{ error: Error; consecutive: number }];
  /** Too many faults in a row: a best-effort stop was sent and polling stopped. */
  halted: [{ error: Error }];
};

export type CommandResult = { ok: true } | { ok: false; reason: "no-readback" | "superseded" };

export interface DeviceLinkOptions {
  clock?: Clock;
  /** What the server remembers (M3 loads it from the DB). */
  restore?: Restore;
  /** Halt after this many consecutive faulted ticks (~1 min at 5 s). */
  maxFaults?: number;
  /** Test seam: replace the state machine's step (e.g. with one that throws). */
  step?: typeof step;
}

export class DeviceLink extends EventEmitter<DeviceEvents> {
  private state: MachineState;
  private readonly clock: Clock;
  private readonly maxFaults: number;
  private readonly step: typeof step;
  private faults = 0;
  private nextId = 1;
  private readonly waiters = new Map<string, (r: CommandResult) => void>();
  private running = false;
  private halted = false;
  private loop: Promise<void> | null = null;
  private lastTickMs: number;
  /** Counts POSTs handed to the client, to tell when a poll's data predates a command. */
  private sendsQueued = 0;

  constructor(
    private readonly client: DeviceClient,
    opts: DeviceLinkOptions = {},
  ) {
    super();
    this.clock = opts.clock ?? systemClock;
    this.maxFaults = opts.maxFaults ?? 12;
    this.step = opts.step ?? step;
    this.state = initialState(this.clock.now(), opts.restore);
    this.lastTickMs = this.clock.now();
  }

  /** Read-only view of the machine state (intent, link, sceSentS...). */
  get snapshot(): Readonly<MachineState> {
    return this.state;
  }

  /** One poll cycle: GET data, step the machine, carry out its effects. */
  async tick(): Promise<void> {
    if (this.halted) return;
    let input: Parameters<typeof step>[1];
    const sendsBefore = this.sendsQueued;
    try {
      const data = await this.client.getData();
      input = { type: "poll", ok: true, data, stale: this.sendsQueued !== sendsBefore };
    } catch {
      input = { type: "poll", ok: false };
    }
    await this.apply(input);
    this.lastTickMs = this.clock.now();
  }

  /** Send a command. Resolves once the device reads back as commanded, or it gives up. */
  command(command: Command): Promise<CommandResult> {
    const id = String(this.nextId++);
    const result = new Promise<CommandResult>((resolve) => this.waiters.set(id, resolve));
    void this.apply({ type: "command", id, command });
    return result;
  }

  /**
   * Poll every 5 s until `stop()`. `onWedged` runs if no tick completes for `watchdogMs` (real
   * time); by default it exits the process so Docker restarts it and startup reconciles.
   */
  start(opts: { watchdogMs?: number; onWedged?: () => void } = {}): void {
    if (this.running) return;
    this.running = true;
    const watchdogMs = opts.watchdogMs ?? 120_000;
    const onWedged =
      opts.onWedged ??
      (() => {
        console.error("device link wedged: no poll completed in 2 min, exiting");
        process.exit(1);
      });
    let lastSeen = this.lastTickMs;
    let lastProgress = Date.now();
    const watchdog = setInterval(() => {
      if (this.lastTickMs !== lastSeen) {
        lastSeen = this.lastTickMs;
        lastProgress = Date.now();
      } else if (Date.now() - lastProgress > watchdogMs) {
        clearInterval(watchdog);
        onWedged();
      }
    }, 5_000);
    watchdog.unref();

    this.loop = (async () => {
      while (this.running && !this.halted) {
        const started = this.clock.now();
        await this.tick();
        const elapsed = this.clock.now() - started;
        await this.clock.sleep(Math.max(0, TIMING.pollMs - elapsed));
      }
      clearInterval(watchdog);
    })();
  }

  /** Stop polling. Deliberately leaves any cook running: a redeploy mustn't end a brisket. */
  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async apply(input: Parameters<typeof step>[1]): Promise<void> {
    let effects: Effect[];
    try {
      const next = this.step(this.state, input, this.clock.now());
      this.state = next.state;
      effects = next.effects;
      this.faults = 0;
    } catch (err) {
      await this.onFault(err as Error);
      return;
    }
    for (const effect of effects) {
      if (effect.type === "send") await this.send(effect.payload, effect.reason);
      else this.dispatch(effect.event);
    }
  }

  private async send(payload: Payload, reason: SendReason): Promise<void> {
    this.sendsQueued++;
    try {
      await this.client.postCook(payload);
      this.emit("sent", { payload, reason, ok: true });
    } catch (err) {
      this.emit("sent", { payload, reason, ok: false, error: (err as Error).message });
    }
  }

  private dispatch(event: DeviceEvent): void {
    const { type, ...rest } = event;
    if (event.type === "commandApplied" || event.type === "commandFailed") {
      for (const id of event.ids) {
        this.waiters.get(id)?.(
          event.type === "commandApplied" ? { ok: true } : { ok: false, reason: event.reason },
        );
        this.waiters.delete(id);
      }
    }
    (this.emit as (t: string, e: unknown) => boolean)(type, rest);
  }

  /** An app error must never leave the fan running unattended (CLAUDE.md › Rules). */
  private async onFault(error: Error): Promise<void> {
    this.faults++;
    this.emit("fault", { error, consecutive: this.faults });
    if (this.faults < this.maxFaults) return;
    this.halted = true;
    this.running = false;
    try {
      await this.client.postCook(stopCook(Math.floor(this.clock.now() / 1000)));
    } catch {
      // Best effort; the device's sce (≤ 24 h, or the Fire it up end) is the backstop.
    }
    this.emit("halted", { error });
  }
}
