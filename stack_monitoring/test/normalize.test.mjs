import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSnapshot } from "../../.cache/test-build/common/normalize.js";
const raw = () => ({
  timestamp: 10000,
  info: {
    cluster_uuid: "cluster-a",
    cluster_name: "demo",
    version: { number: "3.9.0" },
  },
  health: {
    status: "green",
    number_of_nodes: 1,
    active_shards: 4,
    unassigned_shards: 0,
  },
  cluster: { indices: { count: 2 } },
  nodeInfo: { nodes: { n1: { version: "3.9.0" } } },
  nodeStats: {
    nodes: {
      n1: {
        name: "node-one",
        roles: ["data"],
        jvm: {
          uptime_in_millis: 60000,
          mem: { heap_used_in_bytes: 100, heap_max_in_bytes: 200 },
        },
        indices: {
          search: { query_total: 10, query_time_in_millis: 100 },
          indexing: { index_total: 20, index_time_in_millis: 50 },
        },
      },
    },
  },
  indexStats: {
    indices: {
      orders: {
        uuid: "orders-uuid",
        primaries: {
          docs: { count: 10 },
          store: { size_in_bytes: 100 },
          search: { query_total: 10, query_time_in_millis: 100 },
          indexing: { index_total: 20, index_time_in_millis: 50 },
        },
        total: {
          docs: { count: 20 },
          store: { size_in_bytes: 200 },
          search: { query_total: 20, query_time_in_millis: 200 },
          indexing: { index_total: 40, index_time_in_millis: 100 },
        },
      },
      "stack-monitoring-v1-today": {
        primaries: { docs: { count: 100 } },
        total: { docs: { count: 200 } },
      },
    },
  },
  shards: [
    {
      index: "orders",
      shard: "0",
      prirep: "p",
      state: "STARTED",
      node: "node-one",
    },
  ],
  recovery: [],
  dashboards: null,
  instance: {
    id: "instance-one",
    name: "dashboards",
    version: "3.9.0",
    address: "localhost:5602",
  },
  errors: [],
});
test("cluster user-document totals exclude replicas and monitoring indices", () => {
  const s = normalizeSnapshot(raw());
  assert.equal(s.cluster.metrics.docs, 10);
  assert.equal(s.cluster.metrics.store, 200);
  assert.equal(s.cluster.metrics.indices, 1);
  assert.equal(s.indices.length, 2);
});
test("missing node measurements stay null rather than claiming zero CPU or disk", () => {
  const s = normalizeSnapshot(raw());
  assert.equal(s.nodes[0]?.metrics.cpu_percent, null);
  assert.equal(s.nodes[0]?.metrics.disk_available, null);
  assert.equal(s.nodes[0]?.metrics.heap_percent, 50);
});
test("node restarts suppress rates even when counters happen to exceed the prior sample", () => {
  const a = raw(),
    before = normalizeSnapshot(a);
  const b = raw();
  b.timestamp = 20000;
  b.nodeStats.nodes.n1.jvm.uptime_in_millis = 1000;
  b.nodeStats.nodes.n1.indices.search.query_total = 30;
  assert.equal(
    normalizeSnapshot(b, before).nodes[0]?.metrics.search_rate,
    null,
  );
});
test("entity rates use successive samples and primary indexing stays separate", () => {
  const a = raw(),
    before = normalizeSnapshot(a);
  const b = raw();
  b.timestamp = 20000;
  b.nodeStats.nodes.n1.jvm.uptime_in_millis = 70000;
  b.nodeStats.nodes.n1.indices.search.query_total = 30;
  b.indexStats.indices.orders.primaries.indexing.index_total = 40;
  b.indexStats.indices.orders.total.indexing.index_total = 80;
  const s = normalizeSnapshot(b, before);
  assert.equal(s.nodes[0]?.metrics.search_rate, 2);
  assert.equal(s.indices[0]?.metrics.index_primary_rate, 2);
  assert.equal(s.indices[0]?.metrics.index_rate, 4);
});
test("partial failures are preserved and stale instance metrics are not relabeled fresh", () => {
  const a = raw();
  a.errors = ["nodeStats unavailable"];
  a.nodeStats = null;
  a.dashboards = {
    collected_at: "1970-01-01T00:00:00Z",
    process: { uptime_in_millis: 1000 },
  };
  a.timestamp = 60000;
  const s = normalizeSnapshot(a);
  assert.deepEqual(s.errors, ["nodeStats unavailable"]);
  assert.equal(s.nodes.length, 0);
  assert.equal(s.instances[0]?.status, "stale");
});
test("shard relocation and changed cluster index membership suppress aggregate rates", () => {
  const a = raw(),
    before = normalizeSnapshot(a),
    b = raw();
  b.timestamp = 20000;
  b.shards[0].node = "node-two";
  b.indexStats.indices.orders.total.indexing.index_total = 80;
  assert.equal(
    normalizeSnapshot(b, before).indices[0].metrics.index_rate,
    null,
  );
  const c = raw();
  c.timestamp = 20000;
  c.indexStats.indices.new_orders = structuredClone(
    c.indexStats.indices.orders,
  );
  assert.equal(normalizeSnapshot(c, before).cluster.metrics.index_rate, null);
});
test("pipeline and processor contributor changes and node restarts produce rate gaps", () => {
  const sample = (timestamp, counts) => {
    const value = raw();
    value.timestamp = timestamp;
    value.nodeStats.nodes = {};
    for (const [id, count, uptime] of counts)
      value.nodeStats.nodes[id] = {
        name: id,
        jvm: { uptime_in_millis: uptime },
        ingest: {
          pipelines: {
            demo: {
              count,
              time_in_millis: count * 2,
              failed: 0,
              current: 0,
              processors: [
                {
                  set: {
                    stats: {
                      count,
                      time_in_millis: count,
                      failed: 0,
                      current: 0,
                    },
                  },
                },
              ],
            },
          },
        },
      };
    return value;
  };
  const first = normalizeSnapshot(
    sample(10000, [
      ["n1", 100, 60000],
      ["n2", 100, 60000],
    ]),
  );
  const missing = normalizeSnapshot(sample(20000, [["n1", 110, 70000]]), first);
  const returned = normalizeSnapshot(
    sample(30000, [
      ["n1", 120, 80000],
      ["n2", 120, 80000],
    ]),
    missing,
  );
  const restarted = normalizeSnapshot(
    sample(20000, [
      ["n1", 110, 1000],
      ["n2", 120, 70000],
    ]),
    first,
  );
  for (const value of [missing, returned, restarted]) {
    assert.equal(value.pipelines[0].metrics.ingest_rate, null);
    assert.equal(value.pipelines[0].processors[0].metrics.ingest_rate, null);
  }
  const stable = normalizeSnapshot(
    sample(20000, [
      ["n1", 110, 70000],
      ["n2", 110, 70000],
    ]),
    first,
  );
  assert.equal(stable.pipelines[0].metrics.ingest_rate, 2);
  assert.equal(stable.pipelines[0].processors[0].metrics.ingest_rate, 2);
});
test("user-index shard totals use the same scope as documents and storage", () => {
  const value = raw();
  value.shards.push(
    {
      index: "orders",
      shard: "0",
      prirep: "r",
      state: "STARTED",
      node: "node-two",
    },
    {
      index: "stack-monitoring-v1-today",
      shard: "0",
      prirep: "p",
      state: "STARTED",
      node: "node-one",
    },
    {
      index: "stack-monitoring-v1-today",
      shard: "0",
      prirep: "r",
      state: "STARTED",
      node: "node-two",
    },
  );
  const snapshot = normalizeSnapshot(value);
  assert.equal(snapshot.cluster.metrics.user_primary_shards, 1);
  assert.equal(snapshot.cluster.metrics.user_replica_shards, 1);
  value.shards = null;
  assert.equal(
    normalizeSnapshot(value).cluster.metrics.user_primary_shards,
    null,
  );
});

test("all entities remain available for alerting and complete cluster totals", () => {
  const value = raw();
  value.nodeStats.nodes = Object.fromEntries(
    Array.from({ length: 101 }, (_, i) => [
      "n" + i,
      {
        name: "n" + i,
        jvm: { mem: { heap_used_in_bytes: 1, heap_max_in_bytes: 2 } },
        fs: { total: { available_in_bytes: 3, total_in_bytes: 4 } },
      },
    ]),
  );
  value.indexStats.indices = Object.fromEntries(
    Array.from({ length: 1001 }, (_, i) => [
      "i" + i,
      {
        uuid: "i" + i,
        primaries: { docs: { count: 1 } },
        total: { store: { size_in_bytes: 2 } },
      },
    ]),
  );
  const result = normalizeSnapshot(value);
  assert.equal(result.nodes.length, 101);
  assert.equal(result.indices.length, 1001);
  assert.equal(result.cluster.metrics.heap_used, 101);
  assert.equal(result.cluster.metrics.heap_max, 202);
  assert.equal(result.cluster.metrics.disk_available, 303);
  assert.equal(result.cluster.metrics.disk_total, 404);
  assert.equal(result.cluster.metrics.indices, 1001);
  assert.equal(result.cluster.metrics.docs, 1001);
  assert.equal(result.cluster.metrics.store, 2002);
  assert.equal(result.source_validity?.nodeStats, true);
  assert.equal(result.source_validity.indexStats, true);
});

test("partial shard statistics cannot produce understated totals or recovery spikes", () => {
  const first = normalizeSnapshot(raw());
  const partial = raw();
  partial.timestamp = 20000;
  partial.indexStats._shards = { total: 2, successful: 1, failed: 1 };
  partial.indexStats.indices.orders.total.indexing.index_total = 20;
  partial.errors = ["indexStats: some nodes or shards did not respond."];
  const missing = normalizeSnapshot(partial, first);
  assert.equal(missing.indices[0].metrics.docs, null);
  assert.equal(missing.cluster.metrics.docs, null);
  assert.equal(missing.indices[0].counters.index_count, null);
  assert.equal(missing.source_validity.indexStats, false);
  const recovered = raw();
  recovered.timestamp = 30000;
  recovered.indexStats.indices.orders.total.indexing.index_total = 80;
  assert.equal(
    normalizeSnapshot(recovered, missing).indices[0].metrics.index_rate,
    null,
  );
});

test("partial node responses keep available node gauges but do not claim cluster totals", () => {
  const value = raw();
  value.nodeStats._nodes = { total: 2, successful: 1, failed: 1 };
  const result = normalizeSnapshot(value);
  assert.equal(result.nodes[0].metrics.heap_used, 100);
  assert.equal(result.cluster.metrics.heap_used, null);
  assert.equal(result.cluster.metrics.disk_total, null);
  assert.equal(result.source_validity?.nodeStats, false);
});

test("unrelated source failures preserve usable measurements for insight rules", () => {
  const value = raw();
  value.nodeInfo = null;
  value.recovery = null;
  value.errors = ["nodeInfo: unavailable.", "recovery: unavailable."];
  const result = normalizeSnapshot(value);
  assert.equal(result.source_validity?.nodeStats, true);
  assert.equal(result.source_validity?.health, true);
  assert.equal(result.nodes[0].metrics.heap_percent, 50);
});

test("initializing shards cannot report a green index", () => {
  const value = raw();
  value.shards[0].state = "INITIALIZING";
  assert.equal(normalizeSnapshot(value).indices[0].status, "red");
  value.shards[0].state = "STARTED";
  value.shards.push({ ...value.shards[0], prirep: "r", state: "INITIALIZING" });
  assert.equal(normalizeSnapshot(value).indices[0].status, "yellow");
  value.shards = [];
  assert.equal(normalizeSnapshot(value).indices[0].status, "unknown");
});

test("processor storage identity cannot collide with a pipeline of the same name", () => {
  const value = raw();
  const stats = { count: 1, failed: 0, current: 0, time_in_millis: 1 };
  value.nodeStats.nodes.n1.ingest = {
    pipelines: {
      foo: { ...stats, processors: [{ set: { stats } }] },
      "foo/0/set": { ...stats, processors: [] },
    },
  };
  const result = normalizeSnapshot(value);
  const pipeline = result.pipelines.find((p) => p.id === "foo/0/set");
  const processor = result.pipelines.find((p) => p.id === "foo").processors[0];
  assert.equal(processor.id, "foo/0/set");
  assert.notEqual(processor.type, pipeline.type);
  assert.equal(processor.type, "processor");
});

test("partial ingest statistics remain unknown until a new complete baseline", () => {
  const sample = (timestamp, count, failedNodes = 0) => {
    const value = raw();
    value.timestamp = timestamp;
    value.nodeStats._nodes = {
      total: 2,
      successful: 2 - failedNodes,
      failed: failedNodes,
    };
    const stats = { count, time_in_millis: count, failed: count, current: 1 };
    value.nodeStats.nodes.n1.ingest = {
      pipelines: {
        demo: { ...stats, processors: [{ set: { stats } }] },
      },
    };
    return value;
  };
  const first = normalizeSnapshot(sample(10000, 100));
  const partial = normalizeSnapshot(sample(20000, 110, 1), first);
  for (const e of [partial.pipelines[0], partial.pipelines[0].processors[0]]) {
    assert.equal(e.metrics.current, null);
    assert.equal(e.counters.ingest_count, null);
    assert.equal(e.metrics.ingest_rate, null);
  }
  const recovered = normalizeSnapshot(sample(30000, 120), partial);
  assert.equal(recovered.pipelines[0].metrics.ingest_rate, null);
  assert.equal(recovered.pipelines[0].processors[0].metrics.ingest_rate, null);
});

test("different cluster identities never share a rate baseline", () => {
  const first = normalizeSnapshot(raw());
  const next = raw();
  next.timestamp = 20000;
  next.info.cluster_uuid = "cluster-b";
  next.nodeStats.nodes.n1.indices.search.query_total = 30;
  next.indexStats.indices.orders.total.indexing.index_total = 80;
  const result = normalizeSnapshot(next, first);
  assert.equal(result.nodes[0].metrics.search_rate, null);
  assert.equal(result.indices[0].metrics.index_rate, null);
  assert.equal(result.cluster.metrics.index_rate, null);
});

test("all pipelines remain available while shard and recovery display limits are explicit", () => {
  const value = raw();
  const stats = { count: 1, time_in_millis: 1, failed: 0, current: 0 };
  value.nodeStats.nodes.n1.ingest = {
    pipelines: Object.fromEntries(
      Array.from({ length: 501 }, (_, i) => ["p" + i, stats]),
    ),
  };
  value.shards = Array.from({ length: 5001 }, (_, i) => ({
    index: "orders",
    shard: String(i),
    prirep: "p",
    state: "STARTED",
    node: "node-one",
  }));
  value.recovery = Array.from({ length: 501 }, () => ({ index: "orders" }));
  const result = normalizeSnapshot(value);
  assert.equal(result.pipelines.length, 501);
  for (const limit of ["shard", "recover"])
    assert.ok(
      result.errors.some((error) => error.includes(limit)),
      limit,
    );
  assert.equal(result.source_validity.nodeStats, true);
});
