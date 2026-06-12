-- ============================================================
-- 036_b2b_prepaid_deposit_and_role.sql
-- 돼봉삼겹살 선입금 전환 PR1 — B2B 예치금 인프라 + b2b 로그인 역할
-- ============================================================
-- 배경 (20260612_돼봉선입금전환_플랜.md):
--   B2B 거래처 중 돼봉삼겹살만 가맹점처럼 선입금(예치금) 방식으로 전환.
--   기존 가맹점 예치금(stores.deposit_balance + deposit_transactions)은
--   stores FK 에 묶여 있어 B2B 거래처가 재사용 불가 → B2B 전용 병렬 신설.
--   아워홈·메이즈랜드는 후불 유지(is_prepaid 기본 FALSE → 동작 변화 없음).
--
-- 이 파일이 하는 일:
--   1) profiles.role 에 'b2b' 추가 + b2b_customer_id 연결 컬럼
--   2) b2b_customers 에 deposit_balance / is_prepaid 추가
--   3) b2b_deposit_transactions (예치금 원장) 신설
--   4) b2b_deposit_requests (충전요청-승인) 신설
--   5) 원자 RPC apply_b2b_deposit_delta (행잠금 + 잔액가드, 032 패턴)
--   6) b2b 역할 RLS — 자기 거래처 데이터만 SELECT (쓰기는 전부 서버 API 경유)
--   7) 데이터: 돼봉 is_prepaid=TRUE, 양념장 비활성, 돼봉 정보 업데이트
--
-- 가맹점 쪽 알려진 약점을 복제하지 않음:
--   - type CHECK 에 'withdrawal' 포함 (가맹점 원장은 누락돼 기록 유실 버그 있음)
--   - 잔액 갱신+원장 기록을 RPC 한 트랜잭션으로 (가맹점 주문생성 경로는 비원자)
--
-- products 원가 노출 차단: b2b 역할에 products SELECT 를 주지 않는다.
--   상품명/입수 등 안전 필드는 PR2 에서 서버 API 가 내려준다.
--
-- 멱등성: IF NOT EXISTS / DROP POLICY IF EXISTS / CREATE OR REPLACE — 재실행 안전.
-- 절대원칙: 본인이 Supabase SQL Editor 에서 직접 실행. AI 는 파일만 생성.
-- ============================================================

BEGIN;

-- ============================================================
-- 1. profiles — 'b2b' 역할 + 거래처 연결 컬럼
-- ============================================================

-- role CHECK 재정의 (이름이 달라도 안전하게: role 관련 CHECK 전부 찾아 제거 후 재생성)
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.profiles'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%role%'
  LOOP
    EXECUTE format('ALTER TABLE public.profiles DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('admin', 'store', 'shinwa', 'b2b'));

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS b2b_customer_id UUID REFERENCES public.b2b_customers(id);

-- ============================================================
-- 2. b2b_customers — 예치금 잔액 + 선입금 여부
-- ============================================================

ALTER TABLE public.b2b_customers
  ADD COLUMN IF NOT EXISTS deposit_balance BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_prepaid BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS min_order_amount BIGINT NOT NULL DEFAULT 0;  -- 0 = 제한 없음 (가맹점 stores.min_order_amount 와 동일 개념)

-- ============================================================
-- 3. b2b_deposit_transactions — B2B 예치금 원장
-- ============================================================

CREATE TABLE IF NOT EXISTS public.b2b_deposit_transactions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  b2b_customer_id UUID NOT NULL REFERENCES public.b2b_customers(id),
  type TEXT NOT NULL CHECK (type IN ('deposit', 'order_deduct', 'order_refund', 'adjustment', 'withdrawal')),
  amount BIGINT NOT NULL,                                  -- 부호 포함: 차감/출금 음수, 충전/환불 양수
  balance_after BIGINT NOT NULL,                           -- 처리 후 잔액 스냅샷
  description TEXT,
  b2b_order_id UUID REFERENCES public.b2b_orders(id),
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_b2b_deposit_tx_customer
  ON public.b2b_deposit_transactions (b2b_customer_id, created_at DESC);

ALTER TABLE public.b2b_deposit_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_b2b_deposit_tx_all" ON public.b2b_deposit_transactions;
CREATE POLICY "admin_b2b_deposit_tx_all" ON public.b2b_deposit_transactions
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

DROP POLICY IF EXISTS "b2b_deposit_tx_read_own" ON public.b2b_deposit_transactions;
CREATE POLICY "b2b_deposit_tx_read_own" ON public.b2b_deposit_transactions
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles
             WHERE id = auth.uid() AND role = 'b2b'
               AND b2b_customer_id = b2b_deposit_transactions.b2b_customer_id)
  );

-- ============================================================
-- 4. b2b_deposit_requests — 충전요청(거래처 생성) → 승인(관리자)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.b2b_deposit_requests (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  b2b_customer_id UUID NOT NULL REFERENCES public.b2b_customers(id),
  amount BIGINT NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  description TEXT,
  created_by UUID NOT NULL REFERENCES auth.users(id),
  reviewed_by UUID REFERENCES auth.users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_b2b_deposit_req_customer
  ON public.b2b_deposit_requests (b2b_customer_id, created_at DESC);

ALTER TABLE public.b2b_deposit_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_b2b_deposit_req_all" ON public.b2b_deposit_requests;
CREATE POLICY "admin_b2b_deposit_req_all" ON public.b2b_deposit_requests
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

DROP POLICY IF EXISTS "b2b_deposit_req_read_own" ON public.b2b_deposit_requests;
CREATE POLICY "b2b_deposit_req_read_own" ON public.b2b_deposit_requests
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles
             WHERE id = auth.uid() AND role = 'b2b'
               AND b2b_customer_id = b2b_deposit_requests.b2b_customer_id)
  );

DROP POLICY IF EXISTS "b2b_deposit_req_insert_own" ON public.b2b_deposit_requests;
CREATE POLICY "b2b_deposit_req_insert_own" ON public.b2b_deposit_requests
  FOR INSERT WITH CHECK (
    status = 'pending'
    AND EXISTS (SELECT 1 FROM public.profiles
                 WHERE id = auth.uid() AND role = 'b2b'
                   AND b2b_customer_id = b2b_deposit_requests.b2b_customer_id)
  );

-- ============================================================
-- 5. 원자 RPC — 잔액 검증 + 갱신 + 원장 기록을 한 트랜잭션으로
--    (032 apply_inventory_delta 와 동일 패턴: 행잠금 → 가드 → 단일 UPDATE → 이력)
-- ============================================================

CREATE OR REPLACE FUNCTION public.apply_b2b_deposit_delta(
  p_customer_id  UUID,
  p_type         TEXT,                 -- 'deposit'|'order_deduct'|'order_refund'|'adjustment'|'withdrawal'
  p_amount       BIGINT,               -- 부호 포함: 차감/출금 음수, 충전/환불 양수
  p_description  TEXT    DEFAULT NULL,
  p_order_id     UUID    DEFAULT NULL,
  p_actor        UUID    DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cust    public.b2b_customers%ROWTYPE;
  v_balance BIGINT;
BEGIN
  IF p_customer_id IS NULL THEN
    RAISE EXCEPTION '거래처 정보가 없습니다.';
  END IF;

  IF p_type NOT IN ('deposit', 'order_deduct', 'order_refund', 'adjustment', 'withdrawal') THEN
    RAISE EXCEPTION '허용되지 않는 거래 유형입니다: %', p_type;
  END IF;

  -- (1) 행잠금 — 동시 요청은 여기서 대기. lost update 원천 차단.
  SELECT * INTO v_cust
    FROM public.b2b_customers
   WHERE id = p_customer_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'B2B 거래처를 찾을 수 없습니다 (id=%).', p_customer_id;
  END IF;

  -- (2) 선입금 거래처가 아니면 발주 차감 불가 (후불 거래처 오차감 방지)
  IF p_type = 'order_deduct' AND NOT v_cust.is_prepaid THEN
    RAISE EXCEPTION '후불 거래처(%)는 예치금 차감 대상이 아닙니다.', v_cust.name;
  END IF;

  -- (3) 잠근 직후의 실제 잔액 기준으로 델타 적용 + 음수 가드
  v_balance := COALESCE(v_cust.deposit_balance, 0) + COALESCE(p_amount, 0);

  IF v_balance < 0 THEN
    RAISE EXCEPTION '예치금 잔액 부족: 현재 %원, 요청 %원.', v_cust.deposit_balance, p_amount;
  END IF;

  -- (4) 잔액 갱신 + 원장 기록 (같은 트랜잭션 — 중간에 끊겨도 둘 다 롤백)
  UPDATE public.b2b_customers
     SET deposit_balance = v_balance,
         updated_at      = NOW()
   WHERE id = p_customer_id;

  INSERT INTO public.b2b_deposit_transactions
    (b2b_customer_id, type, amount, balance_after, description, b2b_order_id, created_by)
  VALUES
    (p_customer_id, p_type, COALESCE(p_amount, 0), v_balance, p_description, p_order_id, p_actor);

  RETURN jsonb_build_object(
    'success',       TRUE,
    'balance_after', v_balance
  );
END;
$$;

-- 권한: service_role(서버 API)만 호출. anon/authenticated 차단. (032 와 동일)
REVOKE ALL ON FUNCTION public.apply_b2b_deposit_delta(UUID, TEXT, BIGINT, TEXT, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_b2b_deposit_delta(UUID, TEXT, BIGINT, TEXT, UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.apply_b2b_deposit_delta(UUID, TEXT, BIGINT, TEXT, UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.apply_b2b_deposit_delta(UUID, TEXT, BIGINT, TEXT, UUID, UUID) TO service_role;

-- ============================================================
-- 6. b2b 역할 RLS — 자기 거래처 데이터만 SELECT
--    (쓰기는 전부 서버 API 경유 — INSERT/UPDATE 정책 없음 = 단가 조작 차단)
-- ============================================================

DROP POLICY IF EXISTS "b2b_customers_read_own" ON public.b2b_customers;
CREATE POLICY "b2b_customers_read_own" ON public.b2b_customers
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles
             WHERE id = auth.uid() AND role = 'b2b'
               AND b2b_customer_id = b2b_customers.id)
  );

DROP POLICY IF EXISTS "b2b_orders_read_own" ON public.b2b_orders;
CREATE POLICY "b2b_orders_read_own" ON public.b2b_orders
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles
             WHERE id = auth.uid() AND role = 'b2b'
               AND b2b_customer_id = b2b_orders.b2b_customer_id)
  );

DROP POLICY IF EXISTS "b2b_order_items_read_own" ON public.b2b_order_items;
CREATE POLICY "b2b_order_items_read_own" ON public.b2b_order_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1
        FROM public.b2b_orders o
        JOIN public.profiles pr ON pr.id = auth.uid()
       WHERE o.id = b2b_order_items.order_id
         AND pr.role = 'b2b'
         AND pr.b2b_customer_id = o.b2b_customer_id
    )
  );

DROP POLICY IF EXISTS "b2b_prices_read_own" ON public.b2b_customer_product_prices;
CREATE POLICY "b2b_prices_read_own" ON public.b2b_customer_product_prices
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles
             WHERE id = auth.uid() AND role = 'b2b'
               AND b2b_customer_id = b2b_customer_product_prices.customer_id)
  );

-- ============================================================
-- 7. 데이터 정리 — 돼봉삼겹살 (id 고정: ca5f8cd3-8f45-43d8-9908-0ce59b9e214f)
-- ============================================================

-- 7-1. 선입금 전환 스위치 ON + 최소주문금액 15만원 (가맹점과 동일, 2026-06-12 확정)
--      잔액은 0원 시작 — 기존 후불 2건 수금 완료 확인됨
UPDATE public.b2b_customers SET
  is_prepaid       = TRUE,
  min_order_amount = 150000,
  updated_at       = NOW()
 WHERE id = 'ca5f8cd3-8f45-43d8-9908-0ce59b9e214f';

-- 7-2. 양념장 발주 비활성 (발주 품목 = 비빔전용장 + 생밀면 2종 확정, 2026-06-12)
UPDATE public.b2b_customer_product_prices SET
  is_active = FALSE
 WHERE customer_id = 'ca5f8cd3-8f45-43d8-9908-0ce59b9e214f'
   AND product_id  = '6955b3fa-9057-43ce-9fd9-e5135db1c0f5';  -- 양념장

-- 7-3. 거래처 정보 업데이트 (사업자등록증 862-31-01565 + 배송 정보, 2026-06-12 확인)
UPDATE public.b2b_customers SET
  name            = '돼봉삼겹살 상봉점',
  business_number = '862-31-01565',
  contact_name    = '이환국',
  contact_phone   = '010-8687-9995',
  address         = '서울 중랑구 상봉동 90-3',
  memo            = '새벽배송 시 우편함 04호에 보안키 있음 / 도로명: 망우로50길 24, 104호(상봉동) / 이전 연락처: 010-3074-7733(사장님)',
  updated_at      = NOW()
 WHERE id = 'ca5f8cd3-8f45-43d8-9908-0ce59b9e214f';

COMMIT;

-- ============================================================
-- (검증용 — 실행 후 확인)
-- ============================================================
-- 1) 역할 CHECK 에 b2b 포함됐는지:
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conrelid='public.profiles'::regclass AND conname='profiles_role_check';
--
-- 2) 돼봉 상태 (is_prepaid=true, 잔액 0, 최소주문 150000, 새 정보):
-- SELECT name, business_number, contact_name, contact_phone, address,
--        is_prepaid, deposit_balance, min_order_amount, memo
--   FROM public.b2b_customers
--  WHERE id='ca5f8cd3-8f45-43d8-9908-0ce59b9e214f';
--
-- 3) 활성 단가 2종만 남았는지 (비빔전용장 132,968 / 생밀면 64,900):
-- SELECT p.name, pr.b2b_price_with_tax, pr.is_active
--   FROM public.b2b_customer_product_prices pr
--   JOIN public.products p ON p.id = pr.product_id
--  WHERE pr.customer_id='ca5f8cd3-8f45-43d8-9908-0ce59b9e214f'
--  ORDER BY pr.is_active DESC, p.name;
--
-- 4) RPC 존재 + 권한:
-- SELECT proname FROM pg_proc WHERE proname='apply_b2b_deposit_delta';
