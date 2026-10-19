// Cook harness: the device-link harness plus an in-memory DB and the cook engine, all on one
// ManualClock. `restart()` throws away the link and engine and builds new ones on the same DB and
// simulator, as a server restart would (the cook keeps running on the device meanwhile).

import type { CookEvent, CookEventType } from "@ember/shared";
import { Catalog, SEED_CATALOG } from "../cook/catalog.ts";
import { CookEngine, linkRestoreFrom } from "../cook/engine.ts";
import { type Db, openDb } from "../db/open.ts";
import { Store } from "../db/store.ts";
import { DeviceClient } from "../device/client.ts";
import { DeviceLink } from "../device/device.ts";
import { SimTransport } from "../sim/wire.ts";
import { type Harness, harness, SEC } from "./harness.ts";

export interface CookHarness extends Harness {
  db: Db;
  store: Store;
  engine: CookEngine;
  /** Every engine event, across restarts. */
  cookEvents: CookEvent[];
  ofCook(type: CookEventType): CookEvent[];
  /** A fresh link + engine on the same DB and simulator (the server restarted). */
  restart(): void;
}

const catalog = Catalog.fromFile(SEED_CATALOG);

export function cookHarness(opts: Parameters<typeof harness>[0] & { db?: Db } = {}): CookHarness {
  const db = opts.db ?? openDb(":memory:");
  const store = new Store(db);
  const base = harness({ ...opts, restore: opts.restore ?? linkRestoreFrom(store) });
  const cookEvents: CookEvent[] = [];
  const makeEngine = (link: DeviceLink) => {
    const engine = new CookEngine({ store, link, clock: base.clock, catalog });
    engine.on("event", (e) => cookEvents.push(e));
    return engine;
  };

  const h: CookHarness = Object.assign(base, {
    db,
    store,
    engine: makeEngine(base.link),
    cookEvents,
    ofCook: (type: CookEventType) => cookEvents.filter((e) => e.type === type),
    restart() {
      h.engine.close();
      const client = new DeviceClient(new SimTransport(h.sim));
      const link = new DeviceLink(client, { clock: h.clock, restore: linkRestoreFrom(store) });
      h.link = link;
      h.engine = makeEngine(link);
      // Keep the device-event log going for the new link.
      for (const type of ["link", "recovery", "adopted", "reading", "sent"] as const) {
        link.on(type, (e: object) => h.events.push({ type, at: h.clock.now(), ...e } as never));
      }
    },
  });
  // run/runUntil/boot close over `link` from the base harness; rebind them to the current link.
  h.run = async (ms) => {
    const end = h.clock.now() + ms;
    while (h.clock.now() < end) {
      h.clock.advance(5 * SEC);
      await h.link.tick();
    }
  };
  h.runUntil = async (pred, maxMs) => {
    const end = h.clock.now() + maxMs;
    while (!pred()) {
      if (h.clock.now() >= end) throw new Error(`condition not met within ${maxMs / 1000} s`);
      h.clock.advance(5 * SEC);
      await h.link.tick();
    }
  };
  h.boot = async () => {
    await h.link.tick();
    await h.runUntil(() => h.link.snapshot.link === "online", 2 * 60 * SEC);
  };
  return h;
}
