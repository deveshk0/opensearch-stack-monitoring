const fs = require("node:fs");
const assert = require("node:assert/strict");
const { chromium, request } = require(
  process.env.PLAYWRIGHT_MODULE || "playwright",
);
const env = Object.fromEntries(
  fs
    .readFileSync(".opensearch.env", "utf8")
    .trim()
    .split("\n")
    .map((s) => s.split("=")),
);
(async () => {
  const admin = await request.newContext({
    baseURL: "http://localhost:5602",
    extraHTTPHeaders: {
      authorization:
        "Basic " +
        Buffer.from("admin:" + env.OPENSEARCH_ADMIN_PASSWORD).toString(
          "base64",
        ),
      "osd-xsrf": "theme-test",
      securitytenant: "global",
    },
  });
  const before = await (
    await admin.get("/api/opensearch-dashboards/settings")
  ).json();
  const original = before.settings["theme:darkMode"];
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    assert.equal(
      (
        await admin.post("/api/opensearch-dashboards/settings", {
          data: { changes: { "theme:darkMode": true } },
        })
      ).status(),
      200,
    );
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1000 },
    });
    await page.goto("http://localhost:5602/app/stackMonitoring");
    await page.getByPlaceholder("Username", { exact: true }).fill("monitor");
    await page
      .getByPlaceholder("Password", { exact: true })
      .fill(env.MONITORING_READER_PASSWORD);
    await page.getByPlaceholder("Password", { exact: true }).press("Enter");
    await page.waitForSelector(".sm-status");
    const confirm = page.getByRole("button", { name: "Confirm", exact: true });
    if (await confirm.isVisible({ timeout: 3000 }).catch(() => false))
      await Promise.all([page.waitForNavigation({waitUntil:"domcontentloaded"}), confirm.click()]);
    await page.evaluate(() => {
      location.hash = "#/opensearch?paused=true";
    });
    await page
      .getByRole("heading", { level: 1, name: "OpenSearch overview" })
      .waitFor();
    await page.waitForSelector(".sm-chart-canvas");
    await page.waitForTimeout(500);
    const color = await page
      .locator(".sm-app")
      .evaluate((e) => getComputedStyle(e).backgroundColor);
    console.log("Dark page background", color);
    assert(
      color.match(/rgb\((\d+)/) && Number(color.match(/rgb\((\d+)/)[1]) < 100,
    );
    await page.screenshot({
      path: "docs/reference/opensearch/dark.png",
      fullPage: true,
    });
    await page.evaluate(() => { location.hash = "#/insights?paused=true"; });
    await page.getByRole("heading", { level: 1, name: "Insights", exact: true }).waitFor();
    await page.waitForSelector(".sm-insight-summary");
    await page.screenshot({ path: "docs/reference/opensearch/insights-dark.png", fullPage: true, animations: "disabled" });
    console.log("PASS native dark theme for monitoring and Insights");
  } finally {
    const restored = original
      ? await admin.post("/api/opensearch-dashboards/settings", {
          data: { changes: { "theme:darkMode": original.userValue } },
        })
      : await admin.delete(
          "/api/opensearch-dashboards/settings/" +
            encodeURIComponent("theme:darkMode"),
        );
    assert.equal(restored.status(), 200, "Restore original theme");
    await browser.close();
    await admin.dispose();
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
