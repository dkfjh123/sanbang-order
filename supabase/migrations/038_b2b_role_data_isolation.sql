-- ============================================================
-- 038_b2b_role_data_isolation.sql
-- b2b 역할의 공용 테이블 접근 차단 (원가·공지·배송일정)
-- ============================================================
-- 배경:
--   돼봉 계정(role='b2b') 실로그인 테스트(2026-06-12)에서 확인된 노출:
--     - products 28건 전체 (cost_price 등 원가 컬럼 포함!) ← 핵심
--     - notices 6건 (가맹점 대상 공지)
--     - delivery_schedule 2건
--   원인: 기존 permissive 정책이 "인증된 사용자 전체"에 SELECT 를
--   허용하고 있어, 신설된 b2b 역할이 자동 상속.
--
-- 해결: RESTRICTIVE 정책(AND 결합)으로 b2b 역할만 제외.
--   - 기존 permissive 정책은 일절 수정하지 않음 → admin/store/shinwa
--     동작은 한 글자도 안 바뀜 (RESTRICTIVE 는 b2b 외 모두 true)
--   - 서버 API(service_role)는 RLS 우회라 /api/b2b/products 등 무영향
--   - b2b 화면은 상품 정보를 서버 API 로만 받으므로 화면 깨짐 없음
--
-- 멱등성: DROP POLICY IF EXISTS — 재실행 안전. 데이터 변경 없음.
-- 절대원칙: 본인이 Supabase SQL Editor 에서 직접 실행. AI 는 파일만 생성.
-- ============================================================

-- 1. products — 원가 노출 차단 (가장 중요)
DROP POLICY IF EXISTS "b2b_products_deny" ON public.products;
CREATE POLICY "b2b_products_deny" ON public.products
  AS RESTRICTIVE FOR SELECT
  USING (
    NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'b2b')
  );

-- 2. notices — 가맹점 대상 공지 차단
DROP POLICY IF EXISTS "b2b_notices_deny" ON public.notices;
CREATE POLICY "b2b_notices_deny" ON public.notices
  AS RESTRICTIVE FOR SELECT
  USING (
    NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'b2b')
  );

-- 3. delivery_schedule — 배송 일정 차단
DROP POLICY IF EXISTS "b2b_delivery_schedule_deny" ON public.delivery_schedule;
CREATE POLICY "b2b_delivery_schedule_deny" ON public.delivery_schedule
  AS RESTRICTIVE FOR SELECT
  USING (
    NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'b2b')
  );

-- ============================================================
-- (검증용 — 실행 후 확인)
-- SELECT polname, polpermissive FROM pg_policy
--  WHERE polrelid IN ('public.products'::regclass, 'public.notices'::regclass,
--                     'public.delivery_schedule'::regclass)
--  ORDER BY polrelid::regclass::text, polname;
-- → b2b_*_deny 3개가 polpermissive = false 로 보여야 함
-- ============================================================
