-- ============================================================
-- B2B 거래처 region 컬럼 + 메이즈랜드(제주) 신규 등록
-- ============================================================
-- 변경 의미:
--   1) b2b_customers.region 컬럼 추가 — 신화 물류수수료율을 거래처별 권역으로 산정
--      (제주 12.5% / 육지 8.5%). 기존엔 정산 코드에서 'seoul' 하드코딩이었음.
--   2) 메이즈랜드(제주) 거래처 등록 + 생밀면/비빔전용장 가격 시드.
--   3) 신화수수료 산정 기준은 "가맹점 판가" 이므로 B2B 가격과 별개.
--      이 규칙은 코드(5섹션 정산)에서 처리.
-- ============================================================

-- ------------------------------------------------------------
-- 1) b2b_customers.region 컬럼 추가 (DEFAULT 'seoul' — 기존 로우 자동 호환)
-- ------------------------------------------------------------
ALTER TABLE public.b2b_customers
  ADD COLUMN IF NOT EXISTS region TEXT NOT NULL DEFAULT 'seoul'
    CHECK (region IN ('jeju', 'seoul'));

COMMENT ON COLUMN public.b2b_customers.region IS
  '거래처 권역 (jeju=제주 12.5% / seoul=육지 8.5%). 신화 물류수수료율 산정용.';

-- 기존 거래처 명시 백필 (DEFAULT로 이미 'seoul' 이지만 의도 명시)
UPDATE public.b2b_customers SET region = 'seoul' WHERE name IN ('아워홈', '돼봉삼겹살');

-- ------------------------------------------------------------
-- 2) 메이즈랜드 거래처 등록 (제주)
-- ------------------------------------------------------------
INSERT INTO public.b2b_customers (
  name, business_number, contact_name, contact_phone, address, region, is_active
)
VALUES (
  '메이즈랜드',
  '497-88-00217',
  '이종헌 본부장',
  '010-9662-3170',
  '제주도 제주시 구좌읍 비자림로 2134-47',
  'jeju',
  TRUE
)
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------
-- 3) 메이즈랜드 상품 가격 시드 (생밀면 / 비빔전용장)
--    - 단위: 박스
--    - 박스단가 (부가세 별도): 생밀면 59,000 / 비빔전용장 135,000
--    - 박스단가 (부가세 포함): 64,900 / 148,500
-- ------------------------------------------------------------
INSERT INTO public.b2b_customer_product_prices (
  customer_id, product_id, b2b_price, b2b_price_with_tax, available_units, is_active
)
SELECT c.id, p.id, 59000, 64900, ARRAY['box']::TEXT[], TRUE
FROM public.b2b_customers c
JOIN public.products p ON p.name = '생밀면'
WHERE c.name = '메이즈랜드'
ON CONFLICT (customer_id, product_id) DO UPDATE SET
  b2b_price = EXCLUDED.b2b_price,
  b2b_price_with_tax = EXCLUDED.b2b_price_with_tax,
  available_units = EXCLUDED.available_units,
  is_active = TRUE;

INSERT INTO public.b2b_customer_product_prices (
  customer_id, product_id, b2b_price, b2b_price_with_tax, available_units, is_active
)
SELECT c.id, p.id, 135000, 148500, ARRAY['box']::TEXT[], TRUE
FROM public.b2b_customers c
JOIN public.products p ON p.name = '비빔전용장'
WHERE c.name = '메이즈랜드'
ON CONFLICT (customer_id, product_id) DO UPDATE SET
  b2b_price = EXCLUDED.b2b_price,
  b2b_price_with_tax = EXCLUDED.b2b_price_with_tax,
  available_units = EXCLUDED.available_units,
  is_active = TRUE;

-- ------------------------------------------------------------
-- 4) (검증용) 적용 결과 확인
-- ------------------------------------------------------------
-- SELECT c.name, c.region, p.name AS product, pr.b2b_price, pr.b2b_price_with_tax, pr.available_units
--   FROM public.b2b_customer_product_prices pr
--   JOIN public.b2b_customers c ON c.id = pr.customer_id
--   JOIN public.products p ON p.id = pr.product_id
--  ORDER BY c.name, p.name;
