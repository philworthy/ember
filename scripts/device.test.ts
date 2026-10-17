// End-to-end: run the CLI against the stub, never the real device.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type Stub, type StubOptions, startStub } from "./test/stub.ts";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "device.ts");

let stub: Stub | undefined;
afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

async function run(
  args: string[],
  stdin: string,
  opts: {
    stub?: StubOptions;
    host?: string;
    setup?: (s: Stub) => void;
    /** Send SIGINT (what Ctrl-C delivers) once stdout contains this. */
    interruptOn?: string;
  } = {},
) {
  stub = await startStub(opts.stub);
  opts.setup?.(stub);
  const host = opts.host;
  const child = spawn(process.execPath, ["--import", "tsx", SCRIPT, "--no-log", ...args], {
    env: {
      ...process.env,
      IKAMAND_HOST: host ?? stub.host,
      EMBER_SKIP_DOTENV: "1",
      EMBER_SETTLE_MS: "50",
    },
  });
  let out = "";
  let interrupted = false;
  child.stdout.on("data", (c) => {
    out += c;
    if (opts.interruptOn && !interrupted && out.includes(opts.interruptOn)) {
      interrupted = true;
      child.kill("SIGINT");
    }
  });
  child.stderr.on("data", (c) => {
    out += c;
  });
  child.stdin.end(stdin);
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { code, out, stub };
}

const nowS = () => Math.floor(Date.now() / 1000);

describe("device CLI", () => {
  it("data decodes sentinels as no probe", async () => {
    const { code, out } = await run(["data"], "");
    expect(code).toBe(0);
    expect(out).toMatch(/probe 1\s+—\s+\(raw 400: no probe\)/);
    expect(out).toMatch(/probe 2\s+—\s+\(raw -400: no probe\)/);
    expect(out).toContain("raw: time=");
  });

  it("start sends the full payload after yes", async () => {
    const { code, out, stub } = await run(["start", "--pit", "250"], "yes\n");
    expect(code, out).toBe(0);
    const [post] = stub.posts();
    expect(post?.headers["content-type"]).toBe("application/json");
    const f = post?.fields ?? {};
    expect(Object.keys(f)).toEqual(["acs", "csid", "tpt", "sce", "p", "tft", "as", "ct"]);
    expect(f).toMatchObject({ acs: "1", csid: "", tpt: "121", p: "0", tft: "0", as: "0" });
    expect(Math.abs(Number(f.ct) - nowS())).toBeLessThan(10);
    expect(Number(f.sce) - Number(f.ct)).toBe(86400);
    expect(out).toContain("acs: 0 → 1");
  });

  it.each([
    ["no", "no\n"],
    ["empty stdin", ""],
  ])("start sends nothing on %s", async (_label, stdin) => {
    const { code, out, stub } = await run(["start", "--pit", "250"], stdin);
    expect(code).toBe(1);
    expect(out).toContain("Not sent.");
    expect(stub.posts()).toHaveLength(0);
  });

  it("start rejects an out-of-range pit before contacting the device", async () => {
    const { code, stub } = await run(["start", "--pit", "800"], "yes\n");
    expect(code).toBe(1);
    expect(stub.requests).toHaveLength(0);
  });

  it("start can set a device food-probe target for testing", async () => {
    const { code, out, stub } = await run(
      ["start", "--pit", "225", "--probe", "1", "--probe-target", "90"],
      "yes\n",
    );
    expect(code, out).toBe(0);
    expect(stub.posts()[0]?.fields).toMatchObject({ p: "1", tft: "32" });
    expect(out).toContain("Device food-probe target p=1 tft=32: UNVERIFIED");
  });

  it("start warns above 260 °C", async () => {
    const { out } = await run(["start", "--pit", "700"], "no\n");
    expect(out).toContain("tpt=371 is above 260 °C: UNVERIFIED");
  });

  it("refuses to run without IKAMAND_HOST", async () => {
    const { code, out, stub } = await run(["data"], "", { host: "" });
    expect(code).toBe(1);
    expect(out).toContain("IKAMAND_HOST is not set");
    expect(stub.requests).toHaveLength(0);
  });

  it("grill method B starts a 260 °C cook and stops it at the end of the timer", async () => {
    const { code, out, stub } = await run(
      ["grill", "--min", "0.05", "--method", "b", "--interval", "1"],
      "yes\n",
    );
    expect(code, out).toBe(0);
    const [start, stop, ...rest] = stub.posts();
    expect(start?.fields).toMatchObject({ acs: "1", tpt: "260" });
    expect(Number(start?.fields.sce) - Number(start?.fields.ct)).toBe(3);
    expect(stop?.fields).toMatchObject({ acs: "0", tpt: "0", sce: "0" });
    expect(rest).toHaveLength(0);
    expect(out).toContain("Stopped:");
  }, 20_000);

  it("grill method A falls back to a full stop cook when ag=0 doesn't stop the fan", async () => {
    const { code, out, stub } = await run(
      ["grill", "--min", "0.05", "--method", "a", "--interval", "1"],
      "yes\n",
      { stub: { ignoreGrillStop: true } },
    );
    expect(code, out).toBe(0);
    const posts = stub.posts().map((p) => p.fields);
    expect(posts[0]).toMatchObject({ ag: "1" });
    expect(posts[1]).toEqual({ ag: "0", sge: "0", ct: expect.any(String) });
    expect(posts[2]).toMatchObject({ acs: "0", tpt: "0" });
    expect(out).toContain("sending full stop cook");
  }, 20_000);

  it("Ctrl-C during grill sends stop before exiting", async () => {
    const { code, out, stub } = await run(
      ["grill", "--min", "5", "--method", "b", "--interval", "1"],
      "yes\n",
      { interruptOn: "T-" },
    );
    expect(code, out).toBe(130);
    const posts = stub.posts().map((p) => p.fields);
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({ acs: "0", tpt: "0", sce: "0" });
    expect(out).toContain("Sending stop (Ctrl-C)");
    expect(out).toContain("Stopped:");
  }, 20_000);

  it("grill refuses while a cook is active", async () => {
    const { code, out, stub } = await run(["grill", "--min", "1", "--method", "b"], "yes\n", {
      setup: (s) => {
        s.state.acs = "1";
      },
    });
    expect(code).toBe(1);
    expect(out).toContain("already active");
    expect(stub.posts()).toHaveLength(0);
  });

  it("raw-post adds ct and honours --form-header", async () => {
    const { code, stub } = await run(["raw-post", "p=1", "tft=40", "--form-header"], "yes\n");
    expect(code).toBe(0);
    const [post] = stub.posts();
    expect(post?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.keys(post?.fields ?? {})).toEqual(["p", "tft", "ct"]);
  });
});
