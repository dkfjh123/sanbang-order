-- ============================================================
-- 재고 테이블 RLS 정책
-- 전용상품: 어드민만 수정 / 신화는 조회만
-- 범용상품: 어드민 + 신화 수정 가능
-- 가맹점: 조회만 (발주 시 재고 한도 적용용)
-- ============================================================

-- inventory: 가맹점/신화 조회 허용 (전용+범용 모두)
CREATE POLICY "store_read_inventory" ON public.inventory
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('store', 'shinwa'))
  );

-- inventory_transactions: 가맹점/신화 조회 허용
CREATE POLICY "store_read_inventory_tx" ON public.inventory_transactions
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('store', 'shinwa'))
  );

-- inventory_transactions: 신화 — 범용상품만 입출고 등록
CREATE POLICY "shinwa_insert_inventory_tx" ON public.inventory_transactions
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'shinwa')
    AND EXISTS (SELECT 1 FROM public.products WHERE id = inventory_transactions.product_id AND product_type = 'general')
  );

-- inventory: 신화 — 범용상품만 재고 수정
CREATE POLICY "shinwa_update_inventory" ON public.inventory
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'shinwa')
    AND EXISTS (SELECT 1 FROM public.products WHERE id = inventory.product_id AND product_type = 'general')
  );
