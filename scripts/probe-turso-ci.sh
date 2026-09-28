#!/usr/bin/env bash
#
# ‏غلاف CI لمجسّ Turso (قراءة فقط):
#   1. يشغّل `scripts/verify-turso.mjs` على قاعدة الإنتاج — اتصال حقيقي بلا أي
#      هجرة وبلا أي كتابة.
#   2. يطبع الجدول في سجل التشغيل وفي ملخّص التشغيل ($GITHUB_STEP_SUMMARY).
#   3. ينشره تعليقًا على طلب الدمج: سجلات Actions تُقدَّم بروابط موقّعة على مضيف
#      تخزين لا تصل إليه كل بيئات القراءة، والتعليق قناة متاحة دائمًا (ويُحدَّث
#      في كل تشغيل بدل تكديس التعليقات).
#
# متغيرات: SCOPE (وصف نطاق الأسرار)، RUN_URL، PR_NUMBER، GH_TOKEN — كلها من Actions.
# كود الخروج = كود `verify-turso.mjs`: 0 أخضر، 1 صفوف حمراء، 2 تهيئة ناقصة.
set -uo pipefail

REPORT=$(mktemp)
{
  echo "### 🔎 مجسّ Turso — ${SCOPE:-نطاق غير مسمّى}"
  echo
  echo "- **قراءة فقط**: لا هجرة ولا كتابة ولا أي تغيير على القاعدة."
  echo "- التشغيل: ${RUN_URL:-محلي}"
  echo
} > "$REPORT"

# ‏`--allow-dashboard-url`: لصق رابط لوحة التحكم بدل رابط الاتصال حالة واقعية،
# والترميم مشروط ومُعلَن في صف `conn` نفسه — فيكتمل الجدول بدل إسقاط الفحص كله.
node scripts/verify-turso.mjs --allow-secret-repair >> "$REPORT" 2>&1
code=$?

cat "$REPORT"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then cat "$REPORT" >> "$GITHUB_STEP_SUMMARY"; fi

# قسم إعلامي: سطح الإنتاج الحيّ قراءةً (GET فقط، بلا --admin-probe الذي يستهلك
# حد المعدل وبلا --allow-mutations الذي ينشئ طلبًا حقيقيًا). صف `db-binding` هنا
# قرينة مصدر الكتالوج — تكمل صفوف Turso ولا يُحكم بها على الاتصال.
{
  echo "### 🌐 الواجهة الحيّة (قراءة فقط)"
  echo
} >> "$REPORT"
node scripts/smoke-production.mjs >> "$REPORT" 2>&1 || true

# تعليق على طلب الدمج إن وُجد رقمه؛ `--edit-last` يمنع تكديس تعليق لكل تشغيل.
if [ -n "${PR_NUMBER:-}" ] && [ -n "${GH_TOKEN:-}" ]; then
  gh pr comment "$PR_NUMBER" --body-file "$REPORT" --edit-last --create-if-none \
    || gh pr comment "$PR_NUMBER" --body-file "$REPORT" \
    || echo "::warning::تعذّر نشر التعليق — الجدول متاح في ملخّص التشغيل."
fi

exit "$code"
