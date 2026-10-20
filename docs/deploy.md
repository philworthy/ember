# Deploying Ember to the NAS

Ember runs on the Synology as a Container Manager project with two containers:

- **ember**: the server and the PWA, pulled from `ghcr.io/philworthy/ember:latest`.
- **tailscale**: a sidecar that puts Ember on the tailnet as `ember` and serves it over HTTPS at
  `https://ember.<tailnet>.ts.net`, with a certificate from Tailscale.

Ember has no login: being on the tailnet is the access control, so anyone on your tailnet can
control the grill. It has no port on the home LAN.

First deployed and verified 2026-10-19: HTTPS with a valid certificate on the iPhone, installed to
the home screen, live readings from the grill, and Fire it up from the app.

**Why a second Tailscale, when the NAS already runs the Tailscale package?** That's deliberate.
The package puts the NAS on the tailnet; the sidecar puts Ember there as its own device. That
gives it its own name and certificate, keeps it off the LAN, and needs no setup on the NAS. Using
the NAS's package instead would mean opening a LAN port for Ember, setting up `tailscale serve`
over SSH outside this project, and an address of `<nas-name>.<tailnet>.ts.net`. Changing the
address later means reinstalling the app on the phone and allowing notifications again. The
sidecar costs one more device in Tailscale and a few tens of MB of memory.

## How the image gets built

Every push to `main` runs `.github/workflows/image.yml`. It runs lint, typecheck and the tests,
builds the image, starts it on the simulator to check it serves the app, then publishes it for
Intel and ARM as `ghcr.io/philworthy/ember:latest` (plus a `sha-…` tag per commit). The repo and
the image are public, so the NAS pulls it without logging in. Builds:
<https://github.com/philworthy/ember/actions>. Image: <https://github.com/philworthy/ember/pkgs/container/ember>.

Nothing secret is in the repo or the image. The NAS-only values (the Tailscale auth key) live in
the project's YAML on the NAS.

## First-time setup

### 1. Tailscale admin console (<https://login.tailscale.com/admin>)

1. **DNS** page: turn on **MagicDNS**, and under **HTTPS Certificates** click **Enable**. Without
   these, `https://ember.<tailnet>.ts.net` won't work. The same page shows your tailnet name.
2. **Settings › Keys › Generate auth key**: one-off (not reusable) is fine, since it's only used on
   the first start. If your tailnet requires device approval, tick **Pre-approved**. Copy the
   `tskey-auth-…` value.

### 2. Project folder (DSM › File Station)

1. In the `docker` share, create `ember`, and inside it `data` and `tailscale`, and inside
   `tailscale` a folder `state`.
2. Download [`deploy/tailscale/serve.json`](https://raw.githubusercontent.com/philworthy/ember/main/deploy/tailscale/serve.json)
   and upload it to `docker/ember/tailscale/`. **It must be there before the first start:**
   otherwise Docker creates an empty folder named `serve.json` and HTTPS won't work. (If that
   happens, delete the folder, upload the file and restart the project.)

You should end up with:
```
docker/ember/
  data/
  tailscale/
    serve.json
    state/
```

### 3. Create the project (Container Manager › Project › Create)

1. **Project name** `ember`; **Path** `/docker/ember`; **Source** "Create docker-compose.yml".
2. Paste [`deploy/compose.yaml`](../deploy/compose.yaml) and replace `tskey-auth-REPLACE_ME` with the
   auth key. Check that `IKAMAND_HOST` is the grill's address and `TZ` is right.
3. Skip the web portal settings, then **Done**. Container Manager pulls both images and starts them.

### 4. Check it

1. **Container Manager › Project › ember › Log**: the `ember` log shows
   `device: iKamand at 10.0.4.98` and no errors. The `tailscale` log shows it logged in.
2. The Tailscale admin console's **Machines** page lists `ember`.
3. On the iPhone, with Tailscale on, open `https://ember.<tailnet>.ts.net`. The first load can take
   up to a minute while Tailscale issues the certificate. You should see live readings from the
   grill, or the offline banner if the grill is off.
4. Install it: Safari › Share › **Add to Home Screen**.
5. Optional: once it works, replace the auth key in the project's YAML with a dummy value. The
   login is kept in `tailscale/state`. If that folder is ever deleted, Ember needs a new key.

### 5. Turn on alerts

1. Open Ember **from the home screen icon** (push only works in the installed app on iOS), then
   Settings › **Turn on alerts**, and allow notifications.
2. **Send a test.** "Sent" means the NAS reached Apple's push service; the notification should
   arrive a few seconds later.

There is nothing to set up on the NAS. On its first start Ember generates its push (VAPID) keys
into `data/vapid.json` and keeps them. **Don't delete or replace that file:** phones subscribe
against its public key, so new keys mean turning alerts on again on every phone. It's in `data/`,
so the backup covers it. (`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` in the YAML would override it,
but you don't need them.)

Pushes go out from the `ember` container to Apple (`web.push.apple.com`, HTTPS). The container
shares the sidecar's network, but in userspace mode Tailscale only handles tailnet traffic:
internet traffic leaves through Docker's normal bridge and the NAS, the same way Ember reaches the
grill on the LAN. Pushes also reach the phone when Tailscale is off on it.

## Updating

Push to `main` and wait for the build to go green, then pull the new image the same way as your
other GitHub-image projects, and restart the `ember` project. The database (`data/`) and the
Tailscale login (`tailscale/state/`) persist across updates. To roll back, set the image to a
specific `sha-…` tag from the image page.

## Testing alerts with the simulator

The installed app only takes pushes from `ember.<tailnet>.ts.net`, so alerts are tested by running
the NAS instance on the simulator for a while. Don't do it during a real cook: while it's on, Ember
doesn't watch or control the grill (any cook carries on to the grill's own end time).

1. Container Manager › Project › ember › **Stop**, then edit the YAML and uncomment the three lines
   under "Testing alerts with the simulator" (`USE_SIMULATOR`, `SIM_SCENARIO: alerts`,
   `SIM_SPEED: "20"`), keeping their indentation level with `TZ:`. Save and start it.
2. **Check it took** before going on: the `ember` log must show
   `device: simulator (alerts, 20×)`. If it says `device: iKamand at …`, the project is still on
   the real grill: stop, and fix the YAML. In the app, Settings › Grill › Address reads
   "Simulator at 20×". Simulated cooks go to `data/ember-sim.db`, never into the real history.
3. Open Ember on the phone and go to Settings: opening it re-registers the phone with the
   simulator's database. Check it says alerts are on, and **Send a test**.
4. Settings › Alert me when: everything on. Then, on Idle:
   1. Tap the pit target, choose **Roast (350)** and **Set pit to 350°**. The scenario only
      unplugs the fan once the pit gets near 350°, so the default 225° never gives the pit alert.
   2. Tap the **Probe 1** card, then the food, and pick **Poultry › Chicken › Whole**.
   3. **Fire it up**, 10 min, with **Then hold pit at 350°** on. At 20× its countdown takes
      30 seconds.
5. The scenario then runs by itself, in about 3 minutes: **Fire it up done**, then
   **Pit is … below target** (the simulated fan is unplugged for a while), **Chicken is at 165°**,
   **Chicken came off**, and **Grill offline** (a 3-min outage).
6. Once the grill is back, tap **Stop**: **Looks like you're done** arrives, and about 3 minutes
   later **Cook ended**. Tap a notification to check it opens Live cook (History for Cook ended).
7. Stop the project, comment the three lines out again, and start it. Check the log says
   `device: iKamand at …`, then open Settings in the app (it re-registers with the real database)
   and Send a test.

If nothing arrives, the `ember` log says why: each alert logs an `alert: <title>` line, and each
push a `push: … sent to web.push.apple.com (201)` or `failed` line. An `alert:` with no `push:`
after it means the server has no subscription for the phone: open Settings on the phone.

## Rules while Ember runs on the NAS

- **Ember must be the only thing talking to the grill** (protocol.md › Safety). Keep the Home
  Assistant iKamand integration disabled. Don't run `npm run device`, or a dev server with
  `USE_SIMULATOR=false`, on the Mac while the NAS project is up: two clients fight, and one can
  restart a cook the other stopped. Stop the `ember` project first if you need the CLI.
- Stopping or updating the project leaves a running cook to the grill's own end time (`sce`, at
  most 24 h ahead), and Ember picks it up again on restart. To stop the fan, use End cook in the
  app before taking Ember down.

## Data and backups

`docker/ember/data` holds `ember.db` (every reading, cook and item), `food-catalog.json` (the
editable catalog) and `vapid.json` (the push keys). Include it in Hyper Backup. A backup taken while Ember is writing can catch the
database mid-write, so for a copy you'd rely on (before a risky update, say), stop the project
first and copy the whole `data` folder, including the `ember.db-wal` file if there is one.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| The `ember` container keeps restarting | Check its log. `IKAMAND_HOST is not set` means the variable is missing from the YAML. |
| The app shows the offline banner | The grill is off or off Wi-Fi, or `IKAMAND_HOST` is wrong. The grill is often powered off; that's normal. |
| The browser can't reach `ember.<tailnet>.ts.net` | The phone isn't on Tailscale, or the `tailscale` container isn't logged in (check its log and the Machines page). |
| A certificate error, or HTTPS doesn't load | HTTPS Certificates aren't enabled in the Tailscale DNS settings, or `serve.json` is a folder instead of a file (step 2). |
| "Add to Home Screen" makes a plain bookmark | The page wasn't loaded over HTTPS, or wasn't fully loaded yet. Reload, then try again. |
| Settings says to add Ember to the Home Screen | It's open in Safari, not the installed app. Open it from the home screen icon. |
| Send a test fails | The error comes from Apple's push service or the network. Check the `ember` log for `push:` lines. To test the NAS's way out: Container Manager › Container › ember › Terminal › Create › `sh`, then `node -e "fetch('https://web.push.apple.com').then(r => console.log(r.status), e => console.log(e.message))"` (any status code means it got through). |
| Test says sent, but nothing arrives | iPhone Settings › Notifications › Ember: allow notifications, and check Focus isn't hiding them. |
| Settings shows "Turn on alerts" again | The phone's subscription expired or was removed (Apple said it's gone), or `vapid.json` changed. Turn alerts on again. |
