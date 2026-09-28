#!/usr/bin/env bash
#
# تطبيق أسرار Turso في المكانين معًا بأمر واحد — لتقليل المسار اليدوي إلى صفر:
#   1. GitHub: أسرار بيئة `production` (التي يقرأها مجسّ `turso-evidence.yml`).
#   2. Vercel: متغيرات بيئة Production (التي يقرأها الموقع وقت التشغيل).
#
# مبادئ أمنية غير قابلة للتفاوض في هذا الملف:
#   - لا تُطبع أي قيمة سرية أبدًا؛ المعروض وصف شكلي (النوع/طول المضيف/طول الرمز).
#   - لا تُمرَّر القيم كوسائط سطر أوامر (تظهر في `ps`)؛ تُمرَّر عبر stdin فقط.
#   - التحقق شكلي قبل اللمس: رابط `libsql://` حقيقي، ورمز JWT (`eyJ…` بثلاثة مقاطع).
#
# الاستخدام:
#   TURSO_DATABASE_URL='libsql://…' TURSO_AUTH_TOKEN='eyJ…' bash scripts/apply-turso-secrets.sh
#   bash scripts/apply-turso-secrets.sh --dry-run          # عرض ما سيُفعل بلا تنفيذ
#   bash scripts/apply-turso-secrets.sh --github-only      # بلا لمس Vercel
#   bash scripts/apply-turso-secrets.sh --repo owner/name --env production
#
# بلا متغيرات بيئة يطلب القيم من المدخل بشكل مخفي (read -s).
set -uo pipefail

REPO=""
ENV_NAME="production"
DRY_RUN=false
SKIP_VERCEL=false
SKIP_GITHUB=false

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --github-only) SKIP_VERCEL=true ;;
    --vercel-only) SKIP_GITHUB=true ;;
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

# تشذيب آثار اللصق: مسافات/تاب/أسطر زائدة في الطرفين، وعلامتا اقتباس محيطتان.
# (رابط بمسافة زائدة يجعل createClient يرمي Invalid URL في الإنتاج ⇒ 500 على كل
# مسار منتجات — وهو عطل فحص 2026-09-28. التشذيب هنا يمنع تكراره من المنبع.)
trim_secret() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  case "$value" in
    \"*\"|\'*\' ) value="${value:1:${#value}-2}" ;;
  esac
  printf '%s' "$value"
}

URL_TRIMMED="$(trim_secret "$URL_VALUE")"
TOKEN_TRIMMED="$(trim_secret "$TOKEN_VALUE")"
[ "${#URL_TRIMMED}" -ne "${#URL_VALUE}" ] && echo "ℹ️  أُزيلت ${#URL_VALUE}→${#URL_TRIMMED} حرفًا زائدًا من طرفي قيمة الرابط الملصقة." >&2
[ "${#TOKEN_TRIMMED}" -ne "${#TOKEN_VALUE}" ] && echo "ℹ️  أُزيلت ${#TOKEN_VALUE}→${#TOKEN_TRIMMED} حرفًا زائدًا من طرفي قيمة الرمز الملصقة." >&2
URL_VALUE="$URL_TRIMMED"
TOKEN_VALUE="$TOKEN_TRIMMED"

[ -n "$URL_VALUE" ] || fail "TURSO_DATABASE_URL فارغ."
[ -n "$TOKEN_VALUE" ] || fail "TURSO_AUTH_TOKEN فارغ."

# مسافة داخلية لا تُشذَّب بل تُرفض: لا رابط صالح ولا JWT يحمل مسافة أبدًا،
# وتمريرها كان سيُسقط الإنتاج بـ 500 (Invalid URL) أو 401 (رمز مكسور).
case "$URL_VALUE" in *[[:space:]]*) fail "الرابط يحمل مسافة داخلية (طول ${#URL_VALUE}) — الصقه من زر Connect بلا تعديل." ;; esac
case "$TOKEN_VALUE" in *[[:space:]]*) fail "الرمز يحمل مسافة داخلية (طول ${#TOKEN_VALUE}) — أنشئ توكنًا جديدًا والصقه كاملًا." ;; esac

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
  *) fail "الرمز ليس JWT: $(describe_token "$TOKEN_VALUE") — أنشئ توكنًا جديدًا (Create Token · Full access · Never expire)." ;;
esac
case "$TOKEN_VALUE" in *://*) fail "قيمة الرمز تحمل رابطًا لا رمزًا — $(describe_token "$TOKEN_VALUE")." ;; esac

echo "🔎 التحقق الشكلي نجح:"
echo "   • TURSO_DATABASE_URL: $(describe_url "$URL_VALUE")"
echo "   • TURSO_AUTH_TOKEN:   JWT (طول ${#TOKEN_VALUE})"
echo

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
  echo "🧪 --dry-run: لن يُنفَّذ أي شيء. الخطوات المخطَّطة:"
  for a in "${actions[@]}"; do echo "   • $a"; done
  echo
  echo "بعد التنفيذ الفعلي: أي دفع إلى فرعك يعيد تشغيل المجسّ، أو gh workflow run turso-evidence.yml --ref main بعد الدمج."
  exit 0
fi

# 3) GitHub — القيم عبر stdin فقط (لا تظهر في ps ولا في السجل).
if [ "$SKIP_GITHUB" = false ] && command -v gh >/dev/null 2>&1; then
  GH_ARGS=(--env "$ENV_NAME")
  [ -n "$REPO" ] && GH_ARGS+=(--repo "$REPO")
  printf '%s' "$URL_VALUE"   | gh secret set TURSO_DATABASE_URL "${GH_ARGS[@]}" || fail "فشل ضبط سرّ الرابط على GitHub (تحقّق من gh auth status والصلاحيات)."
  printf '%s' "$TOKEN_VALUE" | gh secret set TURSO_AUTH_TOKEN   "${GH_ARGS[@]}" || fail "فشل ضبط سرّ الرمز على GitHub."
  echo "✅ GitHub: حُدِّث السرّان على بيئة $ENV_NAME (بلا طباعة أي قيمة)."
fi

# 4) Vercel — نفس المنطق، والقيمة عبر stdin.
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
