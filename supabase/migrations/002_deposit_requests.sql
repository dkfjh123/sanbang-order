-- ============================================================
-- 입금 요청 테이블
-- ============================================================

CREATE TABLE IF NOT EXISTS public.deposit_requests (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  store_id UUID NOT NULL REFERENCES public.stores(id),
  amount BIGINT NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  description TEXT,
  created_by UUID NOT NULL REFERENCES auth.users(id),
  reviewed_by UUID REFERENCES auth.users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.deposit_requests ENABLE ROW LEVEL SECURITY;

-- 관리자: 전체 접근
CREATE POLICY "admin_deposit_requests_all" ON public.deposit_requests
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- 가맹점: 자기 매장 조회
CREATE POLICY "store_read_own_requests" ON public.deposit_requests
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'store' AND store_id = deposit_requests.store_id)
  );

-- 가맹점: 자기 매장 요청 생성
CREATE POLICY "store_insert_own_requests" ON public.deposit_requests
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'store' AND store_id = deposit_requests.store_id)
  );
