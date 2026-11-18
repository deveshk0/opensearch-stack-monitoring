export const SAMPLE_INTERVAL = 10_000;
export const MAX_RANGE = 24 * 60 * 60 * 1000;
export const MONITORING_INDEX = "stack-monitoring-v1-*,stack-monitoring-v2-*";

export function counterDelta(
  current: number | undefined,
  previous: number | undefined,
  elapsedMs: number,
): number | null {
  if (
    current === undefined ||
    previous === undefined ||
    !Number.isFinite(current) ||
    !Number.isFinite(previous) ||
    current < previous ||
    elapsedMs <= 0 ||
    elapsedMs > SAMPLE_INTERVAL * 3
  )
    return null;
  return ((current - previous) * 1000) / elapsedMs;
}

export function operationLatency(
  currentTime: number,
  previousTime: number,
  currentCount: number,
  previousCount: number,
  elapsedMs: number,
): number | null {
  const time = counterDelta(currentTime, previousTime, elapsedMs);
  const count = counterDelta(currentCount, previousCount, elapsedMs);
  return time !== null && count !== null && count > 0 ? time / count : null;
}

export interface TimeRange {
  from: number;
  to: number;
  interval: number;
}
export function parseRange(
  from: string,
  to: string,
  now: number = Date.now(),
): TimeRange {
  const parse = (value: string) => {
    if (value === "now") return now;
    const relative = /^now-(\d+)([smhd])$/.exec(value);
    if (relative)
      return (
        now -
        Number(relative[1]) *
          ({ s: 1000, m: 60000, h: 3600000, d: 86400000 }[
            relative[2]
          ] as number)
      );
    return /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : NaN;
  };
  const start = parse(from),
    end = parse(to);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start ||
    end - start > MAX_RANGE
  )
    throw new RangeError("Choose a valid time range of up to 24 hours.");
  return {
    from: start,
    to: end,
    interval: Math.max(
      SAMPLE_INTERVAL,
      Math.ceil((end - start) / 359 / SAMPLE_INTERVAL) * SAMPLE_INTERVAL,
    ),
  };
}

export function historyQuery(range: TimeRange, type: string, id: string) {
  return {
    size: 0,
    query: {
      bool: {
        filter: [
          { range: { timestamp: { gte: range.from, lte: range.to } } },
          { term: { type } },
          { term: { entity_id: id } },
        ],
      },
    },
    aggs: {
      samples: {
        date_histogram: {
          field: "timestamp",
          fixed_interval: `${range.interval}ms`,
          min_doc_count: 0,
        },
        aggs: {
          sample: {
            top_hits: {
              size: 1,
              sort: [{ timestamp: "desc" }],
              _source: ["timestamp", "metrics", "name", "status"],
            },
          },
        },
      },
    },
  };
}

export function isInternalIndex(name: string): boolean {
  return name.startsWith(".") || name.startsWith("stack-monitoring-");
}
