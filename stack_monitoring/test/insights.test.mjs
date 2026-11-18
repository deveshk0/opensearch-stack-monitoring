import test from "node:test";
import assert from "node:assert/strict";
import {
  InsightTracker,
  InsightStore,
  readInsights,
} from "../../.cache/test-build/server/insights.js";
import { INSIGHT_RULES } from "../../.cache/test-build/common/insights.js";
const node = (metrics = {}) => ({
  id: "node-1",
  name: "Node one",
  type: "node",
  status: "online",
  counters: {},
  metrics,
});
const snapshot = (t, metrics = { heap_percent: 90 }) => ({
  schema: 1,
  timestamp: 1000000 + t,
  cluster_uuid: "cluster-a",
  cluster_name: "A",
  cluster: {
    id: "cluster",
    name: "A",
    type: "cluster",
    metrics: {},
    counters: {},
    status: "green",
  },
  nodes: [node(metrics)],
  indices: [],
  pipelines: [],
  instances: [],
  shards: [],
  recoveries: [],
  errors: [],
});
function step(tracker, sample) {
  const next = tracker.evaluate(sample);
  next.commit();
  return next.changes;
}
function sustained(tracker, start = 0, metrics) {
  let changes;
  for (let t = start; t <= start + 60000; t += 10000)
    changes = step(tracker, snapshot(t, metrics));
  return changes;
}
test("one minute of pressure opens one incident with evidence; a transient does not", () => {
  const tracker = new InsightTracker();
  for (let t = 0; t < 60000; t += 10000)
    assert.deepEqual(step(tracker, snapshot(t)), []);
  const [incident] = step(tracker, snapshot(60000));
  assert.equal(incident.rule_id, "heap-pressure");
  assert.equal(incident.status, "active");
  assert.equal(incident.first_seen, 1000000);
  assert.equal(incident.detected_at, 1060000);
  assert.equal(incident.evidence.length, 7);
  assert.equal(incident.value, 90);
  assert.equal(step(tracker, snapshot(70000))[0].id, incident.id);
  const transient = new InsightTracker();
  step(transient, snapshot(0));
  for (let t = 10000; t < 100000; t += 10000)
    assert.deepEqual(step(transient, snapshot(t, { heap_percent: 40 })), []);
});
test("sustained recovery resolves; recurrence gets a new incident ID", () => {
  const tracker = new InsightTracker();
  const [opened] = sustained(tracker);
  for (let t = 70000; t < 130000; t += 10000)
    assert.equal(
      step(tracker, snapshot(t, { heap_percent: 40 }))[0].status,
      "active",
    );
  const [resolved] = step(tracker, snapshot(130000, { heap_percent: 40 }));
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.resolved_at, 1130000);
  const [again] = sustained(tracker, 140000);
  assert.notEqual(again.id, opened.id);
});
test("missing data, absent entities and partial samples never count as recovery", () => {
  const tracker = new InsightTracker();
  const [opened] = sustained(tracker);
  for (const mutation of [
    (s) => (s.nodes[0].metrics = {}),
    (s) => (s.nodes = []),
    (s) => (s.errors = ["nodeStats: unavailable."]),
  ]) {
    for (let t = 70000; t <= 150000; t += 10000) {
      const s = snapshot(t, { heap_percent: 20 });
      mutation(s);
      assert.deepEqual(step(tracker, s), []);
    }
  }
  const [after] = step(tracker, snapshot(160000, { heap_percent: 20 }));
  assert.equal(after.id, opened.id);
  assert.equal(after.status, "active");
});
test("gaps, restarts and nonfinite measurements reset detection windows", () => {
  for (const reset of [
    (s) => (s.timestamp += 40000),
    (s) => (s.nodes[0].metrics.heap_percent = null),
    (s) => (s.nodes[0].metrics.heap_percent = NaN),
    (s) => (s.nodes[0].metrics.uptime_ms = 1),
  ]) {
    const tracker = new InsightTracker();
    for (let t = 0; t <= 50000; t += 10000)
      step(tracker, snapshot(t, { heap_percent: 90, uptime_ms: 100000 + t }));
    const s = snapshot(60000, { heap_percent: 90, uptime_ms: 160000 });
    reset(s);
    assert.deepEqual(step(tracker, s), []);
  }
});
test("restore retains the incident identity but requires new recovery continuity", () => {
  const initial = new InsightTracker();
  const [incident] = sustained(initial);
  const restarted = new InsightTracker();
  restarted.restore([incident]);
  assert.equal(
    step(restarted, snapshot(180000, { heap_percent: 20 }))[0].status,
    "active",
  );
  let changes;
  for (let t = 190000; t <= 240000; t += 10000)
    changes = step(restarted, snapshot(t, { heap_percent: 20 }));
  assert.equal(changes[0].status, "resolved");
  assert.equal(changes[0].id, incident.id);
});
test("uncommitted transitions are retryable without duplicate incidents", () => {
  const tracker = new InsightTracker();
  for (let t = 0; t < 60000; t += 10000) step(tracker, snapshot(t));
  const first = tracker.evaluate(snapshot(60000));
  const retry = tracker.evaluate(snapshot(60000));
  assert.deepEqual(retry.changes, first.changes);
  retry.commit();
  assert.equal(step(tracker, snapshot(70000))[0].id, first.changes[0].id);
});
test("each configured rule detects its boundary on the correct entity", () => {
  assert.equal(INSIGHT_RULES.length, 9);
  for (const rule of INSIGHT_RULES) {
    const tracker = new InsightTracker();
    let changes;
    for (let t = 0; t <= 60000; t += 10000) {
      const s = snapshot(t, {});
      const e =
        rule.type === "cluster"
          ? s.cluster
          : rule.type === "pipeline"
            ? { ...node(), type: "pipeline" }
            : s.nodes[0];
      if (rule.type === "pipeline") s.pipelines = [e];
      e.metrics[rule.metric] =
        rule.operator === ">" ? rule.threshold + 1 : rule.threshold;
      changes = step(tracker, s);
    }
    assert.equal(changes.length, 1, rule.id);
    assert.equal(changes[0].rule_id, rule.id);
  }
});

const query = { from: "2026-11-17T10:00:00Z", to: "2026-11-17T10:15:00Z" };
const searchBody = (incidents = []) => ({
  hits: {
    total: { value: incidents.length, relation: "eq" },
    hits: incidents.map((_source) => ({ _source })),
  },
  _shards: { failed: 0 },
  timed_out: false,
});
test("failed incident persistence retries the same ID and restores open incidents on startup", async () => {
  const source = new InsightTracker();
  const [incident] = sustained(source);
  let fail = true;
  const writes = [];
  const client = {
    transport: {
      request: async (r) => ({
        body: r.path.endsWith("_delete_by_query")
          ? { deleted: 0, timed_out: false, failures: [] }
          : searchBody([incident]),
      }),
    },
    bulk: async (r) => {
      writes.push(r.body);
      return { body: { errors: fail } };
    },
  };
  const store = new InsightStore(client);
  await assert.rejects(store.collect(snapshot(70000)), /write/);
  fail = false;
  await store.collect(snapshot(70000));
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0], writes[1]);
  assert.equal(writes[1][1].id, incident.id);
});
test("insight reads enforce user permissions, cluster scope and overlap range", async () => {
  const requests = [];
  const client = {
    transport: {
      request: async (r) => {
        requests.push(r);
        return {
          body: r.path === "/" ? { cluster_uuid: "cluster-a" } : searchBody(),
        };
      },
    },
  };
  const response = await readInsights(client, query);
  assert.equal(response.total, 0);
  const search = requests.at(-1);
  assert.equal(search.body.size, 500);
  assert.ok(
    search.body.query.bool.filter.some(
      (f) => f.term?.cluster_uuid === "cluster-a",
    ),
  );
  assert.ok(
    search.body.query.bool.filter.some(
      (f) => f.range?.detected_at.lte === Date.parse(query.to),
    ),
  );
  const overlap = search.body.query.bool.filter.find((f) => f.bool);
  assert.ok(
    overlap.bool.should.some(
      (f) => f.range?.resolved_at.gte === Date.parse(query.from),
    ),
  );
  await assert.rejects(
    readInsights(
      {
        transport: {
          request: async () => {
            throw { statusCode: 403 };
          },
        },
      },
      query,
    ),
    { statusCode: 403 },
  );
});
test("invalid ranges and incomplete insight searches fail instead of showing no issues", async () => {
  let calls = 0;
  const unused = {
    transport: {
      request: async () => {
        calls++;
        return { body: {} };
      },
    },
  };
  await assert.rejects(readInsights(unused, { from: "now-48h", to: "now" }));
  assert.equal(calls, 0);
  for (const partial of [{ timed_out: true }, { _shards: { failed: 1 } }]) {
    const client = {
      transport: {
        request: async (r) => ({
          body:
            r.path === "/"
              ? { cluster_uuid: "cluster-a" }
              : { ...searchBody(), ...partial },
        }),
      },
    };
    await assert.rejects(readInsights(client, query), /incomplete/);
    await assert.rejects(
      new InsightStore(client).collect(snapshot(0)),
      /incomplete/,
    );
  }
});
test("restoring more open incidents than the bound fails explicitly", async () => {
  const client = {
    transport: {
      request: async () => ({
        body: { ...searchBody(), hits: { total: { value: 5001 }, hits: [] } },
      }),
    },
  };
  await assert.rejects(new InsightStore(client).collect(snapshot(0)), /limit/);
});

test("cluster topology changes do not suppress sustained unassigned shards", () => {
  const tracker = new InsightTracker();
  let changes;
  for (let t = 0; t <= 60000; t += 10000) {
    const s = snapshot(t, {});
    s.cluster.metrics.unassigned = 1;
    s.cluster.generation = `unrelated-shard-moved-${t}`;
    changes = step(tracker, s);
  }
  assert.equal(changes.length, 1);
  assert.equal(changes[0].rule_id, "unassigned-shards");
});

test("partial bulk success followed by a long gap retries exact transitions without orphan incidents", async () => {
  const documents = new Map();
  let attempts = 0;
  const client = {
    transport: {
      request: async (r) => ({
        body: r.path.endsWith("_delete_by_query")
          ? { deleted: 0, timed_out: false, failures: [] }
          : searchBody(),
      }),
    },
    bulk: async ({ body }) => {
      attempts++;
      for (let i = 0; i < body.length; i += 2) {
        if (attempts === 1 && i > 0) break;
        documents.set(body[i].index._id, body[i + 1]);
      }
      return { body: { errors: attempts === 1 } };
    },
  };
  const store = new InsightStore(client);
  const sample = (t) => {
    const s = snapshot(t);
    s.nodes.push({
      ...node({ heap_percent: 95 }),
      id: "node-2",
      name: "Second node",
    });
    return s;
  };
  for (let t = 0; t < 60000; t += 10000) await store.collect(sample(t));
  await assert.rejects(store.collect(sample(60000)), /write/);
  for (let t = 110000; t <= 170000; t += 10000) await store.collect(sample(t));
  assert.equal(documents.size, 2, "One durable incident per affected node");
  assert.equal(
    new Set([...documents.values()].map((i) => i.first_seen)).size,
    1,
  );
  assert.ok([...documents.values()].every((i) => i.first_seen === 1000000));
});

test("restart keeps recent breach evidence and marks an observation gap before recovery", () => {
  const initial = new InsightTracker();
  const [incident] = sustained(initial);
  const restarted = new InsightTracker();
  restarted.restore([incident]);
  const [observed] = step(restarted, snapshot(180000));
  assert.ok(
    observed.evidence.some((e) => e.timestamp === 1060000 && e.value === 90),
    "Pre-restart evidence retained",
  );
  assert.ok(
    observed.evidence.some((e) => e.value === null),
    "A gap is not drawn as continuous pressure",
  );
  const [resolved] = sustained(restarted, 190000, { heap_percent: 20 });
  assert.equal(resolved.status, "resolved");
  assert.deepEqual(resolved.evidence, observed.evidence);
});

test("valid rule sources keep evaluating despite unrelated warnings", () => {
  for (const [nodeStats, health, expected] of [
    [true, true, ["heap-pressure", "ingest-failures", "unassigned-shards"]],
    [false, true, ["unassigned-shards"]],
    [true, false, ["heap-pressure", "ingest-failures"]],
  ]) {
    const tracker = new InsightTracker();
    let changes;
    for (let t = 0; t <= 60000; t += 10000) {
      const s = snapshot(t);
      s.errors = ["recovery: unavailable.", "Display limit reached."];
      s.source_validity = {
        nodeStats,
        health,
        indexStats: false,
        shards: false,
      };
      s.cluster.metrics.unassigned = 1;
      s.pipelines = [{ ...node({ failed_rate: 1 }), type: "pipeline" }];
      changes = step(tracker, s);
    }
    assert.deepEqual(changes.map((i) => i.rule_id).sort(), expected.sort());
  }
});

test("invalid cluster identities cannot read or write incidents", async () => {
  for (const identity of [undefined, null, "", "  ", "_na_", 42]) {
    const calls = [];
    const client = {
      transport: {
        request: async (r) => {
          calls.push(r);
          return {
            body: r.path === "/" ? { cluster_uuid: identity } : searchBody(),
          };
        },
      },
      bulk: async () => assert.fail("Invalid identity must not write"),
    };
    await assert.rejects(readInsights(client, query), /identity/);
    assert.equal(calls.filter((r) => r.path.endsWith("_search")).length, 0);
    calls.length = 0;
    await assert.rejects(
      new InsightStore(client).collect({
        ...snapshot(0),
        cluster_uuid: identity,
      }),
      /identity/,
    );
    assert.equal(calls.length, 0);
  }
});

test("a cluster switch discards pending writes from the previous backend", async () => {
  let backend = "cluster-a";
  const writes = [];
  const client = {
    transport: {
      request: async (r) => ({
        body: r.path.endsWith("_delete_by_query")
          ? { deleted: 0, timed_out: false, failures: [] }
          : searchBody(),
      }),
    },
    bulk: async (r) => {
      writes.push({ backend, body: r.body });
      return { body: { errors: backend === "cluster-a" } };
    },
  };
  const store = new InsightStore(client);
  for (let t = 0; t < 60000; t += 10000) await store.collect(snapshot(t));
  await assert.rejects(store.collect(snapshot(60000)), /write/);
  backend = "cluster-b";
  for (let t = 70000; t <= 130000; t += 10000)
    await store.collect({ ...snapshot(t), cluster_uuid: backend });
  const secondWrites = writes.filter((w) => w.backend === "cluster-b");
  assert.equal(secondWrites.length, 1);
  assert.ok(
    secondWrites.every((w) =>
      w.body
        .filter((_, i) => i % 2 === 1)
        .every((incident) => incident.cluster_uuid === "cluster-b"),
    ),
  );
});

test("acknowledged incidents are visible to an immediately restarted store", async () => {
  const visible = new Map();
  const client = {
    transport: {
      request: async (r) => ({
        body: r.path.endsWith("_delete_by_query")
          ? { deleted: 0, timed_out: false, failures: [] }
          : searchBody(
              [...visible.values()].filter((i) => i.status === "active"),
            ),
      }),
    },
    bulk: async ({ body, refresh }) => {
      if (refresh === "wait_for")
        for (let i = 0; i < body.length; i += 2)
          visible.set(body[i].index._id, body[i + 1]);
      return { body: { errors: false } };
    },
  };
  const first = new InsightStore(client);
  for (let t = 0; t <= 60000; t += 10000) await first.collect(snapshot(t));
  assert.equal(visible.size, 1);
  const incident = [...visible.values()][0];
  const restarted = new InsightStore(client);
  for (let t = 70000; t <= 130000; t += 10000)
    await restarted.collect(snapshot(t));
  assert.equal(visible.size, 1);
  assert.equal([...visible.values()][0].id, incident.id);
});

test("resolved retention is hourly, bounded and never selects active or recent incidents", async () => {
  const day = 86400000;
  const now = 40 * day;
  for (const retention of [undefined, 7]) {
    const requests = [];
    const client = {
      transport: {
        request: async (r) => {
          requests.push(r);
          return {
            body: r.path.endsWith("_delete_by_query")
              ? { deleted: 1, timed_out: false, failures: [] }
              : searchBody(),
          };
        },
      },
      bulk: async () => ({ body: { errors: false } }),
    };
    const store = new InsightStore(client, retention);
    const sample = (timestamp) => ({ ...snapshot(0, {}), timestamp });
    await store.collect(sample(now));
    await store.collect(sample(now + 10000));
    const cleanup = requests.filter((r) => r.path.endsWith("_delete_by_query"));
    assert.equal(cleanup.length, 1);
    assert.equal(
      cleanup[0].path,
      "/stack-monitoring-insights-v1/_delete_by_query",
    );
    assert.equal(cleanup[0].querystring.max_docs, 1000);
    assert.equal(cleanup[0].querystring.conflicts, "proceed");
    const filter = cleanup[0].body.query.bool.filter;
    assert.ok(filter.some((f) => f.term?.status === "resolved"));
    assert.ok(filter.some((f) => f.term?.cluster_uuid === "cluster-a"));
    assert.ok(
      filter.some(
        (f) => f.range?.resolved_at?.lt === now - (retention ?? 30) * day,
      ),
    );
    assert.equal(
      filter.some((f) => f.range?.last_seen),
      false,
    );
    await store.collect(sample(now + 3600000));
    assert.equal(
      requests.filter((r) => r.path.endsWith("_delete_by_query")).length,
      2,
    );
  }
});

test("incomplete retention fails visibly and retries without dropping active state", async () => {
  for (const failed of [
    { deleted: 0, timed_out: true, failures: [] },
    {
      deleted: 0,
      timed_out: false,
      failures: [{ cause: { reason: "denied" } }],
    },
    {},
  ]) {
    let cleanupCalls = 0;
    const [incident] = sustained(new InsightTracker());
    const writes = [];
    const client = {
      transport: {
        request: async (r) => {
          if (r.path.endsWith("_delete_by_query")) {
            cleanupCalls++;
            return {
              body:
                cleanupCalls === 1
                  ? failed
                  : { deleted: 0, timed_out: false, failures: [] },
            };
          }
          return { body: searchBody([incident]) };
        },
      },
      bulk: async ({ body }) => {
        writes.push(body[1]);
        return { body: { errors: false } };
      },
    };
    const store = new InsightStore(client);
    await assert.rejects(store.collect(snapshot(70000)), /retention/i);
    await store.collect(snapshot(80000));
    assert.equal(cleanupCalls, 2);
    assert.equal(writes.length, 2);
    assert.ok(
      writes.every(
        (value) => value.id === incident.id && value.status === "active",
      ),
    );
  }
});

test("invalid retention values fail before any deletion", () => {
  for (const days of [0, -1, NaN, Infinity, 0.5])
    assert.throws(() => new InsightStore({}, days), /retention/i);
});

test("retention drains a full bounded batch on subsequent samples before returning to hourly checks", async () => {
  const cleanups = [];
  const client = {
    transport: {
      request: async (request) => {
        if (!request.path.endsWith("_delete_by_query"))
          return { body: searchBody() };
        cleanups.push(request);
        return {
          body: {
            deleted: cleanups.length === 1 ? 1000 : 5,
            timed_out: false,
            failures: [],
          },
        };
      },
    },
    bulk: async () => ({ body: { errors: false } }),
  };
  const store = new InsightStore(client);
  await store.collect(snapshot(0, {}));
  await store.collect(snapshot(10000, {}));
  await store.collect(snapshot(20000, {}));
  assert.equal(cleanups.length, 2);
  assert.ok(cleanups.every((r) => r.querystring.max_docs === 1000));
  await store.collect(snapshot(3610000, {}));
  assert.equal(cleanups.length, 3);
});

test("malformed bulk acknowledgements keep the incident transition retryable", async () => {
  const [incident] = sustained(new InsightTracker());
  const writes = [];
  const client = {
    transport: {
      request: async (r) => ({
        body: r.path.endsWith("_delete_by_query")
          ? { deleted: 0, timed_out: false, failures: [] }
          : searchBody([incident]),
      }),
    },
    bulk: async ({ body }) => {
      writes.push(body);
      return { body: writes.length === 1 ? {} : { errors: false } };
    },
  };
  const store = new InsightStore(client);
  await assert.rejects(store.collect(snapshot(70000)), /write/);
  await store.collect(snapshot(70000));
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0], writes[1]);
});

test("insight network requests use bounded timeouts without transport retries", async () => {
  const [incident] = sustained(new InsightTracker());
  const options = [];
  const client = {
    transport: {
      request: async (r, requestOptions) => {
        options.push(requestOptions);
        return {
          body:
            r.path === "/"
              ? { cluster_uuid: "cluster-a" }
              : r.path.endsWith("_delete_by_query")
                ? { deleted: 0, timed_out: false, failures: [] }
                : searchBody([incident]),
        };
      },
    },
    bulk: async (_, requestOptions) => {
      options.push(requestOptions);
      return { body: { errors: false } };
    },
  };
  await new InsightStore(client).collect(snapshot(70000));
  await readInsights(client, query);
  assert.equal(options.length, 6);
  for (const value of options)
    assert.deepEqual(value, { maxRetries: 0, requestTimeout: 20000 });
});

test("large incident transitions use bounded batches and retry every pending chunk before advancing", async () => {
  const documents = new Map();
  const writes = [];
  const client = {
    transport: {
      request: async (r) => ({
        body: r.path.endsWith("_delete_by_query")
          ? { deleted: 0, timed_out: false, failures: [] }
          : searchBody(),
      }),
    },
    bulk: async (request) => {
      writes.push(request);
      if (writes.length === 2) return { body: { errors: true } };
      for (let i = 0; i < request.body.length; i += 2)
        documents.set(request.body[i].index._id, request.body[i + 1]);
      return { body: { errors: false } };
    },
  };
  const sample = (t) => ({
    ...snapshot(t),
    nodes: Array.from({ length: 501 }, (_, i) => ({
      ...node({ heap_percent: 90 }),
      id: "node-" + i,
    })),
  });
  const store = new InsightStore(client);
  for (let t = 0; t < 60000; t += 10000) await store.collect(sample(t));
  await assert.rejects(store.collect(sample(60000)), /write/);
  assert.equal(documents.size, 500);
  await store.collect(sample(110000));
  assert.deepEqual(
    writes.map((r) => r.body.length / 2),
    [500, 1, 500, 1, 500, 1],
  );
  assert.deepEqual(writes[0], writes[2]);
  assert.deepEqual(writes[1], writes[3]);
  assert.ok(writes.every((r) => r.refresh === "wait_for"));
  assert.equal(documents.size, 501);
  assert.ok(
    [...documents.values()].every(
      (i) => i.first_seen === 1000000 && i.last_evaluated === 1110000,
    ),
  );
});
