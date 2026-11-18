import test from "node:test";
import assert from "node:assert/strict";
import { Collector } from "../../.cache/test-build/server/collector.js";
const raw = () => ({
  timestamp: 10000,
  info: { cluster_uuid: "a", cluster_name: "demo" },
  health: { status: "green" },
  cluster: {},
  nodeStats: { nodes: {} },
  nodeInfo: {},
  indexStats: { indices: {} },
  shards: [],
  recovery: [],
  dashboards: null,
  instance: { id: "a", name: "dashboards", version: "3.9.0", address: "" },
  errors: [],
});
test("collection persists snapshots and records success only after the write", async () => {
  let writes = 0;
  const c = new Collector(
    async () => raw(),
    async (s) => {
      assert.equal(s.cluster_uuid, "a");
      writes++;
    },
  );
  await c.runOnce();
  assert.equal(writes, 1);
  assert.equal(c.state.last_success, 10000);
  await c.stop();
});
test("overlapping collection never issues a second read", async () => {
  let release;
  let reads = 0;
  const pending = new Promise((r) => (release = r));
  const c = new Collector(
    async () => {
      reads++;
      await pending;
      return raw();
    },
    async () => {},
  );
  const first = c.runOnce();
  await c.runOnce();
  release();
  await first;
  assert.equal(reads, 1);
  await c.stop();
});
test("a failed write leaves the last success unchanged and exposes a sanitized error", async () => {
  let fail = false;
  const c = new Collector(
    async () => raw(),
    async () => {
      if (fail) throw new Error("secret password");
    },
  );
  await c.runOnce();
  fail = true;
  await c.runOnce();
  assert.equal(c.state.last_success, 10000);
  assert.equal(
    c.state.last_error,
    "Monitoring collection failed. Check the collector permissions and server logs.",
  );
  await c.stop();
});
test("stopping while a read is pending prevents a late write", async () => {
  let release;
  const pending = new Promise((r) => (release = r));
  let writes = 0;
  const c = new Collector(
    async () => {
      await pending;
      return raw();
    },
    async () => writes++,
  );
  const task = c.runOnce();
  const stop = c.stop();
  release();
  await task;
  await stop;
  assert.equal(writes, 0);
  assert.equal(c.state.collecting, false);
});
test("disabling cancels an in-flight read and re-enabling resumes collection", async () => {
  let release;
  let writes = 0;
  let blocked = true;
  const wait = new Promise((r) => (release = r));
  const c = new Collector(
    async () => {
      if (blocked) await wait;
      return raw();
    },
    async () => {
      writes++;
    },
  );
  const running = c.runOnce();
  const disabling = c.setEnabled(false);
  release();
  await disabling;
  await running;
  await c.runOnce();
  assert.equal(writes, 0);
  assert.equal(c.state.enabled, false);
  blocked = false;
  await c.setEnabled(true);
  assert.equal(writes, 1);
  assert.equal(c.state.enabled, true);
  await c.stop();
});
test("disabling waits for an already-started write before reporting success", async () => {
  let release;
  let started;
  const begun = new Promise((r) => (started = r)),
    wait = new Promise((r) => (release = r));
  const c = new Collector(
    async () => raw(),
    async () => {
      started();
      await wait;
    },
  );
  const running = c.runOnce();
  await begun;
  let done = false;
  const disabling = c.setEnabled(false).then(() => {
    done = true;
  });
  await Promise.resolve();
  assert.equal(done, false);
  release();
  await running;
  await disabling;
  assert.equal(done, true);
  await c.stop();
});
test("settings failure retries on subsequent ticks even when disabled", async () => {
  let attempts = 0,
    writes = 0;
  const c = new Collector(
    async () => raw(),
    async () => writes++,
    undefined,
    async () => {
      if (++attempts === 1) throw Error("outage");
      return true;
    },
  );
  c.state.enabled = false;
  await c.runOnce();
  assert.equal(writes, 0);
  await c.runOnce();
  assert.equal(writes, 1);
  assert.equal(c.state.last_error, null);
});
test("insight failures do not invalidate successful metric writes", async () => {
  const c = new Collector(
    async () => raw(),
    async () => {},
    undefined,
    undefined,
    async () => {
      throw Error("secret");
    },
  );
  await c.runOnce();
  assert.equal(c.state.last_success, 10000);
  assert.equal(c.state.last_error, null);
  assert.match(c.state.insights_error, /Insight/);
  assert.ok(!c.state.insights_error.includes("secret"));
});
test("disabling while settings are in flight cannot be overwritten by stale settings", async () => {
  let release,
    writes = 0;
  const wait = new Promise((r) => (release = r));
  const c = new Collector(
    async () => raw(),
    async () => writes++,
    undefined,
    async () => {
      await wait;
      return true;
    },
  );
  const run = c.runOnce();
  const disable = c.setEnabled(false);
  release();
  await Promise.all([run, disable]);
  assert.equal(c.state.enabled, false);
  assert.equal(writes, 0);
});
