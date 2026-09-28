import http from "node:http";

/**
 * مساعدات اختبار أعطال القاعدة (الحالة B: الفشل وقت الاستعلام).
 *
 * هذا الملف **ليس** ملف اختبار (لا يطابق `*.test.ts`) — يُستورد من ملفات
 * الاختبار فقط. الغرض: محاكاة سلوك Turso الحقيقي محليًا وبلا شبكة —
 * العميل يرسل `POST /v2/pipeline` مع `Authorization: Bearer`، والخادم يرد
 * `401`، فيرمي العميل `SERVER_ERROR ... 401` كما في الإنتاج تمامًا.
 */

export interface Stub401 {
  url: string;
  /** ما رآه الخادم: يثبت أن الطلب والترويسة وصلًا فعلًا قبل الرفض. */
  seen: { count: number; auth: string | null };
  close: () => Promise<void>;
}

/** خادم محلي يرفض كل طلب بـ 401 (يحاكي `credential rejected` من Turso). */
export function start401Stub(): Promise<Stub401> {
  const seen = { count: 0, auth: null as string | null };
  const server = http.createServer((req, res) => {
    seen.count += 1;
    if (seen.auth === null) seen.auth = req.headers.authorization ?? null;
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized: invalid token" }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        seen,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

/** رابط libsql لمضيف مغلق — يحاكي تعذّر الوصول (DNS/شبكة) بلا انتظار. */
export const UNREACHABLE_LIBSQL_URL = "libsql://127.0.0.1:9";

/**
 * حارس الجمود: أي نداء شبكي ضد stub محلي يجب أن يُكمَل ضمن ميزانية ثابتة —
 * فالتعليق الصامت (regression الـ `spawnSync` الشهير: والد محجوب + stub في
 * نفس العملية) يتحول إلى فشل صريح سريع بدل استهلاك CI دقيقة كاملة.
 */
export function withTimeout<T>(promise: Promise<T>, ms = 5_000, label = "stub"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    // بلا unref عمدًا: المؤقّت هو ما يُبقي الـ await حيًّا حتى الميزانية،
    // وunref كان يُفرِغ الحلقة قبل إطلاقه فيُعلَّق الاختبار (اكتُشف بالفشل).
    // التنظيف عبر clearTimeout في finally عند النجاح المبكر.
    timer = setTimeout(() => reject(new Error(`${label}: تجاوز ميزانية ${ms}ms — اشتباه جمود`)), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}

export interface CannedStub {
  url: string;
  /** تغيير الاستجابة المعلّبة بين الحالات (رمز/جسم/نوع). */
  set: (status: number, body: string, contentType?: string) => void;
  close: () => Promise<void>;
}

/**
 * خادم محلي باستجابة معلّبة قابلة للتبديل — للضوابط السالبة (P1c) وفوضى
 * P3: نفس المسار الحقيقي (عميل libsql + فحص HTTP خام) ضد 401/404/400/500
 * و200-مضلِّل، بلا شبكة وبلا أسرار.
 */
export function startCannedStub(
  initial: { status: number; body: string; contentType?: string } = {
    status: 401,
    body: JSON.stringify({ error: "Unauthorized: invalid token" }),
  }
): Promise<CannedStub> {
  let current = initial;
  const server = http.createServer((_req, res) => {
    res.writeHead(current.status, { "content-type": current.contentType ?? "application/json" });
    res.end(current.body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        set: (status, body, contentType) => {
          current = { status, body, contentType };
        },
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
