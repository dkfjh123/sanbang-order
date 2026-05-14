-- ============================================================
-- 돼봉삼겹살 거래처에 생밀면 추가
-- ============================================================
-- 변경 의미:
--   돼봉삼겹살은 기존에 비빔전용장/비빔장/양념장 3종만 등록돼 있었음.
--   여기에 '생밀면'을 메이즈랜드와 동일 가격으로 추가한다.
--   - 박스단가 (부가세 별도): 59,000
--   - 박스단가 (부가세 포함): 64,900
--   - 판매 단위: 박스 only (메이즈랜드와 동일)
-- ============================================================

INSERT INTO public.b2b_customer_product_prices (
  customer_id,
  product_id,
  b2b_price,
  b2b_price_with_tax,
  available_units,
  is_active
)
SELECT c.id, p.id, 59000, 64900, ARRAY['box']::TEXT[], TRUE
FROM public.b2b_customers c
JOIN public.products p ON p.name = '생밀면'
WHERE c.name = '돼봉삼겹살'
ON CONFLICT (customer_id, product_id) DO UPDATE SET
  b2b_price = EXCLUDED.b2b_price,
  b2b_price_with_tax = EXCLUDED.b2b_price_with_tax,
  available_units = EXCLUDED.available_units,
  is_active = TRUE;

-- (검증용)
-- SELECT c.name, p.name, pr.b2b_price, pr.b2b_price_with_tax, pr.available_units
--   FROM public.b2b_customer_product_prices pr
--   JOIN public.b2b_customers c ON c.id = pr.customer_id
--   JOIN public.products p ON p.id = pr.product_id
--  WHERE c.name = '돼봉삼겹살'
--  ORDER BY p.name;
