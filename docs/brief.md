# Ember — product brief

## Goal

A lean, modern replacement for the defunct iKamand app. Phil controls and monitors his Kamado Joe
from his iPhone, gets alerts when food is done or the pit drifts, and builds up a history of cooks
that gradually improves time estimates. No cloud, no Home Assistant, no accounts.

**Principles:** fast to glance at mid-cook; reliable over clever; the server owns state; the
phone is just a view.

## Architecture

```
iPhone PWA ──HTTPS (Tailscale)──▶ ember server (Docker on NAS) ──HTTP (LAN)──▶ iKamand
                                    │  poll every 5 s, log readings, run cooks,
                                    │  detect events, send web push
                                    └─ SQLite (/data)
```

- **Server:** the only thing that talks to the device. It polls `data` every 5 s, all the time,
  whether or not a cook is running. It stores every reading, keeps the session and item state,
  applies device recovery (see `protocol.md`), evaluates alert rules, and sends web push. It serves
  the PWA, a REST API for commands, and an SSE stream of live state.
- **Client:** a React PWA. It renders state from SSE and sends commands over REST. It holds no
  important state of its own.
- **Access:** only through Tailscale. A Tailscale sidecar container gives the app the hostname
  `ember` and HTTPS through `tailscale serve`. Being on the tailnet is the authentication, so there
  is no in-app login.
- **Push:** standard Web Push (VAPID). On iOS this needs the PWA installed to the home screen and
  served over HTTPS. Pushes reach the phone through Apple even when Tailscale is off.

## Data model

- **Reading:** timestamp, pit °C, t1–t3 °C (null when unplugged), fan %, cook active flag, target
  pit, plus the raw unknown fields as JSON. One row every 5 s while the device is reachable; nothing
  while it's off. This is the permanent record. Sessions and items are labelled time windows over it.
- **Session (a cook):** start, end (nullable while open), pit target history (a list of changes),
  Fire it up usage, title (generated from item names, editable), notes, ended_by
  (`user` / `auto` / `timeout`). `auto` is the looks-done auto-end; `timeout` is reserved and unused,
  because losing the connection never ends a session. Origin: `user` (Start), `fireUp` (Fire it
  up with "then hold"), `adopted` (found running), `foreign` (another client started it).
- **Item (one food on one probe):** session id, probe slot (1–3), food path (e.g.
  `["Beef","Brisket","Point"]`) or custom name, weight in lb (optional), target, start, end,
  end reason (`removed` / `unplugged` / `session_end` / `user`), and derived stats saved at the end:
  time to target, stall start/end/temps, average pit while it cooked. Also the temperature it came
  off at.
- **Units:** every temperature in the DB and the API is °C. Pit targets are the device's integers;
  probe targets are exact conversions of the °F the user picked (203 °F → 95.0 °C), since only the
  server uses them. The client converts with `shared/src/units.ts`.
- Implemented in `server/src/db/` (schema in `migrations.ts`). The server also keeps target changes,
  Fire it up runs, settings (including the device link's intent, so a restart resumes the cook),
  push subscriptions and an event log.
- **Food catalog:** a tree of category › cut › sub-cut with a default "pull at" temperature. Seed
  it from `docs/food-catalog.json` and keep it editable (a JSON file in `/data` is fine).
  Custom names are stored on the item and also remembered for the Recent list.

## Screens

Mapped to the design artboards in `design/canvas/` (see `design/README.md`).

1. **Live cook** (`Main`): pit temp, tappable target, status (Holding / Heating / Cooling), fan %.
   Graph of pit and three probes, with a dashed target line for each. Range 1h / 3h / 6h / All, and
   each series can be toggled. Probe cards show name, probe number, temp, "of <target>", progress
   bar, and an estimate ("est. 2h 10m"). Fire it up and End cook buttons. History and Settings in the
   header.
2. **Ending states** (`MainItemOff`, `MainDone`): a probe card collapses to "Came off at 204° after
   6h 20m" with **Reuse probe**. The "Looks like you're done" prompt has Keep going / End cook.
3. **Targets** (`SetTarget`): tabs Pit / P1 / P2 / P3. Big value with −/+ and a slider. Pit range is
   150–700 °F in steps of 5, with presets (Low & slow 225, Smoke 250, Hot & fast 300, Roast 350,
   Sear 500, Pizza 700) and a warning above 500. Probe range is 100–220 °F in steps of 1. Each probe
   tab shows the current food with a link to the food picker. The button reads
   "Set <name> to <n>°".
4. **Food picker** (`FoodPicker`): search across all cuts, Recent (last picks with their weights),
   a drill-down through the catalog tree, and Custom… The final step shows "Pull at" (the default
   target) and a weight stepper in 0.5 lb steps (optional), then "Use for probe N". Picking a food
   sets that probe's target to the default.
5. **Fire it up** (`FireUp`): 10 / 20 / 30 min ("For 200–400°" / "400–600°" / "600°+ searing"), plus
   a "Then hold pit at <target>" toggle. The running state shows a countdown ring, pit temp with its
   rate of rise, fan %, and Stop.
6. **Idle / start cook** (`Idle`): current pit and probe readings (or "Not plugged in"), pit target
   and probe targets, Fire it up, Start cook. An offline banner shows when the device can't be
   reached ("Last seen 2 min ago", Retry).
7. **History** (`History`): sessions newest first, each with title, date, small graph, duration, pit
   target and foods.
8. **Past cook** (`HistoryDetail`): full graph with the stall shaded, Adjust start & end (two
   sliders over the full recording, dimming outside the session), per-item stats cards, notes, and
   Cook this again (fills in the same targets and foods).
9. **Settings** (not designed; keep it plain, same style): device status, IP, firmware, last seen;
   alert toggles and thresholds; test notification; install-to-home-screen help.

Screen rules the designs leave open (decided in M4):

- Home is **Live cook** while a session is open, otherwise **Idle**. Fire it up without a session
  shows a "Fire it up · 6:12 left" strip on Idle that opens its running screen.
- The header pill reads Offline, Connecting…, Fire it up · m:ss, Cooking · 6h 40m,
  Stopped · 6h 40m (session open, fan off) or Ready.
- When the session is open but the cook isn't running (Stop, the device's `sce`, another client),
  Live cook offers **Fire it up** and **Resume at <target>** (Start), with **End cook** below.
  End cook asks for confirmation first.
- Pit status: Holding steady, Heating up, Cooling down (above target), Fan off (Cooling once
  Looks done is up). Idle's pit card says "Not lit" under 150 °F.
- Probe cards: an active item shows "est. 2h 10m", "Stalled" or "Done", and progress from the
  probe's temperature when the item started. A plugged-in probe with no item is a "Probe N" card
  that opens Targets; an empty slot is a slim "Not plugged in" row. A finished item shows the
  "Came off at …" card with Reuse probe, which opens the food picker and returns to Live cook.
- Notices on Live cook: grill offline (Retry reconnects the live stream; the server keeps polling
  every 5 s), Ember halted, found a cook running, and another app changed the cook (both
  dismissible).
- Targets: the pit button saves the target (for the next Start when idle); the probe button sets
  that probe's target. "Take it off this probe" (in a session) or "Clear" (before Start) removes
  the food. The food picker's weight starts at the last weight used for that food, else empty;
  + starts at 1.0 lb and −/+ repeat while held. A custom food pulls at 200° (fine-tuned on Targets).
- History stays plain until M7: a list of past cooks. Settings (M6) has the grill's status,
  alerts on this device (Turn on alerts, Send a test, Turn off), the alert toggles and thresholds,
  and install help.

## Behaviour

### Starting

- **Start cook** opens a session, sends start-cook with the pit target, and opens items for any
  probe that has a food assigned.
- **Fire it up** runs for the chosen time (see `protocol.md` for the method). With "then hold" on,
  it opens a session when Fire it up starts (so the heat-up is part of the cook) and switches to
  holding the pit target when the timer ends. With it off, the device stops when the timer ends,
  and no session is opened unless one already exists.
- If readings show a live cook with no open session (e.g. after a server restart), Ember adopts it:
  it tracks the cook at the device's target and shows that it found one running (`protocol.md` ›
  Quirks 3).

### Probes and items

- The device's own food-probe feature isn't used (`p=0`, `tft=0`). The server tracks all three
  targets.
- **Item starts** when a food is assigned to a probe during a session, or when the session starts.
  A probe with readings but no food assigned is still logged and graphed as "Probe N".
- **Item ends** when the probe is unplugged (null readings for 30 s or more), or when it's removed
  from the meat (a drop of at least 15 °F within 2 min after it has passed 140 °F). Notify
  "<Name> came off at <temp>° after <duration>". **Reuse probe** assigns a new food to the slot
  within the same session.

### Ending

- **End cook** (user) sends stop-cook and closes the session and any open items.
- **Stop** turns the fan off (and ends Fire it up) but leaves the session open; Looks done takes it
  from there.
- **Looks done:** when no items are active and either the cook is no longer active or the pit has
  been falling for 15 minutes below the target's holding band (a dying fire, not a pit settling
  back after Fire it up overshoots), show the in-app prompt and send a push. If there's no
  response, auto-end 60 minutes later (`ended_by: auto`, and stop the cook if it's still running).
  Keep going suppresses it until the conditions clear and are met again. "No longer active" means
  Ember no longer intends the cook to run (stopped by the user, by the device's own `sce`, or by
  another client), not the raw `acs`, so the moment between Start and its read-back doesn't count.
  Once the prompt is up it stays until new activity (a food on a probe, Start, a new pit target,
  Fire it up, or another client starting the cook): a dying fire that levels off is still done.
- A no-probe cook (pizza) uses the same rule on pit temperature alone.
- Losing the connection never ends a session.
- All thresholds above live in one config module (`server/src/config.ts`).

### API

REST under `/api`, JSON, °C. Commands answer `202 {id, sessionId}` at once; the device's read-back
arrives on SSE as a `commandResult` event, so nothing waits on an offline device.

- `GET /api/state`: the live state (link, latest reading, cook, Fire it up countdown, session with
  its looks-done and auto-end times, three probes with item or setup and estimate).
- `GET /api/live`: SSE. `state` on connect and after every change, `event` for each domain event.
- `POST /api/cook/start {pitC}`, `/api/cook/target {pitC}` (saved for the next Start when nothing
  is running), `/api/cook/stop`, `/api/cook/end`, `/api/fire-up {minutes, thenHoldC}`,
  `/api/session/keep-going`.
- `PUT /api/probes/:slot {food: {path} | {custom} | null, weightLb?, targetC?}`: during a session,
  edits the active item or starts a new one (Reuse probe); otherwise sets it up for the next Start.
  `POST /api/probes/:slot/target {targetC}`, `DELETE /api/probes/:slot`.
- `GET /api/catalog`, `/api/sessions`, `/api/sessions/:id`, `/api/readings?from&to`.
- `GET /api/foods/recent`: the last 6 distinct foods put on probes, newest first, with the latest
  weight given for each (the food picker's Recent list).
- `LiveState.now` is the server's clock and `clockRate` how fast it runs (1, or `SIM_SPEED` with
  the sped-up simulator). The client advances `now` between frames at that rate for elapsed times,
  countdowns and estimates, so a 60× simulation reads right.

### Alerts (web push)

| Event | Default |
|---|---|
| Probe reached target | on |
| Item came off | on |
| Pit off target by ±25 °F for 10 min (only after the pit has first reached target) | on |
| Device offline for 2 min during a session | on |
| Fire it up finished | on |
| Looks done / auto-ended | on |

Each alert has a short title, one line of body, and a tap target that opens the right screen.

Decided in M6 (`server/src/push/`):

- **Rules.** "Reached target" and "came off" fire with the item events. The pit alert arms once
  the pit is inside the holding band of the current target, so it stays quiet while the pit
  heats up to a new target, during Fire it up, and while Looks done is up. It fires once per
  excursion, and re-arms when the pit is back in the holding band. "Offline" is measured from the
  last good reading, needs an open session and the link to have given up (30 s without an
  answer), and fires once per outage. "Fire it up finished" is only for the timer running out (a
  Stop isn't news). Looks done and auto-ended share one toggle and one notification tag, so
  "Cook ended" replaces the prompt.
- **Settings** holds a toggle for each alert, plus the pit's ± band (10–100 °F) and minutes, and
  the offline minutes (1–60). They're stored on the server for every device (`settings.alerts`),
  with the band in °C like everything else.
- **Payload:** `{type, title, body, url, tag}`, a few hundred bytes. Times are relative ("in
  1h 00m"), so the sped-up simulator reads right. Taps open Live cook (`/#/`), except
  auto-ended, which opens History. The tag is per item, session or Fire it up run, so a repeat
  replaces the older notification instead of stacking.
- **Keys:** the VAPID keys are generated on the server's first start into
  `DATA_DIR/vapid.json` (or come from `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`). They must never
  change: phones subscribe against the public key.
- **iOS:** push exists only in the installed app, and permission is asked from the "Turn on
  alerts" tap. The service worker shows a notification for every push (iOS drops the
  subscriptions of apps that push silently). The app re-sends its subscription to the server
  every time it opens, so a fresh database (or the simulator's) gets it without a tap.

### Estimates

- **v1:** a rate-of-rise projection from the last 20–30 min, labelled "est.". Hide it when the rate
  is flat or negative (the stall), and show "Stalled" instead.
- **v2 (milestone 8):** match the item against past items with the same food path. Fall back one
  level (e.g. any Brisket) when there are fewer than 3 matches. Weight by similarity of weight and
  average pit. Use the progress of past curves to project the remaining time. Show a range when
  there are few matches. Store the stall start and duration for every item so the stall can be
  predicted.

### History editing

- Trimming a session's start or end only moves the window. Readings are never deleted. Item stats
  are recalculated after a trim.

## Non-goals

HomeKit or Home Assistant integration; multiple users or logins; cloud; Wi-Fi provisioning of the
iKamand; supporting other controllers. Celsius display is out for now, but keep conversion in one
place so it could be added.

## Open questions (resolved in milestone 1, details in `protocol.md`)

- Fire it up uses method B. Method A does nothing on firmware 1.0.56.
- The device accepts `tpt` up to 371 °C (700 °F). Whether it can hold the pit there is deferred to
  the first pizza cook.
- The device's own `p`/`tft` probe target does nothing visible, so Ember keeps all probe targets
  on the server.
