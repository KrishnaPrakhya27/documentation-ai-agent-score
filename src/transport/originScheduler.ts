/**
 * Spaces requests to one origin: request starts are at least `intervalMs`
 * apart and at most `maxConcurrent` run at once. Each origin has its own
 * queue, so a slow host never delays requests to another.
 */

interface OriginState {
  active: number;
  nextStartAt: number;
  intervalMs: number;
  waiting: Array<() => void>;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export class OriginScheduler {
  private readonly origins = new Map<string, OriginState>();

  constructor(
    private readonly defaultIntervalMs: number,
    private readonly maxConcurrent: number,
  ) {}

  /** Raises one origin's spacing, e.g. for its robots.txt Crawl-delay. */
  slowDown(origin: string, intervalMs: number): void {
    const state = this.stateFor(origin);
    state.intervalMs = Math.max(state.intervalMs, intervalMs);
  }

  /** Holds back the next start to one origin, e.g. after a Retry-After. */
  pause(origin: string, ms: number): void {
    const state = this.stateFor(origin);
    state.nextStartAt = Math.max(state.nextStartAt, Date.now() + ms);
  }

  async run<T>(origin: string, task: () => Promise<T>): Promise<T> {
    const state = this.stateFor(origin);
    while (state.active >= this.maxConcurrent) {
      await new Promise<void>((resolve) => state.waiting.push(resolve));
    }
    state.active++;
    try {
      const startAt = Math.max(Date.now(), state.nextStartAt);
      state.nextStartAt = startAt + state.intervalMs;
      const wait = startAt - Date.now();
      if (wait > 0) await sleep(wait);
      return await task();
    } finally {
      state.active--;
      state.waiting.shift()?.();
    }
  }

  private stateFor(origin: string): OriginState {
    let state = this.origins.get(origin);
    if (!state) {
      state = {
        active: 0,
        nextStartAt: 0,
        intervalMs: this.defaultIntervalMs,
        waiting: [],
      };
      this.origins.set(origin, state);
    }
    return state;
  }
}
