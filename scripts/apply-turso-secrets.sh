#!/usr/bin/env bash
#
# تطبيق أسرار Turso في المكانين معًا بأمر واحد — لتقليل المسار اليدوي إلى صفر:
#   1. GitHub: أسرار بيئة `production` (التي يقرأها مجسّ `turso-evidence.yml`).
#   2. Vercel: متغيرات بيئة Production (التي يقرأها الموقع وقت التشغيل).
#
# فصل الاعتمادات (عقد docs/ops/secret-rotation.md): التشغيل يأخذ رمز PROD
# والمجسّ يأخذ رمز CI — قيَمًا مختلفة بصلاحيات مختلفة. يقبل السكربت الرمزين
# منفصلين، وإن غاب أحدهما سقط على الرمز المشترك القديم مع تحذير مُعلَن
# (لا بصمت) — فالإعداد القديم يبقى يعمل أثناء الترحيل.
#
# مبادئ أمنية غير قابلة للتفاوض في هذا الملف:
#   - لا تُطبع أي قيمة سرية أبدًا؛ المعروض وصف شكلي (النوع/طول المضيف/طول الرمز).
#   - لا تُمرَّر القيم كوسائط سطر أوامر (تظهر في `ps`)؛ تُمرَّر عبر stdin فقط.
#   - التحقق شكلي قبل اللمس: رابط `libsql://` حقيقي، ورمز JWT (`eyJ…` بثلاثة مقاطع).
#
# قنوات الأسرار (تصنيف صريح — لا مسار رابع):
#   تفاعلي : مدخل مخفي فقط (`read -rs`) — التشغيل العاري. بلا طرفية (CI/
#           cron/pipe) والغياب = إجهاض صريح، لا تعليق على `read` ولا متابعة
#           بقيمة فارغة.
#   أتمتة  : قناة سرية صريحة (متغير CI مُدار أو مدير أسرار يُحقَن في البيئة)
#           — تُعلَن «قيم من البيئة» في المخرجات.
#   inline  : توثيق واختبار فقط — تُحفَظ في سجل الصدفة، ممنوعة على المشترك.
#
# الاستخدام الأول (لا يترك أثرًا في سجل الصدفة — القيم تُطلب بمدخل مخفي):
#   bash scripts/apply-turso-secrets.sh
#
# الاستخدام الثاني (أتمتة/اختبار فقط — القيم inline تُحفَظ في ~/.bash_history
# أو ما يكافئه، فلا تستخدمه على جهاز مشترك؛ انظر «نظافة السجل» في
# docs/ops/secret-rotation.md قبل لصق أي سر في سطر الأوامر):
#   TURSO_DATABASE_URL='libsql://…' TURSO_AUTH_TOKEN_PROD='eyJ…' TURSO_AUTH_TOKEN_CI='eyJ…' bash scripts/apply-turso-secrets.sh
#   bash scripts/apply-turso-secrets.sh --dry-run          # عرض ما سيُفعل بلا تنفيذ
#   bash scripts/apply-turso-secrets.sh --github-only      # بلا لمس Vercel (لا يُسأل عن رمز التشغيل)
#   bash scripts/apply-turso-secrets.sh --vercel-only      # بلا لمس GitHub (لا يُسأل عن رمز المجسّ)
#   bash scripts/apply-turso-secrets.sh --repo owner/name --env production
set -uo pipefail

REPO=""
ENV_NAME="production"
DRY_RUN=false
SKIP_VERCEL=false
SKIP_GITHUB=false

usage() {
  awk '/^set -uo pipefail/{exit} NR>1' "$0" | sed 's/^# \{0,1\}//'
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
    # مغلق-عند-الفشل في غير التفاعلي (CI/cron/pipe): لا تعليق على read
    # ولا متابعة بقيمة فارغة — القيمة الغائبة تُجهِض بسبب صريح.
    if [ ! -t 0 ]; then
      fail "غير تفاعلي: $name غير مضبوط في البيئة ولا مدخل مخفي متاح (stdin ليست طرفية) — مرّر القيمة عبر قناة سرية معتمدة (متغير CI مُدار أو مدير أسرار)، لا عبر سطر الأوامر."
    fi
    printf 'أدخل %s (لن يظهر على الشاشة): ' "$name" >&2
    read -rs value
    printf '\n' >&2
    [ -n "$value" ] || fail "$name فارغ — أُجهِض بدل المتابعة بقيمة فارغة."
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

URL_ENV="$(printenv TURSO_DATABASE_URL || true)"
URL_VALUE="${URL_ENV:-$(read_secret TURSO_DATABASE_URL)}"

# القراءة أولًا من البيئة (للأتمتة والاختبار)، وكل غائب يُسأل عنه بمدخل مخفي
# — فالمسار الأول (تشغيل عارٍ) لا يترك أي سر في سجل الصدفة. قاعدتان صارمتان:
#   1. لا تلوث متبادل: رمز CI لا يُستخدَم للتشغيل أبدًا، ورمز PROD لا يُستخدَم
#      للمجسّ أبدًا — السقوط الوحيد المسموح هو الرمز المشترك القديم.
#   2. مع --vercel-only/--github-only لا يُسأل عن الدور المُتخطَّى أصلًا.
PROD_ENV="$(printenv TURSO_AUTH_TOKEN_PROD || true)"
CI_ENV="$(printenv TURSO_AUTH_TOKEN_CI || true)"
LEGACY_ENV="$(printenv TURSO_AUTH_TOKEN || true)"
if [ -n "${URL_ENV}${PROD_ENV}${CI_ENV}${LEGACY_ENV}" ]; then
  echo "ℹ️  قيم من البيئة — إن كُتبت inline فهي في سجل الصدفة (~/.bash_history)؛ المرة القادمة شغّل عاريًا والصق في المدخل المخفي (انظر «نظافة السجل» في docs/ops/secret-rotation.md)." >&2
elif [ -t 0 ]; then
  echo "ℹ️  لا قيم في البيئة — ستُطلَب بمدخل مخفي لا يُحفَظ في السجل." >&2
fi
if [ -z "${PROD_ENV}${CI_ENV}${LEGACY_ENV}" ]; then
  LEGACY_ENV="$(read_secret TURSO_AUTH_TOKEN)"
fi
PROD_VALUE="${PROD_ENV:-$LEGACY_ENV}"
CI_VALUE="${CI_ENV:-$LEGACY_ENV}"
if [ -z "$PROD_VALUE" ] && [ "$SKIP_VERCEL" = false ]; then
  PROD_VALUE="$(read_secret TURSO_AUTH_TOKEN_PROD)"
fi
if [ -z "$CI_VALUE" ] && [ "$SKIP_GITHUB" = false ]; then
  CI_VALUE="$(read_secret TURSO_AUTH_TOKEN_CI)"
fi
if [ "$SKIP_VERCEL" = false ] && [ -z "$PROD_VALUE" ]; then
  fail "لا رمز للتشغيل: اضبط TURSO_AUTH_TOKEN_PROD أو الرمز المشترك TURSO_AUTH_TOKEN."
fi
if [ "$SKIP_GITHUB" = false ] && [ -z "$CI_VALUE" ]; then
  fail "لا رمز للمجسّ: اضبط TURSO_AUTH_TOKEN_CI أو الرمز المشترك TURSO_AUTH_TOKEN."
fi
if [ -z "$PROD_ENV" ] && [ "$SKIP_VERCEL" = false ]; then
  echo "⚠️  TURSO_AUTH_TOKEN_PROD غير مضبوط — سيُستخدم الرمز المشترك للتشغيل؛ للفصل مرّر TURSO_AUTH_TOKEN_PROD وTURSO_AUTH_TOKEN_CI قيمتين مختلفتين." >&2
fi
if [ -z "$CI_ENV" ] && [ "$SKIP_GITHUB" = false ]; then
  echo "⚠️  TURSO_AUTH_TOKEN_CI غير مضبوط — سيُستخدم الرمز المشترك للمجسّ؛ للفصل مرّر TURSO_AUTH_TOKEN_PROD وTURSO_AUTH_TOKEN_CI قيمتين مختلفتين." >&2
fi

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
PROD_TRIMMED="$(trim_secret "$PROD_VALUE")"
CI_TRIMMED="$(trim_secret "$CI_VALUE")"
[ "${#URL_TRIMMED}" -ne "${#URL_VALUE}" ] && echo "ℹ️  أُزيلت ${#URL_VALUE}→${#URL_TRIMMED} حرفًا زائدًا من طرفي قيمة الرابط الملصقة." >&2
[ "${#PROD_TRIMMED}" -ne "${#PROD_VALUE}" ] && echo "ℹ️  أُزيلت ${#PROD_VALUE}→${#PROD_TRIMMED} حرفًا زائدًا من طرفي رمز التشغيل الملصق." >&2
[ "${#CI_TRIMMED}" -ne "${#CI_VALUE}" ] && echo "ℹ️  أُزيلت ${#CI_VALUE}→${#CI_TRIMMED} حرفًا زائدًا من طرفي رمز المجسّ الملصق." >&2
URL_VALUE="$URL_TRIMMED"
PROD_VALUE="$PROD_TRIMMED"
CI_VALUE="$CI_TRIMMED"

[ -n "$URL_VALUE" ] || fail "TURSO_DATABASE_URL فارغ."

# مسافة داخلية لا تُشذَّب بل تُرفض: لا رابط صالح ولا JWT يحمل مسافة أبدًا،
# وتمريرها كان سيُسقط الإنتاج بـ 500 (Invalid URL) أو 401 (رمز مكسور).
case "$URL_VALUE" in *[[:space:]]*) fail "الرابط يحمل مسافة داخلية (طول ${#URL_VALUE}) — الصقه من زر Connect بلا تعديل." ;; esac

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

# 2) التحقق من الرمزين: JWT بثلاثة مقاطع يبدأ بـ eyJ، وبلا مسافة داخلية.
# سياسة الإصدار: صلاحية قاعدة واحدة ومدة محدودة — `Full access + Never expire`
# للتشخيص المؤقت فقط (انظر docs/ops/secret-rotation.md).
validate_token() {
  local label="$1" value="$2"
  case "$value" in *[[:space:]]*) fail "الرمز في $label يحمل مسافة داخلية (طول ${#value}) — أنشئ توكنًا جديدًا والصقه كاملًا." ;; esac
  case "$value" in
    eyJ*.*.*) ;;
    *) fail "الرمز ليس JWT ($label): $(describe_token "$value") — أنشئ توكنًا جديدًا بصلاحية قاعدة واحدة ومدة محدودة (انظر docs/ops/secret-rotation.md)." ;;
  esac
  case "$value" in *://*) fail "قيمة الرمز في $label تحمل رابطًا لا رمزًا — $(describe_token "$value")." ;; esac
}

if [ "$SKIP_VERCEL" = false ]; then validate_token "TURSO_AUTH_TOKEN_PROD" "$PROD_VALUE"; fi
if [ "$SKIP_GITHUB" = false ]; then validate_token "TURSO_AUTH_TOKEN_CI" "$CI_VALUE"; fi

echo "🔎 التحقق الشكلي نجح:"
echo "   • TURSO_DATABASE_URL: $(describe_url "$URL_VALUE")"
if [ "$SKIP_VERCEL" = false ]; then echo "   • TURSO_AUTH_TOKEN_PROD: JWT (طول ${#PROD_VALUE})$([ -z "$PROD_ENV" ] && printf ' ← مشترك انتقالي ⚠️')"; fi
if [ "$SKIP_GITHUB" = false ]; then echo "   • TURSO_AUTH_TOKEN_CI:   JWT (طول ${#CI_VALUE})$([ -z "$CI_ENV" ] && printf ' ← مشترك انتقالي ⚠️')"; fi
echo

actions=()

if [ "$SKIP_GITHUB" = false ]; then
  if command -v gh >/dev/null 2>&1; then
    actions+=("gh secret set TURSO_DATABASE_URL --env $ENV_NAME   (القيمة عبر stdin)")
    actions+=("gh secret set TURSO_AUTH_TOKEN_CI --env $ENV_NAME  (رمز المجسّ — القيمة عبر stdin)")
    actions+=("gh secret set TURSO_AUTH_TOKEN    --env $ENV_NAME  (انتقالي = نفس قيمة CI لمراجع الكود القديمة)")
  else
    echo "⚠️  gh غير مثبّت — أضف الأسرار يدويًا في Settings → Environments → $ENV_NAME → Secrets" >&2
  fi
fi

if [ "$SKIP_VERCEL" = false ]; then
  if command -v vercel >/dev/null 2>&1; then
    actions+=("vercel env rm TURSO_DATABASE_URL $ENV_NAME --yes   (لتجنّب التكرار)")
    actions+=("vercel env add TURSO_DATABASE_URL $ENV_NAME        (القيمة عبر stdin)")
    actions+=("vercel env rm TURSO_AUTH_TOKEN_PROD $ENV_NAME --yes  (رمز التشغيل)")
    actions+=("vercel env add TURSO_AUTH_TOKEN_PROD $ENV_NAME       (القيمة عبر stdin)")
    actions+=("vercel env rm TURSO_AUTH_TOKEN $ENV_NAME --yes       (انتقالي = نفس قيمة PROD)")
    actions+=("vercel env add TURSO_AUTH_TOKEN $ENV_NAME            (القيمة عبر stdin)")
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
  printf '%s' "$URL_VALUE" | gh secret set TURSO_DATABASE_URL "${GH_ARGS[@]}" || fail "فشل ضبط سرّ الرابط على GitHub (تحقّق من gh auth status والصلاحيات)."
  printf '%s' "$CI_VALUE"  | gh secret set TURSO_AUTH_TOKEN_CI "${GH_ARGS[@]}" || fail "فشل ضبط سرّ رمز المجسّ على GitHub."
  printf '%s' "$CI_VALUE"  | gh secret set TURSO_AUTH_TOKEN "${GH_ARGS[@]}" || fail "فشل ضبط السرّ الانتقالي على GitHub."
  echo "✅ GitHub: حُدِّثت الأسرار على بيئة $ENV_NAME (بلا طباعة أي قيمة)."
fi

# 4) Vercel — نفس المنطق، والقيمة عبر stdin.
if [ "$SKIP_VERCEL" = false ] && command -v vercel >/dev/null 2>&1; then
  vercel env rm TURSO_DATABASE_URL "$ENV_NAME" --yes >/dev/null 2>&1 || true
  printf '%s' "$URL_VALUE"  | vercel env add TURSO_DATABASE_URL "$ENV_NAME" >/dev/null || fail "فشل ضبط متغير الرابط على Vercel."
  vercel env rm TURSO_AUTH_TOKEN_PROD "$ENV_NAME" --yes >/dev/null 2>&1 || true
  printf '%s' "$PROD_VALUE" | vercel env add TURSO_AUTH_TOKEN_PROD "$ENV_NAME" >/dev/null || fail "فشل ضبط متغير رمز التشغيل على Vercel."
  vercel env rm TURSO_AUTH_TOKEN "$ENV_NAME" --yes >/dev/null 2>&1 || true
  printf '%s' "$PROD_VALUE" | vercel env add TURSO_AUTH_TOKEN "$ENV_NAME" >/dev/null || fail "فشل ضبط المتغير الانتقالي على Vercel."
  echo "✅ Vercel: حُدِّثت المتغيرات على بيئة $ENV_NAME."
  echo "➡️  الخطوة الأخيرة: vercel deploy --prod (المتغيرات تُقرأ في نشر جديد)."
fi

echo
echo "🔁 التدوير: سجّل تاريخ إنشاء الرمزين اليوم في docs/ops/secret-rotation.md (جدول السجل) ودوّرهما قبل 90 يومًا؛ المجسّ اليومي ينبّه تلقائيًا عند فشل أي رمز."
echo "بعد التحديث: أي دفع إلى فرعك يعيد تشغيل المجسّ تلقائيًا، وبعد الدمج في main: gh workflow run turso-evidence.yml --ref main"
