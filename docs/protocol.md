# iKamand local protocol

Everything here started from two community implementations (copies in `reference/`). Milestone 1
verified it against Phil's unit (firmware 1.0.56) on 2026-10-18. Items marked **VERIFIED** were
seen on that unit. Anything left untested is marked **Deferred**, with the reason. Raw captures
from that session live in `captures/` (git-ignored) on Phil's Mac.

## Basics

- Plain HTTP on port 80, no auth, LAN only. Base URL: `http://<IKAMAND_HOST>/cgi-bin/`
- **The HTTP framing is malformed** (VERIFIED 2026-10-18). Every response is two status lines, no
  headers, a bare `\n` before the body, no `Content-Length`, a trailing space after the body, and
  then the device closes the connection:
  ```
  HTTP/1.0 200 OK\r\n
  HTTP/1.1 200 OK\r\n
  \n
  time=197&rm=0&acs=0&...&tpt=0␠
  ```
  Strict parsers reject this: Node's `fetch` fails with "Invalid header token" and curl with
  "Header without colon". Python `requests` (used by both references) tolerates it. Ember uses a
  raw TCP client that reads until close, takes the status from the first line, and treats
  everything after the first blank line as the body (`server/src/device/transport.ts`).
- Responses are **URL-encoded query strings**, not JSON (e.g. `acs=1&tpt=121&pt=118&t1=64&...`).
  Parse with a query-string parser; every value arrives as a string. Trim the body first, because
  of the trailing space.
- Requests: both references send `POST` with header `Content-Type: application/json` but a
  **form-encoded body** (Python `requests` with `data=dict`). The device accepts both that and the
  correct `application/x-www-form-urlencoded` header (VERIFIED 2026-10-18). Ember sends the
  references' shape.
- Use a 5–10 s timeout. The device is slow and sometimes drops requests.
- All temperatures are **°C integers**.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `info` | Device info: `fw_version`, `MAC`, `env` |
| GET | `data` | Current state (poll every 5 s) |
| POST | `cook` | Every command: start/stop cook, set targets, grill mode |
| GET | `wifi_list` | Visible Wi-Fi networks (not needed) |
| POST | `netset` | Set Wi-Fi `ssid`, `user`, `pass` (not needed; never call it) |

## `data` fields

| Field | Meaning | Notes |
|---|---|---|
| `time` | Device clock, Unix seconds | Until the clock is set it is **seconds since boot** (VERIFIED: 197, then 259 a minute later). Treat any value before 2020 (< 1 600 000 000) as "no clock" and drop the reading. The device sets its own clock 45 s to 5+ min after boot, or at once when a command's `ct` arrives |
| `acs` | Cook active, `1`/`0` | |
| `tpt` | Target pit temp °C | |
| `pt` | Pit temp °C | `400` = no probe (VERIFIED); treat `-400` the same |
| `t1` `t2` `t3` | Food probe temps °C | `400` = not plugged in (VERIFIED); treat `-400` the same |
| `dc` | Fan duty cycle % | The commanded duty, still reported with the fan unplugged |
| `sce` | Scheduled cook end, Unix seconds | The cook stops itself within 1 s of this time (VERIFIED). **Never reported**, idle or cooking (VERIFIED), so Ember must remember the `sce` it sent |
| `csid` | Cook session id | Both references send `""` |
| `p` | Which food probe the device is watching (0–3) | Never reported (VERIFIED) |
| `tft` | Target food temp °C for probe `p` | Never reported (VERIFIED) |
| `ag` | Grill mode active | Always `0` on 1.0.56, even after `ag=1` (VERIFIED) |
| `rm` | Probably "running" | Equal to `acs` in all 3 320 readings so far; use `acs` |
| `cm`, `as` | Unknown | Always `0` so far; log them in the raw JSON |

## Commands (POST `cook`)

Always include `ct` = current Unix time in seconds; the device uses it to set its clock (VERIFIED).

**Send one request at a time** (2026-10-18). With HA off, 5 of the 7 `ECONNRESET`s came while
two of our clients (the CLI and `watch`) hit the device together, and 2 came with `watch` alone.
So overlapping requests make resets much more likely, but they aren't the only cause. Ember's
device client must queue requests (never a poll and a command at the same time) and still expect
the odd reset (quirk 5).

**Start or update a cook.** Sending this again with a new `tpt` is how the pit target changes
(VERIFIED: only `tpt` changes; the cook and fan carry on).
```
acs=1  csid=""  tpt=<°C>  sce=<now + 86400>  p=0  tft=0  as=0  ct=<now>
```

**Stop a cook**
```
acs=0  csid=""  tpt=0  sce=0  p=0  tft=0  as=0  ct=<now>
```

**Fire it up: use method B** (VERIFIED 2026-10-18, 1.0.56).
- A. Native grill mode (from the original library): `ag=1  sge=<now + minutes*60>  ct=<now>`.
  **Does nothing on 1.0.56.** Accepted (`HTTP 200`), but `ag` stayed 0 and `dc` 0 for the whole
  2 min plus 60 s grace. Not used. Since A is dropped, the always-send-the-full-command rule
  (quirk 4) holds for every command Ember sends.
- B. Emulated (from the Home Assistant version): start a cook with `tpt=260` (500°F) and
  `sce=<now + minutes*60>`. `dc` went to 100% at once on a cold grill. **The device ends the cook
  itself at `sce`:** 1 s after `sce` it read `acs=0 rm=0 dc=0`, while `tpt` stayed 260. A self-stop
  leaves `tpt` set; our stop zeroes it. Ember still runs its own timer and sends a full stop at the
  end, so either one stops the fan (see Safety). With "then hold", Ember sets `sce` 2 min past its
  timer, so it can switch to the hold target before the device stops itself.

**Device food-probe target:** `p=<1-3>  tft=<°C>` on top of an active cook. The firmware only holds
one. **Reaching it does nothing visible** (VERIFIED 2026-10-18): with `p=1 tft=29`, P1 was warmed by
hand to 31–33 °C for 25 s, and `acs`, `rm`, `dc`, `tpt` and `cm` didn't change. `p` and `tft` never
appear in `data`. The old app probably did the alerting itself. Ember always sends `p=0 tft=0` and
tracks all probe targets on the server.

## Quirks the server must handle

1. **Invalid readings:** `400`/`-400` mean "no reading" (1.0.56 sends `400` for unplugged pit
   and food probes). Store null, never the sentinel.
2. **Clock not set:** any `time` before 2020 means the device just rebooted. Drop the reading and
   treat the device as reconnecting. (The references' `time < 40` rule only catches the first
   40 s: the clock was seen unset at 304 s.) The clock is set by the device itself (45 s to 5+ min
   after boot) or at once by any command's `ct`. Dropping these readings matters because for the
   first ~30 s after boot the temperatures are garbage: pit and P1 read the same climbing value on
   a cold grill (`time=19 … pt=84&t1=84`, `time=24 … pt=108`, `time=29 … pt=132`, then
   `time=35 … pt=23`). A command's `ct` can set the clock inside that window, so also ignore any
   reading that jumps more than 50 °C from the previous one within 10 s.
3. **Cook recovery after a reboot or clock drift.** Adapted from the HA logic
   (`connection_recovery` in `reference/ha-ikamand/ikamand.py`), but run only once per reconnect,
   not once per poll. A rebooted device shows a huge clock skew on every poll until its clock is
   set. Trigger it at server start, when the device comes back after being offline, on any
   reading with an unset clock, or when its clock is more than 60 s from the server's. Wait for
   ~30 s of sane readings first (quirk 2; while the clock is unset, a reading counts from 35 s of
   uptime), because the controller acts on the garbage too. Then reconcile once
   (`server/src/device/machine.ts`):
   - Ember has a cook → resend start at its target, **however long the device was gone** (Phil,
     2026-10-18; HA's rule stopped the cook after 10 min offline). Losing the connection never
     ends a session, and a kamado holds its fire through a long outage.
   - Fire it up still running → resend it with `sce` at its original end. Already over → stop,
     or start at the hold target with "then hold".
   - No cook, and the device is cooking → **adopt it**: track it at the device's `tpt` and resend
     start so it has a known `sce`. Unless Ember itself stopped it last; then stop.
   - Otherwise → stop (harmless when idle; its `ct` sets the clock).

   This matters because **a cook does not survive a reboot** (VERIFIED: a 107 °C cook was active,
   Phil power-cycled the controller, and it came back with `acs=0 rm=0 tpt=0`). The server's
   state is the source of truth, not the device.
4. **Partial command payloads:** the HA code sometimes sends only some fields. Ember always sends the
   full command so the device state is predictable.
5. **Flaky HTTP:** one failed poll is not "offline".
   - Over 5½ h idle (3 022 polls at 5 s, Home Assistant also polling), 1.1% failed: 29
     `ECONNRESET`, 5 timeouts at 8 s. With HA off, resets still happened, mostly when two of our
     clients overlapped (see Commands).
   - Failures came in streaks of up to **3** while the device was otherwise fine, so 3 consecutive
     failures is too eager. Mark the device offline after **30 s with no successful response**
     (about 5 failed polls). A device that answers with an unset clock is reachable: Ember shows
     it as "recovering", not offline. Retry on the next poll; don't retry immediately.
   - A POST that gets `ECONNRESET` is **not applied** (VERIFIED: a retarget to 121 was reset and
     `tpt` stayed 107). After every command, read `data` back and resend the full command if the
     state doesn't match. Ember checks `acs` and `tpt` on the next poll and sends at most 3 times.
   - Once, with HA also polling, the web server went away for ~2½ min while the controller stayed on
     (timeouts, then `ECONNREFUSED`, while it still answered ping). It came back by itself with the
     cook intact.

## Safety

- Ember must never be the reason the fan keeps running unattended. If the server crashes, the device
  still stops at `sce`, so never set `sce` more than 24 h ahead, and re-extend it during long cooks
  (every hour, Ember pushes `sce` to now + 24 h). Stopping or redeploying the server leaves a cook
  running on purpose; `sce` is the backstop. If the device logic keeps failing (12 polls in a
  row), the server sends a best-effort stop and stops polling.
- Fire it up must have a server-side timer and a device-side `sce`. Either one stops it.
- On server start, read the device state and reconcile it with the DB before sending anything.
- **Ember must be the only client.** The device has no arbitration, so any client's command wins.
  On 2026-10-18 the Home Assistant iKamand integration was still running. Ember's stop was applied
  (`acs=0 rm=0 tpt=0` at the stop's `ct`), and within 5 s the cook was back (`acs=1 rm=1 tpt=107`)
  with nothing sent by Ember. That's HA's `connection_recovery`: after any failed poll of its own,
  it re-sends the last cook it saw if that cook was active under 10 min ago, and otherwise it sends
  stop. So another client can both restart a cook Ember stopped and stop a cook Ember started.
  **Disabling that integration is not enough:** `async_setup_entry` starts the poll loop with a
  bare `hass.loop.create_task` and unload never cancels it (`reference/ha-ikamand/__init__.py`),
  so it kept restarting the cook (15 s after the next stop) until HA was restarted. Disable it and
  then restart Home Assistant. Ember also treats any `acs` or `tpt`
  change it didn't command as "another client is controlling the device": it logs it, surfaces it
  in the UI, and **follows the device rather than fighting it** (fighting is how Ember and HA
  ping-ponged). The exception is the device's own `sce` stop: `acs` 1 → 0 with `tpt` unchanged at
  or just after the `sce` Ember set.

## Temperature limits

- The HA code limits the pit target to 66–260 °C (150–500 °F). Ember's UI allows up to 700 °F
  (371 °C) for pizza. The device **accepts** `tpt` above 260 (VERIFIED 2026-10-18: 371 read back
  as 371). So Ember sends the real target and doesn't need the "can't hold above 500°" fallback,
  unless the first hot cook shows the controller can't actually hold it (deferred until then).

## Simulator

`server/src/sim/` reproduces everything above for tests and dev mode (`npm run sim -- --help`).
When the real device turns out to differ, fix the simulator in the same change as this doc.

## Milestone 1 test checklist

Fill in results as they're found, with date and firmware. Steps are in `docs/m1-runbook.md`.

- [x] `info` and `data` respond (2026-10-18, 1.0.56). Both need the lenient client (see Basics).
  Raw bodies, idle, cold grill:
  ```
  info: fw_version=1.0.56&env=v1-8CF710CB9FDA&MAC=8CF710CB9FDA
  data: time=1792348237&rm=0&acs=0&csid=&cm=0&ag=0&as=0&pt=22&t1=22&t2=21&t3=22&dc=0&tpt=0
  ```
  `data` has no `sce`, `p` or `tft` while idle, and its field order differs from the references.
- [x] JSON content-type with form body is accepted for `cook` (2026-10-18, 1.0.56). So is the
  correct `application/x-www-form-urlencoded` header (used for a stop). The reply is `HTTP 200`
  with an empty body. Ember keeps the references' JSON header.
- [x] Start cook, change target, stop cook all behave as described (2026-10-18, 1.0.56, HA off):
  - Start: `acs` 0 → 1, `rm` 0 → 1, `tpt` 0 → 107; `dc` 80% then 100% on a cold grill within
    5 s. `rm` has always matched `acs`. During a cook, `data` **still has no `sce`, `p` or `tft`**,
    so Ember can't read back the device-side stop time it set:
    `time=1792368884&rm=1&acs=1&csid=&cm=0&ag=0&as=0&pt=23&t1=23&t2=400&t3=400&dc=100&tpt=107`
  - Retarget (resend start with a new `tpt`): only `tpt` changed (107 → 121); `acs`, `rm` and
    `dc` were undisturbed.
  - Stop: `rm` 1 → 0, `acs` 1 → 0, `dc` 100 → 0, `tpt` → 0, and it stayed stopped with HA off.
  - `dc` reports the commanded duty even with the fan unplugged, so command tests can be read from
    `dc` without the fan connected. With the fan plugged in, a 1-minute method-B Fire it up showed
    `dc=100` from 00:50:20Z to 00:51:15Z, then 0 after the stop. Phil confirmed the fan ran hard
    for about a minute and then stopped, so `dc` matches the physical fan.
  - **`ct` sets the clock.** A start sent at 18 s of uptime (`time=18`, clock unset) with
    `ct=1792370093` was followed 5 s later by `time=1792370099`. Without `ct` the device has taken
    45 s to 5+ min. So any command sets the clock. A cook started in the post-boot garbage window
    uses the garbage too: `dc` stayed 0 while `pt` read a bogus 102 °C against a target of 107.
    Ember's recovery should wait for sane readings (about 30 s after the device comes back)
    before resending a cook.
- [x] Unplugged probe value (2026-10-18, 1.0.56): **`400`** for food probes (`t2=400&t3=400`)
  and the pit probe (`pt=400`). `-400` was never seen; Ember still treats both as "no reading".
  The pit read `400` for ~45 s after Phil unclipped it for about 15 s. That may just be a
  re-detect delay, so don't end items on an unplug faster than the brief's 30 s rule. Plugged-in
  probes at room temperature read 20–23 °C and flicker by ±1 °C between polls.
  ```
  time=1792368700&rm=0&acs=0&csid=&cm=0&ag=0&as=0&pt=400&t1=23&t2=400&t3=400&dc=0&tpt=0
  ```
- [x] What `time` looks like right after a power cycle (2026-10-18, 1.0.56, two power-ons):
  seconds since boot, then a real Unix time set by the device itself, with no `ct` from us. First
  power-on: still unset at 259 s, set by 339 s. Second: HTTP answered at 29 s uptime, clock set
  between 43 and 48 s. The first power-on answered ping before HTTP (`EHOSTUNREACH` at first).
  The second one's first reading was bogus (`pt=126&t1=126` on a cold grill), then 23 °C five
  seconds later:
  ```
  time=29&rm=0&acs=0&csid=&cm=0&ag=0&as=0&pt=126&t1=126&t2=400&t3=400&dc=0&tpt=0
  time=33&rm=0&acs=0&csid=&cm=0&ag=0&as=0&pt=23&t1=23&t2=400&t3=400&dc=0&tpt=0
  time=1792368620&rm=0&acs=0&csid=&cm=0&ag=0&as=0&pt=23&t1=23&t2=400&t3=400&dc=0&tpt=0
  ```
  Later the same evening, `ct` was shown to set the clock immediately (see the start/stop item
  above).
- [x] Fire it up (2026-10-18, 1.0.56, fan unplugged, read from `dc`): method A does nothing; method
  B works. See Commands.
- [x] `tpt` > 260 °C: **accepted** (2026-10-18, 1.0.56). `start --pit 700` sent `tpt=371`; it
  read back as 371 with `acs=1` and `dc=100`. Not clamped, not rejected. Whether the controller
  actually holds the pit above 260 °C can only be seen on a real hot cook. **Deferred** to the
  first pizza cook.
- [x] What happens when a device food-probe target (`p`/`tft`) is reached (2026-10-18, 1.0.56):
  nothing visible. `start --pit 225 --probe 1 --probe-target 85` sent `p=1&tft=29`. P1 went 23 → 33
  °C by hand, passing 29 °C at 00:49:30Z, and the cook carried on (`acs=1 rm=1 dc=100 tpt=107`,
  `cm=0`) until our stop 30 s later. Only ~30 s past the target was tested, so a delayed action
  can't be ruled out; it doesn't matter, because Ember doesn't use `p`/`tft`.
- [x] Meaning of `rm`, `cm`, `as` (2026-10-18, 1.0.56, 3 320 readings: idle, cooks, both Fire it
  up methods, `sce` expiry, reboots). `rm` equals `acs` in every reading, so it's probably "running";
  ignore it and use `acs`. `cm`, `as` and `ag` were `0` in every reading, including the `p`/`tft`
  test. Nothing to infer; keep logging them in the raw JSON.
- [x] Device behaviour when `sce` passes (2026-10-18, 1.0.56): the cook ends within 1 s
  (`acs=0 rm=0 dc=0`), and `tpt` keeps its value:
  ```
  time=1792370683&rm=1&acs=1&csid=&cm=0&ag=0&as=0&pt=23&t1=23&t2=400&t3=400&dc=100&tpt=260
  time=1792370688&rm=0&acs=0&csid=&cm=0&ag=0&as=0&pt=23&t1=23&t2=400&t3=400&dc=0&tpt=260
  ```
  (`sce` was 1792370687.)
