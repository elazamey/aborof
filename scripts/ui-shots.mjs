// لقطات شاشة للتحقق البصري (Desktop 1440×900 + Mobile 390×844).
// يتطلب متصفحًا: npx playwright-core install chromium
// التشغيل: node scripts/ui-shots.mjs <BASE_URL>  (افتراضي http://localhost:3000)
// الإخراج: evidence/ui-cinematic/shots/
import { chromium } from "playwright-core";
import { mkdirSync } from "fs";
import { join } from "path";

const BASE = process.argv[2] || "http://localhost:3000";
const OUT = join(process.cwd(), "evidence/ui-cinematic/shots");
mkdirSync(OUT, { recursive: true });

const routes = [
  ["home", "/"],
  ["product", "/product/p1"],
  ["cart", "/cart"],
  ["admin", "/admin"],
];

const viewports = [
  ["desktop", { width: 1440, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
];

const browser = await chromium.launch({ headless: true });
for (const [vname, vp] of viewports) {
  const page = await browser.newPage({ viewport: vp });
  for (const [rname, route] of routes) {
    const res = await page.goto(BASE + route, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(1200); // انتظار دخول الحركات (hero fade/float)
    const file = join(OUT, `${vname}-${rname}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`${vname} ${route} → ${res?.status()} ${file}`);
  }
  await page.close();
}
await browser.close();
console.log("DONE");
