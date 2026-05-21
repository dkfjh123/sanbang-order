-- ============================================================
-- 030_drop_apply_b2b_inventory_delta.sql
-- 사용 종료된 RPC 폐기 (apply_b2b_inventory_delta)
-- ============================================================
-- 배경:
--   006 에서 도입된 apply_b2b_inventory_delta 는 박스/낱팩 이원 재고 처리 RPC.
--   "loose 우선 차감, 부족하면 박스 분해" 로직을 포함.
--
--   PR3 단순화 옵션(박스 중심 운영) + 029 에서 가맹점 PUT 팩 path 갱신 이후,
--   호출처가 0개 됨:
--     - src/app/api/b2b/orders/route.ts        — PR3에서 RPC 호출 제거 (POST)
--     - src/app/api/b2b/orders/[id]/route.ts   — PR3에서 RPC 호출 제거 (SHIP/CANCEL)
--     - src/app/api/orders/route.ts            — PR3에서 RPC 호출 제거 (가맹점 POST)
--     - src/app/api/orders/[id]/route.ts       — PR3에서 RPC 호출 제거 (가맹점 CANCEL)
--     - supabase/migrations/025                — 029에서 갱신, 팩 path 직접 처리
--     - scripts/cancel-test-order.mjs          — 030 작업 시점에 직접 처리로 갱신
--
--   "박스 분해" 로직 자체가 단순화 옵션에 어긋남 (분해는 B2B 팩 SHIP 시점에만 발생).
--   호출처 0 이므로 DROP 안전.
--
-- 멱등성: DROP FUNCTION IF EXISTS
-- 절대원칙: 본인이 Supabase SQL Editor 에서 직접 실행. AI 는 파일만 생성.
-- ============================================================

-- 안전 검증: 함수 존재 여부 확인 (그래도 없으면 NOTICE 만)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'apply_b2b_inventory_delta'
  ) THEN
    RAISE NOTICE 'apply_b2b_inventory_delta 함수 발견 — DROP 진행';
  ELSE
    RAISE NOTICE 'apply_b2b_inventory_delta 함수 이미 없음 — 건너뜀';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.apply_b2b_inventory_delta(UUID, TEXT, INT, TEXT, UUID);

-- 검증
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'apply_b2b_inventory_delta'
  ) THEN
    RAISE NOTICE '030 DROP 완료 — apply_b2b_inventory_delta 사라짐';
  ELSE
    RAISE EXCEPTION '030 DROP 실패 — 함수가 여전히 존재';
  END IF;
END $$;

-- ============================================================
-- 롤백 (사고 시 — 006 마이그레이션의 함수 정의 재실행)
-- 006_b2b_and_pack_inventory.sql 의 CREATE OR REPLACE FUNCTION 블록 참조
-- ============================================================
