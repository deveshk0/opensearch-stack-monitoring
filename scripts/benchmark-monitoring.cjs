// Synthetic processing check; not a substitute for a workload soak test.
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const { normalizeSnapshot } = require("../.cache/test-build/common/normalize");
const { writeSnapshot } = require("../.cache/test-build/server/writer");
const count = 1000,
  nodes = 100;
const raw = {
  timestamp: Date.now(),
  info: {
    cluster_uuid: "capacity-check",
    cluster_name: "Capacity check",
    version: { number: "3.9.0" },
  },
  health: {
    status: "green",
    number_of_nodes: nodes,
    active_primary_shards: count,
    active_shards: count * 2,
    unassigned_shards: 0,
  },
  cluster: {},
  nodeStats: {
    _nodes: { failed: 0 },
    nodes: Object.fromEntries(
      Array.from({ length: nodes }, (_, i) => [
        "node-" + i,
        {
          name: "node-" + i,
          jvm: {
            uptime_in_millis: 100000,
            mem: {
              heap_used_in_bytes: 512 * 1024 * 1024,
              heap_max_in_bytes: 1024 * 1024 * 1024,
            },
          },
          os: { cpu: { percent: 30 } },
          fs: { total: { total_in_bytes: 100000, available_in_bytes: 50000 } },
          indices: {
            indexing: { index_total: 100, index_time_in_millis: 100 },
            search: { query_total: 100, query_time_in_millis: 100 },
          },
        },
      ]),
    ),
  },
  nodeInfo: { nodes: {} },
  indexStats: {
    _shards: { failed: 0 },
    indices: Object.fromEntries(
      Array.from({ length: count }, (_, i) => [
        "index-" + i,
        {
          uuid: "uuid-" + i,
          primaries: {
            docs: { count: 1000 },
            store: { size_in_bytes: 10000000 },
            indexing: { index_total: 1000, index_time_in_millis: 1000 },
            search: { query_total: 1000, query_time_in_millis: 1000 },
          },
          total: { docs: { count: 2000 }, store: { size_in_bytes: 20000000 } },
        },
      ]),
    ),
  },
  shards: Array.from({ length: count * 2 }, (_, i) => ({
    index: "index-" + Math.floor(i / 2),
    shard: "0",
    prirep: i % 2 ? "r" : "p",
    state: "STARTED",
    node: "node-" + (i % nodes),
  })),
  recovery: [],
  dashboards: null,
  instance: {
    id: "capacity-host",
    name: "Capacity host",
    version: "3.9.0",
    address: "",
  },
  errors: [],
};
(async () => {
  const times = [];
  let previous,
    requests = 0,
    bytes = 0;
  for (let i = 0; i < 20; i++) {
    raw.timestamp += 10000;
    const started = performance.now();
    const snapshot = normalizeSnapshot(raw, previous);
    assert.equal(snapshot.nodes.length, nodes);
    assert.equal(snapshot.indices.length, count);
    assert.equal(snapshot.cluster.metrics.heap_used, nodes * 512 * 1024 * 1024);
    assert.equal(snapshot.cluster.metrics.heap_max, nodes * 1024 * 1024 * 1024);
    await writeSnapshot(
      {
        bulk: async (r) => {
          assert.ok(r.body.length <= 1000);
          requests++;
          bytes += Buffer.byteLength(JSON.stringify(r.body));
          return { body: { errors: false } };
        },
      },
      snapshot,
    );
    previous = snapshot;
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  console.log(
    JSON.stringify(
      {
        profile: { nodes, indices: count, shards: raw.shards.length },
        samples: times.length,
        p95_ms: Math.round(times[18]),
        max_ms: Math.round(times[19]),
        bulk_requests_per_sample: requests / 20,
        encoded_bytes_per_sample: Math.round(bytes / 20),
        heap_used_mib: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      },
      null,
      2,
    ),
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
