"use client";

import Link from "next/link";
import { useEffect } from "react";
import { STORE } from "@/lib/seed";

/**
 * حدّ خطأ على مستوى المسار — يُحيط بأخطاء العرض والمكوّنات الخادمية.
 *
 * لا يُسجَّل نص الخطأ كما هو (قد يحمل تفاصيل داخلية)، ولا يُعرض للمستخدم سوى
 * `digest` الذي يولّده Next.js ويربط الشكوى بالسجل الخادمي بلا أي تسريب.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(JSON.stringify({ level: "error", event: "ui_error_boundary", digest: error?.digest ?? null }));
  }, [error]);

  return (
    <div className="container section">
      <div className="state-card" role="alert">
        <div className="state-emoji" aria-hidden="true">🧯</div>
        <h1 className="state-title">حصلت مشكلة مؤقتة</h1>
        <p className="state-hint">
          جرّب تعيد المحاولة. لو استمرت المشكلة كلمنا واتساب على {STORE.phone} ونتابعها فورًا.
        </p>
        {error?.digest ? <p className="state-code">رقم المرجع: {error.digest}</p> : null}
        <div className="state-actions">
          <button className="btn btn-primary" type="button" onClick={() => reset()}>
            ↻ إعادة المحاولة
          </button>
          <Link className="btn btn-ghost" href="/">الرئيسية</Link>
          <a className="btn btn-wa" href={`https://wa.me/${STORE.whatsapp}`} target="_blank" rel="noreferrer">💬 واتساب</a>
        </div>
      </div>
    </div>
  );
}
