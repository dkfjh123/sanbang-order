-- ============================================================
-- 034_inventory_balance_check.sql
-- 등식 자물쇠 — 재고 3분할 정합을 DB 차원에서 영구 강제
-- ============================================================
-- 목적:
--   on_hand = quantity + reserved          (박스)
--   on_hand_pack = loose_pack_qty + reserved_pack  (팩)
--   이 등식을 깨뜨리는 어떤 UPDATE/INSERT 도 트랜잭션 자체가 실패하도록 CHECK 제약 부여.
--   → lost update 가 만에 하나 다시 발생해도 "조용히 어긋난 채 저장"되는 일이 원천 불가.
--      (032 RPC + 6경로 행잠금이 1차 방어, 본 제약이 최종 안전망.)
--
-- 순서: 033 보정으로 모든 행이 등식을 만족하게 만든 "후" 적용해야 함.
--       (위반 행이 남아 있으면 ADD CONSTRAINT 가 거부됨 → 아래 사전검사로 명시적 안내.)
-- 멱등성: 제약이 이미 있으면 건너뜀. 재실행 안전.
-- 절대원칙: 본인이 Supabase SQL Editor 에서 직접 실행.
-- ============================================================

DO $$
DECLARE
  v_bad_box  INT;
  v_bad_pack INT;
BEGIN
  -- (1) 박스 등식 위반 사전검사
  SELECT COUNT(*) INTO v_bad_box
    FROM public.inventory
   WHERE quantity IS NOT NULL
     AND on_hand <> quantity + reserved;
  IF v_bad_box > 0 THEN
    RAISE EXCEPTION '박스 등식 위반 행 %건 — 033 보정 먼저 적용 필요(자물쇠 보류).', v_bad_box;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_box_balance') THEN
    ALTER TABLE public.inventory
      ADD CONSTRAINT inventory_box_balance
      CHECK (on_hand = quantity + reserved);
    RAISE NOTICE '박스 등식 자물쇠(inventory_box_balance) 추가됨.';
  ELSE
    RAISE NOTICE '박스 등식 자물쇠 이미 존재 — 건너뜀.';
  END IF;

  -- (2) 팩 등식 위반 사전검사
  SELECT COUNT(*) INTO v_bad_pack
    FROM public.inventory
   WHERE loose_pack_qty IS NOT NULL
     AND on_hand_pack <> loose_pack_qty + reserved_pack;
  IF v_bad_pack > 0 THEN
    RAISE EXCEPTION '팩 등식 위반 행 %건 — 점검 필요(자물쇠 보류).', v_bad_pack;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_pack_balance') THEN
    ALTER TABLE public.inventory
      ADD CONSTRAINT inventory_pack_balance
      CHECK (on_hand_pack = loose_pack_qty + reserved_pack);
    RAISE NOTICE '팩 등식 자물쇠(inventory_pack_balance) 추가됨.';
  ELSE
    RAISE NOTICE '팩 등식 자물쇠 이미 존재 — 건너뜀.';
  END IF;
END $$;

-- ============================================================
-- 롤백 (사고 시)
--   ALTER TABLE public.inventory DROP CONSTRAINT IF EXISTS inventory_box_balance;
--   ALTER TABLE public.inventory DROP CONSTRAINT IF EXISTS inventory_pack_balance;
-- ============================================================
