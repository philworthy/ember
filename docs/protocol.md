# iKamand local protocol

Everything here comes from two community implementations (copies in `reference/`) and has **not yet
been verified against Phil's unit** (firmware 1.0.56). Milestone 1 verifies it. Items marked
**UNVERIFIED** must be tested and this file updated with what the device actually does.

## Basics

- Plain HTTP on port 80, no auth, LAN only. Base URL: `http://<IKAMAND_HOST>/cgi-bin/`
- Responses are **URL-encoded query strings**, not JSON (e.g. `acs=1&tpt=121&pt=118&t1=64&...`).
  Parse with a query-string parser; every value arrives as a string.
- Requests: both references send `POST` with header `Content-Type: application/json` but a
  **form-encoded body** (Python `requests` with `data=dict`). Copy that exact shape first; only try
  a correct `application/x-www-form-urlencoded` header if the device rejects it. **UNVERIFIED** which
  the firmware cares about.
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
| `time` | Device clock, Unix seconds | Below ~40 means it just booted and has no clock yet: treat the reading as invalid |
| `acs` | Cook active, `1`/`0` | |
| `tpt` | Target pit temp °C | |
| `pt` | Pit temp °C | `400` or `-400` = no probe / invalid |
| `t1` `t2` `t3` | Food probe temps °C | `400` or `-400` = probe not plugged in |
| `dc` | Fan duty cycle % | |
| `sce` | Scheduled cook end, Unix seconds | Cook stops itself at this time |
| `csid` | Cook session id | Both references send `""` |
| `p` | Which food probe the device is watching (0–3) | |
| `tft` | Target food temp °C for probe `p` | |
| `ag` | Grill mode active | One reference treats this as unknown |
| `rm`, `cm`, `as` | Unknown | Log them; maybe they're useful |

## Commands (POST `cook`)

Always include `ct` = current Unix time in seconds; the device uses it to set its clock.

**Start or update a cook.** Sending this again with a new `tpt` is how the pit target changes.
```
acs=1  csid=""  tpt=<°C>  sce=<now + 86400>  p=0  tft=0  as=0  ct=<now>
```

**Stop a cook**
```
acs=0  csid=""  tpt=0  sce=0  p=0  tft=0  as=0  ct=<now>
```

**Fire it up — two candidate methods. UNVERIFIED which works on 1.0.56:**
- A. Native grill mode (from the original library): `ag=1  sge=<now + minutes*60>  ct=<now>`;
  stop with `ag=0  sge=0  ct=<now>`.
- B. Emulated (from the Home Assistant version): start a cook with `tpt=260` (500°F) and
  `sce=<now + minutes*60>`. The fan runs flat out until the pit nears 260 °C. The server must stop
  the cook when the timer ends: the HA code does this itself rather than trusting `sce`.

**Device food-probe target:** `p=<1-3>  tft=<°C>` on top of an active cook. The firmware only holds
one. **UNVERIFIED:** what the device does when that probe hits `tft`. It might end the cook or switch
to a keep-warm mode. Until that's known, Ember always sends `p=0 tft=0` and tracks all probe targets
on the server.

## Quirks the server must handle

1. **Invalid readings:** `400`/`-400` mean "no reading". Store null, never the sentinel.
2. **Clock not set:** `time < 40` means the device just rebooted. Drop the reading and treat the
   device as reconnecting.
3. **Cook recovery after a reboot or clock drift.** Port the HA logic (`connection_recovery` in
   `reference/ha-ikamand/ikamand.py`): if the device's clock is more than 60 s from the server's, or
   it comes back after being offline, check whether a cook should be running. If Ember has an open
   session that should be active, and the last good reading is under 10 minutes old, resend the
   start-cook command with the last target. Otherwise send stop. The server's session state is the
   source of truth, not the device.
4. **Partial command payloads:** the HA code sometimes sends only some fields. Ember always sends the
   full command so the device state is predictable.
5. **Flaky HTTP:** one failed poll is not "offline". Mark the device offline after about 3
   consecutive failures (~15 s).

## Safety

- Ember must never be the reason the fan keeps running unattended. If the server crashes, the device
  still stops at `sce`, so never set `sce` more than 24 h ahead, and re-extend it during long cooks
  (e.g. every hour, push `sce` to now + 24 h).
- Fire it up must have a server-side timer and a device-side `sce`. Either one stops it.
- On server start, read the device state and reconcile it with the DB before sending anything.

## Temperature limits

- The HA code limits the pit target to 66–260 °C (150–500 °F). Ember's UI allows up to 700 °F
  (371 °C) for pizza. **UNVERIFIED:** what the device does with `tpt` above 260. It might accept it,
  clamp it, or reject the command. Test carefully with the grill cold and the fan unplugged or
  watched, and record the result here. If it clamps or rejects, above 500 °F Ember sends 260 and
  shows the "can't hold above 500°" note from the design.

## Milestone 1 test checklist

Fill in results as they're found, with date and firmware.

- [ ] `info` and `data` respond; capture raw example responses here
- [ ] JSON content-type with form body is accepted for `cook`
- [ ] Start cook, change target, stop cook all behave as described
- [ ] Unplugged probe value (400 or -400?)
- [ ] What `time` looks like right after a power cycle
- [ ] Fire it up: method A (`ag`) works? Method B works?
- [ ] `tpt` > 260 °C: accepted, clamped or rejected?
- [ ] What happens when a device food-probe target (`p`/`tft`) is reached
- [ ] Meaning of `rm`, `cm`, `as`, if anything can be inferred
- [ ] Device behaviour when `sce` passes
