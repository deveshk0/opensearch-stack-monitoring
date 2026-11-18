import test from "node:test";
import assert from "node:assert/strict";
import {
  counterDelta,
  operationLatency,
  parseRange,
  historyQuery,
  isInternalIndex,
} from "../../.cache/test-build/common/metrics.js";

test("counter rate uses elapsed seconds, not lifetime totals", () => {
  assert.equal(counterDelta(120, 100, 10000), 2);
  assert.equal(counterDelta(120, 100, 20000), 1);
});
test("no activity is zero throughput but not zero operation latency", () => {
  assert.equal(counterDelta(100, 100, 10000), 0);
  assert.equal(operationLatency(20, 20, 10, 10, 10000), null);
});
test("first sample, reset, nonfinite values, and a long gap are unavailable", () => {
  for (const [a, b, t] of [
    [10, undefined, 10000],
    [9, 10, 10000],
    [Infinity, 10, 10000],
    [10, 8, 0],
    [10, 8, 31000],
  ]) {
    assert.equal(counterDelta(a, b, t), null);
  }
});
test("latency is operation time delta divided by completed operations", () => {
  assert.equal(operationLatency(140, 100, 20, 10, 10000), 4);
  assert.equal(operationLatency(40, 100, 20, 10, 10000), null);
});
test("relative windows resolve once and cap graph resolution at 360 buckets", () => {
  assert.deepEqual(parseRange("now-15m", "now", 2000000), {
    from: 1100000,
    to: 2000000,
    interval: 10000,
  });
  const range = parseRange("now-24h", "now", 100000000);
  assert.equal(range.from, 13600000);
  assert.ok(Math.ceil((range.to - range.from) / range.interval) <= 360);
});
test("absolute windows are preserved and reject malformed, reversed, or excessive ranges", () => {
  assert.deepEqual(parseRange("2026-11-17T10:00:00Z", "2026-11-17T11:00:00Z"), {
    from: 1794909600000,
    to: 1794913200000,
    interval: 20000,
  });
  for (const [a, b] of [
    ["bad", "now"],
    ["now", "now-1h"],
    ["now-48h", "now"],
    ["now-0m", "now"],
  ]) {
    assert.throws(() => parseRange(a, b, 200000000));
  }
});
test("history query bounds time and selects only the requested entity", () => {
  const q = historyQuery(
    { from: 10000, to: 20000, interval: 10000 },
    "node",
    "node-a",
  );
  assert.equal(q.size, 0);
  assert.deepEqual(q.query.bool.filter, [
    { range: { timestamp: { gte: 10000, lte: 20000 } } },
    { term: { type: "node" } },
    { term: { entity_id: "node-a" } },
  ]);
  assert.equal(q.aggs.samples.date_histogram.fixed_interval, "10000ms");
  assert.equal(q.aggs.samples.aggs.sample.top_hits.size, 1);
});
test("monitoring and system indices are excluded from normal user-index views", () => {
  assert.equal(isInternalIndex(".kibana_1"), true);
  assert.equal(isInternalIndex("stack-monitoring-v1-2026.11.17"), true);
  assert.equal(isInternalIndex("orders"), false);
});
