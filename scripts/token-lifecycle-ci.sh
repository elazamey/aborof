#!/usr/bin/env bash
#
# غلاف CI لتدقيق دورة حياة رمز Turso — **مراقبة فقط (observability)**.
#
#   1. يشغّل `scripts/audit-token-lifecycle.mjs` الذي يفكّ مطالبة `exp` **داخل
#      الـ runner** (القيمة من بيئة العملية، لا من argv، ولا تُطبع إطلاقًا).
#   2. ينشر التقرير في السجل وفي ملخّص التشغيل (`$GITHUB_STEP_SUMMARY`).
#   3. يبثّ إشعار GitHub (`::notice` / `::warning` / `::error`) فيظهر في تبويب الفحوص.
#   4. يدير **Issue واحدًا** لمنطقة الخطر: إنشاء عند الدخول إليها، **تحديث جسمه**
#      (لا تعليق جديد) أثناء البقاء فيها، وإغلاقه عند الخروج — فلا ضوضاء أسبوعية.
#
# ما لا يفعله هذا الغلاف (عقدًا، ومُثبَت باختبارات في tests/deploy-tools.test.ts):
#   - لا يسكّ رمزًا ولا يدوّره: `TURSO_PLATFORM_TOKEN` لا يصل إليه أصلًا (الـ
#     workflow لا يمرّره)، فلو أُضيفت خطوة تدوير لعجزت عن التنفيذ.
#   - لا يلمس الأسرار: لا `gh secret set` ولا `vercel env` في هذا الملف.
#   - لا تتبّع shell (`set -x`) ولا طباعة لقيمة الرمز ولا لجزء منها.
#
# متغيرات (كلها من Actions): SCOPE وصف نطاق السرّ · THRESHOLD_DAYS بوابة التحذير
# (افتراضي 14) · GH_TOKEN لإدارة الـ Issue · RUN_URL · GITHUB_STEP_SUMMARY.
#
# أكواد الخروج: 0 أخضر (PASS/NO_EXPIRY) أو غير مهيأ (NOT_CONFIGURED: تخطٍّ لا فشل) ·
# 10 تحذير (داخل نافذة التدوير — يُحمرّ التشغيل المجدول عمدًا ليبقى التحذير دائمًا) ·
# 1 أحمر (منتهي أو قيمة لا تُفكّ).
set -uo pipefail

THRESHOLD_DAYS="${THRESHOLD_DAYS:-14}"
# عنوان ثابت **بلا رقم** كي يبقى المطابقة صالحة لو تغيّرت البوابة (الأرقام في الجسم).
ISSUE_TITLE="تدوير رمز قاعدة Turso — مراقبة دورة الحياة"
ISSUE_MARKER="<!-- turso-token-lifecycle-audit -->"
SCOPE="${SCOPE:-نطاق غير مسمّى}"

[ -f scripts/audit-token-lifecycle.mjs ] || { echo "::error::scripts/audit-token-lifecycle.mjs مفقود."; exit 1; }
command -v node >/dev/null 2>&1 || { echo "::error::node غير مثبّت على الـ runner."; exit 1; }

# حقل واحد من JSON — بلا jq (غير مضمون على كل الـ runners) وبلا eval.
json_field() {
  printf '%s' "$1" | JSON_KEY="$2" node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      try {
        const value = JSON.parse(s)?.[process.env.JSON_KEY];
        process.stdout.write(value == null ? "" : String(value));
      } catch {
        process.stdout.write("");
      }
    });'
}

# 1) التدقيق نفسه — القيمة من البيئة وحدها.
AUDIT_ARGS=(--json --threshold-days "$THRESHOLD_DAYS")
AUDIT_JSON="$(node scripts/audit-token-lifecycle.mjs "${AUDIT_ARGS[@]}")"
AUDIT_CODE=$?
if [ -z "$AUDIT_JSON" ]; then
  echo "::error::لم يُنتج التدقيق تقريرًا (كود $AUDIT_CODE) — تحقّق من سلامة الأداة."
  exit 1
fi

STATUS="$(json_field "$AUDIT_JSON" status)"
ACTION="$(json_field "$AUDIT_JSON" action)"
REMAINING="$(json_field "$AUDIT_JSON" remainingDays)"
EXPIRES="$(json_field "$AUDIT_JSON" expiresAt)"
NOTE="$(json_field "$AUDIT_JSON" note)"

# 2) التقرير المقروء (نفس دالة العرض المُختبَرة) — من JSON لا من تشغيل ثانٍ.
REPORT="$(printf '%s' "$AUDIT_JSON" | SCOPE="$SCOPE" node --input-type=module -e '
  const { renderMarkdown } = await import("./scripts/audit-token-lifecycle.mjs");
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  process.stdout.write(renderMarkdown(JSON.parse(s), { scope: process.env.SCOPE || "" }));
')" || REPORT="تعذّر بناء التقرير المقروء (JSON متاح أعلاه)."

printf '%s\n' "$REPORT"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$REPORT" >> "$GITHUB_STEP_SUMMARY"; fi

# 3) إشعار في تبويب الفحوص — نصّه من الحقول الرقمية والحكم فقط، بلا قيمة.
case "$STATUS" in
  PASS) echo "::notice::رمز Turso خارج نافذة التدوير — بقي ${REMAINING} يومًا (ينتهي ${EXPIRES})." ;;
  NO_EXPIRY) echo "::warning::رمز Turso بلا انتهاء (never) — ليس خطأً، لكنه خلاف سياسة 90d؛ التدوير اليدوي موصى به." ;;
  WARNING) echo "::warning::رمز Turso داخل نافذة التدوير — بقي ${REMAINING} يومًا (البوابة ${THRESHOLD_DAYS})." ;;
  FAIL) echo "::error::رمز Turso يحتاج تدخلًا: ${NOTE} — التدوير: bash scripts/mint-turso-token.sh" ;;
  NOT_CONFIGURED) echo "::warning::TURSO_AUTH_TOKEN غير مضبوط في ${SCOPE} — لا شيء للتدوير بعد." ;;
  *) echo "::error::حكم غير معروف من التدقيق: ${STATUS:-فارغ}" ;;
esac

# 4) Issue واحد — إنشاء/تحديث/إغلاق. المطابقة بالعنوان حرفيًا (لا بحث نصي، فالعنوان
#    عربي ومحرك البحث لا يضمن التطابق)، ولا Labels (تحتاج صلاحية administration).
find_open_issue() {
  command -v gh >/dev/null 2>&1 || return 0
  [ -n "${GH_TOKEN:-}" ] || return 0
  gh issue list --state open --limit 200 --json number,title 2>/dev/null | ISSUE_TITLE="$ISSUE_TITLE" node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      try {
        const rows = JSON.parse(s);
        const hit = (Array.isArray(rows) ? rows : []).find((row) => row?.title === process.env.ISSUE_TITLE);
        process.stdout.write(hit ? String(hit.number) : "");
      } catch {
        process.stdout.write("");
      }
    });'
}

EXISTING_ISSUE="$(find_open_issue || true)"

if [ "$ACTION" = "OPEN_OR_UPDATE_ISSUE" ]; then
  if ! command -v gh >/dev/null 2>&1 || [ -z "${GH_TOKEN:-}" ]; then
    echo "ℹ️ gh/GH_TOKEN غير متاحين — التحذير في الملخّص وتبويب الفحوص فقط (بلا Issue)."
  else
    BODY_FILE="$(mktemp)"
    {
      printf '%s\n' "$ISSUE_MARKER"
      printf '%s\n' "$REPORT"
      printf '\n---\nآخر فحص: %s · الحكم %s · النطاق: %s · التشغيل: %s\n' \
        "$(date -u +%FT%TZ)" "$STATUS" "$SCOPE" "${RUN_URL:-محلي}"
      printf 'التدوير (يد المشغّل): `bash scripts/mint-turso-token.sh` — يسكّ رمزًا بعمر 90 يومًا ويسلّمه إلى GitHub وVercel.\n'
      printf 'هذا الـ Issue يُحدَّث جسمه ولا يُكرَّر: واحد لكل دخول إلى منطقة الخطر، ويُغلق تلقائيًا عند الخروج منها.\n'
    } > "$BODY_FILE"
    if [ -n "$EXISTING_ISSUE" ]; then
      if gh issue edit "$EXISTING_ISSUE" --body-file "$BODY_FILE" >/dev/null 2>&1; then
        echo "🔁 حُدِّث Issue واحد مفتوح (#$EXISTING_ISSUE) — بلا تعليق جديد (لا ضوضاء)."
      else
        echo "::warning::تعذّر تحديث Issue #$EXISTING_ISSUE — التقرير في الملخّص."
      fi
    else
      if gh issue create --title "$ISSUE_TITLE" --body-file "$BODY_FILE" >/dev/null 2>&1; then
        echo "🆕 فُتح Issue واحد لمنطقة الخطر (سيُحدَّث لا يُكرَّر في الأسابيع التالية)."
      else
        echo "::warning::تعذّر فتح Issue — التقرير في الملخّص وتبويب الفحوص."
      fi
    fi
    rm -f "$BODY_FILE"
  fi
elif [ -n "$EXISTING_ISSUE" ] && { [ "$STATUS" = "PASS" ] || [ "$STATUS" = "NO_EXPIRY" ]; }; then
  # الخروج من منطقة الخطر يُغلق الـ Issue — وإلا بقي مفتوحًا بعد التدوير.
  if gh issue close "$EXISTING_ISSUE" --reason completed \
      --comment "أُغلق تلقائيًا بواسطة مدقق دورة الحياة: الرمز صار خارج نافذة التدوير (بقي ${REMAINING} يومًا، ينتهي ${EXPIRES})." >/dev/null 2>&1; then
    echo "✅ أُغلق Issue #$EXISTING_ISSUE — الرمز خارج نافذة التدوير."
  else
    echo "::warning::تعذّر إغلاق Issue #$EXISTING_ISSUE — أغلقه يدويًا بعد التدوير."
  fi
fi

case "$AUDIT_CODE" in
  0) exit 0 ;;
  2) exit 0 ;;   # NOT_CONFIGURED: تخطٍّ لا فشل — لا شيء للتدوير قبل ربط القاعدة.
  10) exit 10 ;;
  *) exit 1 ;;
esac
