import test from "node:test";
import assert from "node:assert/strict";
import {
  readCollectionSetting,
  saveCollectionSetting,
} from "../../.cache/test-build/server/collection.js";
test("saved disabled setting survives readback without defaulting to true", async () => {
  const client = {
    transport: {
      request: async () => ({ body: { _source: { enabled: false } } }),
    },
  };
  assert.equal(await readCollectionSetting(client), false);
});
test("setting is persisted as current user before runtime collection changes", async () => {
  const steps = [];
  const client = {
    transport: {
      request: async (req) => {
        assert.equal(req.method, "PUT");
        assert.deepEqual(req.body, { enabled: false });
        assert.equal(req.path, "/.stack-monitoring-settings/_doc/collection");
        steps.push("persist");
      },
    },
  };
  await saveCollectionSetting(client, false, async (enabled) => {
    assert.equal(enabled, false);
    steps.push("apply");
  });
  assert.deepEqual(steps, ["persist", "apply"]);
});
test("denied settings write never changes runtime collection", async () => {
  let applied = false;
  const client = {
    transport: {
      request: async () => {
        throw Object.assign(new Error("denied"), { statusCode: 403 });
      },
    },
  };
  await assert.rejects(
    saveCollectionSetting(client, true, async () => {
      applied = true;
    }),
    { statusCode: 403 },
  );
  assert.equal(applied, false);
});
test("invalid persisted settings fail closed", async () => {
  await assert.rejects(
    readCollectionSetting({
      transport: {
        request: async () => ({ body: { _source: { enabled: "true" } } }),
      },
    }),
    /invalid/i,
  );
});
