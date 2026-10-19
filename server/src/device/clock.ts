// All device timing (offline threshold, recovery wait, sce, Fire it up) reads one Clock, so the
// simulator and the server can share a manual clock in tests or a sped-up one for playback.

export interface Clock {
  /** Unix ms. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Time only moves when a test calls `advance`. `sleep` advances it and resolves at once. */
export class ManualClock implements Clock {
  constructor(private t: number) {}

  now(): number {
    return this.t;
  }

  advance(ms: number): void {
    this.t += ms;
  }

  async sleep(ms: number): Promise<void> {
    this.t += ms;
  }
}

/** Runs `speed` times faster than real time, starting from the real time it was created. */
export class ScaledClock implements Clock {
  private readonly realStart = Date.now();

  constructor(
    readonly speed: number,
    private readonly start: number = Date.now(),
  ) {
    if (!(speed > 0)) throw new Error("speed must be > 0");
  }

  now(): number {
    return this.start + Math.round((Date.now() - this.realStart) * this.speed);
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms / this.speed));
  }
}

export const toUnixS = (ms: number): number => Math.floor(ms / 1000);
