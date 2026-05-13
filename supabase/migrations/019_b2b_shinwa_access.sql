-- ============================================================
-- B2B 테이블에 신화푸드(shinwa) SELECT 권한 부여
-- ============================================================
-- 의미:
--   관리자가 B2B 발주를 등록하면 신화푸드가 "배송할 발주"로 확인하고
--   출고 처리를 해야 한다. 그러려면 클라이언트에서 신화 계정으로
--   b2b_orders / b2b_order_items / b2b_order_logs / b2b_customers 를
--   조회할 수 있어야 한다. RLS가 admin 전용이라 SELECT 정책을 추가한다.
--
-- 변경 사항:
--   - SELECT : admin + shinwa
--   - INSERT/UPDATE/DELETE : admin 전용 유지 (API 측 role check + service_role)
--     ※ 출고 처리(PATCH ship) 자체는 API가 service_role 키로 수행하므로
--       UPDATE 정책은 별도로 신화에 줄 필요 없음.
-- ============================================================

-- b2b_customers : 신화도 거래처명/region 조회 필요 (목록/상세에서 조인)
DROP POLICY IF EXISTS "shinwa_b2b_customers_select" ON public.b2b_customers;
CREATE POLICY "shinwa_b2b_customers_select" ON public.b2b_customers
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin', 'shinwa'))
  );

-- b2b_orders : 발주 목록/상세
DROP POLICY IF EXISTS "shinwa_b2b_orders_select" ON public.b2b_orders;
CREATE POLICY "shinwa_b2b_orders_select" ON public.b2b_orders
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin', 'shinwa'))
  );

-- b2b_order_items : 배송할 품목/수량
DROP POLICY IF EXISTS "shinwa_b2b_order_items_select" ON public.b2b_order_items;
CREATE POLICY "shinwa_b2b_order_items_select" ON public.b2b_order_items
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin', 'shinwa'))
  );

-- b2b_order_logs : 이력 확인용
DROP POLICY IF EXISTS "shinwa_b2b_order_logs_select" ON public.b2b_order_logs;
CREATE POLICY "shinwa_b2b_order_logs_select" ON public.b2b_order_logs
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin', 'shinwa'))
  );

-- 참고: b2b_customer_product_prices 는 신화에게 노출하지 않는다
--   (거래처별 단가표는 외부에 보여줄 정보가 아님 — 출고에는 b2b_order_items 의 스냅샷 단가만 사용)
