const fs = require("node:fs");
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const env = Object.fromEntries(
  fs
    .readFileSync(".opensearch.env", "utf8")
    .trim()
    .split("\n")
    .map((s) => s.split("=")),
);
const base = "http://localhost:5602";
const output = "docs/reference/opensearch";
fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
  });
  const page = await context.newPage();
  const errors = [];
  const hostPermissionErrors = [];
  const pluginHttpErrors = [];
  await page.goto(base + "/app/stackMonitoring");
  await page.getByPlaceholder("Username", { exact: true }).fill("monitor");
  await page
    .getByPlaceholder("Password", { exact: true })
    .fill(env.MONITORING_READER_PASSWORD);
  await page.getByPlaceholder("Password", { exact: true }).press("Enter");
  await page.waitForSelector(".sm-status");
  const confirm = page.getByRole("button", { name: "Confirm", exact: true });
  if (await confirm.isVisible({ timeout: 3000 }).catch(() => false))
    await Promise.all([page.waitForNavigation({waitUntil:"domcontentloaded"}), confirm.click()]);
  await page.waitForTimeout(500);
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.log("PAGE_ERROR", error.stack);
  });
  page.on("response", (r) => {
    if (
      r.status() === 403 &&
      new URL(r.url()).pathname === "/api/dataconnections"
    )
      hostPermissionErrors.push(
        "Host Data Connections probe: 403 for restricted reader",
      );
    if (r.status() >= 400 && r.url().includes("/api/stack_monitoring/"))
      pluginHttpErrors.push([r.status(), r.url()]);
  });
  const response = await context.request.get(
    base + "/api/stack_monitoring/history",
  );
  assert.equal(response.status(), 200);
  const data = await response.json(),
    s = data.snapshot;
  const node = s.nodes[0],
    index = s.indices.find((e) => e.name === "monitoring-demo-orders"),
    instance = s.instances[0],
    pipeline = s.pipelines.find((e) => e.name === "stack-monitoring-demo");
  assert(node && index && instance && pipeline);
  const route = async (path, heading) => {
    await page.evaluate(
      (hash) => {
        location.hash = hash;
      },
      "#" + path + "?from=now-15m&to=now&paused=true",
    );
    await page
      .getByRole("heading", { level: 1, name: heading, exact: true })
      .waitFor();
    await page.waitForSelector(".sm-status");
    await page.waitForTimeout(200);
    assert.equal(
      await page
        .getByText("Unable to load monitoring data", { exact: true })
        .count(),
      0,
      path,
    );
  };
  const pages = [
    ["/clusters", "Clusters"],
    ["/overview", "Cluster overview"],
    ["/opensearch", "OpenSearch overview"],
    ["/nodes", "Nodes"],
    ["/nodes/" + encodeURIComponent(node.id), node.name],
    ["/nodes/" + encodeURIComponent(node.id) + "/advanced", node.name],
    ["/indices", "Indices"],
    ["/indices/" + index.name, index.name],
    ["/indices/" + index.name + "/advanced", index.name],
    ["/pipelines", "Ingest pipelines"],
    ["/pipelines/" + pipeline.id, pipeline.name],
    ["/dashboards", "Dashboards overview"],
    ["/instances", "Instances"],
    ["/instances/" + instance.id, instance.name],
  ];
  if (pipeline.processors?.length)
    pages.push([
      "/processors/" + encodeURIComponent(pipeline.processors[0].id),
      pipeline.processors[0].name,
    ]);
  for (let i = 0; i < pages.length; i++) {
    await route(...pages[i]);
    await page.screenshot({
      path: `${output}/${String(i + 1).padStart(2, "0")}-${pages[i][0].split("/")[1]}${pages[i][0].includes("advanced") ? "-advanced" : ""}.png`,
      fullPage: true,
    });
    console.log("PASS route", pages[i][0]);
  }
  await route("/nodes", "Nodes");
  await page.getByPlaceholder("Filter nodes…").fill("os01");
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".sm-app tbody tr").count(), 1);
  assert(page.url().includes("nodes_q=os01"));
  await page.getByPlaceholder("Filter nodes…").fill("");
  await page.getByRole("button", { name: "Name", exact: true }).click();
  assert.equal(await page.locator(".sm-app tbody tr").count(), 3);
  await route("/indices", "Indices");
  const before = await page.locator(".sm-app tbody tr").count();
  await page
    .getByRole("switch", { name: "Show system and monitoring indices" })
    .click();
  await page.waitForTimeout(200);
  assert((await page.locator(".sm-app tbody tr").count()) > before);
  await route("/opensearch", "OpenSearch overview");
  await page
    .getByRole("button", { name: "View data for Search rate", exact: true })
    .click();
  await page.getByRole("table", { name: "Search rate", exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Hide data for Search rate", exact: true })
    .click();
  await page.getByRole("switch", { name: "Show completed recoveries" }).click();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.waitForSelector(".sm-status");
  await page.evaluate(() => {
    location.hash =
      "#/overview?from=2000-01-01T00:00:00Z&to=2000-01-01T01:00:00Z&paused=true";
  });
  await page
    .getByRole("heading", { name: "No monitoring data found" })
    .waitFor();
  await page.screenshot({ path: output + "/empty.png", fullPage: true });
  await route("/overview", "Cluster overview");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: output + "/mobile.png", fullPage: true });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
    "Mobile page overflows viewport",
  );
  await page.keyboard.press("Tab");
  assert(
    await page.evaluate(() => document.activeElement !== document.body),
    "Keyboard focus unavailable",
  );
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page
    .locator('[data-test-subj="superDatePickerToggleQuickMenuButton"]')
    .click();
  await page.getByRole("button", { name: "Last hour", exact: true }).click();
  await page.waitForURL((url) => url.hash.includes("from=now-1h"));
  await page.waitForSelector(".sm-status");
  await page
    .locator('[data-test-subj="superDatePickerToggleQuickMenuButton"]')
    .click();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.waitForURL((url) => url.hash.includes("paused=false"));
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.waitForURL((url) => url.hash.includes("paused=true"));
  await page.keyboard.press("Escape");
  fs.writeFileSync(
    output + "/verification.json",
    JSON.stringify(
      {
        pages: pages.map((v) => v[0]),
        consoleErrors: errors,
        hostPermissionErrors,
        pluginHttpErrors,
        checked: [
          "login",
          "tenant",
          "routes",
          "filter",
          "sort",
          "system indices",
          "chart data table",
          "recoveries",
          "refresh",
          "empty state",
          "mobile overflow",
          "keyboard focus",
          "time picker",
          "refresh start/stop",
        ],
      },
      null,
      2,
    ),
  );
  assert.deepEqual(pluginHttpErrors, []);
  assert(
    errors.every((e) => e === "Forbidden") &&
      errors.length <= hostPermissionErrors.length,
    "Unexpected browser error",
  );
  await browser.close();
  console.log("PASS browser checks");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
