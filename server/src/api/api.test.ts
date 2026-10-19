// The REST API and SSE stream over the cook engine and simulator.

import { fToC, fToDeviceC, type LiveState } from "@ember/shared";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.ts";
import { Catalog, SEED_CATALOG } from "../cook/catalog.ts";
import { type CookHarness, cookHarness } from "../test/cook.ts";
import { SEC } from "../test/harness.ts";

const catalog = Catalog.fromFile(SEED_CATALOG);
let close: (() => Promise<unknown>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

async function setup(scenario = "brisket") {
  const h: CookHarness = cookHarness({ scenario });
  await h.boot();
  const app = await buildApp({
    engine: h.engine,
    store: h.store,
    catalog,
    clock: h.clock,
    serveClient: false,
  });
  close = () => app.close();
  return { h, app };
}

describe("REST commands", () => {
  it("runs a cook: set up a probe, start, retarget, end", async () => {
    const { h, app } = await setup();
    const put = await app.inject({
      method: "PUT",
      url: "/api/probes/1",
      payload: { food: { path: ["Beef", "Brisket", "Flat"] }, weightLb: 6.5 },
    });
    expect(put.statusCode).toBe(202);

    const start = await app.inject({
      method: "POST",
      url: "/api/cook/start",
      payload: { pitC: fToDeviceC(225) },
    });
    expect(start.statusCode).toBe(202);
    expect(start.json()).toMatchObject({ id: "c1", sessionId: 1 });
    await h.run(20 * SEC);

    const state = (await app.inject("/api/state")).json() as LiveState;
    expect(state.session).toMatchObject({ id: 1, title: "Brisket", origin: "user" });
    expect(state.probes[0]?.item).toMatchObject({ weightLb: 6.5, targetC: 95 });
    expect(state.cook).toMatchObject({ active: true, pitTargetC: fToDeviceC(225) });
    expect(state.link.state).toBe("online");

    const target = await app.inject({
      method: "POST",
      url: "/api/probes/1/target",
      payload: { targetC: fToC(200) },
    });
    expect(target.statusCode).toBe(202);

    expect((await app.inject({ method: "POST", url: "/api/cook/end" })).statusCode).toBe(202);
    const detail = (await app.inject("/api/sessions/1")).json();
    expect(detail.session.endedBy).toBe("user");
    expect(detail.items[0].endReason).toBe("session_end");
    expect(detail.targets.map((t: { subject: string }) => t.subject)).toEqual(["pit", "p1", "p1"]);
    expect(detail.events.map((e: { type: string }) => e.type)).toContain("sessionEnded");
    expect((await app.inject("/api/sessions")).json()).toHaveLength(1);
    expect((await app.inject("/api/sessions/99")).statusCode).toBe(404);
  });

  it("validates bodies and ranges", async () => {
    const { app } = await setup();
    const post = (url: string, payload: unknown) =>
      app.inject({ method: "POST", url, payload: payload as object });
    expect((await post("/api/cook/start", {})).statusCode).toBe(400);
    expect((await post("/api/cook/start", { pitC: 20 })).json()).toEqual({
      error: expect.stringMatching(/pitC must be/),
    });
    expect((await post("/api/fire-up", { minutes: 90, thenHoldC: null })).statusCode).toBe(400);
    expect((await post("/api/session/keep-going", {})).statusCode).toBe(409);
    expect((await app.inject({ method: "DELETE", url: "/api/probes/2" })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: "PUT", url: "/api/probes/4", payload: { food: null } }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/probes/1",
          payload: { food: { path: ["Beef", "Unicorn"] } },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("serves the catalog in °C and readings by window", async () => {
    const { h, app } = await setup();
    await h.run(60 * SEC);
    const tree = (await app.inject("/api/catalog")).json();
    const beef = tree.find((n: { name: string }) => n.name === "Beef");
    expect(beef.children[0]).toMatchObject({ name: "Brisket" });
    expect(beef.children[0].children[0].pullAtC).toBeCloseTo(95);
    const readings = (await app.inject("/api/readings")).json();
    expect(readings.length).toBeGreaterThan(5);
    expect(readings[0]).toHaveProperty("pitC");
    expect((await app.inject("/api/readings?from=0&to=999999999999")).statusCode).toBe(400);
  });
});

describe("SSE", () => {
  it("sends the state on connect, then events and state as things change", async () => {
    const { h, app } = await setup();
    const url = await app.listen({ port: 0, host: "127.0.0.1" });
    const ctrl = new AbortController();
    const res = await fetch(`${url}/api/live`, { signal: ctrl.signal });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = "";
    const until = async (pred: () => boolean) => {
      while (!pred()) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    };
    await until(() => text.includes("\n\n"));
    const first = text.slice(0, text.indexOf("\n\n"));
    expect(first.startsWith("event: state\ndata: ")).toBe(true);
    expect(JSON.parse(first.split("data: ")[1] as string).link.state).toBe("online");

    h.engine.start(fToDeviceC(225));
    await h.run(10 * SEC);
    await until(() => text.includes('"type":"sessionStarted"') && text.includes('"commandResult"'));
    expect(text).toContain("event: event\ndata: ");
    ctrl.abort();
    await reader.cancel().catch(() => {});
  });
});
