-- ============================================================
-- 023_inventory_split_and_shipping.sql
-- 1차 PR (DB) — 재고 3분할(A안) + 신화 실측 출고 + 단위변경 플래그 + 반품 컬럼
-- ============================================================
-- 배경 / 의도:
--   - A안 채택: inventory 를 on_hand(총재고) / reserved(나갈것들) / available(매장주문가능)
--     3분할로 관리.
--   - quantity 컬럼은 그대로 유지 → 가맹점 화면이 보는 "available" 의미.
--     코드 호환성 위해 컬럼명/값 손대지 않음. 새 컬럼 on_hand / reserved 만 추가.
--   - Q1 묶음1 (신화 실측 출고 수량/단위 입력) 용 컬럼 준비
--   - Q3 (육수간장 / 비빔전용장 박스↔팩 단위변경) 용 products.allow_unit_change 플래그
--   - Q3 묶음2 (반품) 용 order_items.returned_* 컬럼 준비
--   - 어제 합의된 보정 3건도 같이 반영 (생밀면 -15, 비빔전용장 -2box/-1pack, 육수간장 -1box/-1pack)
--
-- 멱등성:
--   - 백업 테이블은 IF NOT EXISTS
--   - 컬럼 추가는 ADD COLUMN IF NOT EXISTS
--   - 보정 3건은 inventory_transactions description 태그 '[023 보정]' 존재 여부로 가드
--   - 단위변경 플래그 UPDATE 는 멱등
--
-- 절대원칙:
--   본인이 야간에 Supabase SQL Editor 에서 직접 실행. AI 는 파일만 생성.
--
-- 예상 적용 시간: 수 초.
-- ============================================================

-- ----------------------------------------------------------------
-- [백업] 트랜잭션 밖에서 먼저 — 실패해도 백업본은 살아남게
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS backup_inventory_20260521
  AS SELECT * FROM public.inventory;
CREATE TABLE IF NOT EXISTS backup_inventory_transactions_20260521
  AS SELECT * FROM public.inventory_transactions;
CREATE TABLE IF NOT EXISTS backup_orders_pre023
  AS SELECT * FROM public.orders;
CREATE TABLE IF NOT EXISTS backup_order_items_pre023
  AS SELECT * FROM public.order_items;
CREATE TABLE IF NOT EXISTS backup_products_pre023
  AS SELECT * FROM public.products;

-- ----------------------------------------------------------------
-- 본 작업 — 한 트랜잭션으로 묶어서 도중 실패 시 자동 원복
-- ----------------------------------------------------------------
BEGIN;

-- ================================================================
-- 1) inventory 확장 — on_hand / reserved / on_hand_pack / reserved_pack
--    박스와 팩에 대해 완전 대칭 설계.
-- ================================================================
ALTER TABLE public.inventory
  ADD COLUMN IF NOT EXISTS on_hand        INT,
  ADD COLUMN IF NOT EXISTS reserved       INT NOT NULL DEFAULT 0
    CHECK (reserved >= 0),
  ADD COLUMN IF NOT EXISTS on_hand_pack   INT,
  ADD COLUMN IF NOT EXISTS reserved_pack  INT NOT NULL DEFAULT 0
    CHECK (reserved_pack >= 0);

COMMENT ON COLUMN public.inventory.quantity
  IS '가맹점이 보는 매장주문가능 박스 재고(available). 기존 의미 유지.';
COMMENT ON COLUMN public.inventory.on_hand
  IS '신화 창고에 실제 박혀 있어야 할 박스 수 (= quantity + reserved).';
COMMENT ON COLUMN public.inventory.reserved
  IS '미출고 발주(가맹점 pending+confirmed, B2B pending) 박스 합산.';
COMMENT ON COLUMN public.inventory.loose_pack_qty
  IS '가맹점이 보는 매장주문가능 낱개팩 재고(available_pack). 기존 컬럼명 유지.';
COMMENT ON COLUMN public.inventory.on_hand_pack
  IS '신화 창고에 실제 박혀 있어야 할 낱개팩 수 (= loose_pack_qty + reserved_pack).';
COMMENT ON COLUMN public.inventory.reserved_pack
  IS '미출고 팩 발주(가맹점 pending+confirmed, B2B pending) 합산. allow_unit_change=TRUE 상품에서만 의미 있음.';

-- ================================================================
-- 2) 어제 합의된 보정 3건 — quantity / loose 감산 + 이력 기록
--    멱등 가드: 이미 적용됐으면 건너뜀
-- ================================================================
DO $$
DECLARE
  v_admin_id      UUID;
  v_saengmilmyeon UUID;
  v_bibim         UUID;
  v_yangsoo       UUID;
  v_tag CONSTANT TEXT := '[023 보정] 신화 실측';
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.inventory_transactions
     WHERE description LIKE v_tag || '%'
  ) THEN
    RAISE NOTICE '023 보정 3건이 이미 적용되어 있어 건너뜁니다.';
    RETURN;
  END IF;

  SELECT id INTO v_admin_id
    FROM public.profiles
    WHERE email = 'dkfjh1234@gmail.com' AND role = 'admin'
    LIMIT 1;
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION '관리자(dkfjh1234@gmail.com) 프로필을 찾을 수 없습니다.';
  END IF;

  SELECT id INTO v_saengmilmyeon FROM public.products WHERE name = '생밀면';
  SELECT id INTO v_bibim         FROM public.products WHERE name = '비빔전용장';
  SELECT id INTO v_yangsoo       FROM public.products WHERE name = '육수간장';

  IF v_saengmilmyeon IS NULL OR v_bibim IS NULL OR v_yangsoo IS NULL THEN
    RAISE EXCEPTION '필수 상품(생밀면/비빔전용장/육수간장) 미발견';
  END IF;

  -- (a) 생밀면: quantity -15 (48 → 33)
  UPDATE public.inventory
     SET quantity = quantity - 15,
         updated_at = NOW()
   WHERE product_id = v_saengmilmyeon;

  INSERT INTO public.inventory_transactions
    (product_id, type, quantity, unit, description, created_by, created_at)
  VALUES
    (v_saengmilmyeon, 'adjustment', -15, 'box',
     v_tag || ' — 운영 초기 테스트 임시반영 정정',
     v_admin_id, NOW());

  -- (b) 비빔전용장: quantity -2, loose -1 (2/1 → 0/0)
  UPDATE public.inventory
     SET quantity       = quantity - 2,
         loose_pack_qty = loose_pack_qty - 1,
         updated_at     = NOW()
   WHERE product_id = v_bibim;

  INSERT INTO public.inventory_transactions
    (product_id, type, quantity, unit, description, created_by, created_at)
  VALUES
    (v_bibim, 'adjustment', -2, 'box',
     v_tag || ' — 박스→팩 출고 누락 정정(박스분)',
     v_admin_id, NOW()),
    (v_bibim, 'adjustment', -1, 'pack',
     v_tag || ' — 박스→팩 출고 누락 정정(낱개분)',
     v_admin_id, NOW());

  -- (c) 육수간장: quantity -1, loose -1 (27/1 → 26/0)
  UPDATE public.inventory
     SET quantity       = quantity - 1,
         loose_pack_qty = loose_pack_qty - 1,
         updated_at     = NOW()
   WHERE product_id = v_yangsoo;

  INSERT INTO public.inventory_transactions
    (product_id, type, quantity, unit, description, created_by, created_at)
  VALUES
    (v_yangsoo, 'adjustment', -1, 'box',
     v_tag || ' — 박스→팩 출고 누락 정정(박스분)',
     v_admin_id, NOW()),
    (v_yangsoo, 'adjustment', -1, 'pack',
     v_tag || ' — 박스→팩 출고 누락 정정(낱개분)',
     v_admin_id, NOW());

  RAISE NOTICE '023 보정 적용 완료 — 생밀면 -15box, 비빔전용장 -2box/-1pack, 육수간장 -1box/-1pack';
END $$;

-- ================================================================
-- 3) reserved / reserved_pack 백필 — 가맹점 미출고 + B2B 미출고 합산
-- ================================================================
-- (a) 박스 단위 reserved
UPDATE public.inventory inv
   SET reserved =
     COALESCE((
       SELECT SUM(oi.quantity)
         FROM public.order_items oi
         JOIN public.orders o ON o.id = oi.order_id
        WHERE oi.product_id = inv.product_id
          AND oi.unit       = 'box'
          AND o.status      IN ('pending', 'confirmed')
     ), 0)
     +
     COALESCE((
       SELECT SUM(boi.quantity)
         FROM public.b2b_order_items boi
         JOIN public.b2b_orders bo ON bo.id = boi.order_id
        WHERE boi.product_id = inv.product_id
          AND boi.unit       = 'box'
          AND bo.status      = 'pending'
     ), 0);

-- (b) 팩 단위 reserved_pack
UPDATE public.inventory inv
   SET reserved_pack =
     COALESCE((
       SELECT SUM(oi.quantity)
         FROM public.order_items oi
         JOIN public.orders o ON o.id = oi.order_id
        WHERE oi.product_id = inv.product_id
          AND oi.unit       = 'pack'
          AND o.status      IN ('pending', 'confirmed')
     ), 0)
     +
     COALESCE((
       SELECT SUM(boi.quantity)
         FROM public.b2b_order_items boi
         JOIN public.b2b_orders bo ON bo.id = boi.order_id
        WHERE boi.product_id = inv.product_id
          AND boi.unit       = 'pack'
          AND bo.status      = 'pending'
     ), 0);

-- ================================================================
-- 4) on_hand / on_hand_pack 백필 — (보정 적용 후) available + reserved
--    이후 NOT NULL + 음수 가드 부여
-- ================================================================
-- (a) 박스
UPDATE public.inventory
   SET on_hand = quantity + reserved
 WHERE on_hand IS NULL OR on_hand <> quantity + reserved;

ALTER TABLE public.inventory ALTER COLUMN on_hand SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_on_hand_nonneg'
  ) THEN
    ALTER TABLE public.inventory
      ADD CONSTRAINT inventory_on_hand_nonneg CHECK (on_hand >= 0);
  END IF;
END $$;

-- (b) 팩
UPDATE public.inventory
   SET on_hand_pack = loose_pack_qty + reserved_pack
 WHERE on_hand_pack IS NULL OR on_hand_pack <> loose_pack_qty + reserved_pack;

ALTER TABLE public.inventory ALTER COLUMN on_hand_pack SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_on_hand_pack_nonneg'
  ) THEN
    ALTER TABLE public.inventory
      ADD CONSTRAINT inventory_on_hand_pack_nonneg CHECK (on_hand_pack >= 0);
  END IF;
END $$;

-- ================================================================
-- 5) order_items 확장 — 신화 실측 출고(Q1) + 반품(묶음2)
-- ================================================================
ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS shipped_quantity  INT,
  ADD COLUMN IF NOT EXISTS shipped_unit      TEXT
    CHECK (shipped_unit IS NULL OR shipped_unit IN ('box', 'pack')),
  ADD COLUMN IF NOT EXISTS shipment_memo     TEXT,
  ADD COLUMN IF NOT EXISTS returned_quantity INT NOT NULL DEFAULT 0
    CHECK (returned_quantity >= 0),
  ADD COLUMN IF NOT EXISTS returned_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS return_reason     TEXT;

COMMENT ON COLUMN public.order_items.shipped_quantity
  IS '신화가 실제로 출고한 수량. NULL=아직 출고 안 함. quantity와 다르면 shipment_memo 필수.';
COMMENT ON COLUMN public.order_items.shipped_unit
  IS '신화 실측 출고 단위(box/pack). NULL=출고전. 발주 unit과 다르면 단위변경 발생.';
COMMENT ON COLUMN public.order_items.shipment_memo
  IS '출고 수량/단위 변경 사유 메모. 차이 발생 시 필수 입력(PR2 코드에서 강제).';
COMMENT ON COLUMN public.order_items.returned_quantity
  IS '관리자 사후 반품 수량(shipped_unit 단위 기준). 기본 0.';
COMMENT ON COLUMN public.order_items.returned_at
  IS '반품 처리 시각.';
COMMENT ON COLUMN public.order_items.return_reason
  IS '반품 사유.';

-- ================================================================
-- 6) products 확장 — 박스↔팩 단위변경 허용 플래그(Q3)
--    초기값: 육수간장 + 비빔전용장만 TRUE.
-- ================================================================
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS allow_unit_change BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE public.products
   SET allow_unit_change = TRUE
 WHERE name IN ('육수간장', '비빔전용장');

COMMENT ON COLUMN public.products.allow_unit_change
  IS '출고 시 박스→팩 단위변경 허용 여부. 현재 육수간장/비빔전용장만 TRUE. B2B 아워홈 → 가맹점 낱팩 공급 흐름 대응.';

-- ================================================================
-- 7) 적용 직후 검증 출력 (Notices 패널에서 확인)
-- ================================================================
DO $$
DECLARE
  r RECORD;
BEGIN
  RAISE NOTICE '== inventory 3분할(박스+팩) 결과 ==';
  FOR r IN
    SELECT p.name, i.quantity, i.loose_pack_qty,
           i.on_hand, i.reserved, i.on_hand_pack, i.reserved_pack
      FROM public.inventory i
      JOIN public.products p ON p.id = i.product_id
     WHERE p.product_type = 'exclusive'
     ORDER BY p.name
  LOOP
    RAISE NOTICE '% | 박스: qty=% on_hand=% reserved=% | 팩: loose=% on_hand_pack=% reserved_pack=%',
      r.name, r.quantity, r.on_hand, r.reserved,
      r.loose_pack_qty, r.on_hand_pack, r.reserved_pack;
  END LOOP;

  RAISE NOTICE '== allow_unit_change=TRUE 상품 ==';
  FOR r IN
    SELECT name FROM public.products WHERE allow_unit_change = TRUE ORDER BY name
  LOOP
    RAISE NOTICE '  - %', r.name;
  END LOOP;
END $$;

COMMIT;

-- ============================================================
-- 적용 후 베이스라인 검증 (별도 쿼리로 한 번 더 실행)
-- ============================================================
-- SELECT p.name, i.quantity, i.loose_pack_qty, i.on_hand, i.reserved
--   FROM public.inventory i
--   JOIN public.products p ON p.id = i.product_id
--  WHERE p.product_type = 'exclusive'
--  ORDER BY p.name;
--
-- 기대값 (2026-05-20 베이스라인 기준):
--   현재 모든 발주가 box 단위라 reserved_pack=0, on_hand_pack=loose_pack_qty.
--
--   상품             quantity loose  on_hand reserved  on_hand_pack reserved_pack
--   고기국수육수       24       0      35       11        0           0
--   비빔전용장         0        0      0        0         0           0
--   생밀면             33       0      103      70        0           0
--   아삭한김치왕만두70 18       0      23       5         0           0
--   양념장             14       0      23       9         0           0
--   왕만두             50       0      91       41        0           0
--   육수간장           26       0      37       11        0           0
--
-- ============================================================
-- 롤백 (사고 시 — 백업 테이블에서 복구)
-- ============================================================
-- BEGIN;
--   -- 보정 이력 제거
--   DELETE FROM public.inventory_transactions WHERE description LIKE '[023 보정]%';
--
--   -- inventory 원복
--   UPDATE public.inventory inv
--      SET quantity       = b.quantity,
--          loose_pack_qty = b.loose_pack_qty,
--          updated_at     = b.updated_at
--     FROM backup_inventory_20260521 b
--    WHERE b.product_id = inv.product_id;
--
--   ALTER TABLE public.inventory
--     DROP CONSTRAINT IF EXISTS inventory_on_hand_nonneg,
--     DROP CONSTRAINT IF EXISTS inventory_on_hand_pack_nonneg,
--     DROP COLUMN     IF EXISTS on_hand,
--     DROP COLUMN     IF EXISTS reserved,
--     DROP COLUMN     IF EXISTS on_hand_pack,
--     DROP COLUMN     IF EXISTS reserved_pack;
--
--   ALTER TABLE public.order_items
--     DROP COLUMN IF EXISTS shipped_quantity,
--     DROP COLUMN IF EXISTS shipped_unit,
--     DROP COLUMN IF EXISTS shipment_memo,
--     DROP COLUMN IF EXISTS returned_quantity,
--     DROP COLUMN IF EXISTS returned_at,
--     DROP COLUMN IF EXISTS return_reason;
--
--   ALTER TABLE public.products
--     DROP COLUMN IF EXISTS allow_unit_change;
-- COMMIT;
-- ============================================================
