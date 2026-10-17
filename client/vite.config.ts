import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const serverPort = Number(process.env.EMBER_PORT ?? 8080);

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": `http://localhost:${serverPort}`,
      "/healthz": `http://localhost:${serverPort}`,
    },
  },
});
