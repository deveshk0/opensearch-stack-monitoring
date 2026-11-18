import test from "node:test";
import assert from "node:assert/strict";
import { readHistory } from "../../.cache/test-build/server/history.js";
const query = {
  from: "2026-11-17T10:00:00Z",
  to: "2026-11-17T10:15:00Z",
  type: "node",
  id: "node-a",
};
test("missing or invalid cluster identity fails before searching history", async () => {
  for (const cluster_uuid of [undefined, null, 123, "", " ", "_na_"]) {
    const requests = [];
    const client = {
      transport: {
        request: async (request) => {
          requests.push(request);
          return { body: request.path === "/" ? { cluster_uuid } : {} };
        },
      },
    };
    await assert.rejects(readHistory(client, query), /identity/i);
    assert.equal(requests.length, 2);
  }
});
test("a forbidden cluster check prevents every history read", async () => {
  let calls = 0;
  const client = {
    transport: {
      request: async () => {
        calls++;
        throw Object.assign(new Error("denied"), { statusCode: 403 });
      },
    },
  };
  await assert.rejects(readHistory(client, query), { statusCode: 403 });
  assert.equal(calls, 1);
});
test("history uses the supplied user client and restricts both queries to the selected time window and cluster", async () => {
  const requests = [];
  const client = {
    transport: {
      request: async (r) => {
        requests.push(r);
        if (r.path === "/_cluster/health") return { body: { status: "green" } };
        if (r.path === "/") return { body: { cluster_uuid: "cluster-a" } };
        if (r.body?.size === 1)
          return {
            body: {
              hits: {
                hits: [
                  {
                    _source: {
                      payload: { schema: 1, timestamp: 1794909600000 },
                    },
                  },
                ],
              },
            },
          };
        return {
          body: {
            aggregations: {
              samples: {
                buckets: [
                  {
                    key: 1794909600000,
                    sample: {
                      hits: {
                        hits: [
                          {
                            _source: {
                              timestamp: 1794909600000,
                              metrics: { cpu_percent: 12 },
                            },
                          },
                        ],
                      },
                    },
                  },
                ],
              },
            },
          },
        };
      },
    },
  };
  const result = await readHistory(client, query);
  assert.equal(result.snapshot?.timestamp, 1794909600000);
  assert.equal(result.series[0]?.metrics.cpu_percent, 12);
  const searches = requests.filter((r) => r.path.includes("_search"));
  assert.equal(searches.length, 2);
  for (const request of searches) {
    assert.ok(
      request.body.query.bool.filter.some(
        (f) => f.range?.timestamp.gte === 1794909600000,
      ),
    );
    assert.ok(
      request.body.query.bool.filter.some(
        (f) => f.term?.cluster_uuid === "cluster-a",
      ),
    );
  }
});
test("invalid windows fail before contacting OpenSearch", async () => {
  let calls = 0;
  const client = {
    transport: {
      request: async () => {
        calls++;
        return { body: {} };
      },
    },
  };
  await assert.rejects(
    readHistory(client, { ...query, from: "now-48h", to: "now" }),
  );
  assert.equal(calls, 0);
});
test("timed-out or failed-shard history responses are not reported as empty success", async () => {
  for (const partial of [{ timed_out: true }, { _shards: { failed: 1 } }])
    for (const failingSize of [0, 1]) {
      const client = {
        transport: {
          request: async (r) => {
            if (r.path === "/_cluster/health")
              return { body: { status: "green" } };
            if (r.path === "/") return { body: { cluster_uuid: "cluster-a" } };
            return {
              body:
                r.body.size === failingSize
                  ? partial
                  : {
                      hits: { hits: [] },
                      aggregations: { samples: { buckets: [] } },
                    },
            };
          },
        },
      };
      await assert.rejects(readHistory(client, query), /incomplete/);
    }
});

const processorId = "pipeline/0/set";
const bucket = (key, source) => ({
  key,
  sample: { hits: { hits: source ? [{ _source: source }] : [] } },
});
const legacySnapshot = (value) => ({
  pipelines: [
    {
      id: "pipeline",
      type: "pipeline",
      processors: [
        {
          id: processorId,
          type: "pipeline",
          name: "1. set",
          status: "healthy",
          metrics: { ingest_rate: value },
        },
      ],
    },
    {
      id: processorId,
      type: "pipeline",
      metrics: { ingest_rate: 999 },
      processors: [],
    },
  ],
});
async function processorHistory(
  legacy,
  modern = [],
  snapshot = legacySnapshot(3),
  partial = {},
) {
  const requests = [];
  const client = {
    transport: {
      request: async (request) => {
        requests.push(request);
        if (request.path === "/_cluster/health")
          return { body: { status: "green" } };
        if (request.path === "/")
          return { body: { cluster_uuid: "cluster-a" } };
        if (request.body.size === 1)
          return {
            body: { hits: { hits: [{ _source: { payload: snapshot } }] } },
          };
        const isLegacy = request.path === "/stack-monitoring-v1-*/_search";
        return {
          body: {
            ...(isLegacy ? partial : {}),
            aggregations: { samples: { buckets: isLegacy ? legacy : modern } },
          },
        };
      },
    },
  };
  return {
    result: await readHistory(client, {
      ...query,
      type: "processor",
      id: processorId,
    }),
    requests,
  };
}

test("legacy processor charts read nested summary measurements without pipeline ID collisions", async () => {
  const timestamp = 1794909600000;
  const { result, requests } = await processorHistory([
    bucket(timestamp, { timestamp, payload: legacySnapshot(3) }),
  ]);
  assert.equal(result.series[0]?.metrics.ingest_rate, 3);
  assert.equal(result.snapshot.pipelines[0].processors[0].type, "processor");
  assert.equal(result.snapshot.pipelines[1].type, "pipeline");
  const search = requests.find(
    (r) => r.path === "/stack-monitoring-v1-*/_search",
  );
  assert.ok(search);
  assert.equal(search.querystring.allow_no_indices, true);
  assert.deepEqual(search.body.query.bool.filter, [
    { range: { timestamp: { gte: timestamp, lte: timestamp + 900000 } } },
    { term: { cluster_uuid: "cluster-a" } },
    { term: { type: "cluster" } },
  ]);
  assert.equal(search.body.aggs.samples.aggs.sample.top_hits.size, 2);
  assert.deepEqual(search.body.aggs.samples.aggs.sample.top_hits._source, [
    "timestamp",
    "payload.pipelines.processors.id",
    "payload.pipelines.processors.name",
    "payload.pipelines.processors.status",
    "payload.pipelines.processors.metrics",
  ]);
});

test("mixed processor history merges each bucket using its latest real sample", async () => {
  const t = 1794909600000;
  const { result } = await processorHistory(
    [
      bucket(t, { timestamp: t + 1, payload: legacySnapshot(1) }),
      bucket(t + 10000, { timestamp: t + 10001, payload: legacySnapshot(2) }),
      bucket(t + 20000),
      bucket(t + 30000, { timestamp: t + 30009, payload: legacySnapshot(4) }),
      bucket(t + 40000, {
        timestamp: t + 40001,
        payload: { pipelines: [legacySnapshot(0).pipelines[1]] },
      }),
      bucket(t + 50000, { timestamp: t + 50001, payload: legacySnapshot(6) }),
    ],
    [
      bucket(t),
      bucket(t + 10000, { timestamp: t + 10005, metrics: { ingest_rate: 20 } }),
      bucket(t + 20000, { timestamp: t + 20005, metrics: { ingest_rate: 30 } }),
      bucket(t + 30000, { timestamp: t + 30005, metrics: { ingest_rate: 40 } }),
      bucket(t + 50000, { timestamp: t + 50005, metrics: {} }),
    ],
  );
  assert.deepEqual(
    result.series.map((p) => p.metrics.ingest_rate),
    [1, 20, 30, 4, undefined, 6],
  );
  assert.deepEqual(
    result.series.map((p) => p.timestamp),
    [t + 1, t + 10005, t + 20005, t + 30009, t + 40000, t + 50001],
  );
});

test("legacy processor fallback rejects incomplete searches and keeps the 360 point bound", async () => {
  for (const partial of [{ timed_out: true }, { _shards: { failed: 1 } }])
    await assert.rejects(
      processorHistory([], [], legacySnapshot(1), partial),
      /incomplete/,
    );
  const { result } = await processorHistory(
    Array.from({ length: 361 }, (_, i) =>
      bucket(i * 10000, { timestamp: i * 10000, payload: legacySnapshot(i) }),
    ),
  );
  assert.equal(result.series.length, 360);
});

test("legacy summaries without processors can omit the projected payload", async () => {
  const timestamp = 1794909600000;
  const { result } = await processorHistory([bucket(timestamp, { timestamp })]);
  assert.deepEqual(result.series, [{ timestamp, metrics: {} }]);
});

test("legacy processor removal retains the latest matching sample within the same bucket", async () => {
  const timestamp = 1794909600000;
  const { result } = await processorHistory([
    {
      key: timestamp,
      sample: {
        hits: {
          hits: [
            { _source: { timestamp: timestamp + 9000 } },
            {
              _source: {
                timestamp: timestamp + 1000,
                payload: legacySnapshot(7),
              },
            },
          ],
        },
      },
    },
  ]);
  assert.deepEqual(result.series, [
    { timestamp: timestamp + 1000, metrics: { ingest_rate: 7 } },
  ]);
});
