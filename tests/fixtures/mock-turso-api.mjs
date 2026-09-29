#!/usr/bin/env node
/**
 * خادم Turso Platform API وهمي — للاختبارات فقط (`tests/deploy-tools.test.ts`).
 *
 * يعمل في **عملية مستقلة** عن ملف الاختبار عمدًا: الاختبارات تشغّل السكربتات بـ
 * `spawnSync` (المتزامن يحبس حلقة الأحداث)، فلو عاش الخادم داخل عملية الاختبار
 * لما خدم أي طلب قبل انتهاء الطفل — ولكان كل نداء مهلةً كاملة.
 *
 * الإعداد كله من البيئة (لا argv — نفس قاعدة الأدوات الحقيقية: الأسرار والمعطيات
 * الحساسة لا تمرّ عبر وسائط سطر الأوامر المرئية في `ps`):
 *   MOCK_PORT_FILE    يُكتب فيه المنفذ عند بدء الاستماع (يقرؤه الاختبار)
 *   MOCK_LOG_FILE     يُضاف إليه سطر `METHOD /path` لكل نداء — وهو دليل الاختبار
 *                     على أن `--dry-run` لا يُرسل POST وأن المعاملة تُرسل واحدة
 *   MOCK_JWT          الرمز الذي يعيده نداء السكّ (يُبنيه الاختبار وقت التشغيل)
 *   MOCK_ORG / MOCK_DB / MOCK_DATABASES / MOCK_ORGS_COUNT
 *
 * المفاتيح في ردّ قائمة القواعد بأحرف كبيرة (`Name`/`Hostname`) كما يعيدها Turso
 * فعلًا — ليُختبر `pickField` على الشكل الحقيقي لا على شكل مُبسَّط.
 */
import fs from "node:fs";
import http from "node:http";

const portFile = process.env.MOCK_PORT_FILE ?? "";
const logFile = process.env.MOCK_LOG_FILE ?? "";
const mintedJwt = process.env.MOCK_JWT ?? "";
const org = process.env.MOCK_ORG ?? "elazamey";
const db = process.env.MOCK_DB ?? "aborof";
const databases = (process.env.MOCK_DATABASES ?? db).split(",").filter(Boolean);
const orgsCount = Number(process.env.MOCK_ORGS_COUNT ?? "1") || 1;

if (!portFile) {
  console.error("MOCK_PORT_FILE مطلوب");
  process.exit(2);
}
if (logFile) fs.writeFileSync(logFile, "");

const server = http.createServer((req, res) => {
  if (logFile) fs.appendFileSync(logFile, `${req.method} ${req.url}\n`);
  const send = (code, body) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  // ‏401 حقيقي لرمز غير صالح الشكل: رموز المنصة JWT، فيُرفض أي شيء آخر — وهذا ما
  // يجعل مسار «رمز المنصة مرفوض» قابلًا للاختبار بدل قبول أي نص بعد Bearer.
  const bearer = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(bearer)) {
    return send(401, { error: "unauthorized: invalid api token" });
  }

  if (req.method === "GET" && url.pathname === "/v1/organizations") {
    return send(200, {
      organizations: Array.from({ length: orgsCount }, (_, index) => ({
        name: index === 0 ? org : `org-${index}`,
        slug: index === 0 ? org : `org-${index}`,
        type: "personal",
      })),
    });
  }
  if (req.method === "GET" && url.pathname === `/v1/organizations/${org}/databases`) {
    return send(200, {
      databases: databases.map((name) => ({
        Name: name,
        DbId: "0eb771dd-6906-11ee-8553-eaa7715aeaf2",
        Hostname: `${name}-${org}.turso.io`,
        group: "default",
      })),
    });
  }
  if (req.method === "GET" && url.pathname === `/v1/organizations/${org}/databases/${db}`) {
    return send(200, { database: { Name: db, DbId: "id", Hostname: `${db}-${org}.turso.io`, group: "default" } });
  }
  if (req.method === "POST" && url.pathname === `/v1/organizations/${org}/databases/${db}/auth/tokens`) {
    if (!mintedJwt) return send(500, { error: "MOCK_JWT غير مُعيَّن" });
    return send(200, { jwt: mintedJwt });
  }
  return send(404, { error: `not found: ${url.pathname}` });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  fs.writeFileSync(portFile, String(typeof address === "object" && address ? address.port : 0));
});
