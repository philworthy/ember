# Design

The design was made in Claude Design. `canvas/` holds the source for each screen, and `screens/`
holds PNG exports. Use the PNGs for the look and the source for exact values and copy.

## Screens

| File | Screen | Notes |
|---|---|---|
| `Main.dc.html` | Live cook | Its `scenario` prop switches between Cooking, Item came off and Looks done |
| `MainItemOff.dc.html` | Live cook, a probe came off | Renders `Main` with that scenario |
| `MainDone.dc.html` | Live cook, looks done | Renders `Main` with that scenario |
| `SetTarget.dc.html` | Targets | Pit / P1–P3 tabs |
| `FoodPicker.dc.html` | Choose food | Search, recent, drill-down, weight |
| `FireUp.dc.html` | Fire it up | Choose duration, then a running state |
| `Idle.dc.html` | Idle / start cook | `connection` prop switches between Ready and Offline |
| `History.dc.html` | History list | |
| `HistoryDetail.dc.html` | Past cook | Includes the Adjust start & end state |

Not designed: Settings, and the first-run "install to home screen and allow notifications" prompt.
Build them plainly in the same style.

## Reading the `.dc.html` files

- These are design files, not app code. Don't import or reuse them as components.
- Inline `style="…"` attributes hold the exact colours, sizes, radii and spacing.
- `{{name}}` is a value from that file's `renderVals()`. `<sc-for>` repeats markup and `<sc-if>`
  shows it conditionally.
- The numbers inside `renderVals()` are **sample data** (made-up temperature curves). They show the
  shape of the UI, not real logic. The real behaviour is in `docs/brief.md`.
- They load a `support.js` runtime that isn't included, so they won't open on their own.

## Tokens

| Token | Value | Use |
|---|---|---|
| `bg` | `#0C0D0E` | App background |
| `surface` | `#16181A` | Cards |
| `surface-2` | `#1F2225` | Raised controls, selected tab |
| `line` | `#26292C` / `#2E3134` | Borders, dividers, chart grid `#24272A` |
| `text` | `#F3F1ED` | Primary text |
| `text-2` | `#A3A09A` | Secondary text |
| `text-3` | `#7D7A75` | Axis labels, tertiary |
| `pit` | `#FF7A3D` | Pit series, primary buttons (dark text `#0C0D0E` on it) |
| `p1` | `#F4CF63` | Probe 1 |
| `p2` | `#5AA9F8` | Probe 2 |
| `p3` | `#C59CFF` | Probe 3 |
| `ok` | `#5FD08A` | Connected, holding, done ticks |
| `warn-bg` / `warn-fg` | `#2A1A14` / `#FF9A6B` | Offline and over-500° notices |

- **Type:** Geist (UI) and Geist Mono (axis labels), from Google Fonts. Self-host them in the PWA.
  Use tabular numbers everywhere. Big readouts use weight 300 with tight letter-spacing: pit 88px,
  targets 88–96px, probes 40px.
- **Radii:** cards 18–22px, buttons 14–16px, chips and pills fully rounded.
- **Touch targets:** at least 44px. Primary actions are 52–56px tall.
- **Dark only** for now. It's used outdoors at night, and glare matters.
- **Charts:** 2px lines, dashed 1px target lines at 70% opacity, end-point dots, °F gridlines every
  50°, stall shaded at 7% of the probe colour.
