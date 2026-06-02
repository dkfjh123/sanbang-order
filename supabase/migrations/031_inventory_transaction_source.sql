-- 031: inventory_transactions.source — 입고 분류 라벨 (정산/이력보기용)
--
-- 목적: "입고" = 재고관리 화면에서 사람이 '입고 등록'한 것(=제조사 입고)만 집계.
--       발주/B2B/롤백/취소복구 등 시스템 자동건은 입고에서 제외.
--
-- ⚠️ 안전: 이 마이그레이션은 inventory(재고 3분할 카운트)와 발주/출고 로직을 일절 건드리지 않음.
--          inventory_transactions(이력 로그)에 분류 라벨 컬럼 하나만 추가/채움.

-- 1) 컬럼 추가 (nullable — 기존 INSERT 동작에 영향 없음)
ALTER TABLE public.inventory_transactions
  ADD COLUMN IF NOT EXISTS source TEXT;

COMMENT ON COLUMN public.inventory_transactions.source IS
  'manual_inbound=재고관리 입고등록(제조사입고, 입고정산 대상). manual_adjust=재고관리 조정. NULL=발주/B2B/롤백 등 시스템 자동(입고 제외).';

-- 2) 과거 데이터 백필
--   (a) 사람이 등록한 입고 → manual_inbound  (발주/B2B 시스템 자동건은 NULL 유지)
UPDATE public.inventory_transactions
SET source = 'manual_inbound'
WHERE type = 'inbound'
  AND source IS NULL
  AND description NOT LIKE '발주%'
  AND description NOT LIKE 'B2B%'
  AND description NOT LIKE 'b2b%';

--   (b) 돼봉삼겹살 B2B 조정 3건 → manual_adjust (입고에서 제외)
--       (어떤 제조사 입고에도 '돼봉삼겹살' 문구가 없으므로 정확히 이 3건만 매칭)
UPDATE public.inventory_transactions
SET source = 'manual_adjust'
WHERE type = 'inbound'
  AND description LIKE '%돼봉삼겹살%';

-- 검증용 (실행 후 확인):
--   SELECT source, count(*), sum(quantity) FROM inventory_transactions WHERE type='inbound' GROUP BY source;
--   기대: manual_inbound 40건 / manual_adjust 3건 / NULL 54건
