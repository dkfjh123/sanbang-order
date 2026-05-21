-- ============================================================
-- 028_inventory_real_stock_alignment.sql
-- inventory 를 신화 실재고 기준으로 강제 정합
-- ============================================================
-- 배경:
--   023 백필이 quantity 안 건드린 채 reserved 에 (가맹점+B2B) 미출고를 합산했음.
--   결과: on_hand = quantity + reserved 가 실재고보다 B2B 미출고 박스 환산만큼 부풀음.
--   026/027 이 그 위에 더 가산하여 차이가 누적됨.
--   사용자 직접 확인한 실재고로 강제 정합 (PR3 의 옵션 A 정책 = 가맹점 패턴):
--     on_hand  = 신화 실재고
--     quantity = on_hand - reserved   (가맹점 발주 가능 = 실재고에서 미출고 약속 분 제외)
--     reserved = 그대로 (가맹점 미출고 + B2B 미출고 박스 환산, 이미 정합)
--
-- 사용자 합의 실재고 (2026-05-21):
--   고기국수육수            24박스  (시스템 24 — 변경 없음)
--   비빔전용장              5박스   (시스템 8  → -3, B2B 환산 영향)
--   생밀면                  38박스  (시스템 53 → -15, B2B 환산 영향)
--   아삭한김치왕만두70      20박스  (시스템 27 → -7, B2B 환산 영향)
--   왕만두                  54박스  (시스템 68 → -14, B2B 환산 영향)
--   육수간장                26박스  (시스템 28 → -2, B2B 환산 영향)
--
--   ※ 양념장 (시스템 29 → 실재고 15, 14박스 차이) 은 028 에서 제외.
--     이 차이는 B2B 미출고와 무관한 별도 원인 — 5/22 이후 별도 추적/보정.
--
-- 멱등성: [028 실재고] 태그 검사
-- 절대원칙: 본인이 Supabase SQL Editor 에서 직접 실행. AI 는 파일만 생성.
-- ============================================================

CREATE TABLE IF NOT EXISTS backup_inventory_20260521_v4
  AS SELECT * FROM public.inventory;

BEGIN;

DO $$
DECLARE
  v_admin_id UUID;
  v_tag CONSTANT TEXT := '[028 실재고]';
  r RECORD;
  v_target_on_hand INT;
  v_new_quantity   INT;
  v_diff_on_hand   INT;
  v_diff_quantity  INT;
BEGIN
  -- 멱등 가드
  IF EXISTS (
    SELECT 1 FROM public.inventory_transactions
     WHERE description LIKE v_tag || '%'
  ) THEN
    RAISE NOTICE '028 실재고 정합이 이미 적용되어 있어 건너뜁니다.';
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

  -- 각 전용상품 처리
  FOR r IN
    SELECT p.id AS pid, p.name, i.quantity, i.reserved, i.on_hand
      FROM public.products p
      JOIN public.inventory i ON i.product_id = p.id
     WHERE p.product_type = 'exclusive'
  LOOP
    -- 사용자 합의 실재고 매핑 (양념장 제외 — B2B 무관 별도 원인, 5/22 이후 추적)
    v_target_on_hand := CASE r.name
      WHEN '고기국수육수'         THEN 24
      WHEN '비빔전용장'           THEN 5
      WHEN '생밀면'               THEN 38
      WHEN '아삭한김치왕만두70'   THEN 20
      WHEN '왕만두'               THEN 54
      WHEN '육수간장'             THEN 26
      -- '양념장' 의도적 제외
      ELSE NULL
    END;

    IF v_target_on_hand IS NULL THEN
      RAISE NOTICE '  % | 매핑 없음 / 의도적 제외, 건너뜀', r.name;
      CONTINUE;
    END IF;

    -- 사전 안전 검증: quantity 가 음수가 되면 안 됨
    IF v_target_on_hand < r.reserved THEN
      RAISE EXCEPTION '% : 목표 on_hand=% < reserved=% — quantity 음수가 됨. 데이터 재확인 필요',
        r.name, v_target_on_hand, r.reserved;
    END IF;

    v_new_quantity   := v_target_on_hand - r.reserved;
    v_diff_on_hand   := v_target_on_hand - r.on_hand;
    v_diff_quantity  := v_new_quantity - r.quantity;

    IF v_diff_on_hand = 0 AND v_diff_quantity = 0 THEN
      RAISE NOTICE '  % | 변경 없음 (이미 일치)', r.name;
      CONTINUE;
    END IF;

    UPDATE public.inventory
       SET on_hand    = v_target_on_hand,
           quantity   = v_new_quantity,
           updated_at = NOW()
     WHERE product_id = r.pid;

    INSERT INTO public.inventory_transactions
      (product_id, type, quantity, unit, description, created_by, created_at)
    VALUES
      (r.pid, 'adjustment', 0, 'box',
       v_tag || ' ' || r.name
              || ' | on_hand ' || r.on_hand || '→' || v_target_on_hand
              || ' (diff=' || v_diff_on_hand || ')'
              || ', quantity ' || r.quantity || '→' || v_new_quantity
              || ' (diff=' || v_diff_quantity || ')'
              || '. 신화 실재고 기준 강제 정합.',
       v_admin_id, NOW());

    RAISE NOTICE '  % | on_hand %→% (%), quantity %→% (%)',
      r.name,
      r.on_hand, v_target_on_hand, v_diff_on_hand,
      r.quantity, v_new_quantity, v_diff_quantity;
  END LOOP;

  RAISE NOTICE '028 실재고 정합 완료';
END $$;

-- 적용 후 검증
DO $$
DECLARE
  r RECORD;
  v_eq_box BOOLEAN;
BEGIN
  RAISE NOTICE '== 적용 후 검증 (전 전용상품) ==';
  FOR r IN
    SELECT p.name, i.quantity, i.loose_pack_qty, i.on_hand, i.reserved, i.on_hand_pack, i.reserved_pack
      FROM public.inventory i
      JOIN public.products p ON p.id = i.product_id
     WHERE p.product_type = 'exclusive'
     ORDER BY p.name
  LOOP
    v_eq_box := r.on_hand = r.quantity + r.reserved;
    RAISE NOTICE '  % | quantity=% reserved=% on_hand=% | 등식 % | (팩) loose=% reserved_pack=% on_hand_pack=%',
      r.name,
      r.quantity, r.reserved, r.on_hand, CASE WHEN v_eq_box THEN '✓' ELSE '✗' END,
      r.loose_pack_qty, r.reserved_pack, r.on_hand_pack;
  END LOOP;
END $$;

COMMIT;

-- ============================================================
-- 롤백
-- ============================================================
-- BEGIN;
--   DELETE FROM public.inventory_transactions WHERE description LIKE '[028 실재고]%';
--   UPDATE public.inventory inv
--      SET quantity   = b.quantity,
--          on_hand    = b.on_hand,
--          updated_at = b.updated_at
--     FROM backup_inventory_20260521_v4 b
--    WHERE b.product_id = inv.product_id;
-- COMMIT;
-- ============================================================
