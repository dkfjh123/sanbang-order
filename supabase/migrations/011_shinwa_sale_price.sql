-- ============================================================
-- 산방식당 — 전용상품 "산방푸드 판매가" 컬럼 추가 + 7개 상품 가격 입력
-- ============================================================
-- 의미: 산방푸드가 산방에프앤비/상공회의소점(직영)에 공급하는 가격 (부가세 포함)
--   - 가맹점 판매가(price_with_tax)와 별개
--   - 매입가(cost_price_with_tax, 제조사→산방푸드)와도 별개
-- 정산 용도:
--   ① 산방에프앤비 → 산방푸드 (입고 정산): 입고 수량 × 단가
--   ② 상공회의소점(직영) → 산방푸드 (직영 후불): 출고 수량 × 단가
--   두 거래는 같은 단가(산방푸드 판매가) 적용
-- ============================================================

-- 1. 컬럼 추가 (DEFAULT 0 — 기존 로우 자동 호환)
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS sanbang_food_sale_price_with_tax BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.products.sanbang_food_sale_price_with_tax IS
  '산방푸드 → 산방에프앤비/직영점 공급가 (부가세 포함). 정산 시 입고/직영점 출고 단가로 사용';

-- 2. 7개 전용상품에 가격 입력 (2026-04-30 기준, 5/1 다담 인상분 포함)
UPDATE public.products SET sanbang_food_sale_price_with_tax =  50600 WHERE product_type = 'exclusive' AND name = '왕만두';
UPDATE public.products SET sanbang_food_sale_price_with_tax =  39600 WHERE product_type = 'exclusive' AND name = '생밀면';
UPDATE public.products SET sanbang_food_sale_price_with_tax =  50600 WHERE product_type = 'exclusive' AND name = '아삭한김치왕만두70';
UPDATE public.products SET sanbang_food_sale_price_with_tax =  33000 WHERE product_type = 'exclusive' AND name = '고기국수육수';
UPDATE public.products SET sanbang_food_sale_price_with_tax =  62150 WHERE product_type = 'exclusive' AND name = '육수간장';
UPDATE public.products SET sanbang_food_sale_price_with_tax = 107800 WHERE product_type = 'exclusive' AND name = '비빔전용장';
UPDATE public.products SET sanbang_food_sale_price_with_tax =  92400 WHERE product_type = 'exclusive' AND name = '양념장';

-- 3. (실행 후 검증용) 가격 확인 — 주석 해제하고 실행하세요
-- SELECT name, price_with_tax AS 가맹점판매가, sanbang_food_sale_price_with_tax AS 산방푸드판매가, cost_price_with_tax AS 매입가
-- FROM public.products WHERE product_type = 'exclusive' ORDER BY sort_order;
