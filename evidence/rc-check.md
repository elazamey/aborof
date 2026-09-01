# RC Check — Release Candidate Evidence

| الحقل | القيمة |
|---|---|
| **الحالة** | ✅ Local Release Check PASS |
| **التاريخ** | 2026-09-01T22:40:41Z |
| **Code commit (بدون workflows)** | `83567f0ddde9575ac1d2030125148a21b1eeb894` |
| **RC_COMMIT (نهائي، بعد رفع workflows)** | <يُثبَّت هنا بعد الرفع: `git rev-parse HEAD`> |
| **الأمر** | `npm run release:check` (L1 Static → L2 Build → L3/4 Smoke → L5 Drills) |
| **السجل الكامل** | `evidence/release-check/release-2026-09-01T22-40-41Z.log` |

## النتائج

| المستوى | النتيجة |
|---|---|
| L1 — Static (ESLint / TSC / Prettier / Routes) | ✅ |
| L2 — Build (`next build`) | ✅ |
| L3 — Runtime (36 فحص HTTP على `next start`) | ✅ SMOKE PASS |
| L4 — Business (رحلة العميل والإدارة الكاملة) | ✅ |
| L5 — Resilience (36 فحص حقن أعطال) | ✅ — الدليل: `evidence/l5-resilience/` |

Unit: 32/32 · Smoke: 36/36 · Drills: 36/36

## Integrity (تثبت عند CI)

```text
CI_COMMIT == RC_COMMIT
```
