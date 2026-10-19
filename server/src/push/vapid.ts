// The VAPID keys that sign every push. Phones subscribe against the public key, so it must never
// change: generated once into DATA_DIR/vapid.json (backed up with the database that holds the
// subscriptions), unless VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are set.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import webpush from "web-push";

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface Vapid extends VapidKeys {
  subject: string;
  /** Where the keys came from, for the startup log. */
  source: "env" | "file" | "generated";
}

export function loadVapid(
  opts: { env: VapidKeys | null; subject: string },
  dataDir: string,
): Vapid {
  const { subject } = opts;
  if (opts.env) return { ...opts.env, subject, source: "env" };
  const file = path.join(dataDir, "vapid.json");
  if (existsSync(file)) {
    const keys = JSON.parse(readFileSync(file, "utf8")) as Partial<VapidKeys>;
    if (!keys.publicKey || !keys.privateKey) throw new Error(`${file} is missing a key`);
    return { publicKey: keys.publicKey, privateKey: keys.privateKey, subject, source: "file" };
  }
  const keys = webpush.generateVAPIDKeys();
  mkdirSync(dataDir, { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return { ...keys, subject, source: "generated" };
}
