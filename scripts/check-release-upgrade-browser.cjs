const fs = require("node:fs");
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const config = JSON.parse(fs.readFileSync(process.env.UPGRADE_BROWSER_CONFIG, "utf8"));
let stage = "launch";
(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    const confirm = page.getByRole("button", { name: "Confirm", exact: true });
    await page.addLocatorHandler(confirm, async () => { await confirm.click(); });
    async function open(reload) {
      const phase = reload ? "reload" : "baseline";
      stage = phase + "_navigation";
      if (reload) await page.reload();
      else await page.goto(config.base + "/app/stackMonitoring#/opensearch?from=now-15m&to=now&paused=true");
      stage = phase + "_login";
      const username = page.getByPlaceholder("Username", { exact: true });
      await Promise.race([username.waitFor(), page.locator(".sm-app").waitFor()]);
      if (await username.isVisible()) {
        await username.fill("admin");
        const password = page.getByPlaceholder("Password", { exact: true });
        await password.fill(config.password);
        await password.press("Enter");
      }
      stage = phase + "_app";
      await page.locator(".sm-app").waitFor();
      stage = phase + "_tab";
      await page.getByRole("tab", { name: "OpenSearch", exact: true }).click();
      stage = phase + "_canvas";
      await page.locator(".sm-chart-canvas canvas").first().waitFor();
      stage = phase + "_control";
      await page.getByRole("button", { name: "Self-monitoring", exact: true }).waitFor();
      stage = phase + "_table";
      const chart = page.locator(".sm-chart").filter({ has: page.locator(".sm-chart-canvas") }).first();
      const title = await chart.locator("h3").innerText();
      await chart.getByRole("button", { name: /^View data for / }).click();
      await page.getByRole("table", { name: title, exact: true }).locator("tbody tr").first().waitFor();
      return page.evaluate(() => performance.getEntriesByType("resource").map(r => r.name)
        .find(url => url.includes("/plugin/stackMonitoring/stackMonitoring.chunk.0.js")));
    }
    stage = "baseline";
    const originalAsset = await open(false);
    assert.ok(originalAsset, "Baseline plugin chunk missing");
    const oldBuild = new URL(originalAsset).pathname.split("/")[1];
    fs.writeFileSync(config.ready, "ready", { mode: 0o600 });
    stage = "wait_for_replacement";
    const deadline = Date.now() + 240000;
    let newBuild;
    while (Date.now() < deadline) {
      try {
        const response = await context.request.get(config.base + "/api/status", {
          headers: { Authorization: "Basic " + Buffer.from("admin:" + config.password).toString("base64") },
          timeout: 5000,
        });
        if (response.status() === 200) {
          const value = String((await response.json()).version.build_number);
          if (value !== oldBuild) { newBuild = value; break; }
        }
      } catch {}
      await page.waitForTimeout(1000);
    }
    assert.ok(newBuild, "Replacement did not change the asset build identity");
    stage = "cached_reload";
    const asset = await open(true);
    assert.ok(asset && asset !== originalAsset, "Cached browser reused the previous plugin chunk");
    assert.equal(new URL(asset).pathname.split("/")[1], newBuild);
    console.log("PASS: cached-browser reload loaded the replacement plugin, chart and data table");
  } finally {
    await browser.close();
  }
})().catch(() => {
  console.error(`FAIL: browser stage ${stage}`);
  process.exitCode = 1;
});
