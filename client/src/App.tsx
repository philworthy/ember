import type { CookEvent } from "@ember/shared";
import { useEffect } from "react";
import { store, useLive, useServerNow } from "./live.ts";
import { useRoute } from "./router.ts";
import { FireUp } from "./screens/FireUp.tsx";
import { FoodPicker } from "./screens/FoodPicker.tsx";
import { History } from "./screens/History.tsx";
import { Idle } from "./screens/Idle.tsx";
import { LiveCook } from "./screens/LiveCook.tsx";
import { PastCook } from "./screens/PastCook.tsx";
import { Settings } from "./screens/Settings.tsx";
import { Targets } from "./screens/Targets.tsx";
import { SheetHeader } from "./ui/parts.tsx";
import { Toasts, toast } from "./ui/toast.tsx";

const COMMAND_NAME: Record<string, string> = {
  start: "the cook start",
  stop: "the stop",
  fireUp: "Fire it up",
};

/** The grill didn't confirm a command after Ember's retries (a superseded one is expected). */
function onEvent(e: CookEvent): void {
  if (e.type !== "commandResult" || e.data.ok !== false) return;
  if (e.data.reason === "superseded") return;
  const what = COMMAND_NAME[String(e.data.command)] ?? "the command";
  toast(`The grill didn't confirm ${what}. Check it has power and Wi-Fi.`);
}

export function App() {
  const snap = useLive();
  const now = useServerNow();
  const route = useRoute();

  useEffect(() => store.onEvent(onEvent), []);
  // Each screen opens at the top.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on route change
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route.name, route.name === "cook" && route.id]);

  return (
    <>
      {screen()}
      <Toasts />
    </>
  );

  // Called, not rendered as a component: a component defined here would remount on every frame.
  function screen() {
    if (route.name === "history") return <History />;
    if (route.name === "cook") return <PastCook id={route.id} snap={snap} />;
    if (route.name === "settings") return <Settings snap={snap} now={now} />;
    if (!snap.live) {
      return (
        <main className="screen">
          <SheetHeader title="Ember" />
          <p className="muted" style={{ textAlign: "center", marginTop: 80 }}>
            {snap.conn === "down" ? "Can't reach Ember. Retrying…" : "Connecting…"}
          </p>
        </main>
      );
    }
    switch (route.name) {
      case "targets":
        return <Targets snap={snap} tab={route.tab} />;
      case "food":
        return <FoodPicker snap={snap} slot={route.slot} />;
      case "fireUp":
        return <FireUp snap={snap} now={now} />;
      default:
        return snap.live.session ? (
          <LiveCook snap={snap} now={now} />
        ) : (
          <Idle snap={snap} now={now} />
        );
    }
  }
}
