#!/usr/bin/env bash
#
# تحويل توكن **منصّة** Turso إلى إعداد قاعدة صحيح — بأمر واحد ومعاملة واحدة:
#
#   TURSO_PLATFORM_TOKEN  ←  Platform API  (هنا فقط، ولا يغادره أبدًا)
#        ↓ mint
#   توكن قاعدة (full-access · PROD)  +  توكن قاعدة (read-only · CI · مدة قصيرة)
#        ↓ verify database auth          (SELECT 1 عبر verify-turso.mjs)
#        ↓ verify database identity      (check-db-identity.mjs — فشل مغلق)
#        ↓ explicit migration gate       (migrate-turso.mjs — لا هجرة وقت البناء
#        ↓                                ولا على أول طلب مستخدم)
#        ↓ verify schema                 (READY قبل أي كتابة سرّ)
#        ↓ ONLY THEN apply               (apply-turso-secrets.sh — حاجز حيّ ثم
#                                         GitHub production + Vercel Production)
#        ↓                               (النشر اللاحق: vercel deploy --prod ←
#                                         runtime probe — خارج هذا السكربت)
#
# الفصل الأسمية (نقطة4 في مراجعة المسار) — كل قيمة في حقلها:
#   TURSO_PLATFORM_TOKEN   توكن المنصّة — **لا يُطبع ولا يُكتب في GitHub ولا
#                          Vercel ولا ملف ولا سطر أوامر**؛ لا يغادر هذا
#                          السكربت (يُلغى قبل التسليم لـ apply). لا shell
#                          history: إما متغير بيئة أو مدخل مخفي read -rs.
#   TURSO_AUTH_TOKEN_PROD  توكن قاعدة full-access → Vercel Production
#                          (+ الجسر القديم TURSO_AUTH_TOKEN على Vercel فقط
#                          حتى يندمج فصل PR #18).
#   TURSO_AUTH_TOKEN_CI    توكن قاعدة read-only مدة يوم → GitHub production
#                          (+ الجسر القديم هناك — سياق CI يقرأ CI دائمًا).
#
# الفحص قبل التطبيق transactional — أي بوابة حمراء = توقّف قبل أي لمس:
#   GATE_AUTH · GATE_IDENTITY · GATE_MIGRATE · GATE_SCHEMA · GATE_CI_AUTH
#
# الاستخدام:
#   TURSO_PLATFORM_TOKEN='…' bash scripts/mint-turso-token.sh                 # تنفيذ كامل
#   TURSO_PLATFORM_TOKEN='…' bash scripts/mint-turso-token.sh --dry-run       # بلا أي كتابة (CI)
#   TURSO_PLATFORM_TOKEN='…' bash scripts/mint-turso-token.sh --skip-migrate  # قاعدة مهيّأة مسبقًا
#   TURSO_PLATFORM_TOKEN='…' TURSO_ORG=x TURSO_DB=y bash scripts/mint-turso-token.sh
#   TURSO_TOKEN_EXPIRATION=never TURSO_CI_TOKEN_EXPIRATION=1d …
#
# المتطلبات: curl · jq · node · node_modules كاملة (npm ci — tsx للبوابة
# الصريحة) — وأثناء التنفيذ الفعلي: gh وvercel لapply.
set -uo pipefail

MINT_USAGE_OFF=$(awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit } NR == 1 { next }' "$0" | head -n 40)

STAGE="INIT"
fail() { echo "❌ $*" >&2; echo "GATE_FAIL=${STAGE} — أُوقف هنا (لا قيمة في هذا السطر)"; exit 1; }

MIGRATE_FLAG="--migrate"     # بوابة الهجرات الصريحة: مفعّلة افتراضيًا في التنفيذ الكامل.
forward_args=()
for arg in "$@"; do
  case "$arg" in
    --skip-migrate) MIGRATE_FLAG="--skip-migrate" ;;
    -h|--help) printf '%s\n' "$MINT_USAGE_OFF"; exit 0 ;;
    *) forward_args+=("$arg") ;;
  esac
done

command -v curl >/dev/null 2>&1 || fail "curl غير مثبّت."
command -v jq >/dev/null 2>&1 || fail "jq غير مثبّت (مطلوب لقراءة استجابات المنصّة)."
command -v node >/dev/null 2>&1 || fail "node غير مثبّت."
[ -f scripts/verify-turso.mjs ] || fail "scripts/verify-turso.mjs مفقود — لا بوابة تحقّق بلا سكربت."
[ -f scripts/check-db-identity.mjs ] || fail "scripts/check-db-identity.mjs مفقود."
[ -f scripts/migrate-turso.mjs ] || fail "scripts/migrate-turso.mjs مفقود."

# — التوكن المنصّي: بيئة أو مدخل مخفي — لا argv أبدًا (لا ps ولا history).
STAGE="TOKEN"
PLATFORM_TOKEN="${TURSO_PLATFORM_TOKEN:-}"
if [ -n "$PLATFORM_TOKEN" ]; then
  TOKEN_SOURCE="env"
else
  printf 'أدخل TURSO_PLATFORM_TOKEN (لن يظهر على الشاشة ولا يُسجَّل): ' >&2
  read -rs PLATFORM_TOKEN
  printf '\n' >&2
  TOKEN_SOURCE="prompt"
fi
if [ -n "$PLATFORM_TOKEN" ]; then
  echo "GATE_TOKEN_SOURCE=${TOKEN_SOURCE} — التوكن المنصّي من البيئة أو مدخل مخفي (لا argv ولا تاريخ ولا طباعة)."
else
  fail "TURSO_PLATFORM_TOKEN فارغ — توكن المنصّة مطلوب (Account → API tokens). لا تستخدم TURSO_AUTH_TOKEN لهذا الدور."
fi

STAGE="PLATFORM"
API_BASE="${TURSO_API_BASE:-https://api.turso.tech}"
PROD_EXPIRATION="${TURSO_TOKEN_EXPIRATION:-never}"
CI_EXPIRATION="${TURSO_CI_TOKEN_EXPIRATION:-1d}"

api() { # $1=method · $2=url · $3=data? — يعيد الحالة في API_STATUS والجسم في API_BODY (لا طباعة).
  local method="$1" url="$2" data="${3:-}" out
  local args=(-sS -o - -w $'\n%{http_code}' --max-time 20 -X "$method"
    -H "Authorization: Bearer ${PLATFORM_TOKEN}" -H "Accept: application/json")
  [ -n "$data" ] && args+=(-H "Content-Type: application/json" --data "$data")
  out="$(curl "${args[@]}" "$url" 2>/dev/null || true)"
  API_STATUS="${out##*$'\n'}"
  API_BODY="${out%$'\n'*}"
  [ -n "$API_STATUS" ] || API_STATUS=000
}

mask() { local h="$1"; if [ "${#h}" -gt 12 ]; then printf '%s…%s' "${h:0:3}" "${h: -9}"; else printf '%s…' "${h:0:3}"; fi; }

# كل نداء verify يقرأ بيئته من الجملة نفسها — لا تلوّث متغيّرات الطرفية.
verify_pair() { # $1=الرابط · $2=الرمز → stdout JSON من verify (قراءة فقط)
  TURSO_DATABASE_URL="$1" TURSO_AUTH_TOKEN="$2" node scripts/verify-turso.mjs --json 2>/dev/null
}
verify_json() { # $1=الرمز الاختياري بديل (فارغ = PROD) → stdout JSON، رمز الخروج كما هو
  local tok="${1:-$TURSO_AUTH_TOKEN}"
  verify_pair "$TURSO_DATABASE_URL" "$tok"
}
row_ok() { printf '%s' "$1" | jq -r --arg id "$2" '.rows[]? | select(.id == $id) | .ok' 2>/dev/null; }
row_detail() { printf '%s' "$1" | jq -r --arg id "$2" '.rows[]? | select(.id == $id) | .detail' 2>/dev/null; }
print_rows() { # تفاصيل مُنقّاة أصلًا من verify — تُطبع للإنسان عند الفشل فقط.
  printf '%s' "$1" | jq -r '.rows[]? | select(.ok == false) | "   • \(.id): \(.detail)"' 2>/dev/null
}

# ───────────────────────── Platform API: المؤسسة والقاعدة والمضيف ─────────────
# عقد المنصّة الحقيقي (docs.turso.tech/api-reference/organizations/list): الاستجابة
# **مصفوفة سادة** [{name,slug,type,…}] لا كائن — ولكل حساب مؤسسة personal إضافة إلى
# فرقه؛ فمع أكثر من مؤسسة نمسح القراءة (GET فقط) ونختار التي تحوي قواعد، والتعادل
# أو الفراغ = طلب صريح بـ TURSO_ORG (ولا يُطبع أي اسم مؤسسة).
ORG="${TURSO_ORG:-}"
DB_JSON=""
api GET "$API_BASE/v1/organizations"
case "$API_STATUS" in
  200) ;;
  401|403) fail "توكن المنصّة مرفوض على المنصّة نفسها (HTTP ${API_STATUS}) — أنشئ توكنًا جديدًا: Account → API tokens." ;;
  *) fail "استجابة غير متوقعة من المنصّة (HTTP ${API_STATUS}) — تحقّق من الشبكة أو TURSO_API_BASE." ;;
esac
ORG_LIST="$(printf '%s' "$API_BODY" | jq -r 'if type=="array" then .[] else (.organizations // [])[] end | select(type=="object") | (.slug // .name // empty)' 2>/dev/null || true)"
ORG_COUNT=0
if [ -n "$ORG_LIST" ]; then
  ORG_COUNT="$(printf '%s\n' "$ORG_LIST" | grep -c . || true)"
fi
if [ -z "$ORG" ] && [ "$ORG_COUNT" = 1 ]; then
  ORG="$(printf '%s\n' "$ORG_LIST" | head -n1)"
fi
if [ -z "$ORG" ] && [ "$ORG_COUNT" -gt 1 ]; then
  FOUND=""
  FOUND_N=0
  while IFS= read -r cand; do
    [ -n "$cand" ] || continue
    api GET "$API_BASE/v1/organizations/$cand/databases"
    [ "$API_STATUS" = 200 ] || continue
    n="$(printf '%s' "$API_BODY" | jq '.databases | length' 2>/dev/null || echo 0)"
    case "$n" in ''|*[!0-9]*) n=0 ;; esac
    if [ "$n" -gt 0 ]; then
      FOUND_N=$((FOUND_N + 1))
      FOUND="$cand"
      DB_JSON="$API_BODY"
    fi
  done <<< "$ORG_LIST"
  if [ "$FOUND_N" = 1 ]; then
    ORG="$FOUND"
    echo "✅ اختيرت مؤسسة واحدة تحوي قاعدة (من ${ORG_COUNT} مؤسسة) — قراءة فقط بلا طباعة أي اسم."
  elif [ "$FOUND_N" = 0 ]; then
    fail "لا قاعدة في أي من ${ORG_COUNT} مؤسسة — حدّد TURSO_ORG=<اسم>."
  else
    fail "توجد ${FOUND_N} مؤسسات تحوي قواعد — حدّد TURSO_ORG=<اسم> (لا يُطبع أي اسم هنا)."
  fi
fi
[ -n "$ORG" ] || fail "تعذّر استنتاج اسم المؤسسة (HTTP 200 · عددها ${ORG_COUNT}) — شغّل بـ TURSO_ORG=<اسم>."
echo "✅ GATE_PLATFORM=PASS · المؤسسة: $(mask "$ORG") (طول ${#ORG})"

# جرد القاعدات — جسم المسح أعلاه يُعاد استخدامه إن وُجد (لا نداء مكرر).
if [ -z "$DB_JSON" ]; then
  api GET "$API_BASE/v1/organizations/$ORG/databases"
  [ "$API_STATUS" = 200 ] || fail "جرد القاعدات مرفوض (HTTP ${API_STATUS}) — تحقّق من TURSO_ORG أو ألغِه إن كانت مؤسستك واحدة."
  DB_JSON="$API_BODY"
fi
DB_COUNT="$(printf '%s' "$DB_JSON" | jq '.databases | length' 2>/dev/null || echo 0)"
[ "${DB_COUNT:-0}" -gt 0 ] || fail "لا توجد قاعدات في هذه المؤسسة."

DB="${TURSO_DB:-}"
if [ -z "$DB" ]; then
  if [ "$DB_COUNT" = 1 ]; then
    DB="$(printf '%s' "$DB_JSON" | jq -r '.databases[0] | (.Name // .name // .db_name // empty)' 2>/dev/null || true)"
  else
    # برهنة لا تخمين — وتشمل كل السجلات (حتى ذات parent): نلتقط الفرع إن كان
      # هو الإنتاجية. لكل سجل تُسكّ توكن قراءة قصير (5m — ينتهي وحده) ويُقرأ
      # verify بلا أي كتابة؛ «المستخدمة» = schema_migrations أو جدول order_items.
      # واحدة مُستخدمة فقط ⇒ هي المختارة؛ وإلا اسم صريح مطلوب (لا يُطبع أي اسم).
      TOUCHED_N=0
      CANDIDATES="$(printf '%s' "$DB_JSON" | jq -r '.databases[] | [(.Name // .name // .db_name), (.Hostname // .hostname)] | @tsv' 2>/dev/null || true)"
      EVIDENCE_I=0
      while IFS=$'\t' read -r cname chost; do
        [ -n "${cname:-}" ] && [ -n "${chost:-}" ] || continue
        EVIDENCE_I=$((EVIDENCE_I + 1))
        api POST "$API_BASE/v1/organizations/$ORG/databases/$cname/auth/tokens?authorization=read-only&expiration=5m" '{}'
        cjwt="$(printf '%s' "$API_BODY" | jq -r '.jwt // empty' 2>/dev/null || true)"
        if [ "$API_STATUS" != 200 ] || [ -z "$cjwt" ]; then
          # فحص مرشّح فشل — يُعلَن بالحالة فقط (لا اسم، لا جسم استجابة).
          echo "EVIDENCE i=${EVIDENCE_I} mint=${API_STATUS} jwt=$([ -n "$cjwt" ] && echo yes || echo no)"
          continue
        fi
        cv="$(verify_pair "libsql://${chost}" "$cjwt")"
        conn="$(row_ok "$cv" conn)"
        mig="$(row_ok "$cv" mig-table)"
        r7="$(row_ok "$cv" row-7)"
        r8="$(row_ok "$cv" row-8)"
        r9="$(row_ok "$cv" row-9)"
        if [ -z "$cv" ]; then conn="empty"; fi
        echo "EVIDENCE i=${EVIDENCE_I} mint=200 conn=${conn:-none} mig=${mig:-none} row7=${r7:-none} row8=${r8:-none} row9=${r9:-none}"
        # «مستخدمة» بأي أثر محتوى: جدول هجرات أو إصلاح P0 أو FTS أو تزامنه — لأن
        # الإنتاجية القديمة قد تسبق schema_migrations (يُثبتها FTS أو الجداول لا الهجرة).
        if [ "$mig" = "true" ] || [ "$r7" = "true" ] || [ "$r8" = "true" ] || [ "$r9" = "true" ]; then
          TOUCHED_N=$((TOUCHED_N + 1))
          DB="$cname"
        fi
      done <<< "$CANDIDATES"
      if [ "$TOUCHED_N" = 1 ]; then
        echo "✅ اختيرت بالبرهنة القاعدة المستخدمة وحدها (من ${DB_COUNT} سجلًا — جداول فعلية، قراءة فقط، توكن الفحص ينتهي خلال 5 دقائق)."
      elif [ "$TOUCHED_N" = 0 ]; then
        fail "لا جداول في أي من ${DB_COUNT} سجل — لا يمكن التعرّف على الإنتاجية؛ حدّد TURSO_DB=<اسم> (محليًا) أو vars.TURSO_DB (CI). لا يُطبع أي اسم قاعدة هنا."
      else
        fail "أكثر من سجل به جداول فعلية (${TOUCHED_N} من ${DB_COUNT}) — حدّد TURSO_DB=<اسم> (محليًا) أو vars.TURSO_DB (CI). لا يُطبع أي اسم قاعدة هنا."
      fi
  fi
fi
[ -n "$DB" ] || fail "تعذّر قراءة اسم القاعدة — شغّل بـ TURSO_DB=<اسم>."

HOSTNAME="$(printf '%s' "$DB_JSON" | jq -r --arg db "$DB" '.databases[] | select((.Name // .name // .db_name) == $db) | (.Hostname // .hostname // empty)' 2>/dev/null | head -n1 || true)"
[ -n "$HOSTNAME" ] || HOSTNAME="${DB}-${ORG}.turso.io"
CONNECTION_URL="libsql://${HOSTNAME}"
echo "✅ اُشتق رابط الاتصال من سجل المنصّة (طول ${#CONNECTION_URL}) · المضيف: $(mask "$HOSTNAME")"

# ───────────────────────── سكّ توكن القاعدة (PROD · full-access) ───────────────
STAGE="MINT_PROD"
mint_db_token() { # $1=authorization · $2=expiration → يطبع JWT فقط على stdout (لا شيء آخر)
  local auth="$1" exp="$2"
  api POST "$API_BASE/v1/organizations/$ORG/databases/$DB/auth/tokens?authorization=${auth}&expiration=${exp}" '{}'
  [ "$API_STATUS" = 200 ] || return 1
  printf '%s' "$API_BODY" | jq -r '.jwt // empty'
}

DB_JWT="$(mint_db_token full-access "$PROD_EXPIRATION")" || fail "فشل إنشاء توكن القاعدة PROD (HTTP ${API_STATUS})."
case "$DB_JWT" in eyJ*.*.*) ;; *) fail "استجابة الإنشاء لا تحمل JWT (طول ${#API_BODY})." ;; esac
echo "✅ أُنشئ توكن القاعدة PROD (full-access · انتهاء ${PROD_EXPIRATION} · JWT طول ${#DB_JWT}) — لا يُطبع ولا يُسجَّل."

# زوج العمل لبقية البوابات والـ apply (PROD هو الرابط المرجعي).
export TURSO_DATABASE_URL="$CONNECTION_URL"
export TURSO_AUTH_TOKEN="$DB_JWT"


# أي بوابة تحتمل الإجراءات المتبقية؟ --skip-verify يتجاوز الشبكيّة مع تحذير صريح.
SKIP_VERIFY=false
DRY_RUN=false
for a in "${forward_args[@]:-}"; do
  [ "$a" = "--skip-verify" ] || [ "$a" = "--no-verify" ] && SKIP_VERIFY=true
  [ "$a" = "--dry-run" ] && DRY_RUN=true
done

# ───────────────────────── GATE_AUTH — الاتصال بالتوكن الجديد ─────────────────
STAGE="GATE_AUTH"
VJSON=""
if [ "$SKIP_VERIFY" = true ]; then
  echo "⚠️  GATE_AUTH=SKIPPED · GATE_SCHEMA=SKIPPED · GATE_MIGRATE=SKIPPED · GATE_CI_AUTH=SKIPPED (--skip-verify)" >&2
else
  VJSON="$(verify_json "")" || true
  if [ "$(row_ok "$VJSON" conn)" = "true" ]; then
    echo "✅ GATE_AUTH=PASS — التوكن الجديد يفتح الاتصال فعليًا (SELECT 1)."
  else
    echo "❌ GATE_AUTH=FAIL — القاعدة رفضت الزوج الجديد:" >&2
    print_rows "$VJSON" >&2
    echo "GATE_AUTH=FAIL" >&2
    exit 1
  fi
fi

# ───────────────────────── GATE_IDENTITY — فشل مغلق عند المخالفة ──────────────
STAGE="GATE_IDENTITY"
# (محلي بلا شبكة — يعمل حتى مع --skip-verify؛ المدخلات عبر بيئة فقط.)
if MINTED_DB_TOKEN="$DB_JWT" EXPECTED_DB="$DB" EXPECTED_ORG="$ORG" EXPECTED_HOST="$HOSTNAME" \
  node scripts/check-db-identity.mjs; then
  :
else
  fail "GATE_IDENTITY=FAIL — التوكن لا يخصّ هذه القاعدة؛ أُوقفت كل الكتابات."
fi

# ───────────────────────── GATE_MIGRATE — بوابة الهجرات الصريحة ───────────────
STAGE="GATE_MIGRATE"
# لا هجرة وقت البناء (NO MIGRATION DURING BUILD) ولا على أول طلب مستخدم:
# خطوة صريحة هنا، بين «الاتصال ثابت» و«التطبيق».
if [ "$SKIP_VERIFY" = true ]; then
  : # مُسبَّق التحذير أعلاه
elif [ "$MIGRATE_FLAG" = "--skip-migrate" ]; then
  echo "⏭️  GATE_MIGRATE=SKIPPED (--skip-migrate) — تتطلّب GATE_SCHEMA=READY وإلا أُوقف."
elif [ "$DRY_RUN" = true ]; then
  echo "⏭️  GATE_MIGRATE=SKIPPED_DRY_RUN — المعاينة لا تكتب في القاعدة إطلاقًا."
else
  echo "🚪 GATE_MIGRATE — بوابة الهجرات الصريحة (كتابة صريحة على القاعدة)…"
  mig_out="$(node --import tsx scripts/migrate-turso.mjs 2>&1)" && mig_rc=0 || mig_rc=$?
  printf '%s\n' "$mig_out"
  case "$mig_out" in
    *MIGRATE_GATE=APPLIED*|*MIGRATE_GATE=ALREADY*) echo "✅ GATE_MIGRATE=PASS" ;;
    *) echo "❌ GATE_MIGRATE=FAIL — أُوقف قبل أي تطبيق (كود ${mig_rc})." >&2; exit 1 ;;
  esac
fi

# ───────────────────────── GATE_SCHEMA — الجاهزية قبل أي كتابة سرّ ────────────
STAGE="GATE_SCHEMA"
schema_gate() { # $1=VJSON · $2=mode (enforce|report) → 0 مقبول · 1 مرفوض
  local v="$1" mode="$2" mig ok_par
  [ "$(row_ok "$v" conn)" = "true" ] || { echo "   • الاتصال نفسه فقد (GATE_AUTH سابق)."; return 1; }
  mig="$(row_ok "$v" mig-table)"
  if [ "$mig" = "true" ]; then
    for id in mig-parity row-7 row-8 row-9 tables; do
      if [ "$(row_ok "$v" "$id")" != "true" ]; then
        echo "❌ GATE_SCHEMA=DIVERGED — جدول موجود لكن فحصًا حمراء:" >&2
        print_rows "$v" >&2
        return 1
      fi
    done
    echo "✅ GATE_SCHEMA=READY — schema_migrations متطابقة وكل صفوف المحتوى خضراء."
    return 0
  fi
  if [ "$mode" = "report" ]; then
    echo "⚠️  GATE_SCHEMA=EMPTY — قاعدة فارغة (متوقّع قبل أول تشغيل لبوابة الهجرات) — لا تُطبَّق أسرار في المعاينة إلا بجاهزية مُعلنة."
    echo "   • $(row_detail "$v" mig-table)"
    return 0
  fi
  echo "❌ GATE_SCHEMA=NOT_READY — بعد بوابة الهجرات: schema_migrations غير جاهزة — فشل مغلق." >&2
  print_rows "$v" >&2
  return 1
}

if [ "$SKIP_VERIFY" = true ]; then
  :
else
  # بعد الهجرة الصريحة (أو في المعاينة): قراءة جديدة للحكم على الحالة الفعلية.
  VJSON="$(verify_json "")" || true
  if [ "$DRY_RUN" = true ]; then
    schema_gate "$VJSON" report || exit 1
  else
    schema_gate "$VJSON" enforce || exit 1
  fi
fi

# ───────────────────────── سكّ توكن القاعدة (CI · read-only · قصير) ────────────
STAGE="MINT_CI"
CI_JWT=""
if [ "$SKIP_VERIFY" = true ]; then
  echo "⏭️  GATE_CI_AUTH=SKIPPED (--skip-verify)" >&2
else
  CI_JWT="$(mint_db_token read-only "$CI_EXPIRATION")" || fail "فشل إنشاء توكن CI read-only (HTTP ${API_STATUS})."
  case "$CI_JWT" in eyJ*.*.*) ;; *) fail "توكن CI غير صالح (طول ${#API_BODY})." ;; esac
  echo "✅ أُنشئ توكن CI (read-only · انتهاء ${CI_EXPIRATION} · JWT طول ${#CI_JWT})."
  if [ "$(row_ok "$(verify_json "$CI_JWT")" conn)" = "true" ]; then
    echo "✅ GATE_CI_AUTH=PASS — توكن CI يفتح اتصالًا للقراءة فقط."
  else
    fail "GATE_CI_AUTH=FAIL — توكن CI مرفوض؛ لا تُطبَّق أي أسرار."
  fi
  export TURSO_AUTH_TOKEN_CI="$CI_JWT"
fi

# الدور الكامل: PROD كقيمة أساس (ول.'_PROD' عند وجودها) + CI منفصل تمامًا.
export TURSO_AUTH_TOKEN_PROD="$DB_JWT"

# ───────────────────────── تسليم معامل — المنصّي لا يغادر هنا ─────────────────
# (لا يُطبع · لا في GitHub · لا في Vercel · لا في ملف · لا في argv.)
STAGE="APPLY"
unset TURSO_PLATFORM_TOKEN PLATFORM_TOKEN
echo
echo "→ ALL GATES PASSED — تسليم الزوج إلى apply-turso-secrets.sh (حاجز حيّ ثم GitHub production + Vercel Production):"
echo
if [ "${#forward_args[@]}" -eq 0 ]; then
  exec bash scripts/apply-turso-secrets.sh
else
  exec bash scripts/apply-turso-secrets.sh "${forward_args[@]}"
fi
