// Renders client/icons/icon.svg to the PNG icons the PWA manifest and iOS need:
// `npm run icons`. The PNGs are committed, so this only runs when the icon changes.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const root = path.resolve(fileURLToPath(import.meta.url), "../..");
const svg = readFileSync(path.join(root, "client/icons/icon.svg"), "utf8");
const out = path.join(root, "client/public/icons");

const sizes: [string, number][] = [
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  ["apple-touch-icon.png", 180],
  ["favicon-32.png", 32],
];

for (const [name, size] of sizes) {
  const png = new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
  writeFileSync(path.join(out, name), png);
  console.log(`${name} ${size}×${size}`);
}
