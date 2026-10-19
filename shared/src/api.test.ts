import { describe, expect, it } from "vitest";
import { foodLabel } from "./api.ts";

// Every leaf of docs/food-catalog.json (the seed catalog).
const SEED = [
  "Beef › Brisket › Point",
  "Beef › Brisket › Flat",
  "Beef › Brisket › Whole packer",
  "Beef › Beef ribs › Plate ribs",
  "Beef › Beef ribs › Chuck ribs",
  "Beef › Chuck roast",
  "Beef › Tri-tip",
  "Beef › Prime rib",
  "Beef › Steak › Ribeye",
  "Beef › Steak › NY strip",
  "Beef › Steak › Filet",
  "Beef › Steak › Picanha",
  "Pork › Butt / shoulder",
  "Pork › Ribs › Spare ribs",
  "Pork › Ribs › St. Louis",
  "Pork › Ribs › Baby back",
  "Pork › Belly",
  "Pork › Loin",
  "Pork › Tenderloin",
  "Poultry › Chicken › Whole",
  "Poultry › Chicken › Thighs",
  "Poultry › Chicken › Breasts",
  "Poultry › Chicken › Wings",
  "Poultry › Turkey › Whole",
  "Poultry › Turkey › Breast",
  "Lamb › Shoulder",
  "Lamb › Leg",
  "Lamb › Rack",
  "Fish › Salmon",
  "Fish › Trout",
];

describe("foodLabel", () => {
  it("names catalog foods for cards and chips", () => {
    const names = Object.fromEntries(SEED.map((p) => [p, foodLabel({ path: p.split(" › ") })]));
    expect(names["Beef › Brisket › Point"]).toEqual({ name: "Brisket point", short: "Point" });
    expect(names["Beef › Brisket › Whole packer"]?.name).toBe("Brisket whole packer");
    expect(names["Beef › Beef ribs › Plate ribs"]?.name).toBe("Plate ribs");
    expect(names["Beef › Steak › NY strip"]?.name).toBe("Steak NY strip");
    expect(names["Pork › Ribs › Spare ribs"]?.name).toBe("Spare ribs");
    expect(names["Pork › Ribs › St. Louis"]?.name).toBe("St. Louis ribs");
    expect(names["Pork › Ribs › Baby back"]).toEqual({
      name: "Baby back ribs",
      short: "Baby back",
    });
    expect(names["Pork › Butt / shoulder"]).toEqual({
      name: "Butt / shoulder",
      short: "Butt / shoulder",
    });
    expect(names["Poultry › Chicken › Thighs"]?.name).toBe("Chicken thighs");
    for (const label of Object.values(names)) {
      expect(label.name.length).toBeGreaterThan(0);
      expect(label.name.length).toBeLessThanOrEqual(24);
    }
  });

  it("names custom foods and empty probes", () => {
    expect(foodLabel({ custom: "Goat shoulder" })).toEqual({
      name: "Goat shoulder",
      short: "Goat shoulder",
    });
    expect(foodLabel(null, 2)).toEqual({ name: "Probe 2", short: "Probe 2" });
  });
});
