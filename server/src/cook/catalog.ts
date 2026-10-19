// The food catalog (docs/brief.md › Data model): a tree of category › cut › sub-cut with a
// default "pull at" temperature. Lives as an editable JSON file in DATA_DIR, seeded from
// docs/food-catalog.json. The JSON is in °F (it's hand-edited); the tree served is in °C.

import { copyFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type CatalogNode, fToC } from "@ember/shared";

export const SEED_CATALOG = path.resolve(
  fileURLToPath(import.meta.url),
  "../../../../docs/food-catalog.json",
);

type Json = { [k: string]: number | Json };

export class Catalog {
  constructor(readonly tree: CatalogNode[]) {}

  static fromJson(json: Json): Catalog {
    const walk = (obj: Json): CatalogNode[] =>
      Object.entries(obj)
        .filter(([name]) => !name.startsWith("_"))
        .map(([name, v]) =>
          typeof v === "number" ? { name, pullAtC: fToC(v) } : { name, children: walk(v) },
        );
    return new Catalog(walk(json));
  }

  static fromFile(file: string): Catalog {
    return Catalog.fromJson(JSON.parse(readFileSync(file, "utf8")) as Json);
  }

  /** DATA_DIR/food-catalog.json, created from the seed on first run. */
  static load(dataDir: string, seed = SEED_CATALOG): Catalog {
    const file = path.join(dataDir, "food-catalog.json");
    if (!existsSync(file)) copyFileSync(seed, file);
    return Catalog.fromFile(file);
  }

  /** Default target for a leaf path, or null if the path isn't a leaf in the catalog. */
  pullAtC(foodPath: string[]): number | null {
    let nodes: CatalogNode[] | undefined = this.tree;
    let node: CatalogNode | undefined;
    for (const name of foodPath) {
      node = nodes?.find((n) => n.name === name);
      if (!node) return null;
      nodes = node.children;
    }
    return node?.pullAtC ?? null;
  }
}
