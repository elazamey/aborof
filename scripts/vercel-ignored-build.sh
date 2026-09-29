#!/usr/bin/env bash
# وقف البناء على Vercel للتغييرات التوثيقية الخالصة (Ignored Build Step).
# يُستدعى من vercel.json عبر ignoreCommand.
#
# عقد Vercel (حرفيًا من توثيقهم):
#   exit 0 ⇒ تجاهل البناء (skip)
#   exit 1 ⇒ المتابعة في البناء (build)
# القاعدة الأساسية: أي غموض أو خطأ ⇒ نبني (fail-open).
# البناء الزائد يكلّف دقائق؛ أما البناء الناقص فيُبقي إصدارًا قديمًا حيًا بلا إنذار.
#
# القائمة "الثقيلة" (ما يُوقف البناء) مقصورة عمدًا على ما لا يمكن أن يدخل
# مخرجات `next build`:
#   docs/        — توثيق المستودع
#   handoff/     — ملفات التسليم (patches/تقارير) بين الجلسات
#   *.md         — أي ملف ماركداون في أي مسار (كما في `:!*.md`)
# كل ما عدا ذلك — src/ وpackage-lock.json وnext.config وvercel.json وهذا
# السكربت نفسه — يُطلق البناء. إن صار أي مجلد أعلاه يومًا مدخل بناء،
# فهذه القائمة يجب أن تُراجع معه.

set -uo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 1
cd "$root" || exit 1

# قاعدة المقارنة: SHA آخر نشر سابق على الفرع (يوفّره Vercel).
# غيابها = أول بناء على فرع جديد ⇒ نبني دائمًا (لا مقارنة = لا تجاهل).
base="${VERCEL_GIT_PREVIOUS_SHA:-}"
if [ -z "$base" ]; then
  echo "vercel-ignored-build: لا توجد VERCEL_GIT_PREVIOUS_SHA ⇒ بناء كامل (fail-open)" >&2
  exit 1
fi

# أي فشل في git (SHA غير موجود في المستنسخ الضحل مثلًا) ⇒ بناء.
changed="$(git diff --name-only "$base" HEAD -- 2>/dev/null)" || {
  echo "vercel-ignored-build: تعذّرت المقارنة مع $base ⇒ بناء (fail-open)" >&2
  exit 1
}

# لا تغييرات إطلاقًا منذ آخر نشر ⇒ لا حاجة لبناء جديد.
if [ -z "$changed" ]; then
  echo "vercel-ignored-build: لا تغييرات منذ $base ⇒ تجاهل البناء" >&2
  exit 0
fi

# ملف "مؤثر" واحد يكفي ليبدأ البناء.
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    docs/*|handoff/*|*.md) ;; # توثيق خالص — بلا أثر على مخرجات البناء
    *)
      echo "vercel-ignored-build: تغيير مؤثر: $f ⇒ بناء" >&2
      exit 1
      ;;
  esac
done <<< "$changed"

echo "vercel-ignored-build: تغييرات توثيقية خالصة منذ $base ⇒ تجاهل البناء" >&2
exit 0
