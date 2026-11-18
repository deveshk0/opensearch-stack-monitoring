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
  try {
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1000 },
    });
    await page.goto("http://localhost:5602/app/stackMonitoring");
    await page.getByPlaceholder("Username", { exact: true }).fill("monitor");
    await page
      .getByPlaceholder("Password", { exact: true })
      .fill(env.MONITORING_READER_PASSWORD);
    await page.getByPlaceholder("Password", { exact: true }).press("Enter");
    await page.waitForSelector(".sm-time-controls");
    const confirm = page.getByRole("button", { name: "Confirm", exact: true });
    if (await confirm.isVisible())
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        confirm.click(),
      ]);
    await page.waitForSelector(".sm-time-controls");
    const asset = await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .map((r) => r.name)
        .find((url) =>
          url.includes("/plugin/stackMonitoring/stackMonitoring.chunk.0.js"),
        ),
    );
    assert(asset, "Monitoring application chunk loaded");
    const buildId = new URL(asset).pathname.split("/")[1];
    if (process.env.WAIT_FOR_REDEPLOY === "1") {
      fs.writeFileSync(
        ".cache/cache-test-ready.json",
        JSON.stringify({ buildId, asset }),
      );
      console.log(
        "Browser cache warmed; waiting for redeploy. Build:",
        buildId,
      );
      const deadline = Date.now() + 180000;
      let changed = false;
      while (Date.now() < deadline) {
        try {
          const response = await page.request.get(
            "http://localhost:5602/api/status",
          );
          if (
            response.status() === 200 &&
            String((await response.json()).version.build_number) !== buildId
          ) {
            changed = true;
            break;
          }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      assert(changed, "Redeploy must change the asset build identity");
      await page.reload();
      await page.waitForSelector(".sm-time-controls");
      const newAsset = await page.evaluate(() =>
        performance
          .getEntriesByType("resource")
          .map((r) => r.name)
          .find((url) =>
            url.includes("/plugin/stackMonitoring/stackMonitoring.chunk.0.js"),
          ),
      );
      assert(
        newAsset && newAsset !== asset,
        "Normal reload must request a new application URL",
      );
      assert(
        (await page.locator(".sm-time-controls").boundingBox()).width <= 560,
      );
      console.log(
        "PASS cached-browser normal reload fetched new assets:",
        new URL(newAsset).pathname,
      );
    } else {
      assert.notEqual(
        buildId,
        "9054",
        "Custom image must not reuse upstream long-lived asset URLs",
      );
      console.log("PASS custom deployment has distinct asset URLs:", buildId);
    }
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
