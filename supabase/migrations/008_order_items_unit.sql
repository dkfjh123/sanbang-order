-- ============================================================
-- 산방식당 발주시스템 — Phase 8: 가맹점 발주 낱팩 지원
-- ============================================================
-- 원칙: 기존 스키마/로직/데이터에 영향을 주지 않는다.
--   1) order_items 에 ADD COLUMN 만 수행 (DEFAULT 값으로 기존 로우 자동 호환)
--   2) 기존 로우는 unit='box', pack_per_box=1 로 해석되어 직접 inventory.quantity
--      경로를 계속 사용한다.
--   3) 낱팩 주문(unit='pack')은 apply_b2b_inventory_delta RPC 를 재사용하여
--      박스/낱팩 이원 재고 로직으로 처리한다 (가맹점·B2B 공통).
-- ============================================================

ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS unit TEXT NOT NULL DEFAULT 'box'
    CHECK (unit IN ('box', 'pack')),
  ADD COLUMN IF NOT EXISTS pack_per_box INT NOT NULL DEFAULT 1
    CHECK (pack_per_box >= 1);
