// Turns cook events and the live state into push notifications (docs/brief.md › Alerts). It only
// listens: nothing here sends a device command, and every handler is guarded, so an alert or push
// failure can never reach the device link or the cook engine (protocol.md › Safety).

import {
  type AlertPrefs,
  type CookEvent,
  cDeltaToF,
  cToDisplayF,
  duration,
  type PushPayload,
  pitTargetF,
} from "@ember/shared";
import { ALERTS } from "../config.ts";
import type { CookEngine } from "../cook/engine.ts";
import type { Store } from "../db/store.ts";
import { OfflineWatch, PitDrift } from "./rules.ts";
import type { PushSender } from "./sender.ts";

export const ALERT_PREFS_KEY = "alerts";

const HOME = "/#/";
const HISTORY = "/#/history";

export function alertPrefs(store: Store): AlertPrefs {
  const saved = store.getSetting<Partial<AlertPrefs>>(ALERT_PREFS_KEY) ?? {};
  const d = ALERTS.defaults;
  return {
    ...d,
    ...saved,
    pitOffTarget: { ...d.pitOffTarget, ...saved.pitOffTarget },
    deviceOffline: { ...d.deviceOffline, ...saved.deviceOffline },
  };
}

export interface AlertServiceOptions {
  engine: CookEngine;
  store: Store;
  sender: PushSender;
  log?: (msg: string, data?: unknown) => void;
}

export class AlertService {
  private readonly engine: CookEngine;
  private readonly store: Store;
  private readonly sender: PushSender;
  private readonly log: (msg: string, data?: unknown) => void;
  private readonly pitDrift = new PitDrift();
  private readonly offline = new OfflineWatch();
  private readonly onEvent = (e: CookEvent) => this.guard("event", () => this.event(e));

  constructor(opts: AlertServiceOptions) {
    this.engine = opts.engine;
    this.store = opts.store;
    this.sender = opts.sender;
    this.log = opts.log ?? (() => {});
    this.engine.on("event", this.onEvent);
  }

  close(): void {
    this.engine.off("event", this.onEvent);
  }

  /** Check the time-based rules (pit drift, offline) against the live state. Call it often. */
  tick(): void {
    this.guard("tick", () => {
      const live = this.engine.live();
      const prefs = alertPrefs(this.store);
      const online = live.link.state === "online";
      const holding = live.cook.active && live.fireUp === null;
      const drift = this.pitDrift.update(
        {
          now: live.now,
          pitC: online ? (live.reading?.pitC ?? null) : null,
          holdC: holding ? live.cook.pitTargetC : null,
          quiet: live.session === null || live.session.looksDoneAt !== null,
        },
        prefs.pitOffTarget,
      );
      if (drift && prefs.pitOffTarget.on) {
        const offF = Math.round(cDeltaToF(Math.abs(drift.pitC - drift.targetC)));
        const dir = drift.pitC < drift.targetC ? "below" : "above";
        this.push({
          type: "pitOffTarget",
          title: `Pit is ${offF}° ${dir} target`,
          body: `It's ${cToDisplayF(drift.pitC)}°, target ${pitTargetF(drift.targetC)}°, for ${duration(live.now - drift.sinceMs)}.`,
          url: HOME,
          tag: `pit-${live.session?.id ?? 0}`,
        });
      }
      const gone = this.offline.update(
        {
          now: live.now,
          sessionOpen: live.session !== null,
          offline: live.link.state === "offline",
          online,
          lastSeenMs: live.link.lastSeenMs,
        },
        prefs.deviceOffline,
      );
      if (gone && prefs.deviceOffline.on) {
        this.push({
          type: "deviceOffline",
          title: "Grill offline",
          body: `No readings for ${duration(live.now - gone.lastSeenMs)}. Check its power and Wi-Fi.`,
          url: HOME,
          tag: `offline-${live.session?.id ?? 0}`,
        });
      }
    });
  }

  private event(e: CookEvent): void {
    const prefs = alertPrefs(this.store);
    const d = e.data;
    switch (e.type) {
      case "itemAtTarget": {
        if (!prefs.itemAtTarget) return;
        const item = this.store.item(Number(d.itemId));
        const after = item ? ` after ${duration(e.ts - item.startedAt)}` : "";
        this.push({
          type: "itemAtTarget",
          title: `${d.name} is at ${cToDisplayF(Number(d.tempC))}°`,
          body: `Probe ${d.slot} reached its ${cToDisplayF(Number(d.targetC))}° target${after}.`,
          url: HOME,
          tag: `item-${d.itemId}-target`,
        });
        return;
      }
      case "itemCameOff": {
        if (!prefs.itemCameOff) return;
        const at = typeof d.tempC === "number" ? ` at ${cToDisplayF(d.tempC)}°` : "";
        this.push({
          type: "itemCameOff",
          title: `${d.name} came off`,
          body: `Came off${at} after ${duration(Number(d.durationMs))}.`,
          url: HOME,
          tag: `item-${d.itemId}-off`,
        });
        return;
      }
      case "fireUpFinished": {
        if (!prefs.fireUpFinished) return;
        const hold = d.next === "hold";
        const live = this.engine.live();
        this.push({
          type: "fireUpFinished",
          title: "Fire it up done",
          body: hold
            ? `Holding the pit at ${pitTargetF(live.cook.pitTargetC)}°.`
            : `The fan is off. The pit is at ${live.reading?.pitC == null ? "—" : cToDisplayF(live.reading.pitC)}°.`,
          url: HOME,
          tag: `fireup-${d.fireUpId}`,
        });
        return;
      }
      case "looksDone": {
        if (!prefs.looksDone) return;
        this.push({
          type: "looksDone",
          title: "Looks like you're done",
          body: `Ember ends the cook in ${duration(Number(d.autoEndAt) - e.ts)} unless you keep going.`,
          url: HOME,
          tag: `done-${e.sessionId}`,
        });
        return;
      }
      case "sessionEnded": {
        if (!prefs.looksDone || d.endedBy !== "auto" || e.sessionId === null) return;
        const s = this.store.session(e.sessionId);
        const name = s?.title || "The cook";
        const after = s ? ` after ${duration(e.ts - s.startedAt)}` : "";
        this.push({
          type: "looksDone",
          title: "Cook ended",
          body: `${name} ended automatically${after}.`,
          url: `${HISTORY}/${e.sessionId}`,
          tag: `done-${e.sessionId}`,
        });
        return;
      }
      default:
        return;
    }
  }

  private push(p: PushPayload): void {
    this.log(`alert: ${p.title}`);
    this.sender.sendAll(p).catch((err) => this.log("alert: push failed", err));
  }

  private guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.log(`alert: ${what} failed`, err);
    }
  }
}
