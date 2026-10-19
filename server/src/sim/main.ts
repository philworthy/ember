// Standalone simulator: `npm run sim -- --scenario brisket --speed 60 --port 8081 [--start]`.
// Point the CLI at it with `IKAMAND_HOST=127.0.0.1:8081 npm run device -- watch`.
// At speed > 1 the device clock runs fast too, so a real-time client sees it skew.

import { parseArgs } from "node:util";
import { ScaledClock, toUnixS } from "../device/clock.ts";
import { grillStartB, startCook } from "../device/protocol.ts";
import { SimDevice } from "./device.ts";
import { getScenario, scenarios } from "./scenarios.ts";
import { startSimServer } from "./wire.ts";

const { values } = parseArgs({
  options: {
    scenario: { type: "string", default: process.env.SIM_SCENARIO ?? "brisket" },
    speed: { type: "string", default: process.env.SIM_SPEED ?? "1" },
    port: { type: "string", default: process.env.SIM_PORT ?? "8081" },
    seed: { type: "string", default: "1" },
    start: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(`npm run sim -- [--scenario <name>] [--speed <x>] [--port <n>] [--seed <n>] [--start]

  --start   start the scenario's suggested cook, as if someone pressed the button

Scenarios:`);
  for (const s of Object.values(scenarios)) console.log(`  ${s.name.padEnd(15)} ${s.description}`);
  process.exit(0);
}

const scenario = getScenario(values.scenario);
const clock = new ScaledClock(Number(values.speed));
const sim = new SimDevice(clock, { seed: Number(values.seed) });
scenario.setup(sim, clock.now());

if (values.start) {
  const now = toUnixS(clock.now());
  const cook = scenario.cook;
  sim.foreignCommand("pitC" in cook ? startCook(cook.pitC, now) : grillStartB(cook.fireUpMin, now));
}

const server = await startSimServer(sim, { port: Number(values.port) });
console.log(
  `iKamand simulator "${scenario.name}" at ${values.speed}x on ${server.host}: ${scenario.description}`,
);

// Keep physics and the timeline moving even when nobody polls.
setInterval(() => sim.advance(), 1000).unref();
process.on("SIGINT", async () => {
  await server.close();
  process.exit(0);
});
