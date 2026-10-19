import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadVapid } from "./vapid.ts";

const subject = "https://example.com";

describe("loadVapid", () => {
  it("generates keys once and keeps them", () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), "ember-vapid-")), "data");
    const first = loadVapid({ env: null, subject }, dir);
    expect(first.source).toBe("generated");
    expect(first.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    const file = path.join(dir, "vapid.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const again = loadVapid({ env: null, subject }, dir);
    expect(again).toMatchObject({ source: "file", publicKey: first.publicKey });
    expect(JSON.parse(readFileSync(file, "utf8")).privateKey).toBe(first.privateKey);
  });

  it("uses keys from the environment when set", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ember-vapid-"));
    const env = { publicKey: "pub", privateKey: "priv" };
    expect(loadVapid({ env, subject }, dir)).toEqual({ ...env, subject, source: "env" });
  });
});
