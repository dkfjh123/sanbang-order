-- ============================================================
-- 산방식당 — 전용상품 매입가(제조사 → 산방푸드) 갱신
-- ============================================================
-- 의미: 제조사가 산방푸드에 공급하는 가격 (cost_price = 산방푸드 입장 매입원가)
-- 정산 용도: 산방푸드 → 제조사 결제 = 매월 입고 수량 × 매입가
--
-- 변경 사유:
--   - 고기국수육수: 19,140 → 23,000 (5kg×2 = 11,500×2, 단가 정정)
--   - 육수간장/비빔전용장/양념장: 5/1 다담푸드 인상분 반영
--   - 왕만두/생밀면/아삭한김치왕만두70: 변경 없음 (현재 값 그대로 명시)
-- 세전(cost_price)은 cost_price_with_tax / 1.1 (정수 round, 모두 과세)
-- ============================================================

UPDATE public.products SET cost_price_with_tax = 47520, cost_price = 43200 WHERE product_type = 'exclusive' AND name = '왕만두';
UPDATE public.products SET cost_price_with_tax = 35728, cost_price = 32480 WHERE product_type = 'exclusive' AND name = '생밀면';
UPDATE public.products SET cost_price_with_tax = 48180, cost_price = 43800 WHERE product_type = 'exclusive' AND name = '아삭한김치왕만두70';
UPDATE public.products SET cost_price_with_tax = 23000, cost_price = 20909 WHERE product_type = 'exclusive' AND name = '고기국수육수';
UPDATE public.products SET cost_price_with_tax = 52668, cost_price = 47880 WHERE product_type = 'exclusive' AND name = '육수간장';
UPDATE public.products SET cost_price_with_tax = 57970, cost_price = 52700 WHERE product_type = 'exclusive' AND name = '비빔전용장';
UPDATE public.products SET cost_price_with_tax = 62920, cost_price = 57200 WHERE product_type = 'exclusive' AND name = '양념장';

-- 검증 (실행 후 주석 해제)
-- SELECT name, cost_price, cost_price_with_tax, sanbang_food_sale_price_with_tax, price_with_tax
-- FROM public.products WHERE product_type = 'exclusive' ORDER BY sort_order;
