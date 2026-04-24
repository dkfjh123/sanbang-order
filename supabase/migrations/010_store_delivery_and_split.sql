-- ============================================================
-- 산방식당 — 매장별 배송요일 커스텀 + 동일옥 분할 배송 + 관리자 마감 연장
-- ============================================================

-- 1. stores: 매장별 배송요일, 분할배송 허용, 마감 연장 override
--    delivery_days: 1=월, 2=화, 3=수, 4=목, 5=금, 6=토, 0=일 (Date.getDay() 기준)
--    NULL 이면 region 기본값(서울=월·수·금, 제주=수요일마감) 사용
ALTER TABLE public.stores
  ADD COLUMN IF NOT EXISTS delivery_days INTEGER[] DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS allow_split_shipping BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS deadline_override_until TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN public.stores.delivery_days IS '배송요일 배열 (Date.getDay() 기준 0~6). NULL=region 기본값';
COMMENT ON COLUMN public.stores.allow_split_shipping IS 'TRUE면 주문을 여러 배송일로 분할 가능 (동일옥 전용)';
COMMENT ON COLUMN public.stores.deadline_override_until IS '관리자가 마감 연장한 경우 해당 시각까지 마감 판정 건너뜀';

-- 2. order_items: 아이템별 출고일 (분할 배송 지원)
--    NULL 이면 orders.ship_date 따라감 (기존 주문 호환)
ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS ship_date DATE DEFAULT NULL;

COMMENT ON COLUMN public.order_items.ship_date IS '아이템별 출고일. NULL=orders.ship_date와 동일 (분할 아님)';

-- 기존 order_items 백필 — orders.ship_date로 채움
UPDATE public.order_items oi
SET ship_date = o.ship_date
FROM public.orders o
WHERE oi.order_id = o.id
  AND oi.ship_date IS NULL
  AND o.ship_date IS NOT NULL;

-- 3. 기존 가맹점 매출처별 배송요일 지정
--    대한상공회의소점 → 월·목 {1, 4}
--    동일옥 → 화·수·금 {2, 3, 5} + 분할 허용
UPDATE public.stores
SET delivery_days = ARRAY[1, 4]
WHERE short_name = '대한상공회의소점' OR name LIKE '%대한상공회의소%';

UPDATE public.stores
SET delivery_days = ARRAY[2, 3, 5],
    allow_split_shipping = TRUE
WHERE short_name = '동일옥' OR name LIKE '%동일옥%';

-- 4. order_items ship_date 조회 인덱스 (출고화면 그룹핑 성능)
CREATE INDEX IF NOT EXISTS order_items_ship_date_idx ON public.order_items (ship_date);
