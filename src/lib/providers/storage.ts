/**
 * Storage Provider — واجهة تخزين الملفات/الصور مع تطبيق ذاكرة حتمي.
 *
 * قاعدة PRE_RELEASE_GATE:
 *  - المتجر الحالي لا يملك رفع وسائط (صور المنتجات emoji) — لا مزوّد تخزين حقيقي.
 *  - العقد يُختبر عبر MemoryStorageProvider (حتمي، مجاني، محلي) و Fake فاشل.
 */
export type StoredFile = { key: string; contentType: string; size: number };

export interface StorageProvider {
  readonly name: string;
  put(key: string, data: Uint8Array, contentType: string): Promise<StoredFile>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<boolean>;
}

/** تطبيق حتمي بالذاكرة — يستخدم في الاختبارات (ويمكن أن يخدم بيئة محلية). */
const memoryStore = new Map<string, { data: Uint8Array; contentType: string }>();
export const MemoryStorageProvider: StorageProvider = {
  name: "memory",
  async put(key, data, contentType) {
    memoryStore.set(key, { data, contentType });
    return { key, contentType, size: data.byteLength };
  },
  async get(key) {
    return memoryStore.get(key)?.data ?? null;
  },
  async delete(key) {
    return memoryStore.delete(key);
  },
};

/** Test Double للفشل: أي put يرمي (محاكاة مزوّد معطوب/غير متاح). */
export function createFailingStorageProvider(): StorageProvider {
  return {
    name: "failing",
    async put() {
      throw new Error("storage provider unavailable (fake)");
    },
    async get() {
      throw new Error("storage provider unavailable (fake)");
    },
    async delete() {
      throw new Error("storage provider unavailable (fake)");
    },
  };
}
