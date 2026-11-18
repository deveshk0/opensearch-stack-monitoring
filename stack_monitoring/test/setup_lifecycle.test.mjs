import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { StackMonitoringPlugin } from "../../.cache/test-build/server/plugin.js";
import {
  newCredentials,
  saveCredentials,
} from "../../.cache/test-build/server/setup.js";
const require = createRequire(import.meta.url);
const { of, Subject } = require("rxjs");

async function fixture(t, collection = {}) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "stack-setup-lifecycle-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [],
    clients = [],
    routes = new Map();
  const config = {
    collection: {
      enabled: true,
      username: "",
      password: "",
      resolvedRetentionDays: 30,
      ...collection,
    },
    logs: { index: "" },
  };
  const context = {
    config: {
      create: () => of(config),
      legacy: { globalConfig$: of({ path: { data: root } }) },
    },
    env: { instanceUuid: "instance-a", packageInfo: { version: "3.9.0" } },
    logger: { get: () => ({ warn() {} }) },
  };
  const core = {
    http: {
      createRouter: () => ({
        get: (r, h) => routes.set("GET " + r.path, h),
        post: (r, h) => routes.set("POST " + r.path, h),
      }),
      getServerInfo: () => ({
        name: "test",
        hostname: "localhost",
        port: 5601,
      }),
    },
    metrics: { getOpsMetrics$: () => new Subject() },
    opensearch: {
      createClient: (name, credentials) => {
        const client = {
          credentials,
          closed: false,
          asInternalUser: {
            transport: {
              request: async (r) => {
                calls.push(r);
                if (r.path === "/.stack-monitoring-settings/_doc/collection")
                  return { body: { _source: { enabled: true } } };
                if (r.path === "/")
                  return { body: { cluster_uuid: "different-cluster" } };
                if (r.path === "/_cluster/health")
                  return {
                    body: {
                      status: "green",
                      number_of_nodes: 1,
                      number_of_data_nodes: 1,
                    },
                  };
                return { body: {} };
              },
            },
          },
          close: async () => {
            client.closed = true;
          },
        };
        clients.push(client);
        return client;
      },
    },
  };
  const plugin = new StackMonitoringPlugin(context);
  await plugin.setup(core);
  t.after(() => plugin.stop());
  return { root, plugin, core, calls, clients, routes };
}

test("explicit manual credentials take precedence over managed files", async (t) => {
  const f = await fixture(t, { username: "manual", password: "manual-secret" });
  await saveCredentials(f.root, {
    ...newCredentials("cluster-a", "instance-a"),
    ready: true,
  });
  await f.plugin.start(f.core);
  assert.equal(f.clients.length, 1);
  assert.equal(f.clients[0].credentials.username, "manual");
  assert.equal(f.clients[0].credentials.password, "manual-secret");
  await f.plugin.stop();
  assert.equal(f.clients[0].closed, true);
});

test("an incomplete setup does not start a collector after restart", async (t) => {
  const f = await fixture(t);
  await saveCredentials(f.root, newCredentials("cluster-a", "instance-a"));
  await f.plugin.start(f.core);
  assert.equal(f.clients.length, 0);
});

test("managed startup loads saved credentials but cannot write to a different cluster", async (t) => {
  const f = await fixture(t);
  const value = { ...newCredentials("cluster-a", "instance-a"), ready: true };
  await saveCredentials(f.root, value);
  await f.plugin.start(f.core);
  await f.plugin.collector.pending;
  await f.plugin.collector.stop();
  assert.equal(f.clients[0].credentials.password, value.password);
  assert.ok(f.calls.some((r) => r.path === "/"));
  assert.equal(f.calls.filter((r) => r.method !== "GET").length, 0);
  assert.ok(f.plugin.collector.state.last_error);
});

test("credentials copied to a different instance and unsafe files fail closed", async (t) => {
  const f = await fixture(t);
  await saveCredentials(f.root, {
    ...newCredentials("cluster-a", "another-instance"),
    ready: true,
  });
  await f.plugin.start(f.core);
  assert.equal(f.clients.length, 0);
  assert.ok(f.plugin.setupError);
});

test("disabled server configuration never starts a managed collector", async (t) => {
  const f = await fixture(t, { enabled: false });
  await saveCredentials(f.root, {
    ...newCredentials("cluster-a", "instance-a"),
    ready: true,
  });
  await f.plugin.start(f.core);
  assert.equal(f.clients.length, 0);
});

test("denied setup performs no filesystem or cluster writes", async (t) => {
  const f = await fixture(t);
  await f.plugin.start(f.core);
  const calls = [];
  await assert.rejects(
    f.plugin.setUpMonitoring({
      transport: {
        request: async (r) => {
          calls.push(r);
          return { body: { has_api_access: false } };
        },
      },
    }),
    { statusCode: 403 },
  );
  assert.ok(calls.every((r) => r.method === "GET"));
  assert.deepEqual(await fs.readdir(f.root), []);
});

test("shutdown rejects new setup work before using request credentials", async (t) => {
  const f = await fixture(t);
  await f.plugin.start(f.core);
  await f.plugin.stop();
  let used = false;
  await assert.rejects(
    f.plugin.setUpMonitoring({
      transport: {
        request: async () => {
          used = true;
        },
      },
    }),
    { statusCode: 503 },
  );
  assert.equal(used, false);
  assert.equal(f.clients.length, 0);
});
