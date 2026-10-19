// Choose food (design/canvas/FoodPicker.dc.html): search, Recent, a drill-down through the
// catalog, Custom…, then "Pull at" and an optional weight before "Use for probe N".

import {
  type CatalogNode,
  cToDisplayF,
  type Food,
  foodLabel,
  fToC,
  type LiveState,
  type ProbeSlot,
  type RecentFood,
} from "@ember/shared";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api.ts";
import { deg } from "../format.ts";
import type { Snapshot } from "../live.ts";
import { goBack } from "../router.ts";
import { ChevronIcon, PlusIcon, SearchIcon } from "../ui/icons.tsx";
import { SheetHeader, SLOT_COLOR, StepButton } from "../ui/parts.tsx";
import { probeFood } from "./Targets.tsx";

const CUSTOM_PULL_F = 200;
const WEIGHT = { step: 0.5, max: 30 };

let catalogCache: CatalogNode[] | null = null;

interface Leaf {
  path: string[];
  pullAtC: number;
}

function leaves(nodes: CatalogNode[], path: string[] = []): Leaf[] {
  return nodes.flatMap((n) =>
    n.children
      ? leaves(n.children, [...path, n.name])
      : n.pullAtC !== undefined
        ? [{ path: [...path, n.name], pullAtC: n.pullAtC }]
        : [],
  );
}

function nodeAt(tree: CatalogNode[], path: string[]): CatalogNode | null {
  let nodes: CatalogNode[] | undefined = tree;
  let node: CatalogNode | null = null;
  for (const name of path) {
    node = nodes?.find((n) => n.name === name) ?? null;
    if (!node) return null;
    nodes = node.children;
  }
  return node;
}

export function FoodPicker({ snap, slot }: { snap: Snapshot; slot: ProbeSlot }) {
  const live = snap.live as LiveState;
  const [tree, setTree] = useState<CatalogNode[] | null>(catalogCache);
  const [recent, setRecent] = useState<RecentFood[]>([]);
  const [path, setPath] = useState<string[]>([]);
  const [custom, setCustom] = useState(false);
  const [customName, setCustomName] = useState("");
  const [query, setQuery] = useState("");
  const [weight, setWeight] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!catalogCache) {
      void api.catalog().then((r) => {
        if (r.ok) {
          catalogCache = r.data;
          setTree(r.data);
        } else setError(r.error);
      });
    }
    void api.recentFoods().then((r) => r.ok && setRecent(r.data));
  }, []);

  const flat = useMemo(() => (tree ? leaves(tree) : []), [tree]);
  const node = tree && path.length ? nodeAt(tree, path) : null;
  const isLeaf = custom || (node !== null && node.pullAtC !== undefined);
  const isRoot = !custom && path.length === 0;
  const q = query.trim().toLowerCase();

  const go = (p: string[]) => {
    setPath(p);
    setQuery("");
    setError(null);
  };
  const up = () => (custom ? setCustom(false) : go(path.slice(0, -1)));
  const lastWeight = (food: Food) =>
    recent.find((r) => JSON.stringify(r.food) === JSON.stringify(food))?.weightLb ?? null;

  const pickLeaf = (p: string[]) => {
    go(p);
    setWeight(lastWeight({ path: p }));
  };

  const current = probeFood(live, slot);
  const currentTargetC = current?.food && "custom" in current.food ? current.targetC : null;

  const use = async () => {
    const food: Food = custom ? { custom: customName.trim() } : { path };
    setBusy(true);
    const r = await api.assignProbe(
      slot,
      {
        food,
        weightLb: weight,
        ...(custom ? { targetC: currentTargetC ?? fToC(CUSTOM_PULL_F) } : {}),
      },
      { quiet: true },
    );
    setBusy(false);
    if (r.ok) goBack();
    else setError(r.error);
  };

  const pullAtC = custom ? (currentTargetC ?? fToC(CUSTOM_PULL_F)) : (node?.pullAtC ?? null);

  const title = custom
    ? "Custom"
    : path.length
      ? (path.at(-1) as string)
      : `What’s on probe ${slot}`;
  const crumb = custom
    ? "Your own name"
    : path.length > 1
      ? path.slice(0, -1).join(" › ")
      : path.length === 1
        ? "Choose a cut"
        : "Pick a category";

  type Row = { key: string; label: string; sub?: string; meta: string; go: () => void };
  let rows: Row[] = [];
  let heading = "";
  if (tree && isRoot && q) {
    const hits = flat.filter((l) => l.path.join(" ").toLowerCase().includes(q));
    heading = hits.length ? "Results" : "No matches";
    rows = hits.slice(0, 12).map((l) => ({
      key: l.path.join("/"),
      label: l.path.at(-1) as string,
      sub: l.path.slice(0, -1).join(" › "),
      meta: deg(l.pullAtC),
      go: () => pickLeaf(l.path),
    }));
  } else if (tree && !isLeaf) {
    const children = isRoot ? tree : (node?.children ?? []);
    heading = isRoot ? "All foods" : "Choose a cut";
    rows = children.map((c) => ({
      key: c.name,
      label: c.name,
      meta: c.children ? String(leaves(c.children).length) : deg(c.pullAtC),
      go: () => (c.children ? go([...path, c.name]) : pickLeaf([...path, c.name])),
    }));
    if (isRoot) {
      rows.push({
        key: "custom",
        label: "Custom…",
        sub: "Name it yourself",
        meta: "",
        go: () => {
          setCustom(true);
          setWeight(null);
        },
      });
    }
  }

  return (
    <main className="screen" style={{ paddingBottom: "calc(24px + env(safe-area-inset-bottom))" }}>
      <SheetHeader
        title={title}
        sub={crumb}
        back={!isRoot}
        onBack={isRoot ? undefined : up}
        right={
          <span
            style={{
              fontSize: 12,
              color: "var(--text-2)",
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
            }}
          >
            <span className="dot" style={{ width: 7, height: 7, background: SLOT_COLOR[slot] }} />P
            {slot}
          </span>
        }
      />

      {isRoot && (
        <div style={{ position: "relative" }}>
          <label htmlFor="food-search" className="sr-only">
            Search foods
          </label>
          <SearchIcon
            size={18}
            color="var(--text-3)"
            style={{ position: "absolute", left: 14, top: 13 }}
          />
          <input
            id="food-search"
            type="search"
            value={query}
            placeholder="Search cuts"
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
            style={{
              width: "100%",
              height: 44,
              borderRadius: 12,
              border: "1px solid var(--line)",
              background: "var(--surface)",
              color: "var(--text)",
              fontSize: 16,
              padding: "0 14px 0 40px",
            }}
          />
        </div>
      )}

      {isRoot && !q && recent.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span className="label" style={{ padding: "0 4px" }}>
            Recent
          </span>
          <div className="list">
            {recent.map((r) => {
              const isCustom = "custom" in r.food;
              const meta = [
                "path" in r.food ? r.food.path[0] : "Custom",
                r.weightLb ? `${r.weightLb} lb last time` : null,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <button
                  key={JSON.stringify(r.food)}
                  type="button"
                  className="list-row"
                  style={{ minHeight: 56 }}
                  onClick={() => {
                    if ("custom" in r.food) {
                      setCustom(true);
                      setCustomName(r.food.custom);
                    } else go(r.food.path);
                    setWeight(r.weightLb);
                  }}
                >
                  <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ fontSize: 15 }}>{foodLabel(r.food).name}</span>
                    <span className="label">{meta}</span>
                  </span>
                  {isCustom ? (
                    <ChevronIcon size={16} color="var(--text-3)" />
                  ) : (
                    <PlusIcon size={16} color="var(--text-3)" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {!isLeaf && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span className="label" style={{ padding: "0 4px" }}>
            {tree ? heading : error ? "" : "Loading…"}
          </span>
          {rows.length > 0 && (
            <div className="list">
              {rows.map((row) => (
                <button key={row.key} type="button" className="list-row" onClick={row.go}>
                  <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ fontSize: 15 }}>{row.label}</span>
                    {row.sub && <span className="label">{row.sub}</span>}
                  </span>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 8,
                      fontSize: 14,
                      color: "var(--text-2)",
                    }}
                  >
                    {row.meta}
                    <ChevronIcon size={16} color="var(--text-3)" />
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {isLeaf && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16, flex: 1 }}>
          {custom && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label htmlFor="custom-name" className="label">
                Name
              </label>
              <input
                id="custom-name"
                type="text"
                value={customName}
                maxLength={60}
                placeholder="e.g. Goat shoulder"
                onChange={(e) => setCustomName(e.target.value)}
                style={{
                  height: 48,
                  borderRadius: 12,
                  border: "1px solid var(--line-2)",
                  background: "var(--surface)",
                  color: "var(--text)",
                  fontSize: 16,
                  padding: "0 14px",
                }}
              />
            </div>
          )}

          <div
            style={{
              background: "var(--surface)",
              borderRadius: 18,
              padding: 18,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="label">Pull at</span>
              <span style={{ fontSize: 32, letterSpacing: "-0.02em" }}>
                {pullAtC === null ? "—" : `${cToDisplayF(pullAtC)}°`}
              </span>
            </span>
            <span className="label" style={{ maxWidth: 150, textAlign: "right", lineHeight: 1.4 }}>
              Fine-tune it on the Targets screen
            </span>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 10,
              paddingTop: 8,
            }}
          >
            <span style={{ fontSize: 13, color: "var(--text-2)" }}>Weight</span>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                width: "100%",
              }}
            >
              <StepButton
                kind="dec"
                label="Less weight"
                disabled={weight === null}
                onStep={() =>
                  setWeight((w) => (w === null || w <= WEIGHT.step ? null : w - WEIGHT.step))
                }
              />
              <div style={{ display: "flex", alignItems: "baseline", gap: 6 }} aria-live="polite">
                <span className="big" style={{ fontSize: 72 }}>
                  {weight === null ? <span className="faint">—</span> : weight.toFixed(1)}
                </span>
                <span style={{ fontSize: 20, color: "var(--text-2)" }}>lb</span>
              </div>
              <StepButton
                kind="inc"
                label="More weight"
                onStep={() =>
                  setWeight((w) => (w === null ? 1 : Math.min(WEIGHT.max, w + WEIGHT.step)))
                }
              />
            </div>
            <span style={{ fontSize: 12, color: "var(--text-3)" }}>
              Optional. Used to improve time estimates.
            </span>
          </div>

          <div style={{ flex: 1 }} />
          {error && (
            <p
              role="alert"
              style={{ margin: 0, fontSize: 13, color: "var(--warn-fg)", textAlign: "center" }}
            >
              {error}
            </p>
          )}
          <button
            type="button"
            className="btn btn-lg btn-primary"
            disabled={busy || (custom && !customName.trim())}
            onClick={() => void use()}
          >
            Use for probe {slot}
          </button>
        </div>
      )}
    </main>
  );
}
