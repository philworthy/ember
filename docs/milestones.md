# Milestones

One milestone per working session or so. Start each in plan mode, and commit when its
"done when" checks pass.

## Status

| Milestone | Done | Commit | Checked by |
|---|---|---|---|
| M0 Scaffold | 2026-10-17 | `ddb7393` | clean-clone install, test and dev |
| M1 Protocol spike | 2026-10-18 | `827cff1` | Phil at the grill; results in `protocol.md` |
| M2 Device client + simulator | 2026-10-18 | `034d243` | tests |
| M3 Storage, sessions, API | 2026-10-19 | `eae10b2` | tests, 60× brisket run |
| M4 Live UI | 2026-10-19 | `6b6dc3d` | Phil, simulated cook on Mac and phone |
| M5 Deploy to the NAS | 2026-10-19 | `5b494ae` | Phil, iPhone over Tailscale with the real grill |

Next: M6.

## M0 — Scaffold
Monorepo-lite: `server/`, `client/`, `shared/` (types and unit conversion), `scripts/`. TypeScript,
lint, Vitest, dev script that runs server + client with hot reload. Fill in the Commands section of
`CLAUDE.md`.
**Done when:** `npm test` and `npm run dev` work on a clean clone.

## M1 — Protocol spike (needs the real grill)
`scripts/device.ts` CLI: `info`, `data` (decoded and raw), `watch` (log to CSV every 5 s),
`start --pit <F>`, `stop`, `grill --min <n> --method a|b`, `raw-post k=v ...`. Every command that
changes device state asks for confirmation first.
Work through the checklist in `protocol.md` with Phil at the grill.
**Done when:** every UNVERIFIED item in `protocol.md` is resolved or explicitly deferred, with raw
example responses captured in the doc.

## M2 — Device client + simulator
`server/src/device/`: a typed client that sends one request at a time, a poller, and the
recovery/reconcile logic as a pure, testable state machine. It handles everything M1 found
(`protocol.md`): the malformed HTTP framing, read-back and full resend after every command,
offline after 30 s without an answer, dropping readings while the clock is unset or after a
> 50 °C jump, recovery once per reconnect after ~30 s of sane readings, remembering the `sce` it
sent, Fire it up by method B, and spotting another client controlling the device.
`server/src/sim/`: a fake iKamand that reproduces firmware 1.0.56 (the framing, resets that drop a
POST, the post-boot garbage window, the unset clock, the `sce` self-stop, the cook lost on reboot),
with scripted scenarios: brisket with a stall, pizza at 700, a probe unplugged mid-cook, meat
removed, a device reboot mid-cook, a long outage, flaky responses, another client, Fire it up.
Speed-up factor for playback (`npm run sim`).
**Done when:** unit tests cover parsing, sentinels, request serialization, read-back and resend,
recovery, offline detection and foreign-control detection against the simulator.

## M3 — Storage, sessions, API
SQLite schema (readings, sessions, items, target changes, push subscriptions, settings), with
migrations. Session/item engine: start, end, item came off, looks done, auto-end. REST commands and
an SSE live-state stream.
**Done when:** the simulator's brisket scenario run at 60× produces the right session, items, stats
and events in tests.

## M4 — Live UI (against the simulator)
Live cook, Targets, Food picker, Fire it up, Idle and the ending states, matching
`design/` closely. Installable PWA manifest, icons and service worker.
**Done when:** Phil can run a full simulated cook in a browser on his Mac and on his phone over LAN.

## M5 — Deploy to the NAS
Dockerfile and `docker-compose.yml`: the app, plus a Tailscale sidecar (`TS_AUTHKEY`,
`TS_HOSTNAME=ember`, `tailscale serve` to the app port, persistent tailscale state volume), and
`/data` volume. A short `docs/deploy.md` with the exact Synology Container Manager steps.
**Done when:** `https://ember.<tailnet>.ts.net` loads on the iPhone with a valid certificate, can be
installed to the home screen, and shows live readings from the real device.

## M6 — Alerts
Web Push with VAPID keys (generated into `/data` on first start, or from the environment);
subscribe flow in Settings; the alert rules from the brief; a test-notification button.
**Done when:** each alert type fires on the installed iPhone PWA during a simulated cook.

## M7 — History
History list, Past cook with stats, Adjust start & end, notes, Cook this again.
**Done when:** a real cook shows up correctly and trimming it recalculates the stats.

## M8 — Better estimates
History-based estimates as described in the brief, with a small offline evaluation script that
replays past cooks and reports estimate error over time.
**Done when:** on replayed cooks, the median error in the last 3 hours beats v1.
