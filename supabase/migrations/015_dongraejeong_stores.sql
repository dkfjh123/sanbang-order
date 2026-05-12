-- ============================================================
-- 산방식당 — 동래정 가맹점 2곳 추가 + 출입 메모(notes) + 매장별 주문 가능 상품 화이트리스트
-- ============================================================
-- 배경:
--   동래정 대흥점 / 신풍역점은 산방식당 시스템에서 "왕만두"와 "아삭한김치왕만두70" 두 가지만 발주 가능.
--   기존 매장은 화이트리스트 없음 = 전체 상품 발주 가능 (기존 동작 유지).
--   두 매장 모두 육지(seoul) / 가맹 / 월·목 배송 / 최소발주금액 120,000원.

-- ============================================================
-- 1. 출입 메모 컬럼 (관리자/신화푸드가 매장 출입 비번 등 확인용)
-- ============================================================
ALTER TABLE public.stores
  ADD COLUMN IF NOT EXISTS notes TEXT;

COMMENT ON COLUMN public.stores.notes IS '출입 비밀번호 등 매장 운영 메모. 관리자·신화푸드 조회 가능';

-- ============================================================
-- 2. 매장별 주문 가능 상품 화이트리스트 테이블
--    - 행 없음 = 전체 상품 발주 가능 (기존 매장)
--    - 행 있음 = 그 상품들만 발주 가능 (동래정 등 제한 매장)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.store_allowed_products (
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (store_id, product_id)
);

COMMENT ON TABLE public.store_allowed_products IS '매장별 주문 가능 상품 화이트리스트. 행이 하나라도 있는 매장은 그 상품들만 발주 가능';

CREATE INDEX IF NOT EXISTS idx_store_allowed_products_store ON public.store_allowed_products(store_id);

-- RLS
ALTER TABLE public.store_allowed_products ENABLE ROW LEVEL SECURITY;

-- 관리자: 전체 접근
CREATE POLICY "admin_allowed_products_all" ON public.store_allowed_products
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- 가맹점: 자기 매장 화이트리스트 조회
CREATE POLICY "store_allowed_products_read_own" ON public.store_allowed_products
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid()
        AND role = 'store'
        AND store_id = store_allowed_products.store_id
    )
  );

-- 신화푸드: 전체 조회
CREATE POLICY "shinwa_allowed_products_read_all" ON public.store_allowed_products
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'shinwa')
  );

-- ============================================================
-- 3. 동래정 대흥점 INSERT
-- ============================================================
INSERT INTO public.stores (
  name, short_name, owner_name, business_number,
  address, contact_name, contact_phone, email,
  region, is_direct,
  delivery_days, min_order_amount,
  notes
) VALUES (
  '동래정 대흥점', '동래정 대흥점', '김서진', '588-49-01075',
  '서울특별시 마포구 백범로16길 5, 1층 (대흥동)',
  '김서진', '010-8208-4219', 'seojin0297@naver.com',
  'seoul', FALSE,
  ARRAY[1, 4], 120000,
  '출입: 밖의 냉동고 (열려있거나 비번 9999)'
)
ON CONFLICT (business_number) DO NOTHING;

-- ============================================================
-- 4. 동래정 신풍역점 INSERT
-- ============================================================
INSERT INTO public.stores (
  name, short_name, owner_name, business_number,
  address, contact_name, contact_phone, email,
  region, is_direct,
  delivery_days, min_order_amount,
  notes
) VALUES (
  '동래정 신풍역점', '동래정 신풍역점', '윤여현', '730-65-00639',
  '서울특별시 영등포구 신풍로 28, 1층 139호·140호·141호 (신길동, 비스타동원)',
  '윤여현', '010-5433-3239', 'yyh5239@naver.com',
  'seoul', FALSE,
  ARRAY[1, 4], 120000,
  '출입: 건물 뒷편 1층(화물 주차장) 뒷문, 비번 2525'
)
ON CONFLICT (business_number) DO NOTHING;

-- ============================================================
-- 5. 두 매장에 왕만두 + 아삭한김치왕만두70 화이트리스트 INSERT
-- ============================================================
INSERT INTO public.store_allowed_products (store_id, product_id)
SELECT s.id, p.id
FROM public.stores s
CROSS JOIN public.products p
WHERE s.short_name IN ('동래정 대흥점', '동래정 신풍역점')
  AND p.name IN ('왕만두', '아삭한김치왕만두70')
ON CONFLICT (store_id, product_id) DO NOTHING;
