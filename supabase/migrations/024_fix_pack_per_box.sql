-- ============================================================
-- 024_fix_pack_per_box.sql
-- products.pack_per_box 값 정정 — 고기국수육수 / 양념장
-- ============================================================
-- 배경:
--   초기 시드 당시 두 상품의 pack_per_box 가 1 로 들어가 있었으나
--   실제 구성은:
--     - 고기국수육수: 5kg × 2EA 가 1박스 → pack_per_box = 2
--     - 양념장      : 2kg × 5EA 가 1박스 → pack_per_box = 5
--   현재 낱개 판매 대상은 아니지만(is_loose_pack_sellable = false),
--   향후 단위변경/단가환산 정확성을 위해 미리 바로잡음.
--
-- 멱등성: UPDATE 라 재실행 시에도 결과 동일.
-- ============================================================

BEGIN;

UPDATE public.products SET pack_per_box = 2, updated_at = NOW()
 WHERE name = '고기국수육수' AND pack_per_box <> 2;

UPDATE public.products SET pack_per_box = 5, updated_at = NOW()
 WHERE name = '양념장'    AND pack_per_box <> 5;

-- 검증
DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '== pack_per_box 정정 결과 ==';
  FOR r IN
    SELECT name, pack_per_box
      FROM public.products
     WHERE name IN ('고기국수육수','양념장')
     ORDER BY name
  LOOP
    RAISE NOTICE '% | pack_per_box=%', r.name, r.pack_per_box;
  END LOOP;
END $$;

COMMIT;

-- 적용 후 검증 쿼리:
--   SELECT name, pack_per_box FROM public.products
--    WHERE name IN ('고기국수육수','양념장');
--   기대값: 고기국수육수=2, 양념장=5
--
-- 롤백:
--   UPDATE public.products SET pack_per_box = 1 WHERE name='고기국수육수';
--   UPDATE public.products SET pack_per_box = 1 WHERE name='양념장';
