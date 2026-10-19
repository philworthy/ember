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

## Updating

Push to `main` and wait for the build to go green, then pull the new image the same way as your
other GitHub-image projects, and restart the `ember` project. The database (`data/`) and the
Tailscale login (`tailscale/state/`) persist across updates. To roll back, set the image to a
specific `sha-…` tag from the image page.

## Rules while Ember runs on the NAS

- **Ember must be the only thing talking to the grill** (protocol.md › Safety). Keep the Home
  Assistant iKamand integration disabled. Don't run `npm run device`, or a dev server with
  `USE_SIMULATOR=false`, on the Mac while the NAS project is up: two clients fight, and one can
  restart a cook the other stopped. Stop the `ember` project first if you need the CLI.
- Stopping or updating the project leaves a running cook to the grill's own end time (`sce`, at
  most 24 h ahead), and Ember picks it up again on restart. To stop the fan, use End cook in the
  app before taking Ember down.

## Data and backups

`docker/ember/data` holds `ember.db` (every reading, cook and item) and `food-catalog.json` (the
editable catalog). Include it in Hyper Backup. A backup taken while Ember is writing can catch the
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
