-- ============================================================
-- 022_auto_confirm_pending_orders.sql
-- 마감(ship_date 전일 17:00 / 제주는 수 16:00) 지난 pending 발주를
-- 매시간 정각마다 자동으로 confirmed 상태로 전환.
-- ============================================================
-- 배경:
--   현재는 관리자/신화푸드가 발주 상세 화면에서 "발주 확정" 버튼을
--   수동으로 눌러야만 pending → confirmed 로 바뀜.
--   가맹점 수정 차단은 이미 isPastDeadlineForShipDate(클라이언트)
--   로 잘 동작하나, status 자체는 어긋난 채 남아있음
--   (예: 2026-05-20 0082 대한상공회의소점).
--
--   A안(재고 3분할: on_hand/reserved/available) 도입 전에
--   pending↔confirmed 상태 정합성을 깔끔히 맞춰두기 위함.
--
-- 동작:
--   매시간 0분에 public.auto_confirm_past_deadline_orders() 실행.
--   1) status='pending' 인 발주를 모두 훑는다.
--   2) 매장의 region 및 deadline_override_until 을 본다.
--      - deadline_override_until 이 현재 이후면 SKIP (관리자가 마감 연장 중)
--   3) ship_date 기준 마감시각 계산
--      - region='jeju'  → (ship_date - 1일) 16:00 KST
--      - 그 외 region  → (ship_date - 1일) 17:00 KST
--      - ship_date 가 NULL 이면 SKIP (그 경우 자동확정 불가)
--   4) 현재시각 >= 마감시각 이면:
--      - orders.status = 'confirmed' 로 UPDATE
--      - order_logs 에 changed_by_role='system', changed_by_name='auto-cron'
--        action='상태 변경: 확정', description='자동확정 (마감 경과)' INSERT
--
-- 클라이언트의 isPastDeadlineForShipDate 와 동일 규칙이므로
-- 가맹점 수정 차단 시점 = 자동확정 시점 일치.
--
-- 참고: deadline_override_until 은 매장(stores) 전체에 걸리는 연장이라
--       해당 매장의 모든 ship_date 발주가 일괄 보호된다.
-- ============================================================

-- ----------------------------------------------------------------
-- 1) pg_cron 확장 활성화 (없으면 생성)
-- ----------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ----------------------------------------------------------------
-- 1-b) order_logs.changed_by NULL 허용
--      자동확정(cron)은 사람 user id가 없으므로 NULL 가능해야 한다.
--      003 마이그레이션 시점엔 명시 NOT NULL 없었으나 운영 DB에 NOT NULL이
--      추가돼 있어 INSERT 실패하던 문제 정리.
-- ----------------------------------------------------------------
ALTER TABLE public.order_logs ALTER COLUMN changed_by DROP NOT NULL;

-- ----------------------------------------------------------------
-- 2) 자동확정 함수 정의
--    - SECURITY DEFINER: order_logs RLS 우회용 (cron 실행 컨텍스트는 익명)
--    - search_path 고정: 함수 하이재킹 방지 베스트프랙티스
--    - RETURNS TABLE: 어떤 발주가 변경됐는지 결과로 반환 (수동 호출 시 확인용)
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auto_confirm_past_deadline_orders()
RETURNS TABLE(
  confirmed_order_id UUID,
  order_number       TEXT,
  store_short_name   TEXT,
  ship_date          DATE,
  deadline_kst       TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now      TIMESTAMPTZ := NOW();
  r          RECORD;
  v_deadline TIMESTAMPTZ;
  v_hour     INT;
BEGIN
  FOR r IN
    SELECT o.id            AS order_id,
           o.order_number  AS order_num,
           o.ship_date     AS ship_d,
           s.short_name    AS store_short,
           s.region        AS store_region,
           s.deadline_override_until AS override_until
      FROM public.orders  o
      JOIN public.stores  s ON s.id = o.store_id
     WHERE o.status     = 'pending'
       AND o.ship_date IS NOT NULL
  LOOP
    -- (a) 마감 연장 활성이면 자동확정 보류
    IF r.override_until IS NOT NULL
       AND r.override_until > v_now THEN
      CONTINUE;
    END IF;

    -- (b) 마감 시각 계산 (KST)
    v_hour := CASE WHEN r.store_region = 'jeju' THEN 16 ELSE 17 END;
    v_deadline := ((r.ship_d - INTERVAL '1 day')::date
                   ::timestamp AT TIME ZONE 'Asia/Seoul')
                  + (v_hour || ' hours')::interval;

    -- (c) 마감 경과 시 확정 처리
    IF v_now >= v_deadline THEN
      UPDATE public.orders
         SET status     = 'confirmed',
             updated_at = NOW()
       WHERE id = r.order_id;

      INSERT INTO public.order_logs
        (order_id, action, description, changed_by, changed_by_name, changed_by_role)
      VALUES
        (r.order_id,
         '상태 변경: 확정',
         '자동확정 (마감 경과)',
         NULL,
         'auto-cron',
         'system');

      confirmed_order_id := r.order_id;
      order_number       := r.order_num;
      store_short_name   := r.store_short;
      ship_date          := r.ship_d;
      deadline_kst       := v_deadline;
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$$;

-- 함수 권한: 익명/anon 에게는 부여하지 않음. cron 실행 컨텍스트(=postgres) 만 호출 가능.
REVOKE ALL ON FUNCTION public.auto_confirm_past_deadline_orders() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auto_confirm_past_deadline_orders() TO postgres;

-- ----------------------------------------------------------------
-- 3) pg_cron 스케줄 등록 — 매시간 정각 (UTC, 매시간이라 KST/UTC 무관)
--    기존 잡 있으면 unschedule 후 재등록.
-- ----------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auto-confirm-orders') THEN
    PERFORM cron.unschedule('auto-confirm-orders');
  END IF;
END $$;

SELECT cron.schedule(
  'auto-confirm-orders',
  '0 * * * *',  -- 매시간 0분
  $cron$ SELECT public.auto_confirm_past_deadline_orders(); $cron$
);

-- ============================================================
-- 수동 실행 / 검증용 (적용 직후 1회 돌려 0082가 잘 confirmed 되는지 확인)
-- ============================================================
-- SELECT * FROM public.auto_confirm_past_deadline_orders();
-- → 첫 호출에서 0082(대한상공회의소점, ship_date=2026-05-21) 가 반환되어야 함
--
-- 스케줄 등록 확인:
-- SELECT jobid, jobname, schedule, command FROM cron.job
--  WHERE jobname = 'auto-confirm-orders';
--
-- 최근 실행 로그:
-- SELECT * FROM cron.job_run_details
--  WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname='auto-confirm-orders')
--  ORDER BY start_time DESC LIMIT 10;
--
-- 롤백:
-- SELECT cron.unschedule('auto-confirm-orders');
-- DROP FUNCTION public.auto_confirm_past_deadline_orders();
-- ============================================================
