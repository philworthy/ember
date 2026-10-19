# M1 runbook: verifying the protocol at the grill

Works through the checklist in `protocol.md` in an order that keeps the fan off for as long as
possible. Every state-changing command shows the exact payload and waits for `yes`. After it sends,
it reads `data` again and prints what changed. Requests and responses are appended to
`captures/device-<date>.log` (git-ignored), so the raw text can be pasted into `protocol.md`.

## Before you start

- `cp .env.example .env` and check that `IKAMAND_HOST` is right. The Mac must be on the home LAN.
- Grill **cold**, no lit charcoal. Controller powered on, pit probe clipped in, **probe 1 plugged
  in, probes 2 and 3 unplugged**. Fan attached and in view. You stay at the grill for every step that
  runs the fan.
- In a second terminal, leave this running for the whole session. It's read-only and logs every
  reading to `captures/watch-<time>.csv`:

  ```bash
  npm run device -- watch
  ```

## Steps

Commands are `npm run device -- <command>`. The checklist item each step resolves is in brackets.

1. **Info and data** [respond; raw examples]. Run `info`, then `data`. Copy both `raw:` lines into
   `protocol.md`. Note any field not in the `data` table (it shows up as `other`).
2. **Probe sentinel** [unplugged value]. With P2 and P3 unplugged, does `data` show `400` or
   `-400`? Unclip the pit probe for one `data` call to see `pt`'s sentinel, then plug it back in.
3. **Power cycle**. Done 2026-10-18: `time` counts seconds since boot until the device sets its
   own clock (45 s to 5+ min), or until any command's `ct` sets it.
4. **Content type** [JSON header with form body]. Run `start --pit 225`. If `acs` changes 0 → 1,
   the references' JSON header is accepted. Then `stop --form-header`. If `acs` goes back to 0,
   the correct form header works too. If the first didn't take, try `start --pit 225 --form-header`.
5. **Start, retarget, stop** [behave as described]. `start --pit 225`, wait for the fan to respond
   (on a cold grill it should run high). `start --pit 250`: `tpt` should change and `acs` stays 1.
   Note whether `sce`, `p` and `tft` appear in `data` during a cook (they're absent while idle). Then `stop`. Optional, useful for recovery: start again, power-cycle during
   the cook, and see whether the cook is still active after the reboot.
6. **Pit target above 260 °C** [`tpt` > 260]. `start --pit 700`. Read `tpt` back in the "Changed"
   output: 371 means accepted, 260 means clamped, and no change or an HTTP error means rejected.
   Run `stop` right away. Repeat with `--pit 550` (288 °C) if the result is unclear.
7. **Fire it up, method A** [method A]. `grill --method a --min 2 --grace 60`. Does `ag` read 1
   and does the fan go to 100%? During the 60 s grace, does the device stop on its own at `sge`? The
   command reports this at the end. If the grill-mode stop doesn't work, it sends a full stop cook
   automatically.
8. **Fire it up, method B, and `sce`** [method B; `sce` passes]. `grill --method b --min 2 --grace
   60`. Same questions. This also shows what the device does when `sce` passes: does `acs` go to 0,
   or does `tpt` or something else change?
9. **Device food-probe target** [`p`/`tft` reached]. Read P1's current temperature with `data`.
   Run `start --pit 225 --probe 1 --probe-target <about 10°F above P1>`. Warm P1 by hand or in
   warm water until it passes the target. Watch `acs`, `dc`, `tpt`, `p`, `tft`, `rm`, `cm`, `as`.
   Does the cook end, hold, or switch to keep-warm? Then `stop`.
10. **Unknown fields** [`rm`, `cm`, `as`]. Stop `watch` and look through the CSV for when `rm`,
    `cm`, `as` and `ag` changed. Match those times against the steps above.

## Afterwards

- Update `protocol.md`: tick each checklist item with the date and firmware, replace UNVERIFIED
  notes with what happened, and paste the raw examples. Also settle these two doc questions from the
  M0/M1 plan:
  - Quirk 4 ("always send the full command") can't apply to grill mode A, which is a partial
    payload by design. Scope the rule to `acs` cook commands, or drop method A.
  - The brief's Fire it up section says the device stops when the timer ends. Reword it to match
    what steps 7–8 showed. Ember's server-side timer stays the main stop either way.
- Anything not tested goes in `protocol.md` as **deferred**, with the reason.
