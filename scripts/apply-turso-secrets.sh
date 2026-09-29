#!/usr/bin/env bash
#
# تطبيق أسرار Turso في المكانين معًا بأمر واحد — لتقليل المسار اليدوي إلى صفر:
#   1. GitHub: أسرار بيئة `production` (التي يقرأها مجسّ `turso-evidence.yml`).
#   2. Vercel: متغيرات بيئة Production (التي يقرأها الموقع وقت التشغيل).
#
# مبادئ أمنية غير قابلة للتفاوض في هذا الملف:
#   - لا تُطبع أي قيمة سرية أبدًا؛ المعروض وصف شكلي (النوع/طول المضيف/طول الرمز).
#   - لا تُمرَّر القيم كوسائط سطر أوامر (تظهر في `ps`)؛ تُمرَّر عبر stdin أو بيئة الطفل فقط.
#   - التحقق شكلي قبل اللمس: رابط `libsql://` حقيقي، ورمز JWT (`eyJ…` بثلاثة مقاطع).
#   - ثم فحص اتصال حيّ للقراءة فقط (`verify-turso.mjs`) قبل أي لمس: إن رفضت القاعدة
#     القيم يتوقف بلا إمساك GitHub ولا Vercel؛ التخطي المتعمّد الوحيد: `--skip-verify`.
#
# الاستخدام:
#   TURSO_DATABASE_URL='libsql://…' TURSO_AUTH_TOKEN='eyJ…' bash scripts/apply-turso-secrets.sh
#   bash scripts/apply-turso-secrets.sh --dry-run          # معاينة ما سيُفعل (الأسوار الثلاثة تُنفَّذ كلها)
#   bash scripts/apply-turso-secrets.sh --github-only      # بلا لمس Vercel
#   bash scripts/apply-turso-secrets.sh --vercel-only      # بلا لمس GitHub
#   bash scripts/apply-turso-secrets.sh --repo owner/name --env production
#   bash scripts/apply-turso-secrets.sh --skip-verify      # تخطي الفحص الحيّ (شبكة مقطوعة / بلا npm ci)
#
# بلا متغيرات بيئة يطلب القيم من المدخل بشكل مخفي (read -s).
set -uo pipefail

REPO=""
ENV_NAME="production"
DRY_RUN=false
SKIP_VERCEL=false
SKIP_GITHUB=false
SKIP_VERIFY=false

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --github-only) SKIP_VERCEL=true ;;
    --vercel-only) SKIP_GITHUB=true ;;
    --skip-verify|--no-verify) SKIP_VERIFY=true ;;
    --repo) shift; REPO="${1:-}" ;;
    --env) shift; ENV_NAME="${1:-production}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "خيار غير معروف: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

fail() { echo "❌ $*" >&2; exit 1; }

read_secret() {
  local name="$1" value=""
  value="$(printenv "$name" || true)"
  if [ -z "$value" ]; then
    printf 'أدخل %s (لن يظهر على الشاشة): ' "$name" >&2
    read -rs value
    printf '\n' >&2
  fi
  printf '%s' "$value"
}

# ‏وصف شكلي بلا قيمة: النوع والمضيف المقنّع والأطوال.
describe_url() {
  local value="$1" host masked
  host="$(printf '%s' "$value" | sed -E 's#^[a-z]+://([^/:?]+).*#\1#' | tr '[:upper:]' '[:lower:]')"
  if [ "${#host}" -gt 12 ]; then masked="${host:0:3}…${host: -9}"; else masked="${host:0:3}…"; fi
  printf '%s:// · المضيف %s (طول %s) · طول الرابط %s' "${value%%://*}" "$masked" "${#host}" "${#value}"
}

describe_token() {
  local value="$1" scheme=""
  case "$value" in *"://"*) scheme="${value%%://*}";; esac
  if [ -n "$scheme" ]; then
    printf 'ليست JWT بل قيمة تبدأ بـ %s:// (طول %s)' "$scheme" "${#value}"
  else
    printf 'ليست بصيغة JWT المعتادة (طول %s)' "${#value}"
  fi
}

URL_VALUE="$(read_secret TURSO_DATABASE_URL)"
TOKEN_VALUE="$(read_secret TURSO_AUTH_TOKEN)"

[ -n "$URL_VALUE" ] || fail "TURSO_DATABASE_URL فارغ."
[ -n "$TOKEN_VALUE" ] || fail "TURSO_AUTH_TOKEN فارغ."

# 1) التحقق من الرابط: libsql/turso/https على نطاق Turso، وليس صفحة اللوحة.
case "$URL_VALUE" in
  libsql://*|turso://*|https://*|wss://*) ;;
  *) fail "الرابط لا يبدأ بمخطّط معروف: $(describe_url "$URL_VALUE") — الصيغة المطلوبة libsql://<db>-<org>.turso.io" ;;
esac
URL_HOST="$(printf '%s' "$URL_VALUE" | sed -E 's#^[a-z]+://([^/:?]+).*#\1#' | tr '[:upper:]' '[:lower:]')"
case "$URL_HOST" in
  app.turso.tech|www.turso.tech|turso.tech)
    fail "هذا رابط لوحة تحكم لا رابط اتصال ($(describe_url "$URL_VALUE")) — انسخه من زر Connect في اللوحة." ;;
  *.turso.io|turso.io|localhost|*.local) ;;
  *) echo "⚠️  المضيف ليس نطاق Turso المعتاد (…turso.io) — تأكد أنه رابط الاتصال الصحيح." >&2 ;;
esac

# 2) التحقق من الرمز: JWT بثلاثة مقاطع يبدأ بـ eyJ.
case "$TOKEN_VALUE" in
  eyJ*.*.*) ;;
  *) fail "الرمز ليس JWT: $(describe_token "$TOKEN_VALUE") — أنشئ توكنًا جديدًا (Create Token · Full access · 90 يومًا)، أو دع scripts/mint-turso-token.sh يسكّه ويسلّمه بنفسه." ;;
esac
case "$TOKEN_VALUE" in *://*) fail "قيمة الرمز تحمل رابطًا لا رمزًا — $(describe_token "$TOKEN_VALUE")." ;; esac

echo "🔎 التحقق الشكلي نجح:"
echo "   • TURSO_DATABASE_URL: $(describe_url "$URL_VALUE")"
echo "   • TURSO_AUTH_TOKEN:   JWT (طول ${#TOKEN_VALUE})"
echo

# 3) فحص اتصال حيّ قبل أي لمس — نفس مسار verify-turso.mjs، والقيم عبر بيئة
#    الطفل (غير ظاهرة في `ps` كوسائط سطر) لا عبر سطر الأوامر. الفحص للقراءة فقط.
#    القرار مُصنَّف من بنية تقرير JSON (معرّفات الصفوف) لا من مطابقة نصوص الأخطاء:
#    0 = VERIFY_SUCCESS · 11 = VERIFY_SCHEMA_NOT_READY · 10 = VERIFY_CONNECTION_FAILED · 3 = تقرير غير صالح.
if [ "$SKIP_VERIFY" = true ]; then
  echo "⚠️  VERIFY_SKIPPED: الفحص الحيّ مُتخطَّ (--skip-verify) — لا يوجد إثبات مسبق أن هذا الزوج يعمل؛ سيُطبَّق كما هو." >&2
else
  command -v node >/dev/null 2>&1 || fail "node غير مثبّت — الفحص الحيّ إلزامي؛ ثبّت Node ثم أعد، أو تخطَّه صراحة بـ --skip-verify."
  [ -f scripts/verify-turso.mjs ] || fail "scripts/verify-turso.mjs مفقود — لا يمكن فحص الاتصال؛ تخطَّه صراحة بـ --skip-verify إن كنت تدري."
  [ -d node_modules/@libsql/client ] || fail "node_modules ناقصة (@libsql/client) — شغّل 'npm ci' أولًا، أو تخطَّ الفحص بـ --skip-verify."

  echo "🔍 فحص اتصال Turso حيًّا (للقراءة فقط — لا هجرة ولا كتابة)…"
  verify_err_file="$(mktemp)"
  verify_json="$(TURSO_DATABASE_URL="$URL_VALUE" TURSO_AUTH_TOKEN="$TOKEN_VALUE" node scripts/verify-turso.mjs --json 2>"$verify_err_file")"
  verify_rc=$?
  verify_err="$(cat "$verify_err_file")"
  rm -f "$verify_err_file"

  # الجدول المعروض والقرار يقتصدان من JSON نفسه — لا من نص رسالة خطأ متغيّر.
  printf '%s' "$verify_json" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      let j;
      try { j = JSON.parse(s); } catch { process.exit(3); }
      const rows = Array.isArray(j?.rows) ? j.rows : [];
      const conn = rows.find((r) => r?.id === "conn" || r?.id === "conn-derived");
      console.log("| # | الفحص | النتيجة | التفصيل |");
      console.log("|---|---|---|---|");
      for (const r of rows) console.log(`| ${r.id} | ${r.label} | ${r.ok ? "✅" : "❌"} | ${String(r.detail).replace(/\|/g, "\\|")} |`);
      if (!conn) process.exit(3);
      process.exit(conn.ok ? (rows.every((r) => r.ok) ? 0 : 11) : 10);
    });'
  verify_class=$?

  case "$verify_class" in
    0)
      echo "✅ VERIFY_SUCCESS: القاعدة تستقبل هذا الزوج فعليًا وكل الفحوص خضراء."
      echo
      ;;
    11)
      echo "⚠️  VERIFY_SCHEMA_NOT_READY: الاتصال ناجح لكن فحوصًا تالية حمراء — متوقّع قبل أول نشر إن كانت الهجرات لم تُطبَّق بعد (تُطبَّق تلقائيًا عند أول طلب). أعد 'npm run verify:turso' بعد النشر." >&2
      echo
      ;;
    10)
      fail "VERIFY_CONNECTION_FAILED — القاعدة رفضت هذه القيم: توقّف قبل أي لمس لـ GitHub أو Vercel. (التقرير أعلاه بلا طباعة أي قيمة.)"
      ;;
    *)
      fail "VERIFY_REPORT_UNUSABLE (كود verify=$verify_rc، تحليل=$verify_class) — لم يُلمس GitHub ولا Vercel. ${verify_err}"
      ;;
  esac
fi

actions=()

if [ "$SKIP_GITHUB" = false ]; then
  if command -v gh >/dev/null 2>&1; then
    actions+=("gh secret set TURSO_DATABASE_URL --env $ENV_NAME   (القيمة عبر stdin)")
    actions+=("gh secret set TURSO_AUTH_TOKEN   --env $ENV_NAME   (القيمة عبر stdin)")
  else
    echo "⚠️  gh غير مثبّت — أضف السرّين يدويًا في Settings → Environments → $ENV_NAME → Secrets" >&2
  fi
fi

if [ "$SKIP_VERCEL" = false ]; then
  if command -v vercel >/dev/null 2>&1; then
    actions+=("vercel env rm TURSO_DATABASE_URL $ENV_NAME --yes   (لتجنّب التكرار)")
    actions+=("vercel env add TURSO_DATABASE_URL $ENV_NAME        (القيمة عبر stdin)")
    actions+=("vercel env rm TURSO_AUTH_TOKEN $ENV_NAME --yes")
    actions+=("vercel env add TURSO_AUTH_TOKEN $ENV_NAME")
    actions+=("vercel deploy --prod                               (نشر جديد لقراءة المتغيرات)")
  else
    echo "ℹ️  vercel CLI غير مثبّت — أعِد النشر من اللوحة: Project → Deployments → Redeploy" >&2
  fi
fi

if [ "$DRY_RUN" = true ]; then
  echo "🧪 --dry-run: لن يُطبَّق أي سرّ على أي خدمة. الخطوات المخطَّطة:"
  if [ "$SKIP_VERIFY" = false ]; then
    echo "   • فحص الاتصال الحيّ: نُفِّذ للتو (للقراءة فقط) ✔"
  else
    echo "   • فحص الاتصال الحيّ: مُتخطَّ (--skip-verify)"
  fi
  for a in "${actions[@]}"; do echo "   • $a"; done
  echo
  echo "بعد التنفيذ الفعلي: أي دفع إلى فرعك يعيد تشغيل المجسّ، أو gh workflow run turso-evidence.yml --ref main بعد الدمج."
  exit 0
fi

# 4) GitHub — القيم عبر stdin فقط (لا تظهر في ps ولا في السجل).
if [ "$SKIP_GITHUB" = false ] && command -v gh >/dev/null 2>&1; then
  GH_ARGS=(--env "$ENV_NAME")
  [ -n "$REPO" ] && GH_ARGS+=(--repo "$REPO")
  printf '%s' "$URL_VALUE"   | gh secret set TURSO_DATABASE_URL "${GH_ARGS[@]}" || fail "فشل ضبط سرّ الرابط على GitHub (تحقّق من gh auth status والصلاحيات)."
  printf '%s' "$TOKEN_VALUE" | gh secret set TURSO_AUTH_TOKEN   "${GH_ARGS[@]}" || fail "فشل ضبط سرّ الرمز على GitHub."
  echo "✅ GitHub: حُدِّث السرّان على بيئة $ENV_NAME (بلا طباعة أي قيمة)."
fi

# 5) Vercel — نفس المنطق، والقيمة عبر stdin.
if [ "$SKIP_VERCEL" = false ] && command -v vercel >/dev/null 2>&1; then
  vercel env rm TURSO_DATABASE_URL "$ENV_NAME" --yes >/dev/null 2>&1 || true
  printf '%s' "$URL_VALUE"   | vercel env add TURSO_DATABASE_URL "$ENV_NAME" >/dev/null || fail "فشل ضبط متغير الرابط على Vercel."
  vercel env rm TURSO_AUTH_TOKEN "$ENV_NAME" --yes >/dev/null 2>&1 || true
  printf '%s' "$TOKEN_VALUE" | vercel env add TURSO_AUTH_TOKEN "$ENV_NAME" >/dev/null || fail "فشل ضبط متغير الرمز على Vercel."
  echo "✅ Vercel: حُدِّث المتغيّران على بيئة $ENV_NAME."
  echo "➡️  الخطوة الأخيرة: vercel deploy --prod (المتغيرات تُقرأ في نشر جديد)."
fi

echo
echo "بعد التحديث: أي دفع إلى فرعك يعيد تشغيل المجسّ تلقائيًا، وبعد الدمج في main: gh workflow run turso-evidence.yml --ref main"
