/**
 * Notification Provider — واجهة إشعارات (Email / WhatsApp) مع تطبيقات حتمية.
 *
 * قاعدة PRE_RELEASE_GATE:
 *  - فشل خدمة خارجية (إشعارات) يجب ألا يُفسد معاملة الطلب الأساسية.
 *  - الإنتاج: NoopProvider حاليًا (لا بريد/واتساب API مهيأ — روابط wa.me فقط في الواجهة).
 *  - الاختبارات: Fake حتمي يسجّل الإرسال ويمنع التكرار (dedupe) ويحاكي الفشل/المهلة.
 */
export type NotificationType = "order_created" | "order_status_changed" | "order_cancelled";

export type NotificationPayload = {
  type: NotificationType;
  orderId: string;
  to?: string;
  data?: Record<string, unknown>;
};

export type NotifyResult = { ok: true; provider: string; duplicate?: boolean } | { ok: false; error: string };

export interface NotificationProvider {
  readonly name: string;
  send(notification: NotificationPayload): Promise<NotifyResult>;
}

/** Real: لا مزوّد إشعارات مهيأ — تسجيل صامت (المتجر الحالي لا يرسل بريداً/واتساب API). */
export const NoopNotificationProvider: NotificationProvider = {
  name: "noop",
  async send() {
    return { ok: true, provider: "noop" };
  },
};

export type FakeNotificationOptions = { fail?: boolean; timeoutMs?: number };

/**
 * Test Double حتمي: يسجّل الإرسالات، يحمي من التكرار (نفس orderId+type مرة واحدة)،
 * ويحاكي الفشل/المهلة. من دون إرسال أي شيء خارجي.
 */
export function createFakeNotificationProvider(options: FakeNotificationOptions = {}) {
  const sent = new Map<string, { count: number; last: string }>();
  return {
    name: "fake-notifications",
    sent,
    async send(notification: NotificationPayload): Promise<NotifyResult> {
      if (options.timeoutMs) {
        await new Promise((r) => setTimeout(r, options.timeoutMs));
      }
      if (options.fail) return { ok: false, error: "notification provider failed (fake)" };
      const key = `${notification.type}:${notification.orderId}`;
      const prev = sent.get(key);
      if (prev) {
        prev.count += 1;
        return { ok: true, provider: "fake-notifications", duplicate: true };
      }
      sent.set(key, { count: 1, last: new Date().toISOString() });
      return { ok: true, provider: "fake-notifications" };
    },
  };
}
