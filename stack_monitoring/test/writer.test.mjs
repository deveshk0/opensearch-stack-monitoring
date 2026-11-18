import test from "node:test";
import assert from "node:assert/strict";
import {
  writeSnapshot,
  displaySnapshot,
} from "../../.cache/test-build/server/writer.js";
const entity = (id, type = "index") => ({
  id,
  type,
  name: id,
  status: "green",
  metrics: {},
  counters: {},
});
const snapshot = () => ({
  schema: 1,
  timestamp: 10000,
  cluster_uuid: "a",
  cluster_name: "demo",
  cluster: entity("a", "cluster"),
  nodes: [],
  indices: Array.from({ length: 1001 }, (_, i) => entity(String(i))),
  pipelines: [],
  instances: [],
  shards: [],
  recoveries: [],
  errors: [],
});
test("bounded alias writes retain all entities and publish the capped summary last", async () => {
  const calls = [];
  const s = snapshot();
  s.indices[0].id = "x".repeat(4096);
  await writeSnapshot(
    {
      bulk: async (request) => {
        calls.push(request);
        return { body: { errors: false } };
      },
    },
    s,
  );
  assert.equal(calls.length, 4);
  assert.equal(
    calls.flatMap((c) => c.body).filter((d) => d.type === "index").length,
    1001,
  );
  for (const call of calls) {
    assert.equal(call.require_alias, true);
    assert.ok(call.body.length <= 1000);
    for (let i = 0; i < call.body.length; i += 2) {
      assert.equal(call.body[i].index._index, "stack-monitoring-write");
      assert.equal(call.body[i].index._id.length, 64);
    }
  }
  assert.equal(calls.at(-1).body[1].type, "cluster");
  assert.equal(calls.at(-1).body[1].payload.indices.length, 1000);
  assert.equal(s.indices.length, 1001);
  assert.match(displaySnapshot(s).errors.join(" "), /1000 indices/);
});
test("failed entity batch never publishes a complete-looking summary", async () => {
  const calls = [];
  await assert.rejects(
    writeSnapshot(
      {
        bulk: async (r) => {
          calls.push(r);
          return { body: { errors: true } };
        },
      },
      snapshot(),
    ),
  );
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].body.some((d) => d.type === "cluster"));
});
