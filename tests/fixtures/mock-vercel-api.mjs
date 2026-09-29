#!/usr/bin/env node
/**
 * خادم Vercel REST API وهمي — للاختبارات فقط (`tests/vercel-deploy-link.test.ts`).
 *
 * يعمل في **عملية مستقلة** عن ملف الاختبار عمدًا، لنفس السبب الموثّق في
 * mock-turso-api.mjs: الاختبارات تشغّل الأدوات بـ `spawnSync` (المتزامن يحبس
 * حلقة الأحداث)، فلو عاش الخادم داخل عملية الاختبار لما خدم أي طلب قبل انتهاء
 * الطفل — ولكان كل نداء مهلة كاملة (20 ثانية).
 *
 * الإعداد كله من البيئة (لا argv — نفس قاعدة الأدوات الحقيقية: المعطيات لا تمرّ
 * عبر وسائط سطر الأوامر المرئية في `ps`):
 *   MOCK_PORT_FILE  يُكتب فيه المنفذ عند بدء الاستماع (يقرؤه الاختبار)
 *   MOCK_LOG_FILE   يُضاف إليه سطر `METHOD /path?query` لكل نداء — وهو دليل
 *                   الاختبار على أن الرفض الشكلي يحدث **بلا** أي نداء شبكة
 *   MOCK_SCENARIO   مستند JSON واحد يصف الردود كلها (أدناه)
 *
 * شكل MOCK_SCENARIO:
 * {
 *   "userStatus": 200, "username": "canyoudfg-3243", "uid": "usr_…",
 *   "teams": ["team_…"], "teamsStatus": 200,
 *   "projects": { "": [ {name,id,accountId} ], "team_…": [ … ] },   // "" = النطاق الافتراضي
 *   "projectListStatus": { "team_…": 403 },                          // سرد مرفوض لنطاق
 *   "resolved": { "<projectId>|<teamId أو فارغ>": {status,name,framework} },
 *   "defaultLookup": { "status": 404, "message": "Project not found" }
 * }
 */
import fs from "node:fs";
import http from "node:http";

const portFile = process.env.MOCK_PORT_FILE ?? "";
const logFile = process.env.MOCK_LOG_FILE ?? "";

if (!portFile) {
  console.error("MOCK_PORT_FILE مطلوب");
  process.exit(2);
}

let scenario = {};
try {
  scenario = JSON.parse(process.env.MOCK_SCENARIO ?? "{}");
} catch (error) {
  console.error("MOCK_SCENARIO ليس JSON صالحًا:", error.message);
  process.exit(2);
}
if (logFile) fs.writeFileSync(logFile, "");

const userStatus = Number(scenario.userStatus ?? 200);
const username = String(scenario.username ?? "canyoudfg-3243");
const uid = String(scenario.uid ?? "usr_personal_uid_0001");
const teams = Array.isArray(scenario.teams) ? scenario.teams : [];
const teamsStatus = Number(scenario.teamsStatus ?? 200);
const projectsByScope = scenario.projects ?? {};
const projectListStatus = scenario.projectListStatus ?? {};
const resolved = scenario.resolved ?? {};
const defaultLookup = scenario.defaultLookup ?? { status: 404, message: "Project not found" };

const server = http.createServer((req, res) => {
  if (logFile) fs.appendFileSync(logFile, `${req.method} ${req.url}\n`);
  const send = (code, body) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const teamId = url.searchParams.get("teamId") ?? "";

  if (url.pathname === "/v2/user") {
    if (userStatus !== 200) return send(userStatus, { error: { message: "Insufficient permissions", code: "forbidden" } });
    return send(200, { user: { username, uid, email: "owner@example.test" } });
  }

  if (url.pathname === "/v2/teams") {
    if (teamsStatus !== 200) return send(teamsStatus, { error: { message: "forbidden" } });
    return send(200, { teams: teams.map((id) => ({ id, slug: String(id).replace(/^team_/, "") })) });
  }

  if (url.pathname === "/v9/projects") {
    const blocked = Number(projectListStatus[teamId] ?? 0);
    if (blocked) return send(blocked, { error: { message: "You do not have access to this team", code: "forbidden" } });
    const list = Array.isArray(projectsByScope[teamId]) ? projectsByScope[teamId] : [];
    return send(200, { projects: list, pagination: { count: list.length } });
  }

  const lookup = url.pathname.match(/^\/v9\/projects\/(.+)$/);
  if (lookup) {
    const id = decodeURIComponent(lookup[1]);
    const entry = resolved[`${id}|${teamId}`];
    if (entry) return send(Number(entry.status ?? 200), { name: entry.name ?? id, framework: entry.framework ?? "nextjs", id });
    return send(Number(defaultLookup.status ?? 404), { error: { message: defaultLookup.message ?? "Project not found", code: "not_found" } });
  }

  return send(404, { error: { message: "not found" } });
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  fs.writeFileSync(portFile, String(port));
  if (logFile) fs.appendFileSync(logFile, `# listening ${port}\n`);
});
