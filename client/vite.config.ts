import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const serverPort = Number(process.env.EMBER_PORT ?? 8080);

export default defineConfig({
  plugins: [react()],
  server: {
    // Listen on the LAN too, so a phone on the home network can open http://<mac>:5173.
    host: true,
    proxy: {
      "/api": `http://localhost:${serverPort}`,
      "/healthz": `http://localhost:${serverPort}`,
    },
  },
});
