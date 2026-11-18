import type { RawSnapshot, Snapshot } from "../common/types";
import { normalizeSnapshot } from "../common/normalize";
import { SAMPLE_INTERVAL } from "../common/metrics";

export class Collector {
  state = {
    enabled: true,
    last_success: null as number | null,
    last_error: null as string | null,
    collecting: false,
    insights_error: null as string | null,
  };
  private previous?: Snapshot;
  private pending?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private version = 0;
  constructor(
    private read: () => Promise<RawSnapshot>,
    private write: (snapshot: Snapshot) => Promise<void>,
    private onError?: (error: unknown) => void,
    private beforeCollect?: () => Promise<boolean>,
    private afterWrite?: (snapshot: Snapshot) => Promise<void>,
  ) {}
  async runOnce(): Promise<void> {
    if (this.state.collecting || this.stopped) return;
    this.state.collecting = true;
    const version = this.version;
    this.pending = (async () => {
      try {
        if (this.beforeCollect) {
          const enabled = await this.beforeCollect();
          if (version !== this.version || this.stopped) return;
          if (enabled !== this.state.enabled) this.previous = undefined;
          this.state.enabled = enabled;
          this.state.last_error = null;
        }
        if (!this.state.enabled || this.stopped) return;
        const raw = await this.read();
        if (this.stopped || !this.state.enabled) return;
        const snapshot = normalizeSnapshot(raw, this.previous);
        await this.write(snapshot);
        this.previous = snapshot;
        this.state.last_success = snapshot.timestamp;
        this.state.last_error = snapshot.errors.length
          ? "Some monitoring sources are unavailable. See collection details."
          : null;
        try {
          await this.afterWrite?.(snapshot);
          this.state.insights_error = null;
        } catch (error) {
          this.onError?.(error);
          this.state.insights_error =
            "Insight evaluation failed. Metrics collection is still running; check server logs.";
        }
      } catch (error) {
        this.onError?.(error);
        this.state.last_error =
          "Monitoring collection failed. Check the collector permissions and server logs.";
      } finally {
        this.state.collecting = false;
      }
    })();
    await this.pending;
  }
  async setEnabled(enabled: boolean) {
    this.version++;
    this.state.enabled = enabled;
    await this.pending;
    this.previous = undefined;
    this.state.last_error = null;
    if (enabled) await this.runOnce();
  }
  start(immediate = true) {
    const tick = async () => {
      await this.runOnce();
      if (!this.stopped) this.timer = setTimeout(tick, SAMPLE_INTERVAL);
    };
    if (immediate) void tick();
    else this.timer = setTimeout(tick, SAMPLE_INTERVAL);
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.pending;
  }
}
