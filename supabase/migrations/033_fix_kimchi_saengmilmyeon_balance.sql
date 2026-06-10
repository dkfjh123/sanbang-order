-- ============================================================
-- 033_fix_kimchi_saengmilmyeon_balance.sql
-- 아삭한김치왕만두70 / 생밀면 재고 등식 정합 회복
-- ============================================================
-- 배경:
--   lost update(동시성 덮어쓰기)로 발주의 quantity 차감이 일부 유실되어
--   on_hand <> quantity + reserved 가 됨(2026-06-10 확인).
--     · 아삭한김치왕만두70: 주문가능 21·나갈것 1·총재고 21 (등식 -1)
--     · 생밀면:            주문가능 41·나갈것 45·총재고 81 (등식 -5)
--
-- 정정 정책 (신화 실물 카운트 불필요 — 장부로 닫힘):
--   · on_hand(총재고)는 입고/출고 트랜잭션 장부로 검증됨 → 그대로 유지(신뢰).
--   · reserved = 현재 미출고 발주(가맹점 pending+confirmed + B2B pending) 박스 합으로 재계산.
--   · quantity = on_hand - reserved.
--   기대 결과: 아삭 18/3/21, 생밀면 36/45/81 (정확한 값은 실행 시점 미출고로 재집계).
--
-- 순서: 점검 모드 ON(발주/출고 차단) 상태에서 실행해야 미출고 집계가 안정적.
--       032(RPC) + 6경로 코드 배포 후 → 본 보정 → 034(자물쇠) 순.
-- 멱등성: 이미 정합이면 변경 없이 NOTICE 만 출력. 재실행 안전.
-- 절대원칙: 본인이 Supabase SQL Editor 에서 직접 실행.
-- ============================================================

-- [백업] 트랜잭션 밖에서 먼저
CREATE TABLE IF NOT EXISTS backup_inventory_20260610
  AS SELECT * FROM public.inventory;

BEGIN;

DO $$
DECLARE
  r              RECORD;
  v_admin        UUID;
  v_new_reserved INT;
  v_new_quantity INT;
BEGIN
  SELECT id INTO v_admin
    FROM public.profiles
   WHERE email = 'dkfjh1234@gmail.com' AND role = 'admin'
   LIMIT 1;

  FOR r IN
    SELECT i.product_id, p.name, i.quantity, i.reserved, i.on_hand
      FROM public.inventory i
      JOIN public.products p ON p.id = i.product_id
     WHERE p.name IN ('생밀면', '아삭한김치왕만두70')
  LOOP
    -- 미출고 박스 재집계 (가맹점 pending+confirmed + B2B pending)
    SELECT
      COALESCE((
        SELECT SUM(oi.quantity)
          FROM public.order_items oi
          JOIN public.orders o ON o.id = oi.order_id
         WHERE oi.product_id = r.product_id
           AND oi.unit = 'box'
           AND o.status IN ('pending', 'confirmed')
      ), 0)
      +
      COALESCE((
        SELECT SUM(boi.quantity)
          FROM public.b2b_order_items boi
          JOIN public.b2b_orders bo ON bo.id = boi.order_id
         WHERE boi.product_id = r.product_id
           AND boi.unit = 'box'
           AND bo.status = 'pending'
      ), 0)
      INTO v_new_reserved;

    v_new_quantity := r.on_hand - v_new_reserved;

    IF v_new_quantity < 0 THEN
      RAISE EXCEPTION '% : on_hand(%) < 미출고(%) — 자동 보정 불가, 수동 점검 필요',
        r.name, r.on_hand, v_new_reserved;
    END IF;

    IF r.quantity = v_new_quantity AND r.reserved = v_new_reserved THEN
      RAISE NOTICE '% : 이미 정합 (quantity=% reserved=% on_hand=%) — 변경 없음',
        r.name, r.quantity, r.reserved, r.on_hand;
      CONTINUE;
    END IF;

    UPDATE public.inventory
       SET quantity   = v_new_quantity,
           reserved   = v_new_reserved,
           updated_at = NOW()
     WHERE product_id = r.product_id;

    INSERT INTO public.inventory_transactions
      (product_id, type, quantity, unit, description, created_by, source)
    VALUES
      (r.product_id, 'adjustment', v_new_quantity - r.quantity, 'box',
       '[20260610 정합보정] lost update 드리프트 정정 — on_hand ' || r.on_hand
         || ' 유지, reserved ' || r.reserved || '→' || v_new_reserved
         || ', quantity ' || r.quantity || '→' || v_new_quantity,
       v_admin, 'manual_adjust');

    RAISE NOTICE '% : quantity %→%, reserved %→% (on_hand % 유지)',
      r.name, r.quantity, v_new_quantity, r.reserved, v_new_reserved, r.on_hand;
  END LOOP;
END $$;

COMMIT;

-- ============================================================
-- 적용 후 검증 (별도 실행)
-- ============================================================
-- SELECT p.name, i.quantity, i.reserved, i.on_hand,
--        (i.on_hand = i.quantity + i.reserved) AS 등식ok
--   FROM public.inventory i JOIN public.products p ON p.id = i.product_id
--  WHERE p.name IN ('생밀면','아삭한김치왕만두70');
-- ============================================================
