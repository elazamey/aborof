/**
 * تشخيص هوية مشروع Vercel — دوال **نقية** (بلا شبكة ولا `gh`) تُستورد من
 * الاختبارات ومن أداتَي النشر:
 *   • scripts/vercel-preflight.mjs  — الطيران التمهيدي داخل deploy.yml (CI)
 *   • scripts/apply-vercel-link.mjs — ربط المشروع وضبط الأسرار من جهاز المالك
 *
 * لماذا هذا الملف موجود أصلًا:
 *   فشل النشر المتكرر كان `HTTP 404: Project not found` من
 *   `GET /v9/projects/$VERCEL_PROJECT_ID?teamId=$VERCEL_ORG_ID` بينما
 *   `GET /v2/user` ينجح — أي أن الرمز سليم والمعّرِفين هما العطل. الرسالة
 *   وحدها لا تكفي للتشخيص لأن لها أربعة أسباب مختلفة تمامًا (نطاق فريق مقابل
 *   نطاق شخصي، معرّف مشروع قديم بعد إعادة إنشائه، مشروع في حساب Vercel آخر،
 *   أو مشروع مربوط بالمستودع غير الذي يخدم الإنتاج). هذا الملف يحوّل الرد
 *   الخام إلى **حكم مُصنَّف** بأسباب وإجراءات، على نمط `classifyApiFailure`
 *   في scripts/lib/turso-api.mjs.
 *
 * قاعدة عرض غير قابلة للتفاوض (نفس سياسة deploy.yml: «الأسماء فقط»):
 *   لا تُطبع قيمة معرّف ولا قيمة رمز. الأسماء والأطوال والأشكال المقنّعة فقط —
 *   لأن سجلات CI قابلة للقراءة من أي قارئ للمستودع، ولأن المعرّف الصحيح ليس
 *   سرًّا مسجّلًا بعد في GitHub فلا يُحجب تلقائيًا كما يُحجب القديم.
 */

export const DEFAULT_VERCEL_API_BASE = "https://api.vercel.com";

/**
 * المشروع الذي يجب أن يخدم الإنتاج. المستودع مرتبط بثلاثة مشاريع Vercel
 * (aborof، aborof-store-v2، aborof-updated-17d3397) وتكامل Git ينشرها كلها،
 * لذا «نشر ناجح» بلا تطابق اسم = إنتاج لم يتغير. يُتجاوز بمتغير
 * `VERCEL_EXPECTED_PROJECT` (Variable لا Secret).
 */
export const DEFAULT_EXPECTED_PROJECT = "aborof";

/** الأسرار الثلاثة التي يقرأها deploy.yml — بالترتيب الذي تُضبط به. */
export const DEPLOY_SECRET_NAMES = ["VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID"];

/* ------------------------------------------------------------------ */
/* قاعدة API والتحقق الشكلي                                            */
/* ------------------------------------------------------------------ */

/**
 * قاعدة API مقبولة: `https://` فقط. الاستثناء الوحيد اختباري وصريح
 * (`VERCEL_API_ALLOW_INSECURE_BASE=true`) لتشغيل خادم وهمي محلي في الاختبارات،
 * ويُعلَن في النتيجة حتى لا يمرّ بصمت (نفس عقد resolveApiBase في turso-api.mjs).
 */
export function resolveApiBase(value, { allowInsecure = false } = {}) {
  const base = String(value || DEFAULT_VERCEL_API_BASE).trim().replace(/\/+$/, "");
  if (/^https:\/\//i.test(base)) return { ok: true, base, insecure: false };
  if (/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(base) && allowInsecure) {
    return { ok: true, base, insecure: true };
  }
  return {
    ok: false,
    base,
    insecure: false,
    error: allowInsecure
      ? `قاعدة API غير مقبولة (${base}) — يُسمح محليًا بـ http://127.0.0.1 فقط في الاختبارات.`
      : `قاعدة Vercel API يجب أن تكون https:// (وصل: ${base}) — الاستثناء المحلي للاختبارات فقط عبر VERCEL_API_ALLOW_INSECURE_BASE=true.`,
  };
}

/**
 * قيم موضعية منسوخة من التوثيق/الأوامر الجاهزة بلا استبدال — أخطر ما يمرّ على
 * `gh secret set` لأنه «ينجح» ويكتب هراءً فوق سرّ كان يعمل.
 */
export function isPlaceholderValue(value) {
  const v = String(value ?? "").trim();
  if (!v) return true;
  if (/<[^>]*>/.test(v)) return true; // ‏<orgId> · <الرمز الجديد> · <projectId>
  if (/\bYOUR[_-]?(VERCEL|PROJECT|TEAM|ORG|TOKEN)/i.test(v)) return true; // ‏prj_YOUR_PROJECT_ID
  if (/^(your|xxx+|changeme|change_me|todo|tbd|placeholder|example|sample|dummy|fake|test-value)$/i.test(v)) return true;
  if (/^(prj|team)_(your|xxx|changeme|todo|placeholder)/i.test(v)) return true;
  if (/\.\.\.|…/.test(v)) return true; // ‏team_… منقولة حرفيًا من جدول أو نص مقنّع
  return false;
}

/** رموز منصات أخرى تُخطئ اليد إليها (أشهرها: رمز GitHub بدل Vercel، وJWT تورسو). */
const FOREIGN_TOKEN_SHAPES = [
  { re: /^(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)/i, label: "رمز GitHub (ghp_… أو github_pat_…)" },
  { re: /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, label: "رمز Turso/JWT (eyJ… بثلاثة مقاطع)" },
  { re: /^(xox[baprs]-)/i, label: "رمز Slack" },
  { re: /^sk-(proj-)?[A-Za-z0-9_-]{10,}/i, label: "رمز OpenAI" },
  { re: /^AIza[A-Za-z0-9_-]{20,}/i, label: "مفتاح Google" },
];

/**
 * فحص شكلي للرمز قبل أي نداء شبكة: لا يُطبع الرمز، بل وصفه.
 * النتيجة: `{ ok, reason?, shape }` حيث `shape` وصف آمن للطول والبداية.
 */
export function validateTokenShape(value) {
  const v = String(value ?? "");
  const shape = maskIdentifier(v);
  if (!v.trim()) return { ok: false, reason: "الرمز فارغ.", shape };
  if (isPlaceholderValue(v)) return { ok: false, reason: "قيمة موضعية من التوثيق لم تُستبدل (مثل YOUR_VERCEL_TOKEN).", shape };
  if (/\s/.test(v)) return { ok: false, reason: "الرمز يحمل مسافة أو سطرًا جديدًا — غالبًا نُسخ مع نهاية سطر.", shape };
  const foreign = FOREIGN_TOKEN_SHAPES.find((f) => f.re.test(v.trim()));
  if (foreign) {
    return { ok: false, reason: `هذا ${foreign.label} لا رمز Vercel — أنشئ الرمز من Vercel → Account Settings → Tokens.`, shape };
  }
  if (v.trim().length < 20) {
    return { ok: false, reason: `أقصر من أي رمز Vercel حقيقي (${shape}) — تحقّق أن النسخ كامل.`, shape };
  }
  return { ok: true, shape };
}

/**
 * تقنيع معرّف: أول 4 حروف (بادئة النوع مثل `prj_`/`team_`) + آخر 4 + الطول.
 * يكفي للتعرّف على **أي** معرّف موضوع، ولا يكفي لإعادة بنائه.
 */
export function maskIdentifier(value) {
  const v = String(value ?? "").trim();
  if (!v) return "—";
  if (v.length <= 8) return `…(طول ${v.length})`;
  return `${v.slice(0, 4)}…${v.slice(-4)} (طول ${v.length})`;
}

/* ------------------------------------------------------------------ */
/* نطاق الهوية: فريق أم حساب شخصي                                       */
/* ------------------------------------------------------------------ */

/**
 * يصنّف `VERCEL_ORG_ID` مقابل هوية الرمز من `GET /v2/user`.
 *
 * الفخ الموثّق: الرمز قد يعود لحساب **شخصي** (Hobby) بينما يُضبط `orgId` على
 * قيمة `team_…` (أو على اسم المستخدم بدل المعرّف)، فيردّ Vercel بـ
 * `404 Project not found` رغم أن الرمز والمشروع سليمين — لأن `teamId` ينقل
 * الطلب إلى نطاق لا يملكه الرمز.
 */
export function classifyOrgScope(orgId, user = {}) {
  const value = String(orgId ?? "").trim();
  const uid = String(user?.uid ?? user?.user?.uid ?? "").trim();
  const username = String(user?.username ?? user?.user?.username ?? "").trim();
  const startsWithTeam = /^team_/i.test(value);
  const matchesTokenUserUid = Boolean(uid) && value === uid;
  const matchesTokenUsername = Boolean(username) && value.toLowerCase() === username.toLowerCase();
  const kind = startsWithTeam
    ? "team"
    : matchesTokenUserUid
      ? "personal-uid"
      : matchesTokenUsername
        ? "username"
        : value
          ? "unknown"
          : "empty";
  return {
    kind,
    masked: maskIdentifier(value),
    startsWithTeam,
    matchesTokenUserUid,
    matchesTokenUsername,
    tokenUsername: username || null,
    // ‏وصف آمن يُطبع في CI: لا قيمة، بل شكل.
    describe() {
      if (kind === "empty") return "غير معرّف/فارغ";
      if (kind === "team") return `نطاق فريق (يبدأ بـ team_ · ${maskIdentifier(value)})`;
      if (kind === "personal-uid") return `نطاق شخصي مطابق لمعرّف حساب الرمز (${maskIdentifier(value)})`;
      if (kind === "username") return `اسم مستخدم لا معرّف نطاق (${maskIdentifier(value)})`;
      return `نطاق غير مصنّف (${maskIdentifier(value)})`;
    },
  };
}

/** تطبيع استجابة `/v9/projects` إلى قائمة مشاريع. */
function normalizeProjects(projectsResponse) {
  return Array.isArray(projectsResponse)
    ? projectsResponse
    : Array.isArray(projectsResponse?.projects)
      ? projectsResponse.projects
      : [];
}

/**
 * أسماء المشاريع فقط من استجابة `/v9/projects` — بلا معرّفات (سياسة «الأسماء فقط»).
 * يقبل قائمة كائنات (من API) أو قائمة أسماء (مطبّعة مسبقًا) حتى لا يختلف المخرَج
 * بين أدوات CI والمحلي.
 */
export function projectNames(projectsResponse) {
  return normalizeProjects(projectsResponse)
    .map((p) => String(typeof p === "string" ? p : (p?.name ?? "")))
    .filter(Boolean);
}

/**
 * بحث بالاسم يعيد **المعرّفين الصحيحين** معًا (`id` و`accountId`).
 * تُستخدم محليًا فقط (scripts/apply-vercel-link.mjs) لضبط الأسرار من غير أن
 * ينسخ المالك أي معرّف بيده — ولا تُطبع قيمها. `accountId` هو بالضبط ما يطلبه
 * `teamId`: معرّف الفريق للمشاريع الجماعية، ومعرّف الحساب الشخصي لغيرها — وهذا
 * هو أصل فخّ «نطاق فريق مقابل نطاق شخصي» الذي يُنتج `404 Project not found`.
 */
export function findProjectByName(projectsResponse, expectedName) {
  const hit = normalizeProjects(projectsResponse).find((p) => expectedProjectMatches(p?.name, expectedName));
  if (!hit) return null;
  const id = String(hit.id ?? "").trim();
  const accountId = String(hit.accountId ?? hit.owner?.id ?? "").trim();
  return { name: String(hit.name ?? "").trim(), projectId: id || null, orgId: accountId || null, framework: hit.framework ?? null };
}

/**
 * هل يكفي الزوج المُستنتَج للنشر؟ (بلا شبكة — يُختبر مباشرة)
 * `orgId` إلزامي لأن `deploy.yml` يمرّره كـ `teamId` دائمًا، ووظيفته ترفض السرّ الفارغ.
 */
export function isUsableProjectLink(link) {
  return Boolean(link && String(link.projectId ?? "").trim() && String(link.orgId ?? "").trim());
}

/** مطابقة اسم المشروع: حرفية بلا حساسية حالة الأحرف (أسماء Vercel أصلًا lowercase). */
export function expectedProjectMatches(actualName, expectedName) {
  const a = String(actualName ?? "").trim().toLowerCase();
  const e = String(expectedName ?? "").trim().toLowerCase();
  if (!a || !e) return false;
  return a === e;
}

/* ------------------------------------------------------------------ */
/* الحكم المُصنَّف                                                      */
/* ------------------------------------------------------------------ */

/**
 * يترجم نتيجة فحص المشروع إلى سبب وإجراء.
 *
 * @param {object} input
 * @param {number} input.status          رمز HTTP من GET /v9/projects/:id?teamId=:org (0 = تعذّر الوصول)
 * @param {string} [input.projectName]   الاسم الفعلي عند 200
 * @param {string} [input.expectedName]  الاسم المطلوب (افتراضيًا aborof)
 * @param {string} [input.orgId]         قيمة VERCEL_ORG_ID (لا تُطبع)
 * @param {object} [input.user]          جسم /v2/user
 * @param {{status:number, names:Array<string|{name?:string}>}} [input.teamScope]      مشاريع النطاق المُمرَّر كـ teamId
 * @param {{status:number, names:Array<string|{name?:string}>}} [input.personalScope]  مشاريع نطاق الرمز بلا teamId
 * @param {object} [input.error]         خطأ شبكة إن وُجد
 * @returns {{code:string, headline:string, causes:string[], fixes:string[], projectName:string|null, names:{team:string[], personal:string[]}}}
 */
export function diagnoseProjectLookup(input = {}) {
  const {
    status = 0,
    projectName = null,
    expectedName = DEFAULT_EXPECTED_PROJECT,
    orgId = "",
    user = {},
    teamScope = null,
    personalScope = null,
    error = null,
  } = input;

  const scope = classifyOrgScope(orgId, user);
  const names = {
    team: projectNames(teamScope?.names ?? teamScope?.json ?? []),
    personal: projectNames(personalScope?.names ?? personalScope?.json ?? []),
  };
  // ‏403 عند سرد مشاريع النطاق = الرمز لا يملك الفريق أصلًا (سبب أدقّ من 404 المشروع).
  const teamScopeForbidden = Number(teamScope?.status ?? 0) === 403;
  const teamScopeStatus = Number(teamScope?.status ?? 0) || null;
  const personalScopeStatus = Number(personalScope?.status ?? 0) || null;
  const base = {
    projectName: projectName ?? null,
    names,
    scopeDescribe: scope.describe(),
    scopeStatuses: { team: teamScopeStatus, personal: personalScopeStatus },
  };

  if (error || status === 0) {
    const message = String(error?.message ?? error ?? "");
    const unreachable = /ENOTFOUND|EAI_AGAIN|getaddrinfo|fetch failed|ECONNREFUSED|ECONNRESET|SSL|timeout|aborted/i.test(message);
    return {
      ...base,
      code: unreachable ? "API_UNREACHABLE" : "API_UNKNOWN",
      headline: unreachable
        ? "تعذّر الوصول إلى api.vercel.com (شبكة/DNS محجوبة أو مهلة منتهية)."
        : `استجابة غير مفهومة من Vercel API${message ? `: ${message.slice(0, 160)}` : ""}.`,
      causes: unreachable
        ? ["الشبكة الحالية لا تسمح بالاتصال بـ Vercel (جدار/وكيل/حجب)."]
        : ["ردّ خارج التصنيف المعتاد."],
      fixes: unreachable
        ? ["أعد المحاولة من شبكة أخرى، أو نفّذ الفحص من جهاز المالك: node scripts/apply-vercel-link.mjs --dry-run"]
        : ["أعد التشغيل؛ إن تكرّر أرفق رمز HTTP في تذكرة."],
    };
  }

  if (status === 401 || status === 403) {
    return {
      ...base,
      code: "SCOPE_FORBIDDEN",
      headline: `الرمز مرفوض أو ناقص الصلاحية على هذا النطاق (HTTP ${status}).`,
      causes: [
        "الرمز ملغى/منتهي، أو",
        "الرمز لا يملك الوصول إلى الفريق المطلوب في VERCEL_ORG_ID (صلاحية Full access على الفريق ناقصة).",
      ],
      fixes: [
        "Vercel → Account Settings → Tokens: أنشئ رمزًا بصلاحية Full access على الفريق الهدف ثم حدّث VERCEL_TOKEN.",
        "لا تستخدم توكن `vercel login` (OAuth قصير العمر) كسرّ دائم — راجع DEPLOYMENT.md.",
      ],
    };
  }

  if (status === 429) {
    return {
      ...base,
      code: "RATE_LIMITED",
      headline: "حد المعدل على Vercel API (HTTP 429).",
      causes: ["نداءات كثيرة في وقت قصير (نشرات متتابعة أو مجسّات)."],
      fixes: ["أعد المحاولة بعد دقائق — لا تغيير مطلوب في الأسرار."],
    };
  }

  if (status >= 500) {
    return {
      ...base,
      code: "SERVER_ERROR",
      headline: `خطأ من خادم Vercel (HTTP ${status}).`,
      causes: ["عطل عابر لدى Vercel."],
      fixes: ["تحقّق من status.vercel.com ثم أعد تشغيل workflow النشر."],
    };
  }

  if (status === 200) {
    if (expectedProjectMatches(projectName, expectedName)) {
      return {
        ...base,
        code: "PROJECT_OK",
        headline: `المشروع المطلوب متاح: «${projectName}» مطابق لـ «${expectedName}» ضمن النطاق ${scope.describe()}.`,
        causes: [],
        fixes: [],
      };
    }
    // ‏«نشر ناجح وإنتاج لم يتغير»: أخطر حالة لأنها صامتة.
    return {
      ...base,
      code: "PROJECT_NAME_MISMATCH",
      headline: `المعرّف يحل إلى مشروع اسمه «${projectName ?? "؟"}» لا «${expectedName}» — النشر سينجح في Actions بينما الإنتاج لن يتغير.`,
      causes: [
        `VERCEL_PROJECT_ID يشير إلى مشروع آخر من المشاريع المرتبطة بهذا المستودع (${names.personal.concat(names.team).filter((n) => !expectedProjectMatches(n, expectedName)).join("، ") || "غير معلوم"}).`,
        "المشروع أُعيد إنشاؤه فتغيّر معرّفه وبقي الاسم.",
      ],
      fixes: [
        `node scripts/apply-vercel-link.mjs --project ${expectedName} (يربط المشروع الصحيح ويضبط الأسرار عبر stdin بعد تحقق حيّ).`,
        `أو غيّر الاسم المتوقع بمتغير VERCEL_EXPECTED_PROJECT إن كان «${projectName}» هو المقصود فعلًا للإنتاج.`,
      ],
    };
  }

  if (status === 404) {
    const inTeam = names.team.some((n) => expectedProjectMatches(n, expectedName));
    const inPersonal = names.personal.some((n) => expectedProjectMatches(n, expectedName));
    const nothingVisible = names.team.length === 0 && names.personal.length === 0;

    if (nothingVisible) {
      return {
        ...base,
        code: "TOKEN_SEES_NO_PROJECTS",
        headline: `المشروع غير موجود (HTTP 404) والرمز لا يرى أي مشروع في أي نطاق — النطاق ${scope.describe()}.`,
        causes: [
          "الرمز يعود لحساب Vercel لا يملك مشاريع (أو حساب مختلف عن الذي فيه المشروع).",
          "صلاحية الرمز لا تشمل المشاريع (ليست Full access على الفريق).",
          ...(teamScopeForbidden
            ? [`سرد مشاريع النطاق المُمرَّر كـ teamId رُدّ بـ 403 ⇒ الرمز لا يملك هذا الفريق إطلاقًا (${scope.describe()}).`]
            : []),
        ],
        fixes: [
          "تأكد أنك مسجّل الدخول في Vercel بالحساب الذي يملك aborof.vercel.app، ثم أنشئ الرمز من ذلك الحساب/الفريق.",
          "Vercel → Account Settings → Tokens → Full access، ثم أعِد node scripts/apply-vercel-link.mjs.",
        ],
      };
    }

    if (inPersonal && scope.startsWithTeam) {
      return {
        ...base,
        code: "PROJECT_NOT_FOUND_WRONG_SCOPE",
        headline: `المشروع «${expectedName}» مرئي في النطاق الشخصي للرمز، لكن VERCEL_ORG_ID نطاق فريق (${scope.describe()}) — لذا 404.`,
        causes: [
          "الرمز يعود لحساب شخصي (Hobby) والمشروع تحت هذا الحساب، بينما orgId المضبوط `team_…` ينقل الطلب إلى فريق لا يملك المشروع.",
          "الخلط شائع لأن الأوامر الجاهزة تفترض `team_YOUR_TEAM_ID` دائمًا.",
        ],
        fixes: [
          `node scripts/apply-vercel-link.mjs --project ${expectedName} — يقرأ orgId الصحيح من .vercel/project.json بعد vercel link ويضبطه.`,
          "يدويًا: npx vercel link ثم cat .vercel/project.json وانسخ orgId **كما هو** (قد لا يبدأ بـ team_) إلى VERCEL_ORG_ID.",
          `المشاريع المرئية للرمز الآن: ${names.personal.join("، ") || "—"}.`,
        ],
      };
    }

    if (inTeam || inPersonal) {
      return {
        ...base,
        code: "PROJECT_NOT_FOUND_STALE_ID",
        headline: `المشروع «${expectedName}» مرئي للرمز لكن VERCEL_PROJECT_ID لا يطابقه (HTTP 404) — المعرّف قديم/خاطئ.`,
        causes: [
          "المشروع حُذف وأُعيد إنشاؤه فتغيّر `prj_…` وبقي الاسم.",
          "نُسخ معرّف مشروع آخر (المستودع مرتبط بعدة مشاريع Vercel).",
          `النطاق الحالي: ${scope.describe()} — المشاريع المرئية: ${names.team.concat(names.personal).join("، ") || "—"}.`,
        ],
        fixes: [
          `node scripts/apply-vercel-link.mjs --project ${expectedName} — يعيد الربط ويضبط السرّين بعد تحقق حيّ.`,
          "يدويًا: npx vercel link ثم cat .vercel/project.json وانسخ projectId إلى VERCEL_PROJECT_ID.",
        ],
      };
    }

    return {
      ...base,
      code: "PROJECT_NOT_VISIBLE_TO_TOKEN",
      headline: `المشروع «${expectedName}» غير مرئي لهذا الرمز إطلاقًا (HTTP 404) — النطاق ${scope.describe()}.`,
      causes: [
        "المشروع في حساب/فريق Vercel مختلف عن حساب الرمز.",
        `المشاريع التي يراها الرمز فعلًا: ${names.team.concat(names.personal).join("، ") || "—"} — بينها مشروع production الذي يخدم aborof.vercel.app؟`,
      ],
      fixes: [
        "افتح Vercel بالحساب الذي يخدم aborof.vercel.app وأنشئ الرمز منه (Account Settings → Tokens → Full access).",
        `ثم: node scripts/apply-vercel-link.mjs --project ${expectedName}.`,
      ],
    };
  }

  return {
    ...base,
    code: "UNKNOWN",
    headline: `استجابة غير متوقعة (HTTP ${status}).`,
    causes: ["رمز HTTP خارج التصنيف المعتاد."],
    fixes: ["أعد التشغيل، وإن تكرّر فافحص Vercel → Project → Settings → General."],
  };
}

/** يحوّل الحكم إلى أسطر قابلة للطباعة (بلا قيم سرية). */
export function renderDiagnosis(diagnosis) {
  const lines = [`[${diagnosis.code}] ${diagnosis.headline}`];
  for (const cause of diagnosis.causes ?? []) lines.push(`  • السبب: ${cause}`);
  for (const fix of diagnosis.fixures ?? []) lines.push(`  • الإجراء: ${fix}`);
  return lines;
}

/** أسماء المشاريع المرئية مع تعليم المطلوب — تُطبع في CI بدل «404» الجافة. */
export function renderVisibleProjects(diagnosis, expectedName = DEFAULT_EXPECTED_PROJECT) {
  const rows = [];
  for (const [scopeLabel, names] of [
    ["النطاق الشخصي للرمز", diagnosis.names?.personal ?? []],
    ["النطاق المُمرَّر كـ teamId", diagnosis.names?.team ?? []],
  ]) {
    if (!names.length) continue;
    for (const name of names) {
      rows.push(`  - ${name}${expectedProjectMatches(name, expectedName) ? `  ← المطلوب (${expectedName})` : ""}`);
    }
    rows.push(`    (${scopeLabel}: ${names.length} مشروع)`);
  }
  if (!rows.length) rows.push("  - لا مشاريع مرئية لهذا الرمز في أي نطاق.");
  return rows;
}
