// A tiny hash router: the back gesture works, and push notifications (M6) can open a screen.

import type { ProbeSlot } from "@ember/shared";
import { useSyncExternalStore } from "react";

export type TargetTab = "pit" | ProbeSlot;

export type Route =
  | { name: "home" }
  | { name: "targets"; tab: TargetTab }
  | { name: "food"; slot: ProbeSlot }
  | { name: "fireUp" }
  | { name: "history" }
  | { name: "cook"; id: number }
  | { name: "settings" };

const slotOf = (s: string | undefined): ProbeSlot | null =>
  s === "1" || s === "2" || s === "3" ? (Number(s) as ProbeSlot) : null;

export function parseRoute(hash: string): Route {
  const [name, arg] = hash.replace(/^#?\/?/, "").split("/");
  switch (name) {
    case "targets": {
      const slot = slotOf(arg);
      return { name: "targets", tab: slot ?? "pit" };
    }
    case "food": {
      const slot = slotOf(arg);
      return slot ? { name: "food", slot } : { name: "home" };
    }
    case "fire-up":
      return { name: "fireUp" };
    case "history": {
      const id = Number(arg);
      return arg && Number.isInteger(id) && id > 0 ? { name: "cook", id } : { name: "history" };
    }
    case "settings":
      return { name: "settings" };
    default:
      return { name: "home" };
  }
}

export function href(route: Route): string {
  switch (route.name) {
    case "home":
      return "#/";
    case "targets":
      return `#/targets/${route.tab}`;
    case "food":
      return `#/food/${route.slot}`;
    case "fireUp":
      return "#/fire-up";
    case "cook":
      return `#/history/${route.id}`;
    default:
      return `#/${route.name}`;
  }
}

/** How many screens deep we are in this tab, so Close can go back instead of forward. */
let depth = 0;

export function navigate(route: Route, opts: { replace?: boolean } = {}): void {
  const url = href(route);
  if (opts.replace) {
    history.replaceState(null, "", url);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    depth++;
    location.hash = url;
  }
}

/** Close a screen: back if we came from inside the app, else home. */
export function goBack(): void {
  if (depth > 0) {
    depth--;
    history.back();
  } else {
    navigate({ name: "home" }, { replace: true });
  }
}

/** Go home and forget the screens in between (after a command finishes a flow). */
export function goHome(): void {
  if (depth > 0) {
    const n = depth;
    depth = 0;
    history.go(-n);
  } else {
    navigate({ name: "home" }, { replace: true });
  }
}

const subscribe = (fn: () => void) => {
  window.addEventListener("hashchange", fn);
  return () => window.removeEventListener("hashchange", fn);
};

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => location.hash);
  return parseRoute(hash);
}
