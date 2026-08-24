import fs from "node:fs";
import path from "node:path";

const root = path.resolve("src/app");
const routeFiles = new Set(["page.tsx", "page.ts", "page.jsx", "page.js", "route.ts", "route.js"]);
const rows = [];

function walk(dir, segments = []) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith("_") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, [...segments, entry.name]);
    else if (routeFiles.has(entry.name)) {
      const isApi = entry.name.startsWith("route.");
      const visible = segments
        .filter((s) => !(s.startsWith("(") && s.endsWith(")")))
        .join("/");
      const route = `/${visible}`.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
      const dynamic = segments.some((s) => s.startsWith("[") && s.endsWith("]"));
      const content = fs.readFileSync(full, "utf8");
      const protectedRoute = route.startsWith("/admin") || route.startsWith("/api/admin");
      const usesDb = /(?:from|require\()\s*["'][^"']*(?:db|seed)["']/.test(content) || /getProducts|getOrders|db\./.test(content);
      rows.push({
        route,
        type: isApi ? "API" : dynamic ? "Dynamic page" : "Page",
        auth: protectedRoute ? "Yes" : "No",
        db: usesDb ? "Yes" : "Unknown",
        file: path.relative(process.cwd(), full),
      });
    }
  }
}

walk(root);
rows.sort((a, b) => a.route.localeCompare(b.route));

if (!rows.length) {
  console.error("No Next.js routes found under src/app");
  process.exit(1);
}

console.log("# Route Inventory\n");
console.log("| Route | Type | Auth | DB signal | Source |");
console.log("|---|---|---:|---:|---|");
for (const row of rows) console.log(`| \`${row.route}\` | ${row.type} | ${row.auth} | ${row.db} | \`${row.file}\` |`);
console.log(`\nDiscovered ${rows.length} route files.`);

if (process.argv.includes("--check")) {
  const required = ["/", "/admin", "/api/orders", "/api/products"];
  const found = new Set(rows.map((row) => row.route));
  const missing = required.filter((route) => !found.has(route));
  if (missing.length) {
    console.error(`Missing required routes: ${missing.join(", ")}`);
    process.exit(1);
  }
}
