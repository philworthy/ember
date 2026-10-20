import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { startLive } from "./live.ts";
import { syncPush, syncPushOnResume } from "./push.ts";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

startLive();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The service worker only in production builds: in dev it would fight Vite's hot reload.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then(() => syncPush())
      .then((error) => error && console.warn("push sync failed:", error))
      .catch((err) => {
        console.warn("service worker registration or push sync failed", err);
      });
    syncPushOnResume();
  });
}

// A tapped alert in an open app: the service worker asks to show the alert's screen.
navigator.serviceWorker?.addEventListener("message", (e: MessageEvent) => {
  const data = e.data as { type?: string; url?: string } | null;
  if (data?.type === "open" && typeof data.url === "string") {
    location.hash = new URL(data.url, location.origin).hash || "#/";
  }
});
