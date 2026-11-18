import test from "node:test";
import assert from "node:assert/strict";
import { defineRoutes } from "../../.cache/test-build/server/routes.js";

test("pipeline and processor history accept long identifiers within the query bound", () => {
  let query;
  defineRoutes(
    {
      get: (route) => {
        if (route.path === "/api/stack_monitoring/history")
          query = route.validate.query;
      },
      post() {},
    },
    { collection: { enabled: false }, logs: { index: "" } },
    () => ({}),
    async () => {},
  );
  assert.equal(
    query.validate({ type: "processor", id: "processor-id" }).type,
    "processor",
  );
  for (const type of ["pipeline", "processor"]) {
    for (const length of [1024, 4096]) {
      const id = "p".repeat(length);
      assert.equal(query.validate({ type, id }).id, id);
    }
    assert.throws(() => query.validate({ type, id: "p".repeat(4097) }));
  }
});

async function get(path, search, denied = false) {
  const routes = new Map();
  defineRoutes(
    { get: (route, handler) => routes.set(route.path, handler), post() {} },
    { collection: { enabled: false }, logs: { index: "logs-*" } },
    () => ({ enabled: true, last_success: 10000, last_error: null }),
    async () => {},
  );
  const requests = [];
  const client = {
    transport: {
      request: async (request) => {
        requests.push(request);
        if (denied)
          throw Object.assign(new Error("secret"), { statusCode: 403 });
        return {
          body:
            request.path === "/_cluster/health" ? { status: "green" } : search,
        };
      },
    },
  };
  const result = await routes.get(`/api/stack_monitoring/${path}`)(
    { core: { opensearch: { client: { asCurrentUser: client } } } },
    { query: { from: "now-15m", to: "now" } },
    {
      ok: ({ body }) => ({ status: 200, body }),
      forbidden: ({ body }) => ({ status: 403, body }),
      customError: ({ statusCode, body }) => ({ status: statusCode, body }),
    },
  );
  return { ...result, requests };
}

test("logs and status reject incomplete searches instead of returning success", async () => {
  for (const path of ["logs", "status"])
    for (const partial of [{ timed_out: true }, { _shards: { failed: 1 } }]) {
      const result = await get(path, { hits: { hits: [] }, ...partial });
      assert.equal(result.status, 503, `${path}: ${JSON.stringify(partial)}`);
    }
});

test("malformed log responses are not shown as an empty log window", async () => {
  for (const search of [{}, { hits: { hits: null } }, { hits: { hits: {} } }])
    assert.equal((await get("logs", search)).status, 503);
});

test("complete log searches return entries using the current user's client", async () => {
  const entries = [{ _id: "event", _source: { message: "Node joined" } }];
  const result = await get("logs", {
    timed_out: false,
    _shards: { failed: 0 },
    hits: { hits: entries },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { configured: true, entries });
  assert.equal(result.requests[1].path, "/logs-*/_search");
  assert.equal(result.requests[1].body.size, 10);
});

test("denied cluster access prevents log and status searches", async () => {
  for (const path of ["logs", "status"]) {
    const result = await get(path, {}, true);
    assert.equal(result.status, 403);
    assert.equal(result.requests.length, 1);
    assert.ok(!result.body.includes("secret"));
  }
});

test("setup routes use the current user and reflect runtime collector configuration", async () => {
  const routes = new Map();
  let configured = false;
  const actor = {
    transport: {
      request: async () => ({ body: { _source: { enabled: true } } }),
    },
  };
  defineRoutes(
    {
      get: (r, h) => routes.set("GET " + r.path, h),
      post: (r, h) => routes.set("POST " + r.path, h),
    },
    {
      collection: { enabled: true, username: "", password: "" },
      logs: { index: "" },
    },
    () => ({ enabled: true }),
    async () => ({ enabled: false }),
    {
      configured: () => configured,
      status: async (client) => {
        assert.equal(client, actor);
        return { available: true, configured };
      },
      run: async (client) => {
        assert.equal(client, actor);
        configured = true;
        return { configured: true };
      },
    },
  );
  const context = {
    core: {
      opensearch: {
        client: { asCurrentUser: actor, asInternalUser: { wrong: true } },
      },
    },
  };
  const response = {
    ok: ({ body }) => body,
    badRequest: ({ body }) => ({ error: body }),
    forbidden: ({ body }) => ({ error: body }),
    customError: ({ statusCode, body }) => ({ statusCode, body }),
  };
  assert.equal(
    (await routes.get("GET /api/stack_monitoring/setup")(context, {}, response))
      .available,
    true,
  );
  await routes.get("POST /api/stack_monitoring/setup")(
    context,
    { body: {} },
    response,
  );
  assert.equal(
    (
      await routes.get("GET /api/stack_monitoring/collection")(
        context,
        {},
        response,
      )
    ).configured,
    true,
  );
});

test("setup errors redact unknown server details and preserve authorization failures", async () => {
  for (const statusCode of [403, 500]) {
    const routes = new Map();
    defineRoutes(
      {
        get: (r, h) => routes.set(r.path, h),
        post: (r, h) => routes.set(r.path, h),
      },
      { collection: { enabled: true }, logs: { index: "" } },
      () => ({}),
      async () => {},
      {
        configured: () => false,
        status: async () => ({}),
        run: async () => {
          throw Object.assign(new Error("secret-password"), { statusCode });
        },
      },
    );
    const result = await routes.get("/api/stack_monitoring/setup")(
      { core: { opensearch: { client: { asCurrentUser: {} } } } },
      { body: {} },
      {
        customError: ({ statusCode, body }) => ({ statusCode, body }),
        forbidden: ({ body }) => ({ statusCode: 403, body }),
      },
    );
    assert.equal(result.statusCode, statusCode === 403 ? 403 : 503);
    assert.ok(!JSON.stringify(result).includes("secret-password"));
  }
});
