-- ============================================================
-- 043_cancel_unshipped_orders_20260817.sql
-- 8/17 출고처리됐으나 실제로 출고되지 않은 가맹점 발주 2건 취소
-- ============================================================
-- 배경:
--   2026-08-17 새벽, 신화푸드가 3건을 1~2분 사이에 몰아서 '출고 처리' 클릭.
--   그 중 아래 2건은 실물이 창고에서 나가지 않았음(사장님 확인, 2026-08-18).
--     · ORD-20260816-0244  산방식당_협재점        ₩677,600  (13박스)
--     · ORD-20260816-0243  제주산방식당 제주외도점  ₩439,142  (7박스)
--   가맹점 발주는 출고완료(shipped) 후 화면에서 되돌릴 방법이 없어(B2B만 가능)
--   SQL 로 '출고취소 반품' 을 수동 처리한다.
--   (이후 044 + 코드 변경으로 관리자 전용 '출고 되돌리기' 버튼이 생김)
--
-- 하는 일 (b2b cancel(shipped→cancelled) 로직과 동일한 거울):
--   1) 재고 복구 : quantity += 수량,  on_hand += 수량   (reserved 불변)
--                 → 등식 on_hand = quantity + reserved 유지 (034 자물쇠 통과)
--                 → inventory_transactions 에 inbound 기록 남김
--   2) 주문 상태 : shipped → cancelled  (정산/손익/거래명세서에서 제외됨)
--   3) 예치금    : 발주 시 차감된 금액 전액 환불 + deposit_transactions 기록
--                 (직영점은 예치금 대상 아님 → 자동 제외)
--   4) order_logs 에 취소 이력 기록
--
-- 적용 후 예상 재고 (적용 전 → 적용 후, 박스)
--   고기국수육수  총34/가용28  → 총36/가용30
--   왕만두        총120/가용107 → 총124/가용111
--   육수간장      총27/가용25  → 총28/가용26
--   생밀면        총94/가용75  → 총106/가용87
--   양념장        총16/가용12  → 총17/가용13
-- 적용 후 예상 예치금
--   협재점    ₩0      → ₩677,600
--   외도점    ₩62,272 → ₩501,414
--
-- 멱등성: 상태가 이미 cancelled 면 건너뜀 / 환불도 order_refund 존재 시 건너뜀.
--         두 번 실행해도 재고·돈이 두 번 움직이지 않음.
-- 절대원칙: 본인이 Supabase SQL Editor 에서 직접 실행. AI 는 파일만 생성.
-- 예상 소요: 1초 미만.
-- ============================================================

-- ----------------------------------------------------------------
-- [백업] 트랜잭션 밖에서 먼저 — 실패해도 백업본은 살아남게
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS backup_orders_20260818_043
  AS SELECT * FROM public.orders;
CREATE TABLE IF NOT EXISTS backup_inventory_20260818_043
  AS SELECT * FROM public.inventory;
CREATE TABLE IF NOT EXISTS backup_stores_20260818_043
  AS SELECT * FROM public.stores;

-- ----------------------------------------------------------------
-- [적용 전 확인] 아무것도 바꾸지 않고 현재 상태만 보여주는 조회
-- ----------------------------------------------------------------
SELECT '적용 전 · 주문' AS 구분, o.order_number, s.name AS 가맹점, o.status AS 상태,
       o.ship_date AS 출고일, o.total_amount AS 금액, s.deposit_balance AS 예치금잔액
  FROM public.orders o JOIN public.stores s ON s.id = o.store_id
 WHERE o.order_number IN ('ORD-20260816-0244','ORD-20260816-0243');

SELECT '적용 전 · 재고' AS 구분, p.name AS 상품, i.on_hand AS 총재고,
       i.reserved AS 나갈것, i.quantity AS 주문가능
  FROM public.inventory i JOIN public.products p ON p.id = i.product_id
 WHERE p.name IN ('고기국수육수','왕만두','육수간장','생밀면','양념장')
 ORDER BY p.name;

-- ----------------------------------------------------------------
-- 본 작업 — 한 트랜잭션. 도중 실패 시 전체 자동 원복.
-- ----------------------------------------------------------------
BEGIN;

DO $$
DECLARE
  v_tag   CONSTANT TEXT := '[043 보정] 미출고 취소';
  v_admin UUID;
  v_ord   RECORD;
  v_it    RECORD;
  v_bal   INT;
  v_new   INT;
  v_done  INT := 0;
BEGIN
  SELECT id INTO v_admin
    FROM public.profiles
   WHERE email = 'dkfjh1234@gmail.com' AND role = 'admin'
   LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION '관리자(dkfjh1234@gmail.com) 프로필을 찾을 수 없습니다.';
  END IF;

  FOR v_ord IN
    SELECT o.id, o.order_number, o.status, o.total_amount, o.store_id
      FROM public.orders o
     WHERE o.order_number IN ('ORD-20260816-0244', 'ORD-20260816-0243')
     ORDER BY o.order_number
  LOOP
    -- 멱등 가드 ①: 이미 취소된 주문은 건드리지 않는다
    IF v_ord.status = 'cancelled' THEN
      RAISE NOTICE '% : 이미 취소됨 → 건너뜀', v_ord.order_number;
      CONTINUE;
    END IF;
    -- 안전 가드: shipped 가 아니면 이 스크립트의 전제가 깨진 것 → 전체 중단
    IF v_ord.status <> 'shipped' THEN
      RAISE EXCEPTION '% : 상태가 shipped 가 아닙니다(현재 %). 확인 후 다시 실행하세요.',
        v_ord.order_number, v_ord.status;
    END IF;

    -- ---- 1) 재고 복구 (출고완료의 거울: quantity↑ on_hand↑, reserved 불변) ----
    FOR v_it IN
      SELECT product_id, product_name, quantity, COALESCE(unit, 'box') AS unit
        FROM public.order_items
       WHERE order_id = v_ord.id
    LOOP
      CONTINUE WHEN v_it.product_id IS NULL;

      IF v_it.unit = 'box' THEN
        PERFORM public.apply_inventory_delta(
          p_product_id     => v_it.product_id,
          p_d_quantity     => v_it.quantity,
          p_d_on_hand      => v_it.quantity,
          p_tx_type        => 'inbound',
          p_tx_unit        => 'box',
          p_tx_quantity    => v_it.quantity,
          p_tx_description => v_tag || ' 반품 (' || v_ord.order_number || ') — '
                              || v_it.product_name || ' ' || v_it.quantity || '박스',
          p_actor          => v_admin,
          p_require_exist  => FALSE
        );
      ELSE
        PERFORM public.apply_inventory_delta(
          p_product_id     => v_it.product_id,
          p_d_loose_pack   => v_it.quantity,
          p_d_on_hand_pack => v_it.quantity,
          p_tx_type        => 'inbound',
          p_tx_unit        => 'pack',
          p_tx_quantity    => v_it.quantity,
          p_tx_description => v_tag || ' 반품 (' || v_ord.order_number || ') — '
                              || v_it.product_name || ' ' || v_it.quantity || '팩',
          p_actor          => v_admin,
          p_require_exist  => FALSE
        );
      END IF;
    END LOOP;

    -- ---- 2) 주문 상태 취소 ----
    UPDATE public.orders SET status = 'cancelled' WHERE id = v_ord.id;

    -- ---- 3) 예치금 환불 (직영점 제외 — is_direct = FALSE 인 경우만 매칭) ----
    SELECT deposit_balance INTO v_bal
      FROM public.stores
     WHERE id = v_ord.store_id AND is_direct = FALSE
     FOR UPDATE;

    IF FOUND THEN
      -- 멱등 가드 ②: 이미 환불 기록이 있으면 다시 넣지 않는다
      IF EXISTS (
        SELECT 1 FROM public.deposit_transactions
         WHERE order_id = v_ord.id AND type = 'order_refund'
      ) THEN
        RAISE NOTICE '% : 예치금 환불 기록이 이미 있음 → 환불 건너뜀', v_ord.order_number;
      ELSE
        v_new := v_bal + v_ord.total_amount;
        UPDATE public.stores SET deposit_balance = v_new WHERE id = v_ord.store_id;
        INSERT INTO public.deposit_transactions
          (store_id, type, amount, balance_after, description, order_id, created_by)
        VALUES
          (v_ord.store_id, 'order_refund', v_ord.total_amount, v_new,
           v_tag || ' 환불 (' || v_ord.order_number || ') — 신화푸드 출고처리됐으나 실물 미출고',
           v_ord.id, v_admin);
        RAISE NOTICE '% : 예치금 % 원 환불 → 잔액 % 원',
          v_ord.order_number, v_ord.total_amount, v_new;
      END IF;
    END IF;

    -- ---- 4) 이력 ----
    INSERT INTO public.order_logs
      (order_id, action, description, changed_by, changed_by_name, changed_by_role)
    VALUES
      (v_ord.id, '주문 취소',
       v_tag || ' — 2026-08-17 신화푸드가 출고처리했으나 실물이 나가지 않아 관리자가 취소. '
             || '재고 반품 복구 + 예치금 환불 처리.',
       v_admin, '관리자', 'admin');

    v_done := v_done + 1;
  END LOOP;

  RAISE NOTICE '043 보정 완료 — 취소 처리 % 건', v_done;
END $$;

COMMIT;

-- ----------------------------------------------------------------
-- [적용 후 확인]
-- ----------------------------------------------------------------
SELECT '적용 후 · 주문' AS 구분, o.order_number, s.name AS 가맹점, o.status AS 상태,
       o.total_amount AS 금액, s.deposit_balance AS 예치금잔액
  FROM public.orders o JOIN public.stores s ON s.id = o.store_id
 WHERE o.order_number IN ('ORD-20260816-0244','ORD-20260816-0243');

SELECT '적용 후 · 재고' AS 구분, p.name AS 상품, i.on_hand AS 총재고,
       i.reserved AS 나갈것, i.quantity AS 주문가능,
       CASE WHEN i.on_hand = i.quantity + i.reserved THEN 'OK' ELSE '★등식위반' END AS 등식
  FROM public.inventory i JOIN public.products p ON p.id = i.product_id
 WHERE p.name IN ('고기국수육수','왕만두','육수간장','생밀면','양념장')
 ORDER BY p.name;
