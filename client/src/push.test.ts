import { describe, expect, it } from "vitest";
import { type PushEnv, pushState } from "./push.ts";

const iphoneApp: PushEnv = {
  hasWorker: true,
  hasPush: true,
  isIOS: true,
  standalone: true,
  permission: "default",
  subscribed: false,
};

describe("pushState", () => {
  it("asks iOS Safari to install first (no push outside the home screen app)", () => {
    expect(pushState({ ...iphoneApp, standalone: false, hasPush: false })).toBe("needsInstall");
  });

  it("walks the installed app through off, on and denied", () => {
    expect(pushState(iphoneApp)).toBe("off");
    expect(pushState({ ...iphoneApp, permission: "granted" })).toBe("off");
    expect(pushState({ ...iphoneApp, permission: "granted", subscribed: true })).toBe("on");
    expect(pushState({ ...iphoneApp, permission: "denied", subscribed: true })).toBe("denied");
  });

  it("explains a missing service worker or push support", () => {
    const desktop = { ...iphoneApp, isIOS: false, standalone: false };
    expect(pushState({ ...desktop, hasWorker: false })).toBe("noWorker");
    expect(pushState({ ...desktop, hasPush: false })).toBe("unsupported");
    expect(pushState({ ...desktop, permission: null })).toBe("unsupported");
  });
});
