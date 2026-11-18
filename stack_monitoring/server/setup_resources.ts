import type { OpenSearchClient } from "../../../src/core/server";
import definitions from "../common/setup_resources.json";
import { at, record } from "../common/normalize";

const ALIAS = "stack-monitoring-write";
const PATTERN = "stack-monitoring-v2-*";
const FIRST = "stack-monitoring-v2-000001";
const POLICY = "stack-monitoring-v2-retention";
const status = (error: unknown) =>
  record(error).statusCode ?? at(error, "meta.statusCode");

function validateMapping(
  name: string,
  actual: unknown,
  expected: unknown,
  requireAll = false,
) {
  const mapping = record(actual);
  const desired = record(expected);
  if (
    mapping.dynamic !== desired.dynamic &&
    mapping.dynamic !== String(desired.dynamic)
  )
    throw new Error(`Conflicting mapping for ${name}: dynamic setting`);
  for (const [field, definition] of Object.entries(
    record(desired.properties),
  )) {
    const current = record(mapping.properties)[field];
    if (
      current === undefined
        ? requireAll
        : Object.entries(record(definition)).some(
            ([key, value]) => record(current)[key] !== value,
          )
    )
      throw new Error(`Conflicting or missing mapping for ${name}: ${field}`);
  }
}

function setting(settings: unknown, key: string): unknown {
  return (
    record(settings)[key] ??
    record(settings)[`index.${key}`] ??
    record(record(settings).index)[key] ??
    at(record(settings).index, key) ??
    at(settings, key)
  );
}

function validateTemplate(
  name: string,
  value: unknown,
  expected: unknown,
  metrics: boolean,
) {
  const template = record(value);
  validateMapping(
    name,
    template.mappings,
    at(expected, "template.mappings"),
    true,
  );
  const replicas = setting(template.settings, "number_of_replicas");
  if (
    String(setting(template.settings, "number_of_shards")) !== "1" ||
    !/^\d+$/.test(String(replicas)) ||
    Object.keys(record(template.aliases)).length ||
    (metrics &&
      setting(
        template.settings,
        "plugins.index_state_management.rollover_alias",
      ) !== ALIAS)
  )
    throw new Error(
      `Conflicting monitoring template settings or alias: ${name}`,
    );
}

function validatePolicy(value: unknown) {
  const policy = record(record(value).policy);
  const states = Array.isArray(policy.states) ? policy.states.map(record) : [];
  const collecting = states.find((state) => state.name === "collecting");
  const deleting = states.find((state) => state.name === "delete");
  const actions = collecting?.actions;
  const transitions = collecting?.transitions;
  const transition = record(Array.isArray(transitions) && transitions[0]);
  const retention = at(transition, "conditions.min_rollover_age");
  const templates = policy.ism_template;
  if (
    policy.default_state !== "collecting" ||
    states.length !== 2 ||
    !Array.isArray(actions) ||
    actions.length !== 1 ||
    !Object.keys(record(record(actions[0]).rollover)).length ||
    !Array.isArray(transitions) ||
    transitions.length !== 1 ||
    transition.state_name !== "delete" ||
    !/^[1-9]\d*(ms|s|m|h|d)$/.test(String(retention)) ||
    !Array.isArray(deleting?.actions) ||
    deleting.actions.length !== 1 ||
    !Object.prototype.hasOwnProperty.call(
      record(deleting.actions[0]),
      "delete",
    ) ||
    !Array.isArray(deleting.transitions) ||
    deleting.transitions.length !== 0 ||
    !Array.isArray(templates) ||
    templates.length !== 1 ||
    JSON.stringify(record(templates[0]).index_patterns) !==
      JSON.stringify([PATTERN])
  )
    throw new Error("Conflicting monitoring retention policy");
}

export async function provisionResources(
  client: OpenSearchClient,
  replicas: number,
): Promise<void> {
  if (!Number.isInteger(replicas) || replicas < 0)
    throw new Error("replicas must be a nonnegative integer");
  const desired: typeof definitions = JSON.parse(JSON.stringify(definitions));
  desired.metrics_template.template.settings.number_of_replicas = replicas;
  desired.insights_template.template.settings.number_of_replicas = replicas;
  for (const definition of Object.values(desired.indices))
    definition.settings.number_of_replicas = replicas;
  const request = async (
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ) => {
    const result = await client.transport.request(
      { method, path, ...(body === undefined ? {} : { body }) },
      { maxRetries: 0, requestTimeout: 20000 },
    );
    return record(result.body);
  };
  const optional = async (path: string) => {
    try {
      return await request("GET", path);
    } catch (error) {
      if (status(error) !== 404) throw error;
      return undefined;
    }
  };
  const alias = await optional(`/_alias/${ALIAS}`);
  let writeIndex: string | undefined;
  if (alias) {
    const writers: string[] = [];
    for (const [name, value] of Object.entries(alias)) {
      const options = record(record(record(value).aliases)[ALIAS]);
      if (
        !/^stack-monitoring-v2-\d{6,}$/.test(name) ||
        ["filter", "routing", "index_routing", "search_routing"].some(
          (key) => key in options,
        )
      )
        throw new Error(
          "Monitoring write alias has an unexpected backing index or routing",
        );
      if (options.is_write_index === true) writers.push(name);
    }
    if (writers.length !== 1)
      throw new Error(
        "Monitoring write alias must have exactly one explicit write index",
      );
    writeIndex = writers[0];
  } else if (
    (await optional(`/${ALIAS}`)) ||
    Object.keys(await request("GET", `/${PATTERN}?expand_wildcards=all`)).length
  ) {
    throw new Error(
      "Monitoring backing indices exist without the expected write alias; repair explicitly",
    );
  }
  const existing: Record<string, Record<string, unknown> | undefined> = {};
  for (const [name, definition] of Object.entries(desired.indices)) {
    const current = await optional(`/${name}`);
    if (current) {
      if (Object.keys(current).length !== 1 || !current[name])
        throw new Error(
          `Expected a fixed monitoring index, found alias: ${name}`,
        );
      validateMapping(
        name,
        record(current[name]).mappings,
        definition.mappings,
      );
    }
    existing[name] = current;
  }
  if (writeIndex) {
    const current = record(
      (await request("GET", `/${writeIndex}`))[writeIndex],
    );
    validateMapping(
      writeIndex,
      current.mappings,
      desired.metrics_template.template.mappings,
      true,
    );
    if (
      setting(
        current.settings,
        "plugins.index_state_management.rollover_alias",
      ) !== ALIAS
    )
      throw new Error(
        "Monitoring backing index has the wrong rollover alias setting",
      );
    const managed = await request(
      "GET",
      `/_plugins/_ism/explain/${writeIndex}`,
    );
    if (record(managed[writeIndex]).policy_id !== POLICY)
      throw new Error(
        "Monitoring write index is not managed by the expected retention policy; retry after ISM attachment settles",
      );
  }
  const policyPath = `/_plugins/_ism/policies/${POLICY}`;
  const policy = await optional(policyPath);
  if (policy) validatePolicy(policy);
  const templates = [
    ["stack-monitoring-v2", desired.metrics_template],
    ["stack-monitoring-insights-v1", desired.insights_template],
  ] as const;
  const missingTemplates: (typeof templates)[number][] = [];
  let metricsReplicas: unknown = replicas;
  for (const entry of templates) {
    const [name, expected] = entry;
    const current = await optional(`/_index_template/${name}`);
    if (!current) {
      missingTemplates.push(entry);
      continue;
    }
    const entries = current.index_templates;
    const template = record(
      Array.isArray(entries) &&
        entries.length === 1 &&
        record(entries[0]).index_template,
    );
    if (
      JSON.stringify(template.index_patterns) !==
      JSON.stringify(expected.index_patterns)
    )
      throw new Error(`Conflicting monitoring template patterns: ${name}`);
    validateTemplate(
      name,
      template.template,
      expected,
      name === "stack-monitoring-v2",
    );
    if (name === "stack-monitoring-v2")
      metricsReplicas = setting(
        at(template, "template.settings"),
        "number_of_replicas",
      );
  }
  // Role writes prove Security REST administration before resource or settings writes.
  for (const [name, role] of Object.entries(desired.roles))
    await request("PUT", `/_plugins/_security/api/roles/${name}`, role);
  if (!policy) await request("PUT", policyPath, desired.policy);
  for (const [name, template] of missingTemplates)
    await request("PUT", `/_index_template/${name}`, template);
  if (!writeIndex) {
    const effective = await request(
      "POST",
      `/_index_template/_simulate_index/${FIRST}`,
    );
    validateTemplate(FIRST, effective.template, desired.metrics_template, true);
    if (
      String(
        setting(at(effective, "template.settings"), "number_of_replicas"),
      ) !== String(metricsReplicas)
    )
      throw new Error(
        "Conflicting effective monitoring template replica count",
      );
  }
  for (const [name, definition] of Object.entries(desired.indices)) {
    if (!existing[name]) await request("PUT", `/${name}`, definition);
    else if (
      Object.keys(definition.mappings.properties).some(
        (field) =>
          !(field in record(at(existing[name]![name], "mappings.properties"))),
      )
    )
      await request("PUT", `/${name}/_mapping`, definition.mappings);
  }
  try {
    await request("PUT", "/.stack-monitoring-settings/_create/collection", {
      enabled: true,
    });
  } catch (error) {
    if (status(error) !== 409) throw error;
  }
  if (!writeIndex)
    await request("PUT", `/${FIRST}`, {
      aliases: { [ALIAS]: { is_write_index: true } },
    });
}
