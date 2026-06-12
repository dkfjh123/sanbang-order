-- ============================================================
-- 5/8 돼봉삼겹살 주문(B-20260508-004) 단가 소급 정정
-- ============================================================
-- 절대원칙: 본인이 Supabase SQL Editor 에서 직접 실행
--
-- 변경 의미:
--   B-20260508-004 는 013 시드의 잘못된 단가(각 107,800 부포)로
--   기록됐으나, 실제 합의 단가(021에서 확정)는:
--     - 비빔전용장: 132,968 (세전 120,880)
--     - 양념장   : 127,842 (세전 116,220)
--   실제 수금도 정상 단가 기준으로 완료됨(2026-06-12 사용자 확인)
--   → 시스템 기록만 실제와 다르므로 소급 정정.
--
--   합계: 215,600 → 260,810 (부포) / 196,000 → 237,100 (세전)
--
-- 영향 범위:
--   - 재고/출고: 영향 없음 (수량 불변, 금액만 변경)
--   - 정산 화면: 5월 B2B 매출 +45,210 반영됨 (수수료는 가맹판가
--     기준 별도 계산이라 불변)
--   - 예치금: 무관 (돼봉 선입금 전환 전 후불 거래)
-- ============================================================

BEGIN;

-- 1. 비빔전용장 1박스: 98,000/107,800 → 120,880/132,968
UPDATE public.b2b_order_items SET
  unit_price          = 120880,
  unit_price_with_tax = 132968,
  subtotal_ex_tax     = 120880 * quantity,
  subtotal            = 132968 * quantity
 WHERE id = '8fb6549d-7c87-45cc-b34d-e159995d6916'  -- B-20260508-004 비빔전용장
   AND unit_price = 98000;                           -- 가드: 이미 정정됐으면 0행

-- 2. 양념장 1박스: 98,000/107,800 → 116,220/127,842
UPDATE public.b2b_order_items SET
  unit_price          = 116220,
  unit_price_with_tax = 127842,
  subtotal_ex_tax     = 116220 * quantity,
  subtotal            = 127842 * quantity
 WHERE id = '36d3da11-2717-47ce-973d-6d080661086a'  -- B-20260508-004 양념장
   AND unit_price = 98000;                           -- 가드: 이미 정정됐으면 0행

-- 3. 주문 합계 재계산 + 정정 메모
UPDATE public.b2b_orders SET
  total_amount        = (SELECT COALESCE(SUM(subtotal), 0)
                           FROM public.b2b_order_items
                          WHERE order_id = 'bb9895e3-56e4-4335-a12e-06fd7e3707d3'),
  total_amount_ex_tax = (SELECT COALESCE(SUM(subtotal_ex_tax), 0)
                           FROM public.b2b_order_items
                          WHERE order_id = 'bb9895e3-56e4-4335-a12e-06fd7e3707d3'),
  memo                = COALESCE(memo || ' / ', '')
                        || '2026-06-12 단가 소급 정정: 시드 오류 단가(각 107,800)로 기록돼 있던 것을 합의 단가(비빔전용장 132,968, 양념장 127,842)로 수정. 수금은 정상 단가로 완료됨.',
  updated_at          = NOW()
 WHERE id = 'bb9895e3-56e4-4335-a12e-06fd7e3707d3';  -- B-20260508-004

-- 4. 변경 이력 기록
INSERT INTO public.b2b_order_logs (order_id, action, description, changed_by_name, changed_by_role)
VALUES (
  'bb9895e3-56e4-4335-a12e-06fd7e3707d3',
  'price_fix',
  '단가 소급 정정 (SQL 035): 비빔전용장 107,800→132,968, 양념장 107,800→127,842 / 합계 215,600→260,810. 재고·수량 불변.',
  '관리자(수동 SQL)',
  'admin'
);

COMMIT;

-- (검증용 — 실행 후 확인: 합계 260,810 / 237,100 이어야 함)
-- SELECT o.order_number, o.total_amount, o.total_amount_ex_tax, o.memo,
--        i.product_name, i.unit_price, i.unit_price_with_tax, i.subtotal
--   FROM public.b2b_orders o
--   JOIN public.b2b_order_items i ON i.order_id = o.id
--  WHERE o.order_number = 'B-20260508-004';
