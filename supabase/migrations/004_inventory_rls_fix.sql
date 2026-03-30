-- ============================================================
-- 재고 테이블 RLS 정책 추가: store, shinwa 역할 읽기 허용
-- ============================================================

-- inventory: 가맹점/신화 조회 허용
CREATE POLICY "store_read_inventory" ON public.inventory
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('store', 'shinwa'))
  );

-- inventory_transactions: 가맹점/신화 조회 허용
CREATE POLICY "store_read_inventory_tx" ON public.inventory_transactions
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('store', 'shinwa'))
  );

-- inventory_transactions: 신화 입출고 등록 허용
CREATE POLICY "shinwa_insert_inventory_tx" ON public.inventory_transactions
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'shinwa')
  );

-- inventory: 신화 재고 수정 허용
CREATE POLICY "shinwa_update_inventory" ON public.inventory
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'shinwa')
  );
