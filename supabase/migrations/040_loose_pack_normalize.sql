-- ============================================================
-- 040_loose_pack_normalize.sql
-- 낱팩이 한 박스 분량 이상 쌓이면 박스로 자동 환산
-- ============================================================
-- ■ 배경
--   B2B 팩 출고는 CEIL(주문팩수 / 박스입수)만큼 박스를 헐고 자투리를 낱팩으로 넘긴다.
--   그런데 "이미 있던 낱팩을 먼저 쓰는" 처리가 없어 낱팩이 계속 쌓였다.
--
--   2026-08-07 08:30 신화 실물 카운트와 대조하면 차이가 정확히 드러난다
--   (총 수량은 전 상품 일치. 박스/낱팩 구분만 다름):
--     비빔전용장(1박스=5팩) : 시스템 19박스+14팩  vs  신화 21박스+4팩
--     육수간장  (1박스=3팩) : 시스템 37박스+ 8팩  vs  신화 39박스+2팩
--   → 신화는 이미 "5팩 모이면 1박스"로 세고 있다. 시스템만 안 하고 있었다.
--
-- ■ 무엇을 만드나
--   (1) normalize_loose_packs(product_id) : 낱팩 >= 박스입수 이면 박스로 환산
--       - B2B 팩 출고 직후 호출한다. 그러면 낱팩은 수학적으로 절대 박스입수를 못 넘는다.
--   (2) ensure_loose_packs(product_id, need) : 낱팩이 need 보다 적으면 박스를 헐어 채운다
--       - (1)의 거울. B2B 출고취소(반품) 때 되돌릴 낱팩이 모자란 경우를 막는다.
--   (3) 지금 쌓여 있는 낱팩 일회성 정리 (전 전용상품 대상)
--
-- ■ 총 수량은 변하지 않는다
--   박스↔낱팩 사이의 '표현'만 바꾼다. on_hand*입수 + on_hand_pack 은 그대로.
--   그래서 재고 가치·정산·역산에 영향이 없다.
--
-- ■ 등식 유지
--   on_hand = quantity + reserved            → 양쪽에 같은 값을 더하므로 유지
--   on_hand_pack = loose_pack_qty + reserved_pack → 양쪽에서 같은 값을 빼므로 유지
--   (034 CHECK 제약을 위반하지 않는다)
--
-- ■ 예약분은 건드리지 않는다
--   환산은 '주문가능 낱팩(loose_pack_qty)' 안에서만 한다.
--   이미 나갈 예정인 예약 낱팩(reserved_pack)은 그대로 둔다.
--
-- ■ 멱등성: 함수는 CREATE OR REPLACE. 일회성 정리는 [040 낱팩정리] 태그로 1회만.
-- ■ 절대원칙: 본인이 Supabase SQL Editor 에서 직접 실행. AI 는 파일만 생성.
-- ============================================================

-- ------------------------------------------------------------
-- (1) 낱팩 → 박스 환산
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.normalize_loose_packs(
  p_product_id UUID,
  p_actor      UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ppb   INT;
  v_inv   public.inventory%ROWTYPE;
  v_conv  INT;
BEGIN
  IF p_product_id IS NULL THEN
    RETURN jsonb_build_object('success', FALSE, 'reason', 'no_product');
  END IF;

  SELECT pack_per_box INTO v_ppb FROM public.products WHERE id = p_product_id;
  IF v_ppb IS NULL OR v_ppb <= 1 THEN
    RETURN jsonb_build_object('success', TRUE, 'converted', 0, 'reason', 'no_pack_split');
  END IF;

  -- 행잠금 — 동시 발주/출고와 직렬화
  SELECT * INTO v_inv FROM public.inventory WHERE product_id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', TRUE, 'converted', 0, 'reason', 'no_inventory_row');
  END IF;

  v_conv := FLOOR(COALESCE(v_inv.loose_pack_qty, 0)::NUMERIC / v_ppb)::INT;
  IF v_conv <= 0 THEN
    RETURN jsonb_build_object('success', TRUE, 'converted', 0);
  END IF;

  UPDATE public.inventory
     SET quantity       = quantity       + v_conv,
         on_hand        = on_hand        + v_conv,
         loose_pack_qty = loose_pack_qty - v_conv * v_ppb,
         on_hand_pack   = on_hand_pack   - v_conv * v_ppb,
         updated_at     = NOW()
   WHERE product_id = p_product_id;

  INSERT INTO public.inventory_transactions
    (product_id, type, quantity, unit, description, created_by, source)
  VALUES
    (p_product_id, 'adjustment', v_conv, 'box',
     '[낱팩환산] 낱팩 ' || (v_conv * v_ppb) || '팩 → ' || v_conv || '박스 (1박스=' || v_ppb || '팩). '
       || '낱팩 ' || v_inv.loose_pack_qty || '→' || (v_inv.loose_pack_qty - v_conv * v_ppb)
       || ', 박스 ' || v_inv.on_hand || '→' || (v_inv.on_hand + v_conv)
       || '. 총 수량 변화 없음.',
     p_actor, 'manual_adjust');

  RETURN jsonb_build_object('success', TRUE, 'converted', v_conv, 'pack_per_box', v_ppb);
END $$;

-- ------------------------------------------------------------
-- (2) 박스 → 낱팩 (환산의 거울). 되돌릴 낱팩이 모자랄 때만 쓴다.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ensure_loose_packs(
  p_product_id UUID,
  p_need       INT,
  p_actor      UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ppb    INT;
  v_inv    public.inventory%ROWTYPE;
  v_short  INT;
  v_break  INT;
BEGIN
  IF p_product_id IS NULL OR COALESCE(p_need, 0) <= 0 THEN
    RETURN jsonb_build_object('success', TRUE, 'broken', 0);
  END IF;

  SELECT pack_per_box INTO v_ppb FROM public.products WHERE id = p_product_id;
  IF v_ppb IS NULL OR v_ppb <= 1 THEN
    RETURN jsonb_build_object('success', TRUE, 'broken', 0, 'reason', 'no_pack_split');
  END IF;

  SELECT * INTO v_inv FROM public.inventory WHERE product_id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', TRUE, 'broken', 0, 'reason', 'no_inventory_row');
  END IF;

  v_short := p_need - COALESCE(v_inv.loose_pack_qty, 0);
  IF v_short <= 0 THEN
    RETURN jsonb_build_object('success', TRUE, 'broken', 0);
  END IF;

  v_break := CEIL(v_short::NUMERIC / v_ppb)::INT;
  IF COALESCE(v_inv.quantity, 0) < v_break THEN
    RAISE EXCEPTION '낱팩 % 개를 만들려면 박스 % 개를 헐어야 하는데 주문가능 박스가 % 개뿐입니다.',
      p_need, v_break, v_inv.quantity;
  END IF;

  UPDATE public.inventory
     SET quantity       = quantity       - v_break,
         on_hand        = on_hand        - v_break,
         loose_pack_qty = loose_pack_qty + v_break * v_ppb,
         on_hand_pack   = on_hand_pack   + v_break * v_ppb,
         updated_at     = NOW()
   WHERE product_id = p_product_id;

  INSERT INTO public.inventory_transactions
    (product_id, type, quantity, unit, description, created_by, source)
  VALUES
    (p_product_id, 'adjustment', -v_break, 'box',
     '[박스분해] ' || v_break || '박스 → 낱팩 ' || (v_break * v_ppb) || '팩 (1박스=' || v_ppb || '팩). '
       || '반품 자투리 회수를 위해 분해. 총 수량 변화 없음.',
     p_actor, 'manual_adjust');

  RETURN jsonb_build_object('success', TRUE, 'broken', v_break, 'pack_per_box', v_ppb);
END $$;

-- ------------------------------------------------------------
-- 권한: 서버(service_role)만 호출
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.normalize_loose_packs(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.normalize_loose_packs(UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.normalize_loose_packs(UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.normalize_loose_packs(UUID, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.ensure_loose_packs(UUID, INT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ensure_loose_packs(UUID, INT, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.ensure_loose_packs(UUID, INT, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_loose_packs(UUID, INT, UUID) TO service_role;

-- ------------------------------------------------------------
-- (3) 지금 쌓여 있는 낱팩 일회성 정리
--     기대 결과 (2026-08-07 11:40 기준, 신화 실물 카운트와 일치):
--       비빔전용장 : 19박스+14팩 → 21박스+4팩
--       육수간장   : 37박스+ 8팩 → 39박스+2팩
--     ※ 그 사이 발주/출고가 있었으면 숫자는 달라질 수 있지만
--       "낱팩을 박스입수로 나눠 떨어지는 만큼 박스로 옮긴다"는 동작은 동일하다.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS backup_inventory_20260807_v2
  AS SELECT * FROM public.inventory;

BEGIN;

DO $$
DECLARE
  v_tag CONSTANT TEXT := '[040 낱팩정리]';
  v_admin UUID;
  r       RECORD;
  v_res   JSONB;
  v_total INT := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM public.inventory_transactions WHERE description LIKE v_tag || '%') THEN
    RAISE NOTICE '040 낱팩 일회성 정리가 이미 적용되어 있습니다 — 건너뜁니다.';
    RETURN;
  END IF;

  SELECT id INTO v_admin
    FROM public.profiles WHERE email = 'dkfjh1234@gmail.com' AND role = 'admin' LIMIT 1;

  FOR r IN
    SELECT p.id, p.name, p.pack_per_box, i.loose_pack_qty, i.on_hand
      FROM public.products p
      JOIN public.inventory i ON i.product_id = p.id
     WHERE p.product_type = 'exclusive'
       AND p.pack_per_box > 1
       AND i.loose_pack_qty >= p.pack_per_box
     ORDER BY p.name
  LOOP
    v_res := public.normalize_loose_packs(r.id, v_admin);
    v_total := v_total + COALESCE((v_res ->> 'converted')::INT, 0);
    RAISE NOTICE '  % : 낱팩 % 개 → % 박스 환산', r.name, r.loose_pack_qty, (v_res ->> 'converted');
  END LOOP;

  -- 정리 흔적 (멱등 가드용)
  INSERT INTO public.inventory_transactions
    (product_id, type, quantity, unit, description, created_by, source)
  SELECT p.id, 'adjustment', 0, 'box',
         v_tag || ' 낱팩 일회성 정리 실행 — 총 ' || v_total || '박스 환산. '
           || '근거: 2026-08-07 08:30 신화 실물 카운트(비빔 21박스4팩 / 육수 39박스2팩)와 구분 일치시킴.',
         v_admin, 'manual_adjust'
    FROM public.products p
   WHERE p.name = '비빔전용장'
   LIMIT 1;

  RAISE NOTICE '040 낱팩 일회성 정리 완료 — 총 % 박스 환산', v_total;
END $$;

COMMIT;

-- ============================================================
-- 적용 후 확인 (따로 실행)
-- ============================================================
-- SELECT p.name, p.pack_per_box AS 입수,
--        i.on_hand AS 총재고, i.quantity AS 주문가능,
--        i.on_hand_pack AS 낱팩총, i.loose_pack_qty AS 낱팩가능,
--        (i.on_hand = i.quantity + i.reserved) AS 박스등식,
--        (i.on_hand_pack = i.loose_pack_qty + i.reserved_pack) AS 팩등식
--   FROM public.inventory i JOIN public.products p ON p.id = i.product_id
--  WHERE p.product_type = 'exclusive' ORDER BY p.name;
--
-- 기대: 비빔전용장 21박스/낱팩 4, 육수간장 39박스/낱팩 2, 등식 모두 true
-- ============================================================

-- ============================================================
-- 롤백 (사고 시)
-- ============================================================
-- BEGIN;
--   UPDATE public.inventory inv
--      SET quantity = b.quantity, on_hand = b.on_hand,
--          loose_pack_qty = b.loose_pack_qty, on_hand_pack = b.on_hand_pack,
--          updated_at = NOW()
--     FROM backup_inventory_20260807_v2 b
--    WHERE b.product_id = inv.product_id;
--   DELETE FROM public.inventory_transactions
--    WHERE description LIKE '[040 낱팩정리]%' OR description LIKE '[낱팩환산]%';
-- COMMIT;
-- -- 함수까지 되돌리려면:
-- -- DROP FUNCTION IF EXISTS public.normalize_loose_packs(UUID, UUID);
-- -- DROP FUNCTION IF EXISTS public.ensure_loose_packs(UUID, INT, UUID);
-- ============================================================
