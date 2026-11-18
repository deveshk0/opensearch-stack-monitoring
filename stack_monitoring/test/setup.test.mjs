import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  newCredentials,
  readCredentials,
  saveCredentials,
  authorizeSetup,
  ensureCollectorIdentity,
} from "../../.cache/test-build/server/setup.js";

async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stack-setup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("managed credentials are private, persistent, and tied to cluster and instance", async (t) => {
  const root = await directory(t);
  assert.equal(await readCredentials(root), undefined);
  const value = newCredentials("cluster-a", "instance-a");
  await saveCredentials(root, value);
  assert.deepEqual(await readCredentials(root), value);
  assert.equal(
    (await fs.stat(path.join(root, "stack-monitoring"))).mode & 0o777,
    0o700,
  );
  assert.equal(
    (await fs.stat(path.join(root, "stack-monitoring/collector.json"))).mode &
      0o777,
    0o600,
  );
  assert.match(value.username, /^stack_monitoring_[a-f0-9]{32}$/);
  assert.ok(value.password.length >= 40);
  assert.equal(value.ready, false);
  await saveCredentials(root, { ...value, ready: true });
  assert.equal((await readCredentials(root)).ready, true);
  await assert.rejects(
    saveCredentials(root, newCredentials("cluster-a", "instance-a")),
    /conflict/i,
  );
});

test("unsafe permissions and symlinks are rejected without reading secret contents", async (t) => {
  const root = await directory(t);
  const value = newCredentials("cluster-a", "instance-a");
  await saveCredentials(root, value);
  const file = path.join(root, "stack-monitoring/collector.json");
  await fs.chmod(file, 0o644);
  await assert.rejects(readCredentials(root), /private/i);
  await fs.unlink(file);
  const other = path.join(root, "outside.json");
  await fs.writeFile(other, JSON.stringify(value), { mode: 0o600 });
  await fs.symlink(other, file);
  await assert.rejects(readCredentials(root));
  await fs.unlink(file);
  await fs.rmdir(path.dirname(file));
  await fs.symlink(root, path.dirname(file));
  await assert.rejects(readCredentials(root));
});

test("corrupt credential files fail closed without including their contents", async (t) => {
  const root = await directory(t);
  await saveCredentials(root, newCredentials("cluster-a", "instance-a"));
  const file = path.join(root, "stack-monitoring/collector.json");
  await fs.writeFile(file, "{secret-password");
  await assert.rejects(
    readCredentials(root),
    (error) => !error.message.includes("secret-password"),
  );
});

test("setup authorization checks Security API access and disabled endpoints", async () => {
  for (const body of [
    { has_api_access: false },
    { has_api_access: true, disabled_endpoints: { INTERNALUSERS: ["PUT"] } },
    { has_api_access: true, disabled_endpoints: { ROLES: ["PUT"] } },
    {},
  ]) {
    await assert.rejects(
      authorizeSetup({ transport: { request: async () => ({ body }) } }),
      { statusCode: 403 },
    );
  }
  await authorizeSetup({
    transport: {
      request: async (r) => {
        assert.equal(r.path, "/_plugins/_security/api/permissionsinfo");
        return { body: { has_api_access: true, disabled_endpoints: {} } };
      },
    },
  });
});

test("generated identity gets only the collector role; retries do not reset an existing user", async () => {
  const credentials = newCredentials("cluster-a", "instance-a");
  let created;
  const requests = [];
  const client = {
    transport: {
      request: async (r) => {
        requests.push(r);
        if (r.method === "GET") {
          if (!created)
            throw Object.assign(new Error("missing"), { statusCode: 404 });
          return { body: { [credentials.username]: created } };
        }
        created = r.body;
        return { body: { status: "CREATED" } };
      },
    },
  };
  await ensureCollectorIdentity(client, credentials);
  assert.deepEqual(created.opendistro_security_roles, [
    "stack_monitoring_collector",
  ]);
  assert.deepEqual(created.backend_roles, []);
  assert.equal(created.password, credentials.password);
  await ensureCollectorIdentity(client, credentials);
  assert.equal(requests.filter((r) => r.method === "PUT").length, 1);
  created.attributes = {};
  await assert.rejects(
    ensureCollectorIdentity(client, credentials),
    /conflict/i,
  );
  assert.equal(requests.filter((r) => r.method === "PUT").length, 1);
});

test("identity lookup failures do not create or overwrite accounts", async () => {
  let writes = 0;
  const client = {
    transport: {
      request: async (r) => {
        if (r.method === "PUT") writes++;
        throw Object.assign(new Error("server error"), { statusCode: 503 });
      },
    },
  };
  await assert.rejects(
    ensureCollectorIdentity(client, newCredentials("cluster", "instance")),
  );
  assert.equal(writes, 0);
});

test("granular Security API administrators can set up without roles_enabled membership", async () => {
  const calls = [];
  await authorizeSetup({
    transport: {
      request: async (r) => {
        calls.push(r.path);
        if (r.path.endsWith("/permissionsinfo"))
          return { body: { has_api_access: false, disabled_endpoints: {} } };
        throw Object.assign(new Error("not created yet"), { statusCode: 404 });
      },
    },
  });
  assert.equal(calls.length, 3);
});
