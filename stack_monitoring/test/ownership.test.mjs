import test from "node:test";
import assert from "node:assert/strict";
import { CollectorOwnership } from "../../.cache/test-build/server/ownership.js";
function backend() {
  let doc,
    seq = 0;
  const calls = [];
  return {
    calls,
    transport: {
      request: async (r) => {
        calls.push(r);
        if (r.method === "GET") {
          if (!doc) throw { statusCode: 404 };
          return { body: { _source: doc, _seq_no: seq, _primary_term: 1 } };
        }
        if (r.path.includes("/_create/")) {
          if (doc) throw { statusCode: 409 };
          doc = r.body;
          return { body: { _seq_no: ++seq, _primary_term: 1 } };
        }
        if (r.querystring.if_seq_no !== seq) throw { statusCode: 409 };
        if (r.method === "DELETE") doc = undefined;
        else doc = r.body;
        return { body: { _seq_no: ++seq, _primary_term: 1 } };
      },
    },
  };
}
test("different collector blocked until owner shuts down; same persistent UUID may restart", async () => {
  const client = backend(),
    a = new CollectorOwnership(client, "a"),
    b = new CollectorOwnership(client, "b");
  await a.acquire("cluster");
  await assert.rejects(b.acquire("cluster"), /another/);
  const restart = new CollectorOwnership(client, "a");
  await restart.acquire("cluster");
  await a.release();
  await assert.rejects(b.acquire("cluster"), /another/);
  await restart.release();
  await b.acquire("cluster");
  await b.release();
});
test("invalid cluster identity never creates ownership", async () => {
  const client = backend(),
    a = new CollectorOwnership(client, "a");
  for (const id of ["", " ", "_na_"]) await assert.rejects(a.acquire(id));
  assert.equal(client.calls.length, 0);
});
