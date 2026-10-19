# Ember

Self-hosted controller for a Kamado Joe **iKamand** (v1, firmware 1.0.56). It replaces the shut-down
cloud app. A small server on the Synology NAS talks to the iKamand over the LAN, records every
reading, runs cooks, sends alerts, and serves a PWA that Phil uses on his iPhone over Tailscale.

## Read before working

- `docs/brief.md` — what to build (product spec, data model, behaviours)
- `docs/protocol.md` — how to talk to the iKamand, its quirks, and what is still unverified
- `docs/milestones.md` — build order; work on one milestone at a time
- `design/README.md` — screens, design tokens, how to read the design files
- `reference/` — two working Python implementations of the protocol (read-only, MIT licensed)

## Stack (decided — ask before changing)

- Server: Node 22+ (better-sqlite3 13 needs it), TypeScript, Fastify, SQLite via better-sqlite3, `web-push` for notifications
- Client: Vite + React + TypeScript, installable PWA, served by the same server; charts in SVG
- Live updates: server-sent events (SSE) from server to client; REST for commands
- Tests: Vitest; a device simulator stands in for the iKamand everywhere except `scripts/`
- Deploy: Docker Compose on the NAS — `ember` app container + Tailscale sidecar
  (`TS_HOSTNAME=ember`, `tailscale serve` provides HTTPS at `https://ember.<tailnet>.ts.net`)

## Rules

- The server is the only thing that talks to the device. The client never calls the iKamand.
- The device speaks °C. Store raw device values; convert in one module; the UI shows °F.
- Tests and dev mode use the simulator. Only scripts in `scripts/` may touch the real device, and
  only when `IKAMAND_HOST` is set. Anything that starts a cook on the real grill must ask for
  confirmation on the command line first.
- Safety: an app error must never leave the fan running unattended. See `docs/protocol.md` › Safety.
- When behaviour of the real device differs from `docs/protocol.md`, update that doc in the same change.
- Secrets live in `.env` (git-ignored). Keep `.env.example` current.
- Start each milestone in plan mode; commit when its "done when" checks pass.
- Keep this file short. Specs belong in `docs/`.

## Environment

- iKamand: `IKAMAND_HOST` in `.env`. It is LAN-only, so Claude Code must run on Phil's Mac on the
  home network to reach it. It is often powered off; use the simulator unless a task needs the grill.
- NAS: Synology, Docker via Container Manager.

## Commands

- `npm install` — install all workspaces (`shared/`, `server/`, `client/`)
- `npm run dev` — server (`tsx watch`, port `EMBER_PORT`, default 8080) + Vite on 5173, which
  proxies `/api` and `/healthz` to the server. With `USE_SIMULATOR=true` the server runs the
  simulator in-process (`SIM_SCENARIO`, `SIM_SPEED`) and uses `DATA_DIR/ember-sim.db`; otherwise it
  talks to `IKAMAND_HOST` and uses `DATA_DIR/ember.db`
- `npm test` / `npm run test:watch` — Vitest across `shared/`, `server/`, `scripts/`
- `npm run lint` (Biome; `npm run format` to fix) and `npm run typecheck`
- `npm run build` — builds `client/dist`, which the server serves in production
- `npm run device -- <cmd>` — real-device CLI (`scripts/device.ts`); needs `IKAMAND_HOST`.
  `npm run device -- --help` lists commands; `docs/m1-runbook.md` is the test order
- `npm run sim -- --scenario brisket --speed 60 [--start]` — standalone simulator on port 8081
  (`--help` lists scenarios); point the CLI at it with `IKAMAND_HOST=127.0.0.1:8081`
- Deploy: milestone 5.
