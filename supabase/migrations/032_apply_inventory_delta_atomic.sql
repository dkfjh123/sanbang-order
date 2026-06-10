-- ============================================================
-- 032_apply_inventory_delta_atomic.sql
-- 공용 원자 재고 증감 RPC — lost update(동시성 덮어쓰기) 근본 차단
-- ============================================================
-- 배경:
--   가맹점 발주생성/취소/출고, B2B 발주/출고/취소/삭제, 입출고 조정 등
--   재고를 바꾸는 6개 경로가 모두 "SELECT 로 읽고 → 앱에서 계산 → UPDATE 로 통째 덮어쓰기"
--   (read-modify-write) 패턴이라, 같은 상품에 동시 요청이 겹치면 한쪽 갱신이 유실됨.
--   → 실제로 아삭한김치왕만두70/생밀면에서 quantity 드리프트 발생(2026-06 확인).
--
--   유일하게 발주 "수정"(029 update_store_order_items_atomic)만 SELECT ... FOR UPDATE
--   행잠금을 써서 안전했음. 그 패턴을 공용 함수로 추출해 나머지 경로도 똑같이 보호한다.
--
-- 동작:
--   1) 대상 inventory 행을 FOR UPDATE 로 잠근다(다른 트랜잭션은 잠금 해제까지 대기 → 덮어쓰기 불가).
--   2) 현재 DB 값 기준으로 각 칸에 델타를 더한다(앱이 읽은 stale 값이 아니라 잠근 직후의 실제 값).
--   3) 어떤 칸이든 음수가 되면 RAISE EXCEPTION(재고 부족/정합 위반) → 트랜잭션 롤백.
--   4) 한 번의 UPDATE 로 반영하고, 필요 시 inventory_transactions 한 줄 기록.
--
-- 등식(on_hand = quantity + reserved)은 "호출부가 등식을 유지하는 델타를 넘기는 것"으로 보장하고,
-- 034 의 CHECK 제약이 최종 안전망으로 위반 자체를 거부한다.
--
-- 멱등성: CREATE OR REPLACE FUNCTION (재실행 안전). 데이터 변경 없음(함수 정의만).
-- 절대원칙: 본인이 Supabase SQL Editor 에서 직접 실행. AI 는 파일만 생성.
-- ============================================================

CREATE OR REPLACE FUNCTION public.apply_inventory_delta(
  p_product_id       UUID,
  p_d_quantity       INT     DEFAULT 0,   -- 주문가능(박스) 증감
  p_d_reserved       INT     DEFAULT 0,   -- 나갈것(박스) 증감
  p_d_on_hand        INT     DEFAULT 0,   -- 총재고(박스) 증감
  p_d_loose_pack     INT     DEFAULT 0,   -- 주문가능(팩) 증감
  p_d_reserved_pack  INT     DEFAULT 0,   -- 나갈것(팩) 증감
  p_d_on_hand_pack   INT     DEFAULT 0,   -- 총재고(팩) 증감
  p_tx_type          TEXT    DEFAULT NULL,-- 'inbound'|'outbound'|'adjustment'|NULL(=기록 안 함)
  p_tx_unit          TEXT    DEFAULT 'box',
  p_tx_quantity      INT     DEFAULT NULL,-- 트랜잭션에 남길 수량(부호 포함). NULL 이면 0.
  p_tx_description   TEXT    DEFAULT NULL,
  p_tx_source        TEXT    DEFAULT NULL,-- 'manual_inbound'|'manual_adjust'|NULL
  p_actor            UUID    DEFAULT NULL,
  p_require_exist    BOOLEAN DEFAULT TRUE -- 재고행 없으면: TRUE=에러, FALSE=조용히 스킵
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv   public.inventory%ROWTYPE;
  v_nq    INT;
  v_nr    INT;
  v_noh   INT;
  v_nlp   INT;
  v_nrp   INT;
  v_nohp  INT;
BEGIN
  IF p_product_id IS NULL THEN
    RAISE EXCEPTION '상품 정보가 없습니다.';
  END IF;

  -- (1) 행잠금 — 동시 요청은 여기서 대기. lost update 원천 차단.
  SELECT *
    INTO v_inv
    FROM public.inventory
   WHERE product_id = p_product_id
   FOR UPDATE;

  IF NOT FOUND THEN
    IF p_require_exist THEN
      RAISE EXCEPTION '재고 레코드가 없습니다 (product_id=%).', p_product_id;
    END IF;
    RETURN jsonb_build_object('success', FALSE, 'reason', 'no_inventory_row');
  END IF;

  -- (2) 잠근 직후의 실제 값 기준으로 델타 적용
  v_nq   := COALESCE(v_inv.quantity, 0)       + COALESCE(p_d_quantity, 0);
  v_nr   := COALESCE(v_inv.reserved, 0)       + COALESCE(p_d_reserved, 0);
  v_noh  := COALESCE(v_inv.on_hand, 0)        + COALESCE(p_d_on_hand, 0);
  v_nlp  := COALESCE(v_inv.loose_pack_qty, 0) + COALESCE(p_d_loose_pack, 0);
  v_nrp  := COALESCE(v_inv.reserved_pack, 0)  + COALESCE(p_d_reserved_pack, 0);
  v_nohp := COALESCE(v_inv.on_hand_pack, 0)   + COALESCE(p_d_on_hand_pack, 0);

  -- (3) 음수 가드 (재고 부족 또는 정합 위반)
  IF v_nq < 0 THEN
    RAISE EXCEPTION '주문가능(박스) 재고 부족: 현재 %, 변동 %.', v_inv.quantity, p_d_quantity;
  END IF;
  IF v_nr < 0 THEN
    RAISE EXCEPTION '나갈것(박스)이 음수가 됩니다: 현재 %, 변동 %.', v_inv.reserved, p_d_reserved;
  END IF;
  IF v_noh < 0 THEN
    RAISE EXCEPTION '총재고(박스)가 음수가 됩니다: 현재 %, 변동 %.', v_inv.on_hand, p_d_on_hand;
  END IF;
  IF v_nlp < 0 THEN
    RAISE EXCEPTION '주문가능(팩) 재고 부족: 현재 %, 변동 %.', v_inv.loose_pack_qty, p_d_loose_pack;
  END IF;
  IF v_nrp < 0 THEN
    RAISE EXCEPTION '나갈것(팩)이 음수가 됩니다: 현재 %, 변동 %.', v_inv.reserved_pack, p_d_reserved_pack;
  END IF;
  IF v_nohp < 0 THEN
    RAISE EXCEPTION '총재고(팩)가 음수가 됩니다: 현재 %, 변동 %.', v_inv.on_hand_pack, p_d_on_hand_pack;
  END IF;

  -- (4) 단일 UPDATE 로 반영
  UPDATE public.inventory
     SET quantity       = v_nq,
         reserved       = v_nr,
         on_hand        = v_noh,
         loose_pack_qty = v_nlp,
         reserved_pack  = v_nrp,
         on_hand_pack   = v_nohp,
         updated_at     = NOW()
   WHERE product_id = p_product_id;

  -- (5) 트랜잭션 이력 (옵션)
  IF p_tx_type IS NOT NULL THEN
    INSERT INTO public.inventory_transactions
      (product_id, type, quantity, unit, description, created_by, source)
    VALUES
      (p_product_id,
       p_tx_type,
       COALESCE(p_tx_quantity, 0),
       COALESCE(p_tx_unit, 'box'),
       p_tx_description,
       p_actor,
       p_tx_source);
  END IF;

  RETURN jsonb_build_object(
    'success',        TRUE,
    'quantity',       v_nq,
    'reserved',       v_nr,
    'on_hand',        v_noh,
    'loose_pack_qty', v_nlp,
    'reserved_pack',  v_nrp,
    'on_hand_pack',   v_nohp
  );
END;
$$;

-- 권한: service_role(서버 API)만 호출. anon/authenticated 차단.
REVOKE ALL ON FUNCTION public.apply_inventory_delta(
  UUID, INT, INT, INT, INT, INT, INT, TEXT, TEXT, INT, TEXT, TEXT, UUID, BOOLEAN
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_inventory_delta(
  UUID, INT, INT, INT, INT, INT, INT, TEXT, TEXT, INT, TEXT, TEXT, UUID, BOOLEAN
) FROM anon;
REVOKE ALL ON FUNCTION public.apply_inventory_delta(
  UUID, INT, INT, INT, INT, INT, INT, TEXT, TEXT, INT, TEXT, TEXT, UUID, BOOLEAN
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.apply_inventory_delta(
  UUID, INT, INT, INT, INT, INT, INT, TEXT, TEXT, INT, TEXT, TEXT, UUID, BOOLEAN
) TO service_role;

-- ============================================================
-- 경로별 호출 시 넘기는 델타 (등식 유지 조합) — 코드 교체 가이드
-- ------------------------------------------------------------
--  가맹점 발주생성(box) : d_quantity=-N, d_reserved=+N                 (on_hand 불변)
--  가맹점 발주취소(box) : d_quantity=+N, d_reserved=-N
--  가맹점 출고완료(box) : d_reserved=-N, d_on_hand=-N                  (quantity 불변)
--  가맹점 발주생성(pack): d_loose_pack=-N, d_reserved_pack=+N
--  B2B  발주등록(box환산): d_quantity=-N, d_reserved=+N
--  B2B  출고(box환산)  : d_reserved=-N, d_on_hand=-N, d_loose_pack=+L, d_on_hand_pack=+L
--  B2B  취소(pending)  : d_quantity=+N, d_reserved=-N
--  B2B  취소(shipped)  : d_quantity=+N, d_on_hand=+N, d_loose_pack=-L, d_on_hand_pack=-L
--  입출고 조정(입고)   : d_quantity=+C, d_on_hand=+C                   (reserved 불변)
--  입출고 조정(출고)   : d_quantity=-C, d_on_hand=-C
-- ============================================================
