-- ============================================================
-- 042_b2b_goodfnb_bridge_account_link.sql
-- 굿에프엔비브릿지 (돼봉물류) — 로그인 계정 ↔ 거래처 연결
-- ============================================================
-- ⚠️ 실행 순서 (이 순서를 꼭 지켜야 합니다)
--   1) 041_b2b_goodfnb_bridge.sql 을 먼저 실행 (거래처 생성)
--   2) Supabase 대시보드 → Authentication → Users → [Add user]
--        · Email        : salems@nate.com      (아래 v_email 과 반드시 같아야 함)
--        · Password     : 초기 비밀번호 입력
--        · ✅ Auto Confirm User 체크 (안 하면 로그인 안 됨)
--   3) 이 파일을 SQL Editor 에 붙여넣고 실행
--
-- 하는 일:
--   auth.users 에 만들어진 계정을 profiles 에 role='b2b' 로 등록하고
--   b2b_customer_id 로 굿에프엔비브릿지 거래처에 묶는다.
--   → 이 계정은 로그인하면 자기 거래처 화면만 보인다.
--     (원가·가맹점 정보·재고·공지 전부 차단 — 038 정책이 이미 처리)
--
-- 안전장치:
--   · 계정이 없으면 에러 메시지를 띄우고 아무것도 바꾸지 않는다.
--   · 거래처가 없으면(041 미실행) 역시 에러로 멈춘다.
--   · 이미 다른 거래처에 묶인 계정이면 멈춘다 (돼봉 상봉점 계정 오염 방지).
--   · 여러 번 실행해도 안전.
--
-- 절대원칙: 본인이 Supabase SQL Editor 에서 직접 실행. AI 는 파일만 생성.
-- ============================================================

DO $$
DECLARE
  -- ▼▼▼ 계정 이메일을 바꾸려면 이 한 줄만 고치세요 ▼▼▼
  v_email       TEXT := 'salems@nate.com';
  -- ▲▲▲ Supabase Authentication 에 만든 이메일과 똑같아야 합니다 ▲▲▲

  v_user_id     UUID;
  v_customer_id UUID;
  v_bound_to    UUID;
  v_role        TEXT;
BEGIN
  -- 1) 로그인 계정 확인
  SELECT id INTO v_user_id FROM auth.users WHERE lower(email) = lower(v_email);
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION
      '로그인 계정(%)이 아직 없습니다. Supabase → Authentication → Users 에서 먼저 만들어 주세요. (Auto Confirm User 체크 필수)',
      v_email;
  END IF;

  -- 2) 거래처 확인 (041 실행 여부)
  SELECT id INTO v_customer_id
    FROM public.b2b_customers
   WHERE business_number = '112-81-56636';
  IF v_customer_id IS NULL THEN
    RAISE EXCEPTION
      '굿에프엔비브릿지 거래처가 없습니다. 041_b2b_goodfnb_bridge.sql 을 먼저 실행해 주세요.';
  END IF;

  -- 3) 이미 다른 거래처/역할에 묶인 계정인지 확인 (기존 돼봉 계정 보호)
  SELECT role, b2b_customer_id INTO v_role, v_bound_to
    FROM public.profiles WHERE id = v_user_id;

  IF FOUND AND v_bound_to IS NOT NULL AND v_bound_to <> v_customer_id THEN
    RAISE EXCEPTION
      '이 계정(%)은 이미 다른 B2B 거래처에 연결돼 있습니다. 다른 이메일로 새 계정을 만들어 주세요.',
      v_email;
  END IF;

  IF FOUND AND v_role IS NOT NULL AND v_role <> 'b2b' THEN
    RAISE EXCEPTION
      '이 계정(%)은 이미 % 역할로 쓰이고 있습니다. B2B 전용 이메일로 새 계정을 만들어 주세요.',
      v_email, v_role;
  END IF;

  -- 4) 연결
  INSERT INTO public.profiles (id, email, name, role, b2b_customer_id)
  VALUES (v_user_id, v_email, '굿에프엔비브릿지 (돼봉물류)', 'b2b', v_customer_id)
  ON CONFLICT (id) DO UPDATE SET
    email           = EXCLUDED.email,
    name            = EXCLUDED.name,
    role            = 'b2b',
    b2b_customer_id = EXCLUDED.b2b_customer_id,
    updated_at      = NOW();

  RAISE NOTICE '연결 완료 — % → 굿에프엔비브릿지 (돼봉물류)', v_email;
END $$;

-- ============================================================
-- (검증용 — 실행 후 확인)
-- ============================================================
--
-- 1) B2B 계정이 각각 다른 거래처에 제대로 묶였는지
--    → 돼봉 상봉점 계정과 굿에프엔비브릿지 계정이 서로 다른 거래처여야 함
-- SELECT pr.email, pr.name, pr.role, c.name AS 연결거래처, c.business_number
--   FROM public.profiles pr
--   LEFT JOIN public.b2b_customers c ON c.id = pr.b2b_customer_id
--  WHERE pr.role = 'b2b'
--  ORDER BY pr.email;
--
-- 2) 한 거래처에 계정이 2개 이상 붙지 않았는지
-- SELECT c.name, COUNT(*) AS 계정수
--   FROM public.profiles pr
--   JOIN public.b2b_customers c ON c.id = pr.b2b_customer_id
--  WHERE pr.role = 'b2b'
--  GROUP BY c.name
--  ORDER BY c.name;
-- ============================================================
