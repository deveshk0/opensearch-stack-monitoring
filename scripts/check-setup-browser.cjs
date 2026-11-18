const fs = require("node:fs");
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const config = JSON.parse(
  fs.readFileSync(process.env.SETUP_BROWSER_CONFIG, "utf8"),
);

let stage = "launch";
(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : { channel: process.env.PLAYWRIGHT_CHANNEL || "chrome" }),
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    const errors = [];
    let configured = false;
    let authenticated = false;
    page.on("pageerror", () => {
      if (authenticated) errors.push("page runtime error");
    });
    page.on("console", (message) => {
      if (
        authenticated &&
        message.type() === "error" &&
        !message.text().includes("Failed to load resource")
      )
        errors.push("browser console error");
    });
    page.on("response", (response) => {
      if (
        configured &&
        response.url().includes("/api/stack_monitoring/") &&
        response.status() >= 400
      )
        errors.push("monitoring API failure after setup");
    });
    stage = "login";
    await page.goto(config.base + "/app/stackMonitoring#/overview");
    await page.getByPlaceholder("Username", { exact: true }).fill("admin");
    await page
      .getByPlaceholder("Password", { exact: true })
      .fill(config.password);
    await page.getByPlaceholder("Password", { exact: true }).press("Enter");
    // The host tenant dialog can appear after the monitoring app has rendered.
    const confirm = page.getByRole("button", { name: "Confirm", exact: true });
    await page.addLocatorHandler(confirm, async () => { await confirm.click(); });
    await page.locator(".sm-app").waitFor({ timeout: 60000 });
    stage = "open_setup";
    const setupEntry = page.getByRole("button", {
      name: "Set up monitoring",
      exact: true,
    });
    await setupEntry.waitFor();
    // Security Dashboards can emit Unauthorized errors while its login page loads.
    authenticated = true;
    stage = "click_setup";
    await setupEntry.click();
    const setup = page
      .locator(".sm-collection-settings")
      .getByRole("button", { name: "Set up monitoring", exact: true });
    stage = "submit_setup";
    for (let attempt = 0; attempt < 6; attempt++) {
      const response = page.waitForResponse(
        (item) =>
          item.url().endsWith("/api/stack_monitoring/setup") &&
          item.request().method() === "POST",
        { timeout: 60000 },
      );
      await setup.click();
      const result = await response;
      if (result.status() === 200) {
        const body = await result.json();
        assert.equal(body.configured, true);
        assert.equal(body.managed, true);
        configured = true;
        break;
      }
      assert.ok(
        [409, 503].includes(result.status()),
        "Administrator setup unexpectedly denied",
      );
      await page.waitForTimeout(2000);
    }
    assert.ok(configured, "Setup did not complete through the button");
    await page.keyboard.press("Escape");
    stage = "charts";
    await page.getByRole("tab", { name: "OpenSearch", exact: true }).click();
    await page
      .locator(".sm-chart-canvas canvas")
      .first()
      .waitFor({ timeout: 120000 });
    assert.ok(
      await page.locator(".sm-chart-canvas canvas").count(),
      "Monitoring charts have no samples",
    );
    stage = "chart_table";
    const chart = page
      .locator(".sm-chart")
      .filter({ has: page.locator(".sm-chart-canvas") })
      .first();
    const chartTitle = await chart.locator("h3").innerText();
    await chart.getByRole("button", { name: /^View data for / }).click();
    const table = page.getByRole("table", { name: chartTitle, exact: true });
    await table.locator("tbody tr").first().waitFor();
    assert.ok(
      await table.locator("tbody tr").count(),
      "Accessible chart table has no samples",
    );
    stage = "history";
    const history = await context.request.get(
      config.base + "/api/stack_monitoring/history",
    );
    assert.equal(history.status(), 200);
    const body = await history.json();
    assert.ok(
      body.snapshot && body.series.length && body.collection.last_success,
    );
    stage = "console_and_runtime_errors";
    assert.deepEqual(
      errors,
      [],
      "Browser reported runtime, console or monitoring errors",
    );
    console.log(
      "PASS: administrator login, first-run setup button and populated chart/table",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  const message = String(error?.message || "");
  const cause = message.includes("intercepts pointer events") ? "overlay" :
    message.includes("strict mode violation") ? "ambiguous_locator" :
    message.includes("Timeout") ? "timeout" : "assertion_or_runtime";
  console.error(`Browser diagnostic: ${cause}`);
  console.error(`FAIL: browser stage ${stage}`);
  process.exitCode = 1;
});
