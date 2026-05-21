-- ============================================================
-- 026_reserved_zombie_cleanup_and_b2b_backfill.sql
-- 재고 정합성 회복 (옵션 B)
-- ============================================================
-- 배경:
--   023 적용 직후(2026-05-21 새벽) PR2 코드(reserved 차감) 배포 18분 전에
--   ORD-20260520-0082(대한상공회의소점)가 출고 처리됨 → ship API가 reserved/on_hand를
--   차감하지 못해 6개 전용상품에 22박스 좀비 잔존.
--   또한 B2B POST는 코드상 reserved를 안 건드리는 알려진 갭 → B2B pending이 reserved에 미반영.
--
-- 의도(옵션 B):
--   reserved      = (가맹점 pending+confirmed 박스) + (B2B pending 박스)
--   reserved_pack = (가맹점 pending+confirmed 팩)  + (B2B pending 팩)
--   on_hand       = quantity       + reserved
--   on_hand_pack  = loose_pack_qty + reserved_pack
--
--   quantity / loose_pack_qty 는 안 건드림 → 가맹점이 보는 매장주문가능 수치는 그대로.
--
-- 멱등성:
--   inventory_transactions description LIKE '[026 정합성]%' 존재하면 건너뜀.
--
-- 절대원칙:
--   본인이 Supabase SQL Editor 에서 직접 실행. AI 는 파일만 생성.
-- ============================================================

-- ----------------------------------------------------------------
-- [백업] 트랜잭션 밖
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS backup_inventory_20260521_v2
  AS SELECT * FROM public.inventory;

-- ----------------------------------------------------------------
-- 본 작업
-- ----------------------------------------------------------------
BEGIN;

DO $$
DECLARE
  v_admin_id UUID;
  v_tag CONSTANT TEXT := '[026 정합성]';
  r RECORD;
  v_new_reserved      INT;
  v_new_reserved_pack INT;
  v_new_on_hand       INT;
  v_new_on_hand_pack  INT;
  v_diff_reserved      INT;
  v_diff_reserved_pack INT;
BEGIN
  -- 멱등 가드
  IF EXISTS (
    SELECT 1 FROM public.inventory_transactions
     WHERE description LIKE v_tag || '%'
  ) THEN
    RAISE NOTICE '026 정합성 회복이 이미 적용되어 있어 건너뜁니다.';
    RETURN;
  END IF;

  -- 관리자
  SELECT id INTO v_admin_id
    FROM public.profiles
    WHERE email = 'dkfjh1234@gmail.com' AND role = 'admin'
    LIMIT 1;
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION '관리자(dkfjh1234@gmail.com) 프로필을 찾을 수 없습니다.';
  END IF;

  -- 전 전용상품 순회 — 정상값 계산 후 inventory + tx 갱신
  FOR r IN
    SELECT p.id AS product_id, p.name, i.quantity, i.loose_pack_qty,
           i.on_hand, i.reserved, i.on_hand_pack, i.reserved_pack
      FROM public.products p
      JOIN public.inventory i ON i.product_id = p.id
     WHERE p.product_type = 'exclusive'
  LOOP
    -- 정상값: 가맹점(pending+confirmed) + B2B(pending) 합산
    v_new_reserved := COALESCE((
        SELECT SUM(oi.quantity)
          FROM public.order_items oi
          JOIN public.orders o ON o.id = oi.order_id
         WHERE oi.product_id = r.product_id
           AND oi.unit       = 'box'
           AND o.status      IN ('pending', 'confirmed')
      ), 0)
      +
      COALESCE((
        SELECT SUM(boi.quantity)
          FROM public.b2b_order_items boi
          JOIN public.b2b_orders bo ON bo.id = boi.order_id
         WHERE boi.product_id = r.product_id
           AND boi.unit       = 'box'
           AND bo.status      = 'pending'
      ), 0);

    v_new_reserved_pack := COALESCE((
        SELECT SUM(oi.quantity)
          FROM public.order_items oi
          JOIN public.orders o ON o.id = oi.order_id
         WHERE oi.product_id = r.product_id
           AND oi.unit       = 'pack'
           AND o.status      IN ('pending', 'confirmed')
      ), 0)
      +
      COALESCE((
        SELECT SUM(boi.quantity)
          FROM public.b2b_order_items boi
          JOIN public.b2b_orders bo ON bo.id = boi.order_id
         WHERE boi.product_id = r.product_id
           AND boi.unit       = 'pack'
           AND bo.status      = 'pending'
      ), 0);

    v_new_on_hand      := r.quantity       + v_new_reserved;
    v_new_on_hand_pack := r.loose_pack_qty + v_new_reserved_pack;

    v_diff_reserved      := v_new_reserved      - r.reserved;
    v_diff_reserved_pack := v_new_reserved_pack - r.reserved_pack;

    -- 변경 없는 상품은 건너뜀
    IF v_diff_reserved = 0 AND v_diff_reserved_pack = 0 THEN
      RAISE NOTICE '  % | 변경 없음', r.name;
      CONTINUE;
    END IF;

    -- inventory 갱신
    UPDATE public.inventory
       SET reserved       = v_new_reserved,
           reserved_pack  = v_new_reserved_pack,
           on_hand        = v_new_on_hand,
           on_hand_pack   = v_new_on_hand_pack,
           updated_at     = NOW()
     WHERE product_id = r.product_id;

    -- 추적용 inventory_transactions (quantity=0 → 정산 합산 영향 없음)
    IF v_diff_reserved <> 0 THEN
      INSERT INTO public.inventory_transactions
        (product_id, type, quantity, unit, description, created_by, created_at)
      VALUES
        (r.product_id, 'adjustment', 0, 'box',
         v_tag || ' reserved ' || r.reserved || '→' || v_new_reserved
                || ' (diff=' || v_diff_reserved
                || '), on_hand ' || r.on_hand || '→' || v_new_on_hand
                || ' — ORD-0082 좀비 정리 + B2B reserved 백필',
         v_admin_id, NOW());
    END IF;

    IF v_diff_reserved_pack <> 0 THEN
      INSERT INTO public.inventory_transactions
        (product_id, type, quantity, unit, description, created_by, created_at)
      VALUES
        (r.product_id, 'adjustment', 0, 'pack',
         v_tag || ' reserved_pack ' || r.reserved_pack || '→' || v_new_reserved_pack
                || ' (diff=' || v_diff_reserved_pack
                || '), on_hand_pack ' || r.on_hand_pack || '→' || v_new_on_hand_pack
                || ' — B2B reserved_pack 백필',
         v_admin_id, NOW());
    END IF;

    RAISE NOTICE '  % | reserved %→%, reserved_pack %→%, on_hand %→%, on_hand_pack %→%',
      r.name,
      r.reserved, v_new_reserved,
      r.reserved_pack, v_new_reserved_pack,
      r.on_hand, v_new_on_hand,
      r.on_hand_pack, v_new_on_hand_pack;
  END LOOP;

  RAISE NOTICE '026 정합성 회복 완료';
END $$;

-- 적용 직후 검증 출력
DO $$
DECLARE
  r RECORD;
  v_store_box  INT;
  v_store_pack INT;
  v_b2b_box    INT;
  v_b2b_pack   INT;
  v_expected_reserved      INT;
  v_expected_reserved_pack INT;
  v_box_ok BOOLEAN;
  v_pack_ok BOOLEAN;
  v_eq_ok   BOOLEAN;
BEGIN
  RAISE NOTICE '== 적용 후 정합성 검증 ==';
  FOR r IN
    SELECT p.id AS pid, p.name, i.quantity, i.loose_pack_qty,
           i.on_hand, i.reserved, i.on_hand_pack, i.reserved_pack
      FROM public.inventory i
      JOIN public.products p ON p.id = i.product_id
     WHERE p.product_type = 'exclusive'
     ORDER BY p.name
  LOOP
    SELECT COALESCE(SUM(oi.quantity), 0) INTO v_store_box
      FROM public.order_items oi
      JOIN public.orders o ON o.id = oi.order_id
     WHERE oi.product_id = r.pid AND oi.unit = 'box'
       AND o.status IN ('pending', 'confirmed');
    SELECT COALESCE(SUM(oi.quantity), 0) INTO v_store_pack
      FROM public.order_items oi
      JOIN public.orders o ON o.id = oi.order_id
     WHERE oi.product_id = r.pid AND oi.unit = 'pack'
       AND o.status IN ('pending', 'confirmed');
    SELECT COALESCE(SUM(boi.quantity), 0) INTO v_b2b_box
      FROM public.b2b_order_items boi
      JOIN public.b2b_orders bo ON bo.id = boi.order_id
     WHERE boi.product_id = r.pid AND boi.unit = 'box'
       AND bo.status = 'pending';
    SELECT COALESCE(SUM(boi.quantity), 0) INTO v_b2b_pack
      FROM public.b2b_order_items boi
      JOIN public.b2b_orders bo ON bo.id = boi.order_id
     WHERE boi.product_id = r.pid AND boi.unit = 'pack'
       AND bo.status = 'pending';

    v_expected_reserved      := v_store_box  + v_b2b_box;
    v_expected_reserved_pack := v_store_pack + v_b2b_pack;

    v_box_ok  := r.reserved      = v_expected_reserved;
    v_pack_ok := r.reserved_pack = v_expected_reserved_pack;
    v_eq_ok   := (r.on_hand = r.quantity + r.reserved)
             AND (r.on_hand_pack = r.loose_pack_qty + r.reserved_pack);

    RAISE NOTICE '  % | reserved=% (기대 %) % | reserved_pack=% (기대 %) % | 등식 %',
      r.name,
      r.reserved, v_expected_reserved, CASE WHEN v_box_ok THEN '✓' ELSE '✗' END,
      r.reserved_pack, v_expected_reserved_pack, CASE WHEN v_pack_ok THEN '✓' ELSE '✗' END,
      CASE WHEN v_eq_ok THEN '✓' ELSE '✗' END;
  END LOOP;
END $$;

COMMIT;

-- ============================================================
-- 롤백 (사고 시 — 백업 테이블에서 복구)
-- ============================================================
-- BEGIN;
--   DELETE FROM public.inventory_transactions WHERE description LIKE '[026 정합성]%';
--   UPDATE public.inventory inv
--      SET reserved       = b.reserved,
--          reserved_pack  = b.reserved_pack,
--          on_hand        = b.on_hand,
--          on_hand_pack   = b.on_hand_pack,
--          updated_at     = b.updated_at
--     FROM backup_inventory_20260521_v2 b
--    WHERE b.product_id = inv.product_id;
-- COMMIT;
-- ============================================================
