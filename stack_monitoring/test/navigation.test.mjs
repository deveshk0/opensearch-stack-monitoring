import test from "node:test";
import assert from "node:assert/strict";
import {
  routeFromHash,
  linkTo,
} from "../../.cache/test-build/common/navigation.js";
test("route preserves entity names and absolute time context", () => {
  const r = routeFromHash(
    "#/indices/orders%2F2026/advanced?from=2026-11-17T00%3A00%3A00Z&to=now&indices_q=order",
  );
  assert.equal(r.id, "orders/2026");
  assert.equal(r.advanced, true);
  assert.equal(r.type, "index");
  const next = routeFromHash(linkTo("/nodes", r.params));
  assert.equal(next.params.get("indices_q"), "order");
  assert.equal(next.params.get("from"), "2026-11-17T00:00:00Z");
});
test("invalid routes and escaping cannot break navigation", () => {
  assert.equal(routeFromHash("#/unknown").view, "overview");
  assert.equal(routeFromHash("#/nodes/%ZZ").id, "");
  assert.equal(routeFromHash("").view, "overview");
  assert.equal(routeFromHash("#/pipelines/a%2F0%2Fset").id, "a/0/set");
});
