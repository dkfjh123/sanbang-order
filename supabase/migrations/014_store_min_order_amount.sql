-- ============================================================
-- 산방식당 — 매장별 최소발주금액
-- ============================================================
-- 기존: 글로벌 상수 150,000원 (api/orders/route.ts, orders/new/page.tsx)
-- 변경: stores.min_order_amount 컬럼 (DEFAULT 150000)
--       특정 매장은 별도 마이그레이션에서 UPDATE (예: 동래정 → 015)

ALTER TABLE public.stores
  ADD COLUMN IF NOT EXISTS min_order_amount INTEGER NOT NULL DEFAULT 150000;

COMMENT ON COLUMN public.stores.min_order_amount IS '매장별 최소발주금액(원). 기본 150,000';
