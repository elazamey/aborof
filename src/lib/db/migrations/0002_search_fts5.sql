-- 0002_search_fts5: فهرس نصي كامل لمنتجات المتجر عبر محرك FTS5.
--
-- ينشئ الجدول الافتراضي product_search ويعبئه من جدول products إن كانت
-- قاعدة البيانات قائمة بالفعل (ترقية بلا فقدان). مزامنة الفهرس بعد هذه
-- الهجرة تتم في طبقة التطبيق (src/lib/search.ts) عند كل كتابة منتج، مع
-- سقوط آمن إلى مطابقة الكلمات المفتاحية عند غياب دعم FTS5 على المحرك.
--
-- ملاحظات:
--  - العمود id مُعلَّم UNINDEXED حتى نستعيد معرّف المنتج الأصلي للربط بالكتالوج.
--  - tokenize = 'unicode61' يمنح مطابقة عربية بكلمات مستقلة مفصولة بالمسافات.
CREATE VIRTUAL TABLE IF NOT EXISTS product_search USING fts5(
  id UNINDEXED,
  name,
  description,
  category,
  tokenize = 'unicode61'
);

INSERT INTO product_search(id, name, description, category)
SELECT id, name, description, category FROM products
WHERE NOT EXISTS (SELECT 1 FROM product_search WHERE product_search.rowid = products.rowid);
