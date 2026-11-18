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
  page.setDefaultTimeout(15000);
  const errors = [];
  let hostPermissionErrors = 0;
  page.on("response", (r) => {
    if (
      r.status() === 403 &&
      new URL(r.url()).pathname === "/api/dataconnections"
    )
      hostPermissionErrors++;
    if (r.url().includes("/api/stack_monitoring/") && r.status() >= 400)
      errors.push(`${r.status()} ${r.url()}`);
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
    await page.waitForTimeout(500);
    page.on("pageerror", (e) => errors.push(e.message));
    await page.getByRole("tab", { name: "Insights", exact: true }).click();
    await page
      .getByRole("heading", { name: "Insights", exact: true })
      .waitFor();
    await page.locator(".sm-insight-summary").waitFor();
    const response = await page.request.get(
      "http://localhost:5602/api/stack_monitoring/insights",
    );
    assert.equal(response.status(), 200);
    const data = await response.json();
    if (process.env.INSIGHT_ID) {
      const incident = data.incidents.find(
        (i) => i.id === process.env.INSIGHT_ID,
      );
      assert(incident, "Controlled test incident visible");
      assert.equal(incident.status, process.env.INSIGHT_STATUS || "active");
      await page
        .getByRole("button", { name: "Shards remain unassigned", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "Recommended next steps", exact: true })
        .waitFor();
      await page
        .getByText(
          "Use the Cluster Allocation Explain API to identify the allocation deciders.",
          { exact: true },
        )
        .waitFor();
      await page.waitForSelector(".sm-chart-canvas");
      const link = page.getByRole("link", {
        name: "Open related monitoring charts",
      });
      assert(
        (await link.getAttribute("href")).startsWith("#/opensearch?from="),
      );
      await page.waitForTimeout(400);
      await page.screenshot({
        animations: "disabled",
        path: `docs/reference/opensearch/insights-${incident.status}-detail.png`,
        fullPage: true,
      });
      await link.click();
      await page
        .getByRole("heading", { name: "OpenSearch overview", exact: true })
        .waitFor();
      assert(page.url().includes("paused=true"));
      await page.evaluate(() => {
        location.hash = "#/insights?paused=true";
      });
      await page.locator(".sm-insight-summary").waitFor();
      await page
        .getByRole("searchbox", { name: "Search insights" })
        .fill("no-such-finding-xyz");
      await page
        .getByRole("heading", { name: "No matching findings" })
        .waitFor();
      await page.getByRole("searchbox", { name: "Search insights" }).fill("");
      await page
        .getByRole("combobox", { name: "Finding status" })
        .selectOption(incident.status);
      await page
        .getByRole("button", { name: "Shards remain unassigned", exact: true })
        .waitFor();
    }
    await page.getByRole("button", { name: "What is checked?" }).click();
    assert.equal(await page.locator(".sm-insight-rules > div").count(), 9);
    await page.waitForTimeout(400);
    await page.screenshot({
      animations: "disabled",
      path: `docs/reference/opensearch/insights-${process.env.INSIGHT_STATUS || "overview"}.png`,
      fullPage: true,
    });
    const picker = await page.locator(".sm-time-controls").boundingBox();
    assert(picker.width <= 561);
    await page.setViewportSize({ width: 390, height: 844 });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      "No horizontal overflow",
    );
    await page.waitForTimeout(400);
    await page.screenshot({
      animations: "disabled",
      path: "docs/reference/opensearch/insights-mobile.png",
      fullPage: true,
    });
    assert(
      errors.every((e) => e === "Forbidden") &&
        errors.length <= hostPermissionErrors,
      `Unexpected browser errors: ${errors.join(", ")}`,
    );
    console.log(
      "PASS Insights UI: real API, finding details, evidence chart, chart link, filters, rules, mobile and compact date picker",
    );
  } catch (error) {
    await page.waitForTimeout(400);
    await page
      .screenshot({
        animations: "disabled",
        path: ".cache/insights-browser-error.png",
        fullPage: true,
      })
      .catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
