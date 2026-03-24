-- ============================================================
-- 산방식당 발주시스템 — Phase 1: stores + profiles
-- ============================================================

-- 1. stores 테이블
CREATE TABLE IF NOT EXISTS public.stores (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  short_name TEXT,
  owner_name TEXT NOT NULL,
  business_number TEXT UNIQUE NOT NULL,
  corporate_number TEXT,
  address TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  contact_phone TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  region TEXT NOT NULL CHECK (region IN ('seoul', 'jeju')),
  is_direct BOOLEAN DEFAULT FALSE,
  deposit_balance BIGINT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. profiles 테이블 (auth.users 연동)
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'store', 'shinwa')),
  store_id UUID REFERENCES public.stores(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. RLS 활성화
ALTER TABLE public.stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- 4. stores RLS 정책
-- 관리자: 전체 접근
CREATE POLICY "admin_stores_all" ON public.stores
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- 가맹점: 자기 매장만 조회
CREATE POLICY "store_read_own" ON public.stores
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'store' AND store_id = stores.id)
  );

-- 신화푸드: 전체 조회만
CREATE POLICY "shinwa_read_all" ON public.stores
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'shinwa')
  );

-- 5. profiles RLS 정책
-- 본인 프로필 조회
CREATE POLICY "read_own_profile" ON public.profiles
  FOR SELECT USING (id = auth.uid());

-- 관리자: 전체 프로필 접근
CREATE POLICY "admin_profiles_all" ON public.profiles
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- 6. updated_at 자동 업데이트 트리거
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stores_updated_at
  BEFORE UPDATE ON public.stores
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
