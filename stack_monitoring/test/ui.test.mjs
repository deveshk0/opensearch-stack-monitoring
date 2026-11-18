import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ts = require("typescript");
const React = require("react");
const renderer = require("react-test-renderer");
const { act } = renderer;

// Execute the shipped components with real React effects and controllable HTTP.
// EUI hosts are inert: no DOM, browser, credentials or live cluster is needed.
function environment(hash = "#/nodes/node-a?paused=false") {
  let tree;
  const listeners = new Map(),
    requests = [],
    cache = new Map();
  const window = {
    location: { hash },
    scrollTo() {},
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name) => listeners.delete(name),
    setInterval: () => 1,
    clearInterval() {},
  };
  const core = {
    http: {
      get: (url) =>
        new Promise((resolve, reject) =>
          requests.push({ url, resolve, reject, method: "GET" }),
        ),
      post: (url, options) =>
        new Promise((resolve, reject) =>
          requests.push({ url, resolve, reject, method: "POST", options }),
        ),
      basePath: { prepend: (value) => value },
    },
    uiSettings: { get: () => false },
    chrome: { setBreadcrumbs() {} },
  };
  const eui = new Proxy({}, { get: (_, name) => name });
  const elasticCharts = {
    Chart: "Chart",
    Settings: "Settings",
    LineSeries: "LineSeries",
    Axis: "Axis",
    Position: { Bottom: "bottom", Left: "left" },
    ScaleType: { Time: "time", Linear: "linear" },
  };
  function load(filename) {
    filename = path.resolve(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const source = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        jsx: ts.JsxEmit.React,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
    }).outputText;
    const localRequire = (name) => {
      if (name === "react") return React;
      if (name === "react-dom")
        return {
          render: (element) => {
            tree = renderer.create(element);
          },
          unmountComponentAtNode: () => tree.unmount(),
        };
      if (name === "@elastic/eui") return eui;
      if (name === "@elastic/charts") return elasticCharts;
      if (name.endsWith(".scss")) return {};
      const resolved = path.resolve(path.dirname(filename), name);
      return load(
        [".ts", ".tsx"].map((ext) => resolved + ext).find(fs.existsSync),
      );
    };
    vm.runInNewContext(
      source,
      {
        require: localRequire,
        module,
        exports: module.exports,
        React,
        window,
        URLSearchParams,
        console,
      },
      { filename },
    );
    return module.exports;
  }
  return {
    core,
    requests,
    load,
    get tree() {
      return tree;
    },
    async app() {
      await act(async () =>
        load("stack_monitoring/public/application.tsx").renderApp(
          core,
          { element: {} },
          false,
        ),
      );
    },
    async component(name, props) {
      const Component = load(
        "stack_monitoring/public/components/" + name + ".tsx",
      )[name === "collection" ? "CollectionControl" : "Insights"];
      await act(async () => {
        tree = renderer.create(
          React.createElement(Component, {
            core,
            tick: 0,
            onChange() {},
            from: "now-15m",
            to: "now",
            dark: false,
            ...props,
          }),
        );
      });
      return Component;
    },
    async navigate(next) {
      await act(async () => {
        window.location.hash = next;
        listeners.get("hashchange")();
      });
    },
    async refresh() {
      await act(async () =>
        tree.root.findByType("EuiSuperDatePicker").props.onRefresh(),
      );
    },
    async close() {
      await act(async () => tree?.unmount());
    },
  };
}
const history = (
  nodes = [
    {
      id: "node-a",
      name: "Node A",
      status: "online",
      metrics: {},
      type: "node",
    },
  ],
) => ({
  snapshot: {
    timestamp: Date.now(),
    cluster_name: "Test",
    cluster: { status: "green", metrics: {} },
    nodes,
    indices: [],
    instances: [],
    pipelines: [],
    errors: [],
    shards: [],
    recoveries: [],
  },
  series: [{ timestamp: Date.now() - 1000, metrics: { cpu_percent: 42 } }],
  range: { from: Date.now() - 10000, to: Date.now() },
  collection: { enabled: true, last_success: Date.now() },
});
const endpoint = (env, suffix, method = "GET") =>
  env.requests.filter(
    (r) => r.url.endsWith("/" + suffix) && r.method === method,
  );
const text = (node) =>
  typeof node === "string"
    ? node
    : Array.isArray(node)
      ? node.map(text).join("")
      : node?.props
        ? text(node.props.children)
        : "";

test("refresh does not abandon or duplicate a slow monitoring request", async () => {
  const env = environment();
  try {
    await env.app();
    await env.refresh();
    await env.refresh();
    assert.equal(endpoint(env, "history").length, 1);
    assert.equal(endpoint(env, "collection").length, 1);
    await act(async () => endpoint(env, "history")[0].resolve(history()));
    assert.equal(
      env.tree.root.findAll((n) => n.props.className === "sm-status").length,
      1,
    );
    await env.refresh();
    assert.equal(endpoint(env, "history").length, 2);
  } finally {
    await env.close();
  }
});

test("changing entity ignores the previous request even when it resolves last", async () => {
  const env = environment();
  try {
    await env.app();
    await env.navigate("#/nodes/node-b?paused=true");
    const next = history([
      {
        id: "node-b",
        name: "Node B",
        status: "online",
        metrics: {},
        type: "node",
      },
    ]);
    await act(async () => endpoint(env, "history")[1].resolve(next));
    await act(async () => endpoint(env, "history")[0].resolve(history()));
    assert.equal(text(env.tree.root.findByType("h1")), "Node B");
  } finally {
    await env.close();
  }
});

test("a removed entity still exposes its historical series", async () => {
  const env = environment();
  try {
    await env.app();
    await act(async () => endpoint(env, "history")[0].resolve(history([])));
    assert.equal(
      env.tree.root.findAll((n) => n.props.className === "sm-chart-grid")
        .length,
      1,
    );
    assert.equal(
      env.tree.root
        .findAllByType("EuiEmptyPrompt")
        .filter((n) => text(n.props.title) === "Entity not found").length,
      0,
    );
  } finally {
    await env.close();
  }
});

test("a collection read begun before saving cannot overwrite the saved state", async () => {
  const env = environment();
  try {
    const Component = await env.component("collection");
    const before = {
      enabled: true,
      configured: true,
      desired_enabled: true,
      interval_ms: 10000,
      index_pattern: "history-*",
      last_success: Date.now(),
    };
    await act(async () => endpoint(env, "collection")[0].resolve(before));
    await act(async () =>
      env.tree.update(
        React.createElement(Component, {
          core: env.core,
          tick: 1,
          onChange() {},
        }),
      ),
    );
    const staleRead = endpoint(env, "collection")[1];
    let save;
    await act(async () => {
      save = env.tree.root.findByType("EuiButton").props.onClick();
    });
    await act(async () => {
      endpoint(env, "collection", "POST")[0].resolve({ enabled: false });
      await save;
    });
    await act(async () => staleRead.resolve(before));
    assert.equal(
      text(env.tree.root.findByType("EuiButton")),
      "Enable self-monitoring",
    );
  } finally {
    await env.close();
  }
});

test("insight evidence links select charts containing the affected metric", async () => {
  for (const [ruleId, expectedPath, metric] of [
    ["cpu-pressure", "/nodes/node-a", "cpu_percent"],
    ["heap-pressure", "/nodes/node-a", "heap_used"],
    ["disk-pressure", "/nodes/node-a", "disk_percent"],
    ["search-queue", "/nodes/node-a/advanced", "search_queue"],
    ["write-rejections", "/nodes/node-a/advanced", "write_rejected_rate"],
  ]) {
    const env = environment();
    try {
      await env.component("insights");
      const incident = {
        id: ruleId,
        rule_id: ruleId,
        entity_id: "node-a",
        entity_name: "Node A",
        entity_type: "node",
        severity: "warning",
        status: "active",
        first_seen: Date.now() - 120000,
        last_seen: Date.now(),
        last_evaluated: Date.now(),
        detected_at: Date.now() - 60000,
        evidence: [],
        value: 95,
      };
      await act(async () =>
        endpoint(env, "insights")[0].resolve({
          incidents: [incident],
          total: 1,
          collection: { enabled: true, last_success: Date.now() },
        }),
      );
      const table = env.tree.root.findByType("EuiInMemoryTable");
      await act(async () =>
        table.props.columns[0].render("", incident).props.onClick(),
      );
      const link = env.tree.root
        .findAllByType("EuiButton")
        .find((n) => text(n) === "Open related monitoring charts");
      assert.equal(link.props.href.split("?")[0], "#" + expectedPath, ruleId);
      const charts = env.load("stack_monitoring/public/components/charts.tsx");
      const specs = expectedPath.endsWith("advanced")
        ? charts.advancedCharts
        : charts.nodeCharts;
      assert(
        specs.some((spec) => spec.keys.some(([key]) => key === metric)),
        ruleId,
      );
    } finally {
      await env.close();
    }
  }
});

test("fractional loads and rejection rates remain visible", () => {
  const env = environment();
  const { format } = env.load("stack_monitoring/public/components/charts.tsx");
  assert.equal(
    format(0.25),
    (0.25).toLocaleString(undefined, { maximumFractionDigits: 2 }),
  );
});

test("processor routes remain distinct from pipelines with the same identifier", async () => {
  const env = environment("#/processors/parent%2F0%2Fset?paused=true");
  try {
    const { routeFromHash } = env.load("stack_monitoring/common/navigation.ts");
    assert.equal(
      routeFromHash("#/processors/parent%2F0%2Fset").type,
      "processor",
    );
    assert.equal(
      routeFromHash("#/pipelines/parent%2F0%2Fset").type,
      "pipeline",
    );
    await env.app();
    const data = history();
    const processor = {
      id: "parent/0/set",
      name: "1. set",
      status: "healthy",
      metrics: {},
      type: "processor",
    };
    data.series[0].metrics.ingest_rate = 3;
    data.snapshot.pipelines = [
      {
        id: "parent/0/set",
        name: "Colliding pipeline",
        status: "healthy",
        metrics: {},
        type: "pipeline",
      },
      {
        id: "parent",
        name: "Parent",
        status: "healthy",
        metrics: {},
        type: "pipeline",
        processors: [processor],
      },
    ];
    await act(async () => endpoint(env, "history")[0].resolve(data));
    assert.equal(text(env.tree.root.findByType("h1")), "1. set");
    assert(
      env.tree.root
        .findAllByType("LineSeries")
        .some((n) => n.props.yAccessors.includes("ingest_rate")),
    );
    await env.navigate("#/pipelines/parent%2F0%2Fset?paused=true");
    await act(async () => endpoint(env, "history")[1].resolve(data));
    assert.equal(text(env.tree.root.findByType("h1")), "Colliding pipeline");
    await env.navigate("#/pipelines/parent?paused=true");
    await act(async () => endpoint(env, "history")[2].resolve(data));
    const table = env.tree.root
      .findAllByType("EuiInMemoryTable")
      .find((n) => n.props.tableCaption === "Processors");
    const nameCell = table.props.columns[0].render(processor.name, processor);
    assert.equal(
      nameCell.props.children[0].props.href.split("?")[0],
      "#/processors/parent%2F0%2Fset",
    );
  } finally {
    await env.close();
  }
});

test("a failed refresh recovers on the next attempt", async () => {
  const env = environment();
  try {
    await env.app();
    await act(async () =>
      endpoint(env, "history")[0].reject({
        body: { message: "Connection unavailable" },
      }),
    );
    assert(
      env.tree.root
        .findAllByType("EuiCallOut")
        .some((n) => n.props.title === "Unable to load monitoring data"),
    );
    await env.refresh();
    await act(async () => endpoint(env, "history")[1].resolve(history()));
    assert.equal(
      env.tree.root.findAll((n) => n.props.className === "sm-status").length,
      1,
    );
  } finally {
    await env.close();
  }
});

test("cluster evidence has an unassigned-shards chart and logs retain server errors", async () => {
  const env = environment("#/opensearch?paused=true");
  try {
    await env.app();
    const data = history();
    data.series[0].metrics.unassigned = 2;
    await act(async () => endpoint(env, "history")[0].resolve(data));
    assert(
      env.tree.root
        .findAllByType("LineSeries")
        .some((n) => n.props.yAccessors.includes("unassigned")),
    );
    await act(async () =>
      endpoint(env, "logs")[0].reject({
        body: { message: "Log index is unavailable" },
      }),
    );
    assert(
      env.tree.root
        .findAllByType("EuiCallOut")
        .some((n) => n.props.title === "Log index is unavailable"),
    );
  } finally {
    await env.close();
  }
});

test("insight evaluation failure is visible even when metric collection is fresh", async () => {
  const env = environment();
  try {
    await env.component("insights");
    await act(async () =>
      endpoint(env, "insights")[0].resolve({
        incidents: [],
        total: 0,
        collection: {
          enabled: true,
          last_success: Date.now(),
          insights_error: "Findings index is unavailable",
        },
      }),
    );
    const warning = env.tree.root.findByType("EuiCallOut");
    assert.equal(warning.props.title, "Current conditions are not verified");
    assert(
      text(warning).includes(
        "Insight evaluation failed: Findings index is unavailable",
      ),
    );
  } finally {
    await env.close();
  }
});

test("collection permission errors survive the follow-up status read", async () => {
  const env = environment();
  try {
    await env.component("collection");
    const state = {
      enabled: true,
      configured: true,
      interval_ms: 10000,
      index_pattern: "history-*",
    };
    await act(async () => endpoint(env, "collection")[0].resolve(state));
    let save;
    await act(async () => {
      save = env.tree.root.findByType("EuiButton").props.onClick();
    });
    await act(async () => {
      endpoint(env, "collection", "POST")[0].reject({
        body: { message: "Write permission required" },
      });
      await save;
    });
    await act(async () => endpoint(env, "collection")[1].resolve(state));
    assert(
      env.tree.root
        .findAllByType("EuiCallOut")
        .some((n) => n.props.title === "Write permission required"),
    );
  } finally {
    await env.close();
  }
});

test("saving collection invalidates history requested before the change", async () => {
  const env = environment();
  try {
    await env.app();
    await act(async () =>
      endpoint(env, "collection")[0].resolve({
        enabled: true,
        configured: true,
        interval_ms: 10000,
        index_pattern: "history-*",
      }),
    );
    let save;
    await act(async () => {
      save = env.tree.root.findByType("EuiButton").props.onClick();
    });
    await act(async () => {
      endpoint(env, "collection", "POST")[0].resolve({ enabled: false });
      await save;
    });
    assert.equal(endpoint(env, "history").length, 2);
    const disabled = history();
    disabled.collection.enabled = false;
    await act(async () => endpoint(env, "history")[1].resolve(disabled));
    await act(async () => endpoint(env, "history")[0].resolve(history()));
    assert(
      env.tree.root
        .findAllByType("EuiCallOut")
        .some((n) => n.props.title === "Self-monitoring is disabled"),
    );
  } finally {
    await env.close();
  }
});

const setupState = (overrides = {}) => ({
  configured: false,
  managed: false,
  available: true,
  reason: null,
  last_success: null,
  last_error: null,
  ...overrides,
});

test("first-run setup remains available without indices and refreshes after one setup request", async () => {
  const env = environment();
  try {
    await env.app();
    await act(async () => {
      endpoint(env, "collection")[0].reject({ statusCode: 404 });
      endpoint(env, "history")[0].reject({ statusCode: 404 });
    });
    assert.equal(endpoint(env, "setup").length, 1);
    await act(async () => endpoint(env, "setup")[0].resolve(setupState()));
    const popover = env.tree.root.findByType("EuiPopover");
    assert.equal(text(popover.props.button), "Set up monitoring");
    await act(async () => popover.props.button.props.onClick());
    assert.equal(env.tree.root.findByType("EuiPopover").props.isOpen, true);
    const button = env.tree.root
      .findByType("EuiPopover")
      .findByType("EuiButton");
    assert.equal(text(button), "Set up monitoring");
    let save;
    await act(async () => {
      save = button.props.onClick();
      button.props.onClick();
    });
    assert.equal(endpoint(env, "setup", "POST").length, 1);
    assert.equal(
      env.tree.root.findByType("EuiPopover").findByType("EuiButton").props
        .isLoading,
      true,
    );
    assert.equal(
      env.tree.root.findByType("EuiPopover").findByType("EuiButton").props
        .isDisabled,
      true,
    );
    assert.equal(endpoint(env, "setup", "POST")[0].options.body, "{}");
    await act(async () => {
      endpoint(env, "setup", "POST")[0].resolve(
        setupState({ configured: true, managed: true }),
      );
      await save;
    });
    assert.equal(endpoint(env, "history").length, 2);
    assert(
      env.tree.root
        .findAllByType("EuiHealth")
        .some((n) => /waiting.*sample/i.test(text(n))),
    );
    await act(async () =>
      endpoint(env, "collection").at(-1).resolve({
        configured: true,
        enabled: true,
        desired_enabled: true,
        index_pattern: "history-*",
        interval_ms: 10000,
        last_success: null,
        last_error: null,
      }),
    );
    assert(
      env.tree.root
        .findAllByType("EuiHealth")
        .some((n) => /waiting.*sample/i.test(text(n))),
    );
    await env.refresh();
    await act(async () =>
      endpoint(env, "collection").at(-1).resolve({
        configured: true,
        enabled: true,
        desired_enabled: true,
        index_pattern: "history-*",
        interval_ms: 10000,
        last_success: 1770000000000,
        last_error: null,
      }),
    );
    assert.equal(
      text(env.tree.root.findByType("EuiPopover").findByType("EuiButton")),
      "Disable self-monitoring",
    );
    assert(
      !env.tree.root
        .findAllByType("EuiHealth")
        .some((n) => /waiting.*sample/i.test(text(n))),
    );
  } finally {
    await env.close();
  }
});

test("readers see why first-run setup is unavailable", async () => {
  const env = environment();
  try {
    await env.component("collection");
    await act(async () =>
      endpoint(env, "collection")[0].reject({ statusCode: 404 }),
    );
    assert.equal(endpoint(env, "setup").length, 1);
    await act(async () =>
      endpoint(env, "setup")[0].resolve(
        setupState({
          available: false,
          reason: "Sign in as an administrator to set up monitoring.",
        }),
      ),
    );
    assert(
      env.tree.root
        .findAllByType("EuiCallOut")
        .some((n) => text(n).includes("Sign in as an administrator")),
    );
    assert.equal(env.tree.root.findAllByType("EuiButton").length, 0);
    assert.equal(endpoint(env, "setup", "POST").length, 0);
  } finally {
    await env.close();
  }
});

test("unconfigured collectors offer setup and failed setup can retry without exposing errors", async () => {
  const env = environment();
  try {
    await env.component("collection");
    const unconfigured = {
      configured: false,
      enabled: false,
      desired_enabled: false,
      interval_ms: 10000,
      index_pattern: "history-*",
      last_success: null,
      last_error: null,
    };
    await act(async () => endpoint(env, "collection")[0].resolve(unconfigured));
    assert.equal(endpoint(env, "setup").length, 1);
    await act(async () => endpoint(env, "setup")[0].resolve(setupState()));
    let save;
    await act(async () => {
      save = env.tree.root.findByType("EuiButton").props.onClick();
    });
    await act(async () => {
      endpoint(env, "setup", "POST")[0].reject({
        body: { message: "secret-internal-detail" },
      });
      await save;
    });
    await act(async () =>
      endpoint(env, "collection").at(-1).resolve(unconfigured),
    );
    await act(async () => endpoint(env, "setup").at(-1).resolve(setupState()));
    const errors = env.tree.root.findAllByType("EuiCallOut");
    assert(errors.some((n) => /could not|failed/i.test(n.props.title)));
    assert(
      !errors.some((n) =>
        (n.props.title + text(n)).includes("secret-internal-detail"),
      ),
    );
    assert.equal(env.tree.root.findByType("EuiButton").props.isDisabled, false);
    await act(async () => {
      env.tree.root.findByType("EuiButton").props.onClick();
    });
    assert.equal(endpoint(env, "setup", "POST").length, 2);
  } finally {
    await env.close();
  }
});

test("a failed setup status read can be retried from the popover", async () => {
  const env = environment();
  try {
    await env.component("collection");
    await act(async () =>
      endpoint(env, "collection")[0].reject({ statusCode: 404 }),
    );
    assert.equal(endpoint(env, "setup").length, 1);
    await act(async () =>
      endpoint(env, "setup")[0].reject({ statusCode: 503 }),
    );
    const retry = env.tree.root.findByType("EuiButton");
    assert.match(text(retry), /retry/i);
    await act(async () => retry.props.onClick());
    await act(async () =>
      endpoint(env, "collection").at(-1).reject({ statusCode: 404 }),
    );
    await act(async () => endpoint(env, "setup").at(-1).resolve(setupState()));
    assert.equal(
      text(env.tree.root.findByType("EuiButton")),
      "Set up monitoring",
    );
  } finally {
    await env.close();
  }
});

test("setup displays public conflict reasons and hides unexpected server errors", async () => {
  const publicMessage =
    "Another Dashboards instance owns monitoring collection.";
  const genericMessage =
    "Monitoring setup could not be completed. Please retry.";
  for (const [failure, expected] of [
    [
      { response: { status: 409 }, body: { message: publicMessage } },
      publicMessage,
    ],
    [{ body: { statusCode: 409, message: publicMessage } }, publicMessage],
    [
      {
        response: { status: 503 },
        body: { statusCode: 503, message: "secret-internal-detail" },
      },
      genericMessage,
    ],
    [{ body: { message: "secret-internal-detail" } }, genericMessage],
    [
      {
        response: { status: 409 },
        body: { message: { detail: "secret-internal-detail" } },
      },
      genericMessage,
    ],
  ]) {
    const env = environment();
    try {
      await env.component("collection");
      await act(async () =>
        endpoint(env, "collection")[0].reject({ statusCode: 404 }),
      );
      await act(async () => endpoint(env, "setup")[0].resolve(setupState()));
      let save;
      await act(async () => {
        save = env.tree.root.findByType("EuiButton").props.onClick();
      });
      await act(async () => {
        endpoint(env, "setup", "POST")[0].reject(failure);
        await save;
      });
      assert.equal(
        env.tree.root.findByType("EuiCallOut").props.title,
        expected,
      );
      assert.equal(
        env.tree.root.findByType("EuiButton").props.isDisabled,
        false,
      );
    } finally {
      await env.close();
    }
  }
});
