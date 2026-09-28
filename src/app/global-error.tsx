"use client";

/**
 * حدّ الخطأ الجذري — يحل مكان الـlayout كله عند فشل تجذيري، لذلك **يجب** أن
 * يُصدّر `<html>` و`<body>` بنفسه، وإلا فشل العرض تمامًا.
 * الأنماط المضمّنة مقصودة: قد تكون ورقة الأنماط نفسها سبب الفشل.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="ar" dir="rtl">
      <body
        style={{
          margin: 0,
          fontFamily: "system-ui, 'Segoe UI', Tahoma, Arial, sans-serif",
          background: "#f6f9f7",
          color: "#14261f",
          display: "grid",
          placeItems: "center",
          minHeight: "100vh",
          padding: "24px",
        }}
      >
        <div style={{ maxWidth: 520, textAlign: "center" }}>
          <div style={{ fontSize: "3rem" }} aria-hidden="true">🛠️</div>
          <h1 style={{ fontSize: "1.4rem", margin: "10px 0" }}>خطأ غير متوقع</h1>
          <p style={{ color: "#6b7f76", lineHeight: 1.8 }}>
            المتجر واجه مشكلة في التحميل. جرّب إعادة المحاولة بعد لحظات.
          </p>
          {error?.digest ? <p style={{ color: "#6b7f76", fontSize: ".85rem" }}>رقم المرجع: {error.digest}</p> : null}
          <button
            type="button"
            onClick={() => reset()}
            style={{
              marginTop: 12,
              padding: "10px 18px",
              borderRadius: 12,
              border: "none",
              background: "#0f7a4d",
              color: "#fff",
              fontWeight: 700,
              cursor: "pointer",
              font: "inherit",
            }}
          >
            ↻ إعادة المحاولة
          </button>
        </div>
      </body>
    </html>
  );
}
