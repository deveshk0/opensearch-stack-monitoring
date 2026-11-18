const fs = require("node:fs");
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const env = Object.fromEntries(
  fs
    .readFileSync(".opensearch.env", "utf8")
    .trim()
    .split("\n")
    .map((line) => line.split("=")),
);
(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
  });
  try {
    await page.goto(
      "http://localhost:5602/app/stackMonitoring#/overview?paused=true",
    );
    await page.getByPlaceholder("Username", { exact: true }).fill("monitor");
    await page
      .getByPlaceholder("Password", { exact: true })
      .fill(env.MONITORING_READER_PASSWORD);
    await page.getByPlaceholder("Password", { exact: true }).press("Enter");
    await page.waitForSelector(".sm-status");
    const confirm = page.getByRole("button", { name: "Confirm", exact: true });
    if (await confirm.isVisible())
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        confirm.click(),
      ]);
    await page
      .getByRole("button", { name: "Self-monitoring", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Disable self-monitoring", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Enable self-monitoring", exact: true })
      .waitFor();
    await page
      .getByText("Self-monitoring is disabled", { exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Enable self-monitoring", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Disable self-monitoring", exact: true })
      .waitFor();
    const response = await page.request.get(
      "http://localhost:5602/api/stack_monitoring/collection",
    );
    const status = await response.json();
    assert(status.enabled && status.last_success);
    assert.equal(status.index_pattern, "stack-monitoring-v1-*,stack-monitoring-v2-*");
    await page
      .getByText("Self-monitoring is disabled", { exact: true })
      .waitFor({ state: "hidden" });
    await page.locator(".sm-time-controls").getByText("Refresh", {exact:true}).waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({
      path: "docs/reference/opensearch/self-monitoring.png",
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await page
      .locator(".sm-status")
      .screenshot({ path: "docs/reference/opensearch/status-alignment.png" });
    console.log(
      "PASS self-monitoring UI enables/disables collection and displays the persisted destination",
    );
  } finally {
    await page.request
      .post("http://localhost:5602/api/stack_monitoring/collection", {
        headers: { "osd-xsrf": "test" },
        data: { enabled: true },
      })
      .catch(() => {});
    await browser.close();
  }
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
