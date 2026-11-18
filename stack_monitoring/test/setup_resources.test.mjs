import test from "node:test";
import assert from "node:assert/strict";
import { provisionResources } from "../../.cache/test-build/server/setup_resources.js";
const ALIAS = "stack-monitoring-write";
const FIRST = "stack-monitoring-v2-000001";
const POLICY = "stack-monitoring-v2-retention";
const missing = () => {
  throw Object.assign(new Error("missing"), { statusCode: 404 });
};
function cluster() {
  const state = {
    indices: {},
    templates: {},
    policy: null,
    enabled: undefined,
    calls: [],
    managed: POLICY,
  };
  state.client = {
    transport: {
      request: async (request) => {
        const { method, path, body } = request;
        state.calls.push(structuredClone(request));
        if (state.fail?.(request))
          throw Object.assign(new Error("denied"), { statusCode: 403 });
        let result = {};
        if (path.startsWith("/_plugins/_security/api/roles/"))
          return { body: result };
        if (path.startsWith("/_plugins/_ism/explain/"))
          result = { [path.split("/").at(-1)]: { policy_id: state.managed } };
        else if (path.startsWith("/_plugins/_ism/policies/")) {
          if (method === "GET") result = state.policy ?? missing();
          else state.policy = structuredClone(body);
        } else if (path.startsWith("/_index_template/_simulate_index/")) {
          const name = path.split("/").at(-1).startsWith("stack-monitoring-v2-")
            ? "stack-monitoring-v2"
            : "stack-monitoring-insights-v1";
          result = {
            template: state.effective ?? state.templates[name].template,
          };
        } else if (path.startsWith("/_index_template/")) {
          const name = path.split("/").at(-1);
          if (method === "GET")
            result = {
              index_templates: [
                { name, index_template: state.templates[name] ?? missing() },
              ],
            };
          else state.templates[name] = structuredClone(body);
        } else if (path === `/_alias/${ALIAS}`) {
          result = Object.fromEntries(
            Object.entries(state.indices).filter(
              ([, value]) => value.aliases?.[ALIAS],
            ),
          );
          if (!Object.keys(result).length) missing();
        } else if (path.startsWith("/stack-monitoring-v2-*")) {
          result = Object.fromEntries(
            Object.entries(state.indices).filter(([name]) =>
              name.startsWith("stack-monitoring-v2-"),
            ),
          );
        } else if (path === "/.stack-monitoring-settings/_create/collection") {
          if (state.enabled !== undefined)
            throw Object.assign(new Error("exists"), { statusCode: 409 });
          state.enabled = body.enabled;
        } else {
          const name = path.split("/")[1];
          if (method === "GET")
            result = { [name]: state.indices[name] ?? missing() };
          else if (path.endsWith("/_mapping"))
            state.indices[name].mappings = structuredClone(body);
          else
            state.indices[name] = {
              ...structuredClone(
                name.startsWith("stack-monitoring-v2-")
                  ? state.templates["stack-monitoring-v2"].template
                  : {},
              ),
              ...structuredClone(body),
            };
        }
        return { body: structuredClone(result) };
      },
    },
  };
  return state;
}
const writes = (state) => state.calls.filter(({ method }) => method === "PUT");
test("native setup provisions scoped resources and checks role-write privilege first", async () => {
  const state = cluster();
  await provisionResources(state.client, 0);
  assert.deepEqual(state.indices[FIRST].aliases, {
    [ALIAS]: { is_write_index: true },
  });
  assert.equal(state.indices[FIRST].settings.number_of_replicas, 0);
  assert.equal(
    state.indices[".stack-monitoring-locks-v1"].mappings.properties.owner.type,
    "keyword",
  );
  assert.equal(state.enabled, true);
  assert.ok(
    writes(state)
      .slice(0, 3)
      .every(({ path }) => path.startsWith("/_plugins/_security/api/roles/")),
  );
  assert.ok(
    state.calls.every(({ path }) => !/internalusers|rolesmapping/.test(path)),
  );
});
test("rerun preserves custom retention, template replicas, write target and disabled collection", async () => {
  const state = cluster();
  await provisionResources(state.client, 2);
  state.enabled = false;
  state.policy.policy.states[0].transitions[0].conditions.min_rollover_age =
    "30d";
  state.indices["stack-monitoring-v2-000002"] = state.indices[FIRST];
  delete state.indices[FIRST];
  const original = structuredClone({
    policy: state.policy,
    templates: state.templates,
    indices: state.indices,
  });
  state.calls = [];
  await provisionResources(state.client, 0);
  assert.deepEqual(
    {
      policy: state.policy,
      templates: state.templates,
      indices: state.indices,
    },
    original,
  );
  assert.equal(state.enabled, false);
  assert.ok(
    writes(state).every(
      ({ path }) =>
        path.includes("/roles/") || path.endsWith("/_create/collection"),
    ),
  );
});
test("missing fixed-index mapping fields are extended without resetting settings", async () => {
  const state = cluster();
  await provisionResources(state.client, 2);
  delete state.indices["stack-monitoring-insights-v1"].mappings.properties
    .evidence;
  await provisionResources(state.client, 0);
  assert.deepEqual(
    state.indices["stack-monitoring-insights-v1"].mappings.properties.evidence,
    { type: "object", enabled: false },
  );
  assert.equal(
    state.indices["stack-monitoring-insights-v1"].settings.number_of_replicas,
    2,
  );
});
for (const [name, corrupt] of [
  [
    "orphan backing index",
    (s) => {
      delete s.indices[FIRST].aliases;
    },
  ],
  [
    "unexpected alias backing index",
    (s) => {
      s.indices["application-data"] = s.indices[FIRST];
      delete s.indices[FIRST];
    },
  ],
  [
    "filtered alias",
    (s) => {
      s.indices[FIRST].aliases[ALIAS].filter = {};
    },
  ],
  [
    "multiple writers",
    (s) => {
      s.indices["stack-monitoring-v2-000002"] = structuredClone(
        s.indices[FIRST],
      );
    },
  ],
  [
    "missing timestamp mapping",
    (s) => {
      delete s.indices[FIRST].mappings.properties.timestamp;
    },
  ],
  [
    "wrong rollover alias",
    (s) => {
      s.indices[FIRST].settings[
        "plugins.index_state_management.rollover_alias"
      ] = "other";
    },
  ],
  [
    "wrong ISM attachment",
    (s) => {
      s.managed = "other";
    },
  ],
  [
    "conflicting fixed mapping",
    (s) => {
      s.indices[".stack-monitoring-settings"].mappings.properties.enabled.type =
        "keyword";
    },
  ],
  [
    "unscoped template",
    (s) => {
      s.templates["stack-monitoring-v2"].index_patterns = ["*"];
    },
  ],
  [
    "conflicting template mapping",
    (s) => {
      s.templates[
        "stack-monitoring-v2"
      ].template.mappings.properties.timestamp.type = "keyword";
    },
  ],
  [
    "policy without rollover",
    (s) => {
      s.policy.policy.states[0].actions = [];
    },
  ],
  [
    "policy without retention",
    (s) => {
      s.policy.policy.states[0].transitions = [];
    },
  ],
])
  test(`rejects ${name} before writes`, async () => {
    const state = cluster();
    await provisionResources(state.client, 1);
    corrupt(state);
    state.calls = [];
    await assert.rejects(provisionResources(state.client, 1));
    assert.deepEqual(writes(state), []);
  });
test("denied reads and role writes do not create indices or settings", async () => {
  for (const fail of [
    (r) => r.method === "GET",
    (r) => r.path.includes("/roles/"),
  ]) {
    const state = cluster();
    state.fail = fail;
    await assert.rejects(provisionResources(state.client, 1), {
      statusCode: 403,
    });
    assert.deepEqual(state.indices, {});
    assert.equal(state.policy, null);
  }
});
test("failed provisioning can retry missing resources without resetting choices", async () => {
  const state = cluster();
  state.fail = ({ path, method }) => method === "PUT" && path === `/${FIRST}`;
  await assert.rejects(provisionResources(state.client, 1), {
    statusCode: 403,
  });
  state.enabled = false;
  state.fail = undefined;
  await provisionResources(state.client, 1);
  assert.ok(state.indices[FIRST]);
  assert.equal(state.enabled, false);
});
test("effective template conflicts prevent creation of the first backing index", async () => {
  const state = cluster();
  state.effective = {
    settings: {},
    mappings: { dynamic: false, properties: {} },
  };
  await assert.rejects(
    provisionResources(state.client, 1),
    /mapping|template/i,
  );
  assert.equal(state.indices[FIRST], undefined);
});
test("invalid replicas fail before cluster requests", async () => {
  for (const replicas of [-1, 0.5, NaN]) {
    const state = cluster();
    await assert.rejects(
      provisionResources(state.client, replicas),
      /replicas/i,
    );
    assert.deepEqual(state.calls, []);
  }
});
test("effective template cannot silently override the selected replica count", async () => {
  const state = cluster();
  await provisionResources(state.client, 1);
  delete state.indices[FIRST];
  state.effective = structuredClone(
    state.templates["stack-monitoring-v2"].template,
  );
  state.effective.settings.number_of_replicas = 7;
  await assert.rejects(provisionResources(state.client, 0), /template/i);
  assert.equal(state.indices[FIRST], undefined);
});
test("existing templates support nested OpenSearch settings without resetting replicas", async () => {
  const state = cluster();
  await provisionResources(state.client, 2);
  delete state.indices[FIRST];
  state.templates["stack-monitoring-v2"].template.settings = {
    index: {
      number_of_shards: "1",
      number_of_replicas: "2",
      plugins: { index_state_management: { rollover_alias: ALIAS } },
    },
  };
  await provisionResources(state.client, 0);
  assert.equal(state.indices[FIRST].settings.index.number_of_replicas, "2");
});
