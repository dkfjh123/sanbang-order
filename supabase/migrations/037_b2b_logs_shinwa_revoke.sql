-- ============================================================
-- 037_b2b_logs_shinwa_revoke.sql
-- B2B 변경 이력에서 신화푸드 SELECT 회수
-- ============================================================
-- 배경:
--   b2b_order_logs 의 description 에 주문 합계·예치금 차감/환불 금액이
--   기록된다 (PR2 부터 "예치금 ₩N 환불" 등). 신화푸드는 출고에 금액
--   정보가 필요 없고, 거래처별 단가(가맹판가와 다름)가 노출되면
--   수수료 산정 기준에 대한 불필요한 의문을 만들 수 있다.
--   → 019 에서 부여한 로그 SELECT 를 회수한다 (화면에서도 admin 전용으로 변경).
--
-- 신화가 계속 보는 것: b2b_orders / b2b_order_items / b2b_customers
--   (출고에 필요한 거래처·품목·수량·날짜 — 단, 화면에서 금액 컬럼은 숨김)
--
-- 멱등성: DROP POLICY IF EXISTS — 재실행 안전. 데이터 변경 없음.
-- 절대원칙: 본인이 Supabase SQL Editor 에서 직접 실행. AI 는 파일만 생성.
-- ============================================================

DROP POLICY IF EXISTS "shinwa_b2b_order_logs_select" ON public.b2b_order_logs;

-- (검증용)
-- SELECT polname FROM pg_policy
--  WHERE polrelid = 'public.b2b_order_logs'::regclass;
-- → admin_b2b_order_logs_all 만 남아야 함
