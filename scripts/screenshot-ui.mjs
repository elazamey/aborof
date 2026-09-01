// TEMPORARY TOOL — captures screenshots of the current UI (desktop + mobile).
// Used by .github/workflows/screenshot-ui.yml; removed together with it.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = "http://127.0.0.1:3199";
const OUT = "/tmp/ui-shots";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();

async function capture(name, path, { width, height }, fullPage) {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE + path, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage });
  console.log(
    `[shot] ${name} (${width}x${height}${fullPage ? ", fullPage" : ""}) console-errors=${errors.length ? errors.join(" | ") : "none"}`
  );
  await page.close();
}

// Desktop (1440x900)
await capture("home-desktop", "/", { width: 1440, height: 900 }, false);
await capture("home-desktop-full", "/", { width: 1440, height: 900 }, true);
await capture("product-desktop-full", "/product/p1", { width: 1440, height: 900 }, true);

// Mobile (390x844 — iPhone-class viewport)
await capture("home-mobile-full", "/", { width: 390, height: 844 }, true);
await capture("product-mobile-full", "/product/p1", { width: 390, height: 844 }, true);

// Chat agent panel open (desktop home)
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(BASE + "/", { waitUntil: "networkidle" });
await page.click("button.fab.bot");
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/home-desktop-chat-open.png` });
await page.close();

await browser.close();
console.log("DONE");
