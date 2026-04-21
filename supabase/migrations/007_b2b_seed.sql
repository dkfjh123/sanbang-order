-- ============================================================
-- 산방식당 발주시스템 — Phase 6 seed: 아워홈 거래처 + 5개 상품 입수/B2B가격
-- ============================================================
-- 이 파일은 멱등(idempotent)합니다. 여러 번 실행해도 같은 결과.
-- 006 마이그레이션이 먼저 적용되어 있어야 합니다.
-- ============================================================

-- ------------------------------------------------------------
-- 1) 아워홈 거래처 등록 (이미 있으면 정보만 갱신)
-- ------------------------------------------------------------
INSERT INTO public.b2b_customers (name, business_number, contact_name, contact_phone, contact_email, memo, is_active)
VALUES ('아워홈', NULL, NULL, NULL, NULL, '이메일 발주 — 관리자가 수동 입력', TRUE)
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------
-- 2) 아워홈 B2B 대상 5개 상품 — 입수(pack_per_box) + B2B가격 세팅
--    매칭은 상품명(name)으로 한다. 전용상품목록.md 기준.
--    B2B가격은 아워홈 공급가표 기준:
--      박스단가_부별(세전) / 박스단가_부포(세포함)
-- ------------------------------------------------------------

-- 생밀면: 1.4kg × 8봉/박스 / 59,000 / 64,900
UPDATE public.products
   SET pack_per_box       = 8,
       b2b_price          = 59000,
       b2b_price_with_tax = 64900,
       is_b2b_eligible    = TRUE
 WHERE name = '생밀면'
   AND product_type = 'exclusive';

-- 왕만두: 1.2kg × 6EA/박스 / 62,400 / 68,640
UPDATE public.products
   SET pack_per_box       = 6,
       b2b_price          = 62400,
       b2b_price_with_tax = 68640,
       is_b2b_eligible    = TRUE
 WHERE name = '왕만두'
   AND product_type = 'exclusive';

-- 아삭한김치왕만두70: 1.4kg × 6EA/박스 / 62,400 / 68,640
UPDATE public.products
   SET pack_per_box       = 6,
       b2b_price          = 62400,
       b2b_price_with_tax = 68640,
       is_b2b_eligible    = TRUE
 WHERE name = '아삭한김치왕만두70'
   AND product_type = 'exclusive';

-- 육수간장: 4kg × 3ea/박스 / 71,250 / 78,375
UPDATE public.products
   SET pack_per_box       = 3,
       b2b_price          = 71250,
       b2b_price_with_tax = 78375,
       is_b2b_eligible    = TRUE
 WHERE name = '육수간장'
   AND product_type = 'exclusive';

-- 비빔전용장: 2kg × 5EA/박스 / 120,880 / 132,968
UPDATE public.products
   SET pack_per_box       = 5,
       b2b_price          = 120880,
       b2b_price_with_tax = 132968,
       is_b2b_eligible    = TRUE
 WHERE name = '비빔전용장'
   AND product_type = 'exclusive';

-- ------------------------------------------------------------
-- 3) 적용 결과 확인용 쿼리 (실행 후 수동 확인)
-- ------------------------------------------------------------
-- SELECT name, pack_per_box, b2b_price, b2b_price_with_tax, is_b2b_eligible
--   FROM public.products
--  WHERE is_b2b_eligible = TRUE
--  ORDER BY name;
