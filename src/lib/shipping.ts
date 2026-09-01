export const SHIPPING_RATES: Record<string, number> = {
  القاهرة: 50,
  الجيزة: 50,
  القليوبية: 60,
  الإسكندرية: 70,
  الدقهلية: 75,
  الشرقية: 75,
  الغربية: 70,
  المنوفية: 70,
  البحيرة: 75,
  "كفر الشيخ": 80,
  دمياط: 80,
  بورسعيد: 80,
  الإسماعيلية: 75,
  السويس: 75,
  الفيوم: 80,
  "بني سويف": 85,
  المنيا: 90,
  أسيوط: 95,
  سوهاج: 100,
  قنا: 105,
  الأقصر: 110,
  أسوان: 120,
  مطروح: 110,
  "الوادي الجديد": 120,
  "شمال سيناء": 120,
  "جنوب سيناء": 120,
  "البحر الأحمر": 110,
};

export const GOVERNORATES = Object.keys(SHIPPING_RATES);

export function calculateShipping(governorate: string, subtotal: number, freeShippingOver: number) {
  if (subtotal <= 0 || subtotal >= freeShippingOver) return 0;
  return SHIPPING_RATES[governorate] ?? 100;
}
