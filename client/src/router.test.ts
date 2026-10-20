import { describe, expect, it } from "vitest";
import { href, parseRoute } from "./router.ts";

describe("routes", () => {
  it("open a past cook by id, and fall back to the list", () => {
    expect(parseRoute("#/history/12")).toEqual({ name: "cook", id: 12 });
    expect(href({ name: "cook", id: 12 })).toBe("#/history/12");
    expect(parseRoute("#/history")).toEqual({ name: "history" });
    expect(parseRoute("#/history/abc")).toEqual({ name: "history" });
    expect(parseRoute("#/history/0")).toEqual({ name: "history" });
  });
});
