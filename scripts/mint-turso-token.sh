#!/usr/bin/env bash
#
# سكّ رمز قاعدة Turso وتفعيلها بأمر واحد — من رمز المنصة إلى قاعدة مهاجَرة وأسرار مضبوطة:
#   1. حلّ الهدف (المنظمة + القاعدة) من الأعلام أو من القيم المضبوطة حاليًا أو من
#      Platform API، وأخذ رابط الاتصال القانوني من ردّ الخادم نفسه (لا من تخمين).
#   2. سكّ رمز القاعدة (POST …/auth/tokens) بعمر محدود افتراضيًا (90 يومًا) — الرمز
#      لا يُطبع ولا يمرّ في argv، ويُسجَّل موعد تدويره في الخلاصة.
#   3. بوابة الهجرات الصريحة: `scripts/apply-migrations.mjs --apply` تُطبّق هجرات
#      المستودع (اليوم 0001+0002) عبر `runMigrations` نفسه المستخدم في الإنتاج.
#   4. تطبيق الأسرار: `scripts/apply-turso-secrets.sh` بالزوج الجديد (GitHub + Vercel).
#
# مبادئ أمنية غير قابلة للتفاوض (نفسها في apply-turso-secrets.sh):
#   - لا تُطبع أي قيمة سرية: لا رمز المنصة ولا الرمز المسكوك؛ المعروض أوصاف شكلية
#     (النوع/الطول/الانتهاء/مستوى الصلاحية) ومعرّفات مقنّعة.
#   - القيم تُمرَّر عبر بيئة الطفل أو stdin أو ملف 0600، لا عبر وسائط سطر الأوامر
#     (المرئية في `ps`).
#   - `--dry-run` لا يلمس شيئًا: نداءات GET فقط — بلا سكّ، بلا هجرة، بلا أسرار.
#   - لا يُسكّ رمز بلا وجهة تسليم (gh أو vercel أو ملف بيئة مُتجاهَل) — وإلا وُجد
#     سرّ صالح على القاعدة لا يملكه أحد، ولا يُسترجع بعد سكّه.
#   - الترتيب ثابت: الأسرار لا تُطبَّق إلا بعد نجاح بوابة الهجرات (أو تخطّيها صراحة).
#
# الاستخدام:
#   export TURSO_PLATFORM_TOKEN='eyJ…'           # أو يُطلب من مدخل مخفي (read -rs)
#   bash scripts/mint-turso-token.sh --dry-run   # معاينة: يطابق ما رأته CI الآن
#   bash scripts/mint-turso-token.sh             # المعاملة الحقيقية
#   bash scripts/mint-turso-token.sh --org elazamey --db aborof
#   bash scripts/mint-turso-token.sh --expect 0001,0002       # الرمز ينتهي بعد 90 يومًا (الافتراضي)
#   bash scripts/mint-turso-token.sh --expiration never       # هروب صريح من التدوير (غير موصى به)
#   bash scripts/mint-turso-token.sh --github-only --skip-migrations
#   bash scripts/mint-turso-token.sh --save-env .env.local   # بلا gh/vercel: ملف محلي 0600
#   bash scripts/mint-turso-token.sh --env-file .env.local --dry-run
#
# المتطلبات: node + `npm ci` (لـ @libsql/client وtsx)، و`gh` مصادَق بصلاحية كتابة
# أسرار البيئة لجهة GitHub، و`vercel` CLI لجهة Vercel — وتُطبَّق الجهة المتاحة وحدها.
# رمز المنصة: Turso → Account/Organization → API Tokens (نطاق يغطّي القاعدة الهدف
# وصلاحية db:mint-token). لا يُدفع إلى Git ولا يُكتب في ملف متتبَّع أبدًا.
set -uo pipefail

REPO=""
ENV_NAME="production"
ORG="${TURSO_ORG:-}"
DB="${TURSO_DB:-}"
API_BASE="${TURSO_API_BASE:-https://api.turso.tech/v1}"
API_BASE_EXPLICIT=false   # --api-base على السطر أولى من أي ملف بيئة
# العمر الافتراضي 90 يومًا لا `never`: رموز Turso لا تُسترجع بعد إنشائها ولا تُلغى
# فرديًا، فالرمز الأبدي المسرَّب يبقى صالحًا إلى الأبد — والتدوير أمر واحد (أعد
# هذا السكربت). الهروب الصريح: --expiration never.
EXPIRATION="${TURSO_TOKEN_EXPIRATION:-90d}"
AUTHORIZATION="full-access"
EXPECT=""
CURRENT_URL="${TURSO_DATABASE_URL:-}"
CURRENT_TOKEN="${TURSO_AUTH_TOKEN:-}"
PLATFORM_TOKEN="${TURSO_PLATFORM_TOKEN:-}"

DRY_RUN=false
SKIP_MIGRATIONS=false
SKIP_SECRETS=false
SKIP_VERIFY=false
SKIP_GITHUB=false
SKIP_VERCEL=false
SHOW_TARGET=false
SAVE_ENV=""
ENV_FILE=""
MIGRATIONS_URL=""

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --skip-migrations|--no-migrations) SKIP_MIGRATIONS=true ;;
    --skip-secrets|--no-secrets) SKIP_SECRETS=true ;;
    --skip-verify|--no-verify) SKIP_VERIFY=true ;;
    --github-only) SKIP_VERCEL=true ;;
    --vercel-only) SKIP_GITHUB=true ;;
    --read-only) AUTHORIZATION="read-only" ;;
    --show-target) SHOW_TARGET=true ;;
    --org) shift; ORG="${1:-}" ;;
    --db) shift; DB="${1:-}" ;;
    --repo) shift; REPO="${1:-}" ;;
    --env) shift; ENV_NAME="${1:-production}" ;;
    --expiration) shift; EXPIRATION="${1:-90d}" ;;
    --expect) shift; EXPECT="${1:-}" ;;
    --api-base) shift; API_BASE="${1:-}"; API_BASE_EXPLICIT=true ;;
    --save-env) shift; SAVE_ENV="${1:-}" ;;
    --env-file) shift; ENV_FILE="${1:-}" ;;
    --migrations-url) shift; MIGRATIONS_URL="${1:-}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "خيار غير معروف: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

fail() { echo "❌ $*" >&2; exit 1; }
warn() { echo "⚠️  $*" >&2; }

# ---------------------------------------------------------------------------
# أدوات
# ---------------------------------------------------------------------------

# نداء طبقة API: المعطيات غير السرية في argv، ورمز المنصة في بيئة الطفل فقط.
turso_api() {
  TURSO_PLATFORM_TOKEN="$PLATFORM_TOKEN" node scripts/lib/turso-api.mjs "$@"
}

# استخراج حقول JSON إلى متغيرات مُسمّاة بلا eval: الخريطة "NAME=path,NAME=path"
# والمخرَج أسطر "NAME<US>value" — فاصل لا يظهر في JWT ولا في رابط.
load_json_vars() {
  local json="$1" mapping="$2" out line name value
  out="$(printf '%s' "$json" | JSON_MAP="$mapping" node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      let j;
      try { j = JSON.parse(s); } catch { process.exit(3); }
      const get = (p) => String(p).split(".").reduce((acc, k) => (acc == null ? undefined : acc[k]), j);
      const lines = [];
      for (const pair of String(process.env.JSON_MAP || "").split(",")) {
        if (!pair) continue;
        const at = pair.indexOf("=");
        const name = at < 0 ? pair : pair.slice(0, at);
        const path = at < 0 ? pair : pair.slice(at + 1);
        const value = get(path);
        const text = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
        lines.push(name + "\u0001" + text.replace(/[\r\n\u0001]+/g, " "));
      }
      process.stdout.write(lines.join("\n"));
    });')" || return 3
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    name="${line%%$'\x01'*}"
    value="${line#*$'\x01'}"
    printf -v "$name" '%s' "$value"
  done <<< "$out"
}

# تحميل ملف بيئة (KEY=VALUE) لمفاتيح Turso وحدها — بلا eval ولا source.
load_env_file() {
  local file="$1" line key value current
  [ -f "$file" ] || fail "--env-file: الملف غير موجود ($file)."
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    case "$line" in *=*) ;; *) continue ;; esac
    key="${line%%=*}"
    value="${line#*=}"
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    value="${value#"${value%%[![:space:]]*}"}"
    case "$value" in \"*\") value="${value%\"}"; value="${value#\"}" ;; \'*\') value="${value%\'}"; value="${value#\'}" ;; esac
    # القائمة البيضاء وحدها تُقبل — فلا eval ولا source ولا تنفيذ لشيء من الملف.
    if [ "$key" = "TURSO_API_BASE" ]; then
      # له افتراضي دائم، فمعيار الأولوية هنا هو العلم الصريح لا الفراغ.
      [ "$API_BASE_EXPLICIT" = true ] && continue
      [ -n "$value" ] && API_BASE="$value"
      continue
    fi
    current=""
    case "$key" in
      TURSO_PLATFORM_TOKEN) current="$PLATFORM_TOKEN" ;;
      TURSO_DATABASE_URL) current="$CURRENT_URL" ;;
      TURSO_AUTH_TOKEN) current="$CURRENT_TOKEN" ;;
      TURSO_ORG) current="$ORG" ;;
      TURSO_DB) current="$DB" ;;
      *) continue ;;
    esac
    # القائم في البيئة أولى: لا يدهس الملفُ export صريحًا.
    [ -n "$current" ] && continue
    printf -v "$key" '%s' "$value"
  done < "$file"
  PLATFORM_TOKEN="${TURSO_PLATFORM_TOKEN:-}"
  CURRENT_URL="${TURSO_DATABASE_URL:-}"
  CURRENT_TOKEN="${TURSO_AUTH_TOKEN:-}"
  ORG="${ORG:-${TURSO_ORG:-}}"
  DB="${DB:-${TURSO_DB:-}}"
}

# فحص الاتصال الحيّ (للقراءة فقط) بنفس تصنيف apply-turso-secrets.sh:
# 0 = VERIFY_SUCCESS · 11 = VERIFY_SCHEMA_NOT_READY · 10 = VERIFY_CONNECTION_FAILED · 3 = تقرير غير صالح.
verify_gate() {
  local stage="$1" target_url="$2" target_token="$3" verify_json verify_class err_file verify_err
  command -v node >/dev/null 2>&1 || fail "node غير مثبّت — الفحص الحيّ إلزامي؛ أو تخطَّه صراحة بـ --skip-verify."
  [ -d node_modules/@libsql/client ] || fail "node_modules ناقصة (@libsql/client) — شغّل 'npm ci' أولًا، أو تخطَّ بـ --skip-verify."
  echo "🔍 فحص اتصال حيّ ($stage) — للقراءة فقط، بلا هجرة وبلا كتابة…"
  err_file="$(mktemp)"
  verify_json="$(TURSO_DATABASE_URL="$target_url" TURSO_AUTH_TOKEN="$target_token" node scripts/verify-turso.mjs --json 2>"$err_file")"
  verify_err="$(cat "$err_file")"
  rm -f "$err_file"
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
    0) echo "✅ VERIFY_SUCCESS ($stage): القاعدة تستقبل هذا الزوج وكل الصفوف خضراء." ;;
    11)
      warn "VERIFY_SCHEMA_NOT_READY ($stage): الاتصال ناجح وصفوف لاحقة حمراء — متوقّع على قاعدة جديدة قبل الهجرات."
      ;;
    10) fail "VERIFY_CONNECTION_FAILED ($stage): القاعدة رفضت هذا الزوج — توقّف قبل أي كتابة. ${verify_err}" ;;
    *) fail "VERIFY_REPORT_UNUSABLE ($stage): لم يُفهم تقرير الفحص. ${verify_err}" ;;
  esac
}

# كتابة الزوج في ملف محلي 0600 مع إبقاء بقية المفاتيح (بلا clobber).
write_env_file() {
  local file="$1" tmp
  tmp="$(mktemp)"
  chmod 600 "$tmp"
  if [ -f "$file" ]; then
    { grep -v '^TURSO_DATABASE_URL=' "$file" || true; } | { grep -v '^TURSO_AUTH_TOKEN=' || true; } > "$tmp"
  fi
  {
    echo "# مُولَّد بواسطة scripts/mint-turso-token.sh — $(date -u +%FT%TZ)"
    echo "# لا يُدفع إلى Git: تأكد أنه مُتجاهَل (.env*.local)."
    echo "TURSO_DATABASE_URL=$FINAL_URL"
    echo "TURSO_AUTH_TOKEN=$MINT_JWT"
  } >> "$tmp"
  mv "$tmp" "$file"
  chmod 600 "$file"
}

# ---------------------------------------------------------------------------
# 0) المتطلبات والمداخل
# ---------------------------------------------------------------------------

command -v node >/dev/null 2>&1 || fail "node غير مثبّت — كل خطوات هذا السكربت تمرّ عبر node."
for required in scripts/lib/turso-api.mjs scripts/apply-migrations.mjs scripts/apply-turso-secrets.sh scripts/verify-turso.mjs; do
  [ -f "$required" ] || fail "$required مفقود — لا يمكن إكمال المعاملة."
done

[ -n "$ENV_FILE" ] && load_env_file "$ENV_FILE"

if [ -z "$PLATFORM_TOKEN" ] && [ "$DRY_RUN" = false ]; then
  printf 'أدخل TURSO_PLATFORM_TOKEN (لن يظهر على الشاشة): ' >&2
  read -rs PLATFORM_TOKEN
  printf '\n' >&2
fi
if [ -z "$PLATFORM_TOKEN" ] && [ "$DRY_RUN" = true ]; then
  warn "بلا TURSO_PLATFORM_TOKEN: المعاينة تشتقّ الهدف محليًا ولا تؤكّده من الخادم (المعاملة الحقيقية تحتاجه)."
fi
# الفشل المبكر قبل أي نداء: لا معنى لحلّ الهدف ثم اكتشاف أن السكّ مستحيل.
[ -n "$PLATFORM_TOKEN" ] || [ "$DRY_RUN" = true ] || fail "TURSO_PLATFORM_TOKEN فارغ — يلزم رمز منصة للسكّ (Turso → API Tokens، نطاق يغطّي القاعدة وصلاحية db:mint-token)."

case "$AUTHORIZATION" in
  full-access|read-only) ;;
  *) fail "مستوى الصلاحية يجب أن يكون full-access أو read-only (وصل: $AUTHORIZATION)." ;;
esac
case "$EXPIRATION" in
  never) ;;
  *[!0-9smhdwySMHDWY]*) fail "مدة انتهاء غير مقبولة: $EXPIRATION — الصيغة never أو مثل 90d / 2w1d30m." ;;
  "") fail "مدة انتهاء فارغة." ;;
esac

# رمز القراءة فقط لا يستطيع تطبيق الهجرات (كتابة) — يُرفض قبل أي نداء للخادم.
if [ "$AUTHORIZATION" = "read-only" ] && [ "$SKIP_MIGRATIONS" = false ] && [ "$DRY_RUN" = false ]; then
  fail "--read-only يسكّ رمزًا لا يكتب، وبوابة الهجرات كتابة — أضف --skip-migrations أو اترك الصلاحية الكاملة (الافتراضي)."
fi

# وجهة التسليم تُحسم **قبل** السكّ: رمز بلا وجهة = سرّ صالح لا يملكه أحد.
DESTINATIONS=""
if [ "$SKIP_SECRETS" = false ]; then
  if [ "$SKIP_GITHUB" = false ]; then
    if command -v gh >/dev/null 2>&1; then DESTINATIONS="${DESTINATIONS}GitHub(بيئة $ENV_NAME) "; else warn "gh غير مثبّت — جهة GitHub لن تُطبَّق (أضف السرّين يدويًا في Settings → Environments → $ENV_NAME)."; fi
  fi
  if [ "$SKIP_VERCEL" = false ]; then
    if command -v vercel >/dev/null 2>&1; then DESTINATIONS="${DESTINATIONS}Vercel($ENV_NAME) "; else warn "vercel CLI غير مثبّت — جهة Vercel لن تُطبَّق (أضف المتغيّرين من اللوحة ثم أعد النشر)."; fi
  fi
fi
if [ -n "$SAVE_ENV" ]; then
  if git ls-files --error-unmatch "$SAVE_ENV" >/dev/null 2>&1; then
    fail "--save-env يشير إلى ملف متتبَّع في Git ($SAVE_ENV) — لا يُكتب سرّ في مستودع. استخدم .env.local (مُتجاهَل)."
  fi
  if git check-ignore -q "$SAVE_ENV" 2>/dev/null; then :; else
    warn "$SAVE_ENV غير مُدرج في .gitignore — لا تُضفه إلى Git بعد الكتابة."
  fi
  DESTINATIONS="${DESTINATIONS}ملف-محلي(0600) "
fi
if [ "$DRY_RUN" = false ] && [ -z "${DESTINATIONS// /}" ]; then
  fail "لا وجهة تسليم للرمز المسكوك: ثبّت gh أو vercel، أو مرّر --save-env .env.local، أو اكتفِ بالمعاينة (--dry-run)."
fi

# ---------------------------------------------------------------------------
# 1) حلّ الهدف (قراءة فقط) — نفسه في المعاينة وفي المعاملة الحقيقية
# ---------------------------------------------------------------------------

echo "1) حلّ الهدف من Turso Platform API (قراءة فقط)…"
RESOLVE_JSON="$(turso_api resolve --org "$ORG" --db "$DB" --url "$CURRENT_URL" --api-base "$API_BASE")"
load_json_vars "$RESOLVE_JSON" \
  "RESOLVE_OK=ok,RESOLVE_ERROR=error,TARGET_ORG=org,TARGET_DB=db,TARGET_URL=url,TARGET_HOST=hostname,TARGET_SOURCE=source,TARGET_CONFIRMED=apiConfirmed,MASK_ORG=masked.org,MASK_DB=masked.db,MASK_HOST=masked.host,MASK_URL=masked.url,TARGET_CANDIDATES=candidates" \
  || fail "تعذّر تحليل ردّ طبقة API (JSON غير صالح)."
[ "$RESOLVE_OK" = "true" ] || fail "تعذّر تحديد الهدف: ${RESOLVE_ERROR:-سبب غير معروف}${TARGET_CANDIDATES:+ · المرشّحون: $TARGET_CANDIDATES}"

if [ "$SHOW_TARGET" = true ]; then
  echo "   • المنظمة: $TARGET_ORG · القاعدة: $TARGET_DB · المضيف: ${TARGET_HOST:-مشتق}"
  echo "   • رابط الاتصال: $TARGET_URL  (مصدره: $TARGET_SOURCE)"
else
  echo "   • المنظمة: $MASK_ORG · القاعدة: $MASK_DB · المضيف: $MASK_HOST"
  echo "   • رابط الاتصال: $MASK_URL  (مصدره: $TARGET_SOURCE · مؤكَّد من الخادم: $([ "$TARGET_CONFIRMED" = "true" ] && echo نعم || echo لا))"
fi
FINAL_URL="$TARGET_URL"
MIG_TARGET="${MIGRATIONS_URL:-$FINAL_URL}"
[ -n "$MIGRATIONS_URL" ] && warn "بوابة الهجرات ستُطبَّق على هدف مختلف عن رابط الأسرار (--migrations-url) — مقصود للتجربة/لفرع."

# ---------------------------------------------------------------------------
# 2) المعاينة: كل شيء للقراءة فقط، وبلا سكّ وبلا هجرة وبلا أسرار
# ---------------------------------------------------------------------------

if [ "$DRY_RUN" = true ]; then
  echo
  echo "2) 🧪 --dry-run: ما ستفعله المعاملة الحقيقية (لا يُنفَّذ شيء منه هنا)"
  echo "   • سكّ الرمز: POST …/organizations/$MASK_ORG/databases/$MASK_DB/auth/tokens?expiration=$EXPIRATION&authorization=$AUTHORIZATION"
  if [ "$SKIP_MIGRATIONS" = false ]; then
    echo "   • بوابة الهجرات الصريحة: scripts/apply-migrations.mjs --apply${EXPECT:+ --expect $EXPECT} على $([ -n "$MIGRATIONS_URL" ] && echo "هدف التجربة" || echo "القاعدة الهدف")"
    node -e 'import("./scripts/lib/migration-checksums.mjs").then((m) => {
      for (const migration of m.expectedMigrations(process.cwd())) {
        console.log(`       – ${migration.version}_${migration.name} · بصمة ${migration.checksum.slice(0, 16)}…`);
      }
    }).catch(() => {});' || true
  else
    echo "   • بوابة الهجرات: مُتخطّاة (--skip-migrations)"
  fi
  if [ "$SKIP_SECRETS" = false ]; then
    echo "   • تطبيق الأسرار: scripts/apply-turso-secrets.sh بالزوج الجديد ← $(printf '%s' "${DESTINATIONS:-لا جهة متاحة}" | sed 's/ *$//')"
  else
    echo "   • تطبيق الأسرار: مُتخطّاة (--skip-secrets)"
  fi

  # ما رأته CI الآن: نفس مجسّ turso-evidence.yml على القيم المضبوطة حاليًا،
  # دليلًا لا بوابة — فلا تُفشل المعاينة لأن الإعداد الحالي معطوب (هذا سببها).
  echo
  echo "3) 🔎 ما تراه CI الآن (نفس مسار scripts/probe-turso-ci.sh — للقراءة فقط)"
  if [ -z "$CURRENT_URL" ]; then
    echo "   • لا قيم مضبوطة محليًا (TURSO_DATABASE_URL) — وجّه السكربت إليها بـ --env-file .env.local لتُعرض هنا."
  elif [ ! -d node_modules/@libsql/client ]; then
    echo "   • تعذّر تشغيل المجسّ: node_modules ناقصة — شغّل 'npm ci' ثم أعد المعاينة."
  else
    probe_out="$(TURSO_DATABASE_URL="$CURRENT_URL" TURSO_AUTH_TOKEN="$CURRENT_TOKEN" node scripts/verify-turso.mjs --allow-secret-repair 2>&1)"
    probe_code=$?
    printf '%s\n' "$probe_out" | sed 's/^/   /'
    case "$probe_code" in
      0) echo "   ⇒ VERIFY_SUCCESS: الإعداد الحالي يعمل كما هو." ;;
      1) echo "   ⇒ صفوف حمراء: هذا بالضبط ما ستصلحه المعاملة الحقيقية (رمز صالح + هجرات + قيم في حقولها)." ;;
      *) echo "   ⇒ تهيئة الفحص ناقصة (كود $probe_code)." ;;
    esac
  fi

  echo
  echo "🧪 انتهت المعاينة: لم يُسكّ رمز، ولم تُلمس القاعدة، ولم تُطبَّق أسرار."
  echo "➡️  للتنفيذ: bash scripts/mint-turso-token.sh"
  exit 0
fi

# ---------------------------------------------------------------------------
# 3) السكّ (النداء الكاتب الوحيد على Platform API)
# ---------------------------------------------------------------------------

echo
echo "2) سكّ رمز القاعدة (POST …/auth/tokens · expiration=$EXPIRATION · authorization=$AUTHORIZATION)…"
[ -n "$PLATFORM_TOKEN" ] || fail "TURSO_PLATFORM_TOKEN مطلوب للسكّ (من البيئة أو --env-file أو المدخل المخفي)."
MINT_JSON="$(turso_api mint --org "$TARGET_ORG" --db "$TARGET_DB" --expiration "$EXPIRATION" --authorization "$AUTHORIZATION" --api-base "$API_BASE")"
load_json_vars "$MINT_JSON" \
  "MINT_OK=ok,MINT_ERROR=error,MINT_JWT=jwt,MINT_DESC=description,MINT_URL=url,MINT_HOST=hostname,MINT_MASK_URL=masked.url,MINT_MASK_HOST=masked.host,MINT_EXPIRES_AT=expiresAt,MINT_EXPIRES_IN=expiresInDays" \
  || fail "تعذّر تحليل ردّ السكّ (JSON غير صالح)."
[ "$MINT_OK" = "true" ] || fail "فشل سكّ الرمز: ${MINT_ERROR:-سبب غير معروف}"
[ -n "$MINT_JWT" ] || fail "ردّ السكّ بلا رمز — لم يُنشأ شيء؛ تحقّق من نطاق رمز المنصة."
[ -n "$MINT_URL" ] && FINAL_URL="$MINT_URL"
echo "   ✅ سُكّ الرمز: $MINT_DESC"
echo "   🔗 الرابط القانوني من الخادم: ${MINT_MASK_URL:-$MASK_URL}"

# ---------------------------------------------------------------------------
# 4) فحص حيّ قبل الكتابة، ثم بوابة الهجرات، ثم فحص حيّ بعدها
# ---------------------------------------------------------------------------

if [ "$SKIP_VERIFY" = true ]; then
  warn "VERIFY_SKIPPED: الفحص الحيّ مُتخطَّ (--skip-verify) — لا إثبات مسبقًا أن هذا الزوج يعمل."
else
  verify_gate "قبل الهجرة" "$FINAL_URL" "$MINT_JWT"
fi

echo
if [ "$SKIP_MIGRATIONS" = true ]; then
  echo "3) ⏭️  بوابة الهجرات مُتخطّاة (--skip-migrations) — الهجرات ستُطبَّق عند أول طلب في الإنتاج (ensureSchema)."
else
  echo "3) 🧱 بوابة الهجرات الصريحة — تطبيق هجرات المستودع على القاعدة الهدف (كتابة مقصودة)…"
  [ -d node_modules/tsx ] || fail "node_modules ناقصة (tsx) — شغّل 'npm ci' أولًا: بوابة الهجرات تُحمّل مشغّل TS نفسه المستخدم في الإنتاج."
  MIGRATION_ARGS=(--apply)
  [ -n "$EXPECT" ] && MIGRATION_ARGS+=(--expect "$EXPECT")
  TURSO_DATABASE_URL="$MIG_TARGET" TURSO_AUTH_TOKEN="$MINT_JWT" \
    node --import tsx scripts/apply-migrations.mjs "${MIGRATION_ARGS[@]}"
  migrations_code=$?
  if [ "$migrations_code" -ne 0 ]; then
    warn "الرمز المسكوك صالح وبقي بلا وجهة تسليم: لم تُطبَّق الأسرار لأن بوابة الهجرات فشلت (كود $migrations_code)."
    fail "MIGRATIONS_GATE_FAILED — توقّف قبل تطبيق الأسرار (التقرير أعلاه)."
  fi
  echo "   ✅ MIGRATIONS_APPLIED: الهجرات مسجّلة على القاعدة ببصمات مطابقة للمستودع."
fi

if [ "$SKIP_VERIFY" = false ]; then
  echo
  verify_gate "بعد الهجرة" "$FINAL_URL" "$MINT_JWT"
fi

# ---------------------------------------------------------------------------
# 5) تطبيق الأسرار (بالزوج الجديد) ثم ملف محلي إن طُلب
# ---------------------------------------------------------------------------

echo
if [ "$SKIP_SECRETS" = true ]; then
  echo "4) ⏭️  تطبيق الأسرار مُتخطَّ (--skip-secrets)."
  if [ -z "$SAVE_ENV" ]; then
    warn "الرمز المسكوك لم يُسلَّم لأي وجهة ولن يُطبع — يبقى صالحًا على القاعدة ولا قيمة له عندك (أعد السكّ متى احتجته)."
  fi
else
  echo "4) 🔐 تطبيق الأسرار بالزوج الجديد ← $(printf '%s' "$DESTINATIONS" | sed 's/ *$//')"
  CHILD_ARGS=()
  # دلالة العلمين عند الطفل معكوسة: «أي جهة تبقى» لا «أي جهة تُترك».
  [ "$SKIP_GITHUB" = true ] && CHILD_ARGS+=(--vercel-only)
  [ "$SKIP_VERCEL" = true ] && CHILD_ARGS+=(--github-only)
  [ "$SKIP_VERIFY" = true ] && CHILD_ARGS+=(--skip-verify)
  [ -n "$REPO" ] && CHILD_ARGS+=(--repo "$REPO")
  CHILD_ARGS+=(--env "$ENV_NAME")
  # القيم عبر بيئة الطفل فقط — لا في argv (ولا تُطبع هنا).
  TURSO_DATABASE_URL="$FINAL_URL" TURSO_AUTH_TOKEN="$MINT_JWT" \
    bash scripts/apply-turso-secrets.sh "${CHILD_ARGS[@]}"
  secrets_code=$?
  [ "$secrets_code" -eq 0 ] || fail "فشل تطبيق الأسرار (كود $secrets_code) — الزوج صالح والقاعدة مهاجَرة؛ أعد هذه الخطوة وحدها."
fi

if [ -n "$SAVE_ENV" ]; then
  write_env_file "$SAVE_ENV"
  echo "   ✅ حُفظ الزوج في $SAVE_ENV (صلاحيات 0600) — لا تُضفه إلى Git."
fi

# ---------------------------------------------------------------------------
# 6) الخلاصة
# ---------------------------------------------------------------------------

echo
MIGRATIONS_SUMMARY="هجرات مطبَّقة"
[ "$SKIP_MIGRATIONS" = true ] && MIGRATIONS_SUMMARY="الهجرات مُتخطّاة صراحة"
SECRETS_SUMMARY="أسرار ← ${DESTINATIONS:-لا جهة}"
[ "$SKIP_SECRETS" = true ] && [ -z "$SAVE_ENV" ] && SECRETS_SUMMARY="الأسرار مُتخطّاة صراحة"
echo "✅ اكتملت المعاملة: رمز مسكوك ($MINT_DESC) · $MIGRATIONS_SUMMARY · $SECRETS_SUMMARY"
if [ -n "$MINT_EXPIRES_AT" ]; then
  echo "🗓️  تدوير الرمز: ينتهي $MINT_EXPIRES_AT${MINT_EXPIRES_IN:+ (بعد $MINT_EXPIRES_IN يومًا)} — أعد هذا الأمر نفسه قبله."
  echo "    رموز Turso لا تُسترجع بعد إنشائها ولا تُلغى فرديًا؛ التدوير = سكّ جديد وتسليم للوجهات نفسها."
else
  warn "الرمز بلا انتهاء (طلبت ذلك صراحة بـ --expiration never) — يبقى التدوير اليدوي موصى به."
fi
echo "➡️  الخطوات التالية:"
echo "   1. نشر جديد ليلتقط المتغيرات: vercel deploy --prod (أو Redeploy من اللوحة)."
echo "   2. إعادة مجسّ الأدلة بعد النشر: gh workflow run turso-evidence.yml --ref main (أو أي دفع إلى فرعك)."
echo "   3. التحقق من الصفوف 7–9 محليًا: TURSO_DATABASE_URL=… TURSO_AUTH_TOKEN=… npm run verify:turso"
