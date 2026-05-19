-- ============================================================
-- 돼봉삼겹살 — 비빔전용장 / 양념장 단가 정정
-- ============================================================
-- 변경 의미:
--   013 마이그레이션에서 돼봉삼겹살의 비빔전용장/양념장은
--   일괄 107,800(부가세 포함)으로 시드됐으나, 실제 합의 단가는
--   가맹점 판가와 동일(부가세 포함):
--     - 비빔전용장: 132,968 (세전 120,880)
--     - 양념장   : 127,842 (세전 116,220)
--   판매 단위는 박스 only 유지.
-- 생밀면은 020 에서 64,900 으로 이미 갱신됨 (변경 없음).
-- ============================================================

UPDATE public.b2b_customer_product_prices SET
  b2b_price = 120880,
  b2b_price_with_tax = 132968,
  available_units = ARRAY['box']::TEXT[],
  is_active = TRUE
 WHERE customer_id = (SELECT id FROM public.b2b_customers WHERE name = '돼봉삼겹살')
   AND product_id  = (SELECT id FROM public.products      WHERE name = '비빔전용장');

UPDATE public.b2b_customer_product_prices SET
  b2b_price = 116220,
  b2b_price_with_tax = 127842,
  available_units = ARRAY['box']::TEXT[],
  is_active = TRUE
 WHERE customer_id = (SELECT id FROM public.b2b_customers WHERE name = '돼봉삼겹살')
   AND product_id  = (SELECT id FROM public.products      WHERE name = '양념장');

-- (검증용)
-- SELECT c.name, p.name, pr.b2b_price, pr.b2b_price_with_tax, pr.available_units
--   FROM public.b2b_customer_product_prices pr
--   JOIN public.b2b_customers c ON c.id = pr.customer_id
--   JOIN public.products      p ON p.id = pr.product_id
--  WHERE c.name = '돼봉삼겹살'
--  ORDER BY p.name;
