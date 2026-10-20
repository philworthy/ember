// Settings (not designed; plain, in the app's style): the grill's status, alerts on this device
// with their toggles and thresholds, and install help (docs/brief.md › Screens 9).

import {
  type AlertPrefs,
  cDeltaToF,
  type DeviceInfo,
  fDeltaToC,
  type LiveState,
} from "@ember/shared";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { duration } from "../format.ts";
import type { Snapshot } from "../live.ts";
import {
  disablePush,
  enablePush,
  isIOS,
  isStandalone,
  type PushState,
  readPush,
  syncPush,
  testPush,
} from "../push.ts";
import { SheetHeader, StepButton, Toggle } from "../ui/parts.tsx";

const LINK_TEXT: Record<LiveState["link"]["state"], string> = {
  starting: "Starting",
  online: "Connected",
  recovering: "Reconnecting",
  offline: "Offline",
};

const PUSH_TEXT: Record<PushState, string> = {
  noWorker: "Alerts need the built app, opened over HTTPS or on localhost.",
  unsupported: "This browser can't show Ember's alerts.",
  needsInstall: "Add Ember to your Home Screen, then open it from there to turn on alerts.",
  denied: isIOS()
    ? "Notifications are off for Ember. Turn them on in iPhone Settings › Notifications › Ember, then come back here."
    : "Notifications are blocked for Ember. Allow them in the browser's site settings, then reload.",
  off: "Get an alert on this device when food is ready or the grill needs you.",
  on: "Alerts are on for this device.",
};

/** How long to wait after the last change before saving prefs. */
const SAVE_DELAY_MS = 600;

export function Settings({ snap, now }: { snap: Snapshot; now: number }) {
  const live = snap.live;
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<AlertPrefs | null>(null);
  const [push, setPush] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshPush = useCallback(() => readPush().then((r) => setPush(r.state)), []);
  useEffect(() => {
    void api.device().then((r) => r.ok && setDevice(r.data));
    void api.push().then((r) => {
      if (!r.ok) return setNote({ text: r.error, ok: false });
      setPublicKey(r.data.publicKey);
      setPrefs(r.data.prefs);
    });
    // Make sure the server has this device's subscription before saying alerts are on.
    void syncPush()
      .then(
        (error) => error && setNote({ text: `Couldn't register this device: ${error}`, ok: false }),
      )
      .finally(() => refreshPush());
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [refreshPush]);

  const change = (next: AlertPrefs) => {
    setPrefs(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void api.setAlerts(next).then((r) => {
        if (!r.ok) setNote({ text: `Couldn't save: ${r.error}`, ok: false });
      });
    }, SAVE_DELAY_MS);
  };

  const run = async (fn: () => Promise<string | null>, okText: string) => {
    setBusy(true);
    setNote(null);
    const error = await fn().catch((err: Error) => err.message);
    setBusy(false);
    setNote(error ? { text: error, ok: false } : { text: okText, ok: true });
    await refreshPush();
  };

  const address =
    device?.source === "simulator" || (live && live.clockRate !== 1)
      ? `Simulator${live && live.clockRate !== 1 ? ` at ${live.clockRate}×` : ""}`
      : (device?.host ?? "—");

  return (
    <main className="screen">
      <SheetHeader title="Settings" />

      <Section title="Grill">
        <Row label="Status" value={live ? LINK_TEXT[live.link.state] : "—"} />
        <Row label="Address" value={address} />
        <Row label="Firmware" value={device?.firmware ?? "—"} />
        <Row
          label="Last reading"
          value={live?.link.lastSeenMs ? `${duration(now - live.link.lastSeenMs)} ago` : "—"}
        />
        {live?.link.halted && <Row label="Control" value="Halted after repeated errors" />}
      </Section>

      <Section title="Alerts">
        <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "14px 0" }}>
          <p className="muted" style={{ margin: 0, fontSize: 14, lineHeight: 1.45 }}>
            {push ? PUSH_TEXT[push] : "Checking…"}
          </p>
          {push === "off" && publicKey && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => {
                // enablePush asks for permission first thing, inside this tap (iOS needs that).
                void run(() => enablePush(publicKey), "Alerts are on. Send a test to check.");
              }}
            >
              Turn on alerts
            </button>
          )}
          {push === "on" && (
            <div className="grid-2">
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void run(testPush, "Sent. It should arrive in a few seconds.")}
              >
                Send a test
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await disablePush();
                    return null;
                  }, "Alerts are off for this device.")
                }
              >
                Turn off
              </button>
            </div>
          )}
          {note && (
            <p
              role="status"
              style={{
                margin: 0,
                fontSize: 13,
                lineHeight: 1.4,
                color: note.ok ? "var(--ok)" : "var(--warn-fg)",
              }}
            >
              {note.text}
            </p>
          )}
        </div>
      </Section>

      {prefs && <AlertToggles prefs={prefs} onChange={change} />}

      <Section title="Install">
        <p
          className="muted"
          style={{ margin: 0, padding: "14px 0", fontSize: 14, lineHeight: 1.45 }}
        >
          {isStandalone()
            ? "Ember is installed on this device."
            : "On iPhone, open Ember in Safari, tap Share, then Add to Home Screen. Then open Ember from the home screen icon and turn on alerts here: alerts need the installed app."}
        </p>
      </Section>
    </main>
  );
}

function AlertToggles({
  prefs,
  onChange,
}: {
  prefs: AlertPrefs;
  onChange: (p: AlertPrefs) => void;
}) {
  const flag = (key: "itemAtTarget" | "itemCameOff" | "fireUpFinished" | "looksDone") => ({
    on: prefs[key],
    onToggle: () => onChange({ ...prefs, [key]: !prefs[key] }),
  });
  const pit = prefs.pitOffTarget;
  const off = prefs.deviceOffline;
  const bandF = Math.round(cDeltaToF(pit.bandC));
  return (
    <Section title="Alert me when">
      <SwitchRow label="Food reaches its target" {...flag("itemAtTarget")} />
      <SwitchRow
        label="Food comes off"
        sub="Taken off the probe or unplugged"
        {...flag("itemCameOff")}
      />
      <SwitchRow
        label="The pit is off target"
        sub="Only after the pit has reached it"
        on={pit.on}
        onToggle={() => onChange({ ...prefs, pitOffTarget: { ...pit, on: !pit.on } })}
      />
      {pit.on && (
        <>
          <StepRow
            label="By more than"
            value={`${bandF}°`}
            dec={bandF > 10}
            inc={bandF < 100}
            onStep={(d) =>
              onChange({ ...prefs, pitOffTarget: { ...pit, bandC: fDeltaToC(bandF + d * 5) } })
            }
          />
          <StepRow
            label="For"
            value={`${pit.forMin} min`}
            dec={pit.forMin > 1}
            inc={pit.forMin < 60}
            onStep={(d) => onChange({ ...prefs, pitOffTarget: { ...pit, forMin: pit.forMin + d } })}
          />
        </>
      )}
      <SwitchRow
        label="The grill goes offline"
        sub="During a cook"
        on={off.on}
        onToggle={() => onChange({ ...prefs, deviceOffline: { ...off, on: !off.on } })}
      />
      {off.on && (
        <StepRow
          label="For"
          value={`${off.forMin} min`}
          dec={off.forMin > 1}
          inc={off.forMin < 60}
          onStep={(d) => onChange({ ...prefs, deviceOffline: { ...off, forMin: off.forMin + d } })}
        />
      )}
      <SwitchRow label="Fire it up finishes" {...flag("fireUpFinished")} />
      <SwitchRow
        label="It looks done"
        sub="And when Ember ends the cook for you"
        {...flag("looksDone")}
      />
    </Section>
  );
}

function SwitchRow({
  label,
  sub,
  on,
  onToggle,
}: {
  label: string;
  sub?: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <button type="button" role="switch" aria-checked={on} className="list-row" onClick={onToggle}>
      <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 15 }}>{label}</span>
        {sub && <span className="label">{sub}</span>}
      </span>
      <Toggle on={on} />
    </button>
  );
}

function StepRow({
  label,
  value,
  dec,
  inc,
  onStep,
}: {
  label: string;
  value: string;
  dec: boolean;
  inc: boolean;
  onStep: (delta: 1 | -1) => void;
}) {
  return (
    <div className="list-row" style={{ paddingLeft: 16 }}>
      <span className="muted" style={{ fontSize: 14 }}>
        {label}
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <StepButton
          kind="dec"
          label={`Less: ${label}`}
          size={44}
          disabled={!dec}
          onStep={() => dec && onStep(-1)}
        />
        <span
          style={{
            minWidth: 56,
            textAlign: "center",
            fontSize: 15,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {value}
        </span>
        <StepButton
          kind="inc"
          label={`More: ${label}`}
          size={44}
          disabled={!inc}
          onStep={() => inc && onStep(1)}
        />
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span className="label" style={{ padding: "0 4px" }}>
        {title}
      </span>
      <div className="list">{children}</div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="list-row">
      <span style={{ fontSize: 15 }}>{label}</span>
      <span className="muted" style={{ fontSize: 14 }}>
        {value}
      </span>
    </div>
  );
}
