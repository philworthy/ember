import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { startLive } from "./live.ts";
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
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("service worker registration failed", err);
    });
  });
}
