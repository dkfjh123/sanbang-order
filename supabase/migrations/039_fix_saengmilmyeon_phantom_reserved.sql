-- ============================================================
-- 039_fix_saengmilmyeon_phantom_reserved.sql   (v2 — 발주 진행 중에도 안전)
-- 생밀면 유령 재고 2박스 제거
-- ============================================================
-- ■ 무엇을 하나
--     총재고(on_hand)  -2
--     나갈것(reserved)  -2
--     주문가능(quantity) 그대로       ← 점주 발주에 영향 없음
--
-- ■ 왜 2박스인가 (2026-08-07 조사)
--   2026-07-30 03:22 ORD-20260728-0204(함덕점) 출고 처리가 2초 간격으로 두 번 실행됨
--   (03:22:17 / 03:22:19, order_logs 에 2줄 남아 있음).
--   → 생밀면 14박스가 이중 차감되어 reserved 가 14 낮아짐.
--   → 뒤이은 출고 처리 2건이 reserved 부족으로 apply_inventory_delta 예외 발생:
--        03:22:42 ORD-20260726-0202(협재점) 12박스
--        07-31 02:24:37 ORD-20260724-0199(동일옥) 4박스
--      그런데 PATCH ship 핸들러가 RPC 에러를 받지 않아 조용히 무시하고
--      orders.status = 'shipped' 로 넘어감 → 물건은 나갔는데 재고는 그대로.
--   → 순효과 = (12+4) - 14 = +2박스가 on_hand·reserved 에 유령으로 남음.
--
--   검증 3중 일치:
--     (1) 리플레이: 6/10 상태에서 전 사건 재생 → DB 실측과 완전 일치
--         (scripts/replay-saengmilmyeon-reserved-readonly.mjs)
--     (2) 실물 역산(팩 환산): 5/21 실사 38박스 기준 → 178박스
--         (scripts/reconstruct-all-onhand-packs-readonly.mjs)
--     (3) 사장님 창고 실물 카운트 = 178박스
--
--   ※ 034 CHECK(on_hand = quantity + reserved)는 on_hand 와 reserved 가 같이 부풀어
--     등식이 닫히므로 이 결함을 못 잡는다. 그래서 실물 역산이 필요했다.
--
-- ■ v1 대비 변경 (중요)
--   v1 은 "미출고 발주를 다시 집계해 reserved 를 덮어쓰는" 방식이었다.
--   발주 등록 API 는 ① orders INSERT → ② apply_inventory_delta 순서라
--   그 사이 찰나에 본 마이그레이션이 실행되면 집계가 실제 reserved 보다 커져
--   오히려 값을 더 망가뜨릴 수 있다.
--   v2 는 집계로 덮어쓰지 않고 "현재 값에서 정확히 2를 빼는" 상대 연산이라
--   발주/출고가 동시에 진행돼도 순서만 바뀔 뿐 결과가 같다(행잠금으로 직렬화).
--
-- ■ 안전장치
--   · inventory 행을 FOR UPDATE 로 잠그고 처리(동시 요청은 대기)
--   · 등식(on_hand = quantity + reserved)이 이미 깨져 있으면 중단
--   · reserved 가 2 미만이면 중단 (예상 밖 상태 → 재점검 필요)
--   · 유령 추정치가 2가 아니면 중단
--       └ 발주가 위 ①~② 찰나에 있으면 여기서 안전하게 멈춘다.
--         그런 경우 아무것도 바뀌지 않으니 잠시 후 그대로 다시 실행하면 된다.
--   · 실행 전 inventory 전체 백업(backup_inventory_20260807)
--   · [039 유령제거] 태그로 멱등 — 두 번 실행해도 중복 적용 안 됨
--
-- ■ 절대원칙: 본인이 Supabase SQL Editor 에서 직접 실행. AI 는 파일만 생성.
-- ============================================================

-- [백업] 트랜잭션 밖에서 먼저
CREATE TABLE IF NOT EXISTS backup_inventory_20260807
  AS SELECT * FROM public.inventory;

BEGIN;

DO $$
DECLARE
  v_tag     CONSTANT TEXT := '[039 유령제거]';
  v_phantom CONSTANT INT  := 2;      -- 제거할 유령 박스 수 (조사로 확정)
  v_pid       UUID;
  v_admin     UUID;
  v_quantity  INT;
  v_reserved  INT;
  v_on_hand   INT;
  v_open      INT;
  v_zombie    INT;
BEGIN
  -- 멱등 가드
  IF EXISTS (SELECT 1 FROM public.inventory_transactions WHERE description LIKE v_tag || '%') THEN
    RAISE NOTICE '039 보정이 이미 적용되어 있습니다 — 아무것도 하지 않고 종료합니다.';
    RETURN;
  END IF;

  SELECT id INTO v_pid FROM public.products WHERE name = '생밀면' LIMIT 1;
  IF v_pid IS NULL THEN RAISE EXCEPTION '생밀면 상품을 찾을 수 없습니다.'; END IF;

  SELECT id INTO v_admin
    FROM public.profiles WHERE email = 'dkfjh1234@gmail.com' AND role = 'admin' LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION '관리자 프로필을 찾을 수 없습니다.'; END IF;

  -- 행잠금 (동시 발주/출고는 여기서 대기 → 순서가 뒤섞이지 않음)
  SELECT quantity, reserved, on_hand
    INTO v_quantity, v_reserved, v_on_hand
    FROM public.inventory WHERE product_id = v_pid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '생밀면 재고 레코드가 없습니다.'; END IF;

  RAISE NOTICE '현재 상태 : 주문가능 %, 나갈것 %, 총재고 %', v_quantity, v_reserved, v_on_hand;

  -- (1) 등식이 이미 깨져 있으면 중단
  IF v_on_hand <> v_quantity + v_reserved THEN
    RAISE EXCEPTION '등식이 깨져 있습니다 (총재고 % <> 주문가능 % + 나갈것 %). 보정 중단 — 재점검 필요.',
      v_on_hand, v_quantity, v_reserved;
  END IF;

  -- (2) 나갈것이 2 미만이면 중단
  IF v_reserved < v_phantom THEN
    RAISE EXCEPTION '나갈것이 %박스뿐이라 %박스를 뺄 수 없습니다. 보정 중단 — 재점검 필요.',
      v_reserved, v_phantom;
  END IF;

  -- (3) 유령 추정치 확인 : 나갈것 − 실제 미출고 발주(가맹 pending/confirmed + B2B pending)
  SELECT
    COALESCE((SELECT SUM(oi.quantity) FROM public.order_items oi
                JOIN public.orders o ON o.id = oi.order_id
               WHERE oi.product_id = v_pid AND COALESCE(oi.unit,'box') = 'box'
                 AND o.status IN ('pending','confirmed')), 0)
  + COALESCE((SELECT SUM(bi.quantity) FROM public.b2b_order_items bi
                JOIN public.b2b_orders bo ON bo.id = bi.order_id
               WHERE bi.product_id = v_pid AND COALESCE(bi.unit,'box') = 'box'
                 AND bo.status = 'pending'), 0)
    INTO v_open;
  v_zombie := v_reserved - v_open;

  RAISE NOTICE '실제 미출고 % 박스, 나갈것 % 박스 → 유령 % 박스', v_open, v_reserved, v_zombie;

  IF v_zombie <> v_phantom THEN
    RAISE EXCEPTION '유령이 %박스로 계산되어 예상(%박스)과 다릅니다. 아무것도 바꾸지 않고 중단했습니다. 발주가 저장되는 찰나였을 수 있으니 1분 뒤 그대로 다시 실행해 보세요. 계속 같은 값이면 재점검이 필요합니다.',
      v_zombie, v_phantom;
  END IF;

  -- (4) 상대 연산으로 적용 (덮어쓰기 아님 → 동시 발주/출고와 충돌 없음)
  UPDATE public.inventory
     SET reserved   = reserved - v_phantom,
         on_hand    = on_hand  - v_phantom,
         updated_at = NOW()
   WHERE product_id = v_pid;

  INSERT INTO public.inventory_transactions
    (product_id, type, quantity, unit, description, created_by, source)
  VALUES
    (v_pid, 'adjustment', -v_phantom, 'box',
     v_tag || ' 생밀면 유령 ' || v_phantom || '박스 제거 — 총재고 ' || v_on_hand || '→' || (v_on_hand - v_phantom)
       || ', 나갈것 ' || v_reserved || '→' || (v_reserved - v_phantom)
       || ', 주문가능 ' || v_quantity || ' 유지. '
       || '원인: 2026-07-30 03:22 ORD-20260728-0204 출고처리 이중 실행 + 후속 출고처리 RPC 에러 무시. '
       || '근거: 리플레이 일치 + 실물 역산 178 + 창고 실물 카운트 178.',
     v_admin, 'manual_adjust');

  RAISE NOTICE '완료 : 주문가능 % (유지), 나갈것 %→%, 총재고 %→%',
    v_quantity, v_reserved, v_reserved - v_phantom, v_on_hand, v_on_hand - v_phantom;
END $$;

COMMIT;

-- ============================================================
-- 적용 후 확인 (아래 SELECT 를 따로 실행)
-- ============================================================
-- SELECT i.on_hand AS 총재고, i.reserved AS 나갈것, i.quantity AS 주문가능,
--        (i.on_hand = i.quantity + i.reserved) AS 등식ok
--   FROM public.inventory i JOIN public.products p ON p.id = i.product_id
--  WHERE p.name = '생밀면';
--
-- 기대: 총재고 = 주문가능 + 나갈것 이고, 총재고가 실행 전보다 2 작을 것.
-- ============================================================

-- ============================================================
-- 롤백 (사고 시)
-- ============================================================
-- BEGIN;
--   UPDATE public.inventory
--      SET reserved = reserved + 2, on_hand = on_hand + 2, updated_at = NOW()
--    WHERE product_id = (SELECT id FROM public.products WHERE name = '생밀면');
--   DELETE FROM public.inventory_transactions WHERE description LIKE '[039 유령제거]%';
-- COMMIT;
-- ============================================================
