// Deliberately simple thermal models: enough to produce believable curves (heat-up, holding,
// a stall, a probe pulled out), not a kamado simulation. All °C and seconds.

/** How far above ambient the pit would settle with the fan at 100 % (pizza needs 371 °C). */
const MAX_RISE_C = 420;
/** Airflow through closed vents with the fan off, as a fraction of full fan. */
const LEAK = 0.04;
/** Pit time constant, for settling and cooling. */
const PIT_TAU_S = 600;
/** A fire only grows so fast: ~8 min from cold to 225 °F, ~30 min to 700 °F. */
const MAX_HEAT_C_PER_S = 0.2;
/** A probe pulled out of the meat and laid down falls to ambient with this time constant. */
const PROBE_AIR_TAU_S = 60;

export interface FoodModel {
  /** Starting temperature (fridge-cold by default). */
  startC: number;
  weightLb: number;
  /** Evaporative stall: the rise slows to cover `startC`→`endC` in `durS`. */
  stall?: { startC: number; endC: number; durS: number };
}

/** Food time constant scales with weight: a 14 lb brisket at 107 °C takes ~12 h with its stall. */
const foodTauS = (lb: number) => 1100 * Math.max(lb, 0.5);

export function pitEquilibriumC(ambientC: number, fanPct: number, fireLit: boolean): number {
  if (!fireLit) return ambientC;
  return ambientC + MAX_RISE_C * (LEAK + (1 - LEAK) * (fanPct / 100));
}

/** The fan duty that holds `targetC` at equilibrium (the firmware's feed-forward). */
export function holdingFanPct(ambientC: number, targetC: number): number {
  const frac = (targetC - ambientC) / MAX_RISE_C;
  return ((frac - LEAK) / (1 - LEAK)) * 100;
}

export function stepPit(pitC: number, eqC: number, dtS: number): number {
  const next = eqC + (pitC - eqC) * Math.exp(-dtS / PIT_TAU_S);
  return Math.min(next, pitC + MAX_HEAT_C_PER_S * dtS);
}

export function stepFood(tempC: number, pitC: number, food: FoodModel, dtS: number): number {
  const tau = foodTauS(food.weightLb);
  let rate = (pitC - tempC) / tau;
  const s = food.stall;
  if (s && rate > 0 && tempC >= s.startC && tempC < s.endC) {
    rate = Math.min(rate, (s.endC - s.startC) / s.durS);
  }
  return tempC + rate * dtS;
}

export function stepProbeInAir(tempC: number, ambientC: number, dtS: number): number {
  return ambientC + (tempC - ambientC) * Math.exp(-dtS / PROBE_AIR_TAU_S);
}
