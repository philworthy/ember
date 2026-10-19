// What the server stores and serves: sessions, items, live state and events. Every temperature
// is °C (pit targets are device integers; probe targets are exact conversions of the °F the user
// picked). The client converts for display with ./units.ts.

import type { DeviceLinkState, ProbeSlot, Reading } from "./types.ts";

export type SessionOrigin = "user" | "fireUp" | "adopted" | "foreign";
/** `timeout` is reserved: losing the connection never ends a session. */
export type EndedBy = "user" | "auto" | "timeout";
export type ItemEndReason = "removed" | "unplugged" | "session_end" | "user";
export type TargetSubject = "pit" | "p1" | "p2" | "p3";
export type TargetSource = "user" | "adopted" | "foreign" | "fireUp";
/** `stopped`: the user (or another command, or another client) ended it early. */
export type FireUpOutcome = "hold" | "stop" | "stopped";
export type PitStatus = "idle" | "heating" | "holding" | "cooling";

/** A catalog path (category › cut › sub-cut) or a custom name. */
export type Food = { path: string[] } | { custom: string };

/** A food set up on a probe before the cook starts. */
export interface ProbeSetup {
  food: Food | null;
  weightLb: number | null;
  targetC: number;
}

export interface Session {
  id: number;
  startedAt: number;
  endedAt: number | null;
  endedBy: EndedBy | null;
  origin: SessionOrigin;
  title: string;
  titleCustom: boolean;
  notes: string;
  /** When the "Looks like you're done" prompt went up; null when it isn't showing. */
  looksDoneAt: number | null;
  /** Keep going: the prompt stays away until its conditions clear and come back. */
  keepGoingAt: number | null;
}

export interface ItemStats {
  timeToTargetMs: number | null;
  stallStartAt: number | null;
  stallEndAt: number | null;
  stallStartC: number | null;
  stallEndC: number | null;
  avgPitC: number | null;
}

export interface Item {
  id: number;
  sessionId: number;
  slot: ProbeSlot;
  food: Food | null;
  weightLb: number | null;
  targetC: number;
  startedAt: number;
  endedAt: number | null;
  endReason: ItemEndReason | null;
  /** The temperature it came off at (peak before the drop, or the last reading before unplug). */
  cameOffC: number | null;
  reachedTargetAt: number | null;
  /** Saved when the item ends. */
  stats: ItemStats | null;
}

export interface TargetChange {
  id: number;
  sessionId: number;
  itemId: number | null;
  ts: number;
  subject: TargetSubject;
  targetC: number;
  source: TargetSource;
}

export interface FireUp {
  id: number;
  sessionId: number | null;
  startedAt: number;
  minutes: number;
  thenHoldC: number | null;
  endedAt: number | null;
  outcome: FireUpOutcome | null;
}

export type CookEventType =
  | "sessionStarted"
  | "sessionEnded"
  | "pitTarget"
  | "itemStarted"
  | "itemUpdated"
  | "itemAtTarget"
  | "itemCameOff"
  | "itemEnded"
  | "looksDone"
  | "looksDoneCleared"
  | "keepGoing"
  | "fireUpStarted"
  | "fireUpFinished"
  | "foundRunning"
  | "foreignControl"
  | "selfStopped"
  | "deviceOffline"
  | "deviceOnline"
  | "recovery"
  | "commandResult"
  | "halted";

export interface CookEvent {
  /** 0 for events that aren't stored (command results). */
  id: number;
  ts: number;
  sessionId: number | null;
  type: CookEventType;
  data: Record<string, unknown>;
}

export type Estimate = { kind: "eta"; atMs: number } | { kind: "stalled" } | null;

export interface LiveProbe {
  slot: ProbeSlot;
  tempC: number | null;
  /** The active item, or the last one in this session if it came off (the "Came off at" card). */
  item: Item | null;
  /** Food set up for the next cook (only when no session is open). */
  setup: ProbeSetup | null;
  estimate: Estimate;
}

export interface LiveState {
  now: number;
  link: {
    state: DeviceLinkState;
    lastSeenMs: number | null;
    /** The server gave up on the device logic after repeated faults (protocol.md › Safety). */
    halted: boolean;
    /** Last time another client changed the cook. */
    foreignControlAt: number | null;
  };
  reading: Reading | null;
  cook: {
    /** Ember means the cook to be running (cook or Fire it up). */
    active: boolean;
    /** The target being held, or the one Start will use. */
    pitTargetC: number;
    status: PitStatus;
  };
  fireUp: {
    startedAt: number;
    endsAtMs: number;
    minutes: number;
    thenHoldC: number | null;
  } | null;
  session:
    | (Session & {
        /** Ember found this cook running and adopted it. */
        foundRunning: boolean;
        autoEndAt: number | null;
        pitTargets: TargetChange[];
      })
    | null;
  probes: LiveProbe[];
}

/** A short display name: the cut for catalog foods ("Brisket"), or the custom name. */
export function foodName(food: Food | null, slot?: ProbeSlot): string {
  if (!food) return slot ? `Probe ${slot}` : "Probe";
  if ("custom" in food) return food.custom;
  return food.path[1] ?? food.path[0] ?? "Food";
}

/** The food catalog: category › cut › optional sub-cut; leaves carry the default "pull at". */
export interface CatalogNode {
  name: string;
  /** Leaves only. */
  pullAtC?: number;
  children?: CatalogNode[];
}
