#!/usr/bin/env bash
#
# تحويل توكن **منصّة** Turso إلى (رابط اتصال + توكن قاعدة) ثم تمريرهما إلى
# `apply-turso-secrets.sh` — أي تحويل الحالة الحالية (المنصّة مضبوطة في حقل
# توكن القاعدة) إلى الإعداد الصحيح بأمر واحد، بلا أي قيمة في المخرجات.
#
# السبب: توكن المنصّة صالح على api.turso.tech (200) لكنه **مرفوض** على حافة
# القاعدة (`can't be decoded with any of the existing keys`) — حقلان مختلفان
# وعلاجهما هذا الملف:
#   1. GET  /v1/organizations                          ← التحقق من التوكن + المؤسسة
#   2. GET  /v1/organizations/{org}/databases          ← الاسم + المضيف (الأسماء لا تُطبع)
#   3. POST /v1/organizations/{org}/databases/{db}/auth/tokens
#            ?authorization=full-access&expiration=…   ← توكن القاعدة (JWT)
#   4. exec apply-turso-secrets.sh [كل خياراته سليمة]  ← حاجز الاتصال الحيّ ثم
#            تطبيق GitHub production + Vercel Production (أو --dry-run للمعاينة).
#
# الاستخدام:
#   TURSO_API_TOKEN='…' bash scripts/mint-turso-token.sh                 # تنفيذ كامل
#   TURSO_API_TOKEN='…' bash scripts/mint-turso-token.sh --dry-run       # معاينة فقط
#   TURSO_API_TOKEN='…' TURSO_ORG=x TURSO_DB=y bash scripts/mint-turso-token.sh
#   TURSO_API_TOKEN='…' TURSO_TOKEN_EXPIRATION=1d bash scripts/mint-turso-token.sh
#
# متغيّرات اختيارية:
#   TURSO_ORG                اسم المؤسسة (يُستنتج تلقائيًا عند اختلاف الأشكال)
#   TURSO_DB                 اسم القاعدة (يُستنتج عند وجود قاعدة واحدة)
#   TURSO_TOKEN_EXPIRATION   مدة توكن القاعدة — never (الافتراضي) أو 1d/2w/30m
#   TURSO_API_BASE           للاختبار فقط — عنوان الـ API الافتراضي api.turso.tech
#
# مبادئ: القيم لا تُطبع ولا تمرّ كوسائط سطر (أحجام فقط)؛ لا تُكتب القيمة في
# المخرجات ولا في اسم ملف مؤقت؛ كل ما يُطبع رموز حالة وأوصاف شكليّة.
set -uo pipefail

fail() { echo "❌ $*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || fail "curl غير مثبّت."
command -v jq >/dev/null 2>&1 || fail "jq غير مثبّت (مطلوب لقراءة استجابات المنصّة)."

PLATFORM_TOKEN="${TURSO_API_TOKEN:-}"
[ -n "$PLATFORM_TOKEN" ] || fail "TURSO_API_TOKEN غير مضبوط — هو توكن المنصّة نفسه (المضبوط اليوم خطأً في TURSO_AUTH_TOKEN). خذه من لوحة Turso → Account → API tokens أو من مكان حفظك، وضعه في متغير بيئة: export TURSO_API_TOKEN='…' — لا تلصقه في المحادثة ولا في سطر الأوامر."

API_BASE="${TURSO_API_BASE:-https://api.turso.tech}"
EXPIRATION="${TURSO_TOKEN_EXPIRATION:-never}"

# نداء منصّة — يعيد رمز الحالة في API_STATUS والجسم في API_BODY (لا طباعة هنا).
api() {
  local method="$1" url="$2" data="${3:-}" out
  local args=(-sS -o - -w $'\n%{http_code}' --max-time 20 -X "$method"
    -H "Authorization: Bearer ${PLATFORM_TOKEN}" -H "Accept: application/json")
  [ -n "$data" ] && args+=(-H "Content-Type: application/json" --data "$data")
  out="$(curl "${args[@]}" "$url" 2>/dev/null || true)"
  API_STATUS="${out##*$'\n'}"
  API_BODY="${out%$'\n'*}"
  [ -n "$API_STATUS" ] || API_STATUS=000
}

mask() { # نفس قناع المضيف elsewhere: أول3 + … + آخر9 للأطوال الكبيرة.
  local h="$1"
  if [ "${#h}" -gt 12 ]; then printf '%s…%s' "${h:0:3}" "${h: -9}"; else printf '%s…' "${h:0:3}"; fi
}

# 1) التحقق من التوكن + اكتشاف المؤسسة (يُتجاوز بـ TURSO_ORG).
ORG="${TURSO_ORG:-}"
api GET "$API_BASE/v1/organizations"
case "$API_STATUS" in
  200)
    if [ -z "$ORG" ]; then
      ORG="$(printf '%s' "$API_BODY" | jq -r '[.organizations[]? | (.slug // .organization.slug // .name // .organization.name // empty)] | if length == 1 then .[0] else empty end' 2>/dev/null || true)"
    fi
    ;;
  401|403) fail "توكن المنصّة مرفوض على المنصّة نفسها (HTTP ${API_STATUS}) — أنشئ توكنًا جديدًا من لوحة Turso → Account → API tokens." ;;
  *) fail "استجابة غير متوقعة من المنصّة (HTTP ${API_STATUS}) — تحقّق من الشبكة أو من TURSO_API_BASE." ;;
esac
[ -n "$ORG" ] || fail "تعذّر استنتاج اسم المؤسسة من /v1/organizations (HTTP 200) — شغّل بـ TURSO_ORG=<اسم>."
echo "✅ توكن المنصّة صالح (HTTP 200) · المؤسسة: $(mask "$ORG") (طول ${#ORG})"

# 2) جرد القاعدات — الاسم والمضيف لا يُطبعان؛ يُطبع العدد والأطوال فقط.
api GET "$API_BASE/v1/organizations/$ORG/databases"
[ "$API_STATUS" = 200 ] || fail "جرد القاعدات مرفوض (HTTP ${API_STATUS})."
DB_COUNT="$(printf '%s' "$API_BODY" | jq '.databases | length' 2>/dev/null || echo 0)"
[ "${DB_COUNT:-0}" -gt 0 ] || fail "لا توجد قاعدات في هذه المؤسسة — أنشئها من اللوحة أولًا."

DB="${TURSO_DB:-}"
if [ -z "$DB" ]; then
  if [ "$DB_COUNT" = 1 ]; then
    DB="$(printf '%s' "$API_BODY" | jq -r '.databases[0] | (.Name // .name // .db_name // empty)' 2>/dev/null || true)"
  else
    fail "توجد ${DB_COUNT} قاعدة — حدّدها بـ TURSO_DB=<اسم> (لا يُطبع أي اسم هنا)."
  fi
fi
[ -n "$DB" ] || fail "تعذّر قراءة اسم القاعدة منجرد القاعدات — شغّل بـ TURSO_DB=<اسم>."

HOSTNAME="$(printf '%s' "$API_BODY" | jq -r --arg db "$DB" '.databases[] | select((.Name // .name // .db_name) == $db) | (.Hostname // .hostname // empty)' 2>/dev/null | head -n1 || true)"
if [ -z "$HOSTNAME" ]; then
  HOSTNAME="${DB}-${ORG}.turso.io"
fi
CONNECTION_URL="libsql://${HOSTNAME}"
echo "✅ اُشتق رابط الاتصال من المنصّة (طول ${#CONNECTION_URL}) · المضيف المقنّع: $(mask "$HOSTNAME")"

# 3) توكن القاعدة — يُستخرج من .jwt ولا يُطبع أبدًا.
api POST "$API_BASE/v1/organizations/$ORG/databases/$DB/auth/tokens?authorization=full-access&expiration=${EXPIRATION}" '{}'
[ "$API_STATUS" = 200 ] || fail "فشل إنشاء توكن القاعدة (HTTP ${API_STATUS}) — تحقق من صلاحية توكن المنصّة للإنشاء."
DB_JWT="$(printf '%s' "$API_BODY" | jq -r '.jwt // empty' 2>/dev/null || true)"
case "$DB_JWT" in
  eyJ*.*.*) ;;
  *) fail "استجابة الإنشاء لا تحمل JWT (طول الاستجابة ${#API_BODY}) — فشل غير متوقّع." ;;
esac
echo "✅ أُنشئ توكن القاعدة (JWT طول ${#DB_JWT} · انتهاء ${EXPIRATION}) — لا يُطبع ولا يُسجَّل."

echo
echo "→ تمرير الزوج إلى apply-turso-secrets.sh (حاجز الاتصال الحيّ ثم GitHub + Vercel):"
echo

# 4) التنفيذ: القيم عبر البيئة فقط (لا ps، لا سجل) — وكل خيارات المستخدم
#    تمرّ كما هي (--dry-run / --github-only / --skip-verify / …).
export TURSO_DATABASE_URL="$CONNECTION_URL"
export TURSO_AUTH_TOKEN="$DB_JWT"
exec bash scripts/apply-turso-secrets.sh "$@"
