-- ============================================================
-- 027_bibim_pack_to_box_conversion.sql
-- 비빔전용장 reserved_pack(3) → reserved(+1 환산 박스) 이동
-- ============================================================
-- 배경:
--   026이 옵션B 백필로 비빔전용장 reserved_pack=3, on_hand_pack=3 을 잡았는데,
--   PR3 단순화 옵션(박스 중심 운영)에서는 B2B 팩 발주를 박스 환산으로 reserved에 합산함.
--   즉 B-008의 비빔전용장 3팩은 CEIL(3/5)=1박스로 환산되어 reserved 에 들어가야 함.
--
-- 의도(단순화 옵션):
--   "팩 분해는 B2B 팩 SHIP 시점에만 발생"
--   따라서 5/22 ship 전까지 reserved_pack 에 잡혀있을 이유 없음 (박스 환산이 정답).
--
-- 변경 대상: 비빔전용장 1줄
--   reserved      2 → 3 (+1 환산 박스)
--   reserved_pack 3 → 0
--   on_hand       7 → 8 (+1, 등식 유지)
--   on_hand_pack  3 → 0
--   quantity, loose_pack_qty: 그대로
--
-- 멱등성:
--   inventory_transactions description LIKE '[027 환산]%' 존재하면 건너뜀.
--
-- 절대원칙:
--   본인이 Supabase SQL Editor 에서 직접 실행. AI 는 파일만 생성.
-- ============================================================

-- ----------------------------------------------------------------
-- [백업] 트랜잭션 밖
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS backup_inventory_20260521_v3
  AS SELECT * FROM public.inventory;

-- ----------------------------------------------------------------
-- 본 작업
-- ----------------------------------------------------------------
BEGIN;

DO $$
DECLARE
  v_admin_id UUID;
  v_bibim_id UUID;
  v_tag CONSTANT TEXT := '[027 환산]';
  v_pack_qty INT := 3;       -- B-008 비빔전용장 팩 발주 수량
  v_pack_per_box INT;
  v_conv_box INT;
  v_inv RECORD;
BEGIN
  -- 멱등 가드
  IF EXISTS (
    SELECT 1 FROM public.inventory_transactions
     WHERE description LIKE v_tag || '%'
  ) THEN
    RAISE NOTICE '027 환산이 이미 적용되어 있어 건너뜁니다.';
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

  -- 비빔전용장
  SELECT id, pack_per_box INTO v_bibim_id, v_pack_per_box
    FROM public.products
   WHERE name = '비빔전용장'
   LIMIT 1;
  IF v_bibim_id IS NULL THEN
    RAISE EXCEPTION '비빔전용장 상품을 찾을 수 없습니다.';
  END IF;

  v_conv_box := CEIL(v_pack_qty::NUMERIC / v_pack_per_box)::INT;  -- 1

  -- 현재 값 조회
  SELECT * INTO v_inv FROM public.inventory WHERE product_id = v_bibim_id;
  RAISE NOTICE '환산 전 비빔전용장: quantity=%, loose=%, on_hand=%, reserved=%, on_hand_pack=%, reserved_pack=%',
    v_inv.quantity, v_inv.loose_pack_qty, v_inv.on_hand, v_inv.reserved,
    v_inv.on_hand_pack, v_inv.reserved_pack;

  -- 사전 조건 확인 — 026 직후 상태와 일치하는지
  IF v_inv.reserved_pack <> v_pack_qty THEN
    RAISE EXCEPTION '예상치 못한 상태: reserved_pack=% (기대 %)', v_inv.reserved_pack, v_pack_qty;
  END IF;
  IF v_inv.on_hand_pack <> v_pack_qty THEN
    RAISE EXCEPTION '예상치 못한 상태: on_hand_pack=% (기대 %)', v_inv.on_hand_pack, v_pack_qty;
  END IF;

  -- inventory 갱신: 팩 칸에서 박스 칸으로 환산 이동
  UPDATE public.inventory
     SET reserved      = reserved      + v_conv_box,    -- 2 → 3
         on_hand       = on_hand       + v_conv_box,    -- 7 → 8
         reserved_pack = 0,                              -- 3 → 0
         on_hand_pack  = 0,                              -- 3 → 0
         updated_at    = NOW()
   WHERE product_id = v_bibim_id;

  -- 추적 row 두 개 (box +환산, pack -3)
  INSERT INTO public.inventory_transactions
    (product_id, type, quantity, unit, description, created_by, created_at)
  VALUES
    (v_bibim_id, 'adjustment', 0, 'box',
     v_tag || ' reserved 2→3, on_hand 7→8 (+' || v_conv_box || ' 환산박스). '
            || 'B-008 비빔전용장 ' || v_pack_qty || '팩 → CEIL(' || v_pack_qty || '/' || v_pack_per_box
            || ')=' || v_conv_box || ' 박스로 환산. 단순화 옵션 정책 반영.',
     v_admin_id, NOW()),
    (v_bibim_id, 'adjustment', 0, 'pack',
     v_tag || ' reserved_pack ' || v_pack_qty || '→0, on_hand_pack ' || v_pack_qty || '→0. '
            || '팩 칸은 자투리 전용으로 운영 (박스 분해는 B2B 팩 SHIP 시점에만).',
     v_admin_id, NOW());

  -- 적용 후 값 출력
  SELECT * INTO v_inv FROM public.inventory WHERE product_id = v_bibim_id;
  RAISE NOTICE '환산 후 비빔전용장: quantity=%, loose=%, on_hand=%, reserved=%, on_hand_pack=%, reserved_pack=%',
    v_inv.quantity, v_inv.loose_pack_qty, v_inv.on_hand, v_inv.reserved,
    v_inv.on_hand_pack, v_inv.reserved_pack;

  RAISE NOTICE '027 환산 완료';
END $$;

-- 적용 직후 정합성 검증
DO $$
DECLARE
  r RECORD;
  v_eq_box  BOOLEAN;
  v_eq_pack BOOLEAN;
BEGIN
  RAISE NOTICE '== 적용 후 등식 검증 (비빔전용장 포함 전 전용상품) ==';
  FOR r IN
    SELECT p.name, i.quantity, i.loose_pack_qty, i.on_hand, i.reserved, i.on_hand_pack, i.reserved_pack
      FROM public.inventory i
      JOIN public.products p ON p.id = i.product_id
     WHERE p.product_type = 'exclusive'
     ORDER BY p.name
  LOOP
    v_eq_box  := r.on_hand      = r.quantity       + r.reserved;
    v_eq_pack := r.on_hand_pack = r.loose_pack_qty + r.reserved_pack;
    RAISE NOTICE '  % | quantity=% reserved=% on_hand=% % | loose=% reserved_pack=% on_hand_pack=% %',
      r.name,
      r.quantity, r.reserved, r.on_hand, CASE WHEN v_eq_box THEN '✓' ELSE '✗' END,
      r.loose_pack_qty, r.reserved_pack, r.on_hand_pack, CASE WHEN v_eq_pack THEN '✓' ELSE '✗' END;
  END LOOP;
END $$;

COMMIT;

-- ============================================================
-- 롤백 (사고 시)
-- ============================================================
-- BEGIN;
--   DELETE FROM public.inventory_transactions WHERE description LIKE '[027 환산]%';
--   UPDATE public.inventory inv
--      SET reserved       = b.reserved,
--          reserved_pack  = b.reserved_pack,
--          on_hand        = b.on_hand,
--          on_hand_pack   = b.on_hand_pack,
--          updated_at     = b.updated_at
--     FROM backup_inventory_20260521_v3 b
--    WHERE b.product_id = inv.product_id;
-- COMMIT;
-- ============================================================
