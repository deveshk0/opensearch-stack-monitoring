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
(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1892, height: 913 },
    });
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
    await page.waitForSelector(".sm-status");
    await page.getByText("No log data found", { exact: true }).waitFor();
    await page.waitForTimeout(400);
    for (const width of [1892, 1600, 1024, 390]) {
      await page.setViewportSize({ width, height: 913 });
      await page.waitForTimeout(300);
      await page.evaluate(() => window.scrollTo(0, 0));
      const layout = await page.evaluate(() => {
        const box = (s) =>
          document.querySelector(s).getBoundingClientRect().toJSON();
        const picker =
          document.querySelector(".sm-time-controls") ||
          document.querySelector(".euiSuperDatePicker__flexWrapper");
        return {
          picker: picker.getBoundingClientRect().toJSON(),
          title: box(".sm-heading h1"),
          first: box(".sm-cards .sm-card"),
          second: box(".sm-cards-two .sm-card"),
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
          height: document.documentElement.scrollHeight,
          statusText: Array.from(document.querySelector(".sm-status").children)
            .slice(0, 6)
            .flatMap((element) => {
              const walker = document.createTreeWalker(
                element,
                NodeFilter.SHOW_TEXT,
              );
              const items = [];
              let node;
              while ((node = walker.nextNode()))
                if (node.textContent.trim()) {
                  const range = document.createRange();
                  range.selectNodeContents(node);
                  const rect = range.getBoundingClientRect();
                  items.push({
                    text: node.textContent,
                    center: rect.y + rect.height / 2,
                    font: getComputedStyle(node.parentElement).fontSize,
                  });
                }
              return items;
            }),
        };
      });
      assert(!layout.overflow, `Horizontal overflow at ${width}`);
      if (width >= 1024) {
        const centers = layout.statusText.map((t) => t.center);
        assert(
          Math.max(...centers) - Math.min(...centers) <= 1,
          `Status text misaligned at ${width}: ${JSON.stringify(layout.statusText)}`,
        );
      }
      assert(
        layout.picker.width <= 560,
        `Time picker stretches to ${layout.picker.width}px at ${width}`,
      );
      assert(
        Math.abs(layout.first.width - layout.second.width) < 2,
        `Summary cards differ in width at ${width}`,
      );
      if (width >= 1600)
        assert(
          layout.height <= 913,
          `Overview unnecessarily scrolls at ${width}`,
        );
      await page.screenshot({
        path: `docs/reference/opensearch/layout-${width}.png`,
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1600, height: 913 });
    await page.evaluate(() => {
      location.hash = "#/opensearch?paused=true";
    });
    await page
      .getByRole("heading", { level: 1, name: "OpenSearch overview" })
      .waitFor();
    await page.evaluate(() => window.scrollTo(0, 500));
    await page.evaluate(() => {
      location.hash = "#/overview?paused=true";
    });
    await page
      .getByRole("heading", { level: 1, name: "Cluster overview" })
      .waitFor();
    await page.waitForFunction(() => window.scrollY === 0);
    console.log(
      "PASS: compact toolbar, aligned cards, desktop fit, mobile width, and navigation scroll reset",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
