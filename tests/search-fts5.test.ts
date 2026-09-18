import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createClient, type Client } from "@libsql/client";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildFtsMatch, ftsProductIds, ensureProductSearchInSync } from "../src/lib/search";
import { runMigrations } from "../src/lib/db/migrate";

/**
 * فهرس البحث FTS5 (هجرة 0002) — الحراسة:
 *  - الهجرة تُنشئ الجدول الافتراضي وتعبئه من المنتجات القائمة.
 *  - بناء الاستعلام آمن (كلمات مقتبسة) ولا يُمرَّر نص العميل خامًا إلى MATCH.
 *  - المزامنة تُبنى مرة واحدة ولا تُفشل التطبيق عند غياب دعم FTS5.
 */

function fileClient(): Client {
  const file = path.join(tmpdir(), `aborof-fts-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  return createClient({ url: `file:${file}` });
}

describe("migration 0002_search_fts5", () => {
  let client: Client;

  beforeEach(() => {
    client = fileClient();
  });

  test("creates the virtual table and backfills from products", async () => {
    await runMigrations(client);
    await client.execute({
      sql: "INSERT INTO products (id,name,description,category,price,stock) VALUES (?,?,?,?,?,?)",
      args: ["p1", "منظف أرضيات برائحة اللافندر", "يزيل الدهون والأتربة", "منظفات أرضيات", 180, 10],
    });
    await client.execute({
      sql: "INSERT INTO products (id,name,description,category,price,stock) VALUES (?,?,?,?,?,?)",
      args: ["p2", "سائل غسيل أطباق ليمون", "رغوة كثيفة", "منظفات مطابخ", 70, 10],
    });

    await ensureProductSearchInSync(client);
    const ids = await ftsProductIds(client, "منظف أرضيات", 5);
    assert.ok(ids.includes("p1"));
  });

  test("match query is built safely (quoted words, no raw syntax)", () => {
    const match = buildFtsMatch('منظف "خطر" *drop');
    // كلمات مقتبسة ولا رموز FTS خاصة خام.
    assert.ok(match.includes('"منظف"'));
    assert.ok(!match.includes("*"));
    assert.ok(!match.includes("drop;"));
  });

  test("no-match query returns no ids", async () => {
    await runMigrations(client);
    const ids = await ftsProductIds(client, "غيرموجودإطلاقا", 5);
    assert.deepEqual(ids, []);
  });
});
