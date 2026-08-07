-- ============================================================
-- 041_b2b_goodfnb_bridge.sql
-- 신규 B2B 거래처 — 굿에프엔비브릿지 (돼봉물류) 등록 + 단가 시드
-- ============================================================
-- 배경 (2026-08-07 사업자등록증 + 명함 확인):
--   돼봉삼겹살 "브랜드 물류"를 담당하는 신규 거래처.
--   기존 '돼봉삼겹살 상봉점'(862-31-01565, 개별 점포)과는 사업자·법인이
--   완전히 다른 별개 거래처다. 이름만 비슷하므로 화면 표기에 (돼봉물류)를
--   붙여 구분한다.
--
--   ⚠️ 서류 2종의 상호가 다름 — 정리 기준:
--     · 사업자등록증: (주)굿에프엔비브릿지 / 112-81-56636 / 대표 최선태
--       → 세금계산서·거래명세서 기준이므로 이쪽을 정식 등록값으로 사용
--     · 명    함    : (주)굿에프엔비 / 이동언 이사 / 시흥시 수인로 2780-3
--       → 실무 담당자 + 물류센터 추정 주소. memo 에 보관.
--     두 상호가 별개 법인이면 나중에 거래처를 쪼개야 하므로 memo 에 명시.
--
-- 이 파일이 하는 일:
--   1) b2b_customers 에 거래처 1건 등록 (선입금 / 육지 / 최소 15만원)
--   2) b2b_customer_product_prices 에 전용상품 7종 전체 단가 시드
--      (돼봉 상봉점은 2종만, 이 거래처는 전용상품 전부 — 2026-08-07 확정)
--
-- 이 파일이 하지 않는 일:
--   · 로그인 계정 생성/연결 → 042_b2b_goodfnb_bridge_account_link.sql
--   · 예치금 충전 → 잔액 0원으로 시작. 입금 확인 후 화면에서 승인.
--
-- 멱등성: WHERE NOT EXISTS / ON CONFLICT DO UPDATE — 여러 번 실행해도 안전.
--         재실행 시에도 deposit_balance(예치금 잔액)는 절대 건드리지 않는다.
-- 절대원칙: 본인이 Supabase SQL Editor 에서 직접 실행. AI 는 파일만 생성.
-- ============================================================

BEGIN;

-- ============================================================
-- 1. 거래처 등록 (사업자번호를 고유키로 사용 — 중복 등록 방지)
-- ============================================================

INSERT INTO public.b2b_customers (
  name, business_number, contact_name, contact_phone, contact_email,
  address, memo, region, is_active, is_prepaid, min_order_amount
)
SELECT
  '굿에프엔비브릿지 (돼봉물류)',
  '112-81-56636',
  '이동언 이사',
  '010-2670-4851',
  'salems@nate.com',
  -- 배송지 (거래명세서에 찍히는 주소) — 명함 기준 물류센터, 2026-08-07 확정
  '경기도 시흥시 수인로 2780-3, 1층',
  '돼봉삼겹살 브랜드 물류 담당 — 돼봉삼겹살 상봉점(862-31-01565)과 별개 거래처.'
  || ' 대표 최선태 / 법인등록 135511-0438909 / 개업 2024-04-18 / 도매업·식품잡화.'
  || ' 명함 상호는 (주)굿에프엔비 — 이동언 이사, 사무실 031-313-2950, 팩스 031-314-2950.'
  || ' 사업자등록증 사업장 소재지(세금계산서 발행용): 서울특별시 금천구 금하로 763,'
  || ' 2층 205-피127호(시흥동, 벽산중심상가).'
  || ' address 컬럼에는 실제 물건 받는 배송지(시흥 물류센터)를 넣었음.',
  'seoul',      -- 육지 (신화 물류수수료 8.5%)
  TRUE,
  TRUE,         -- 선입금 — 발주 등록 시점에 예치금 차감
  500000        -- 최소 발주금액 50만원 (물류사 물량 기준, 2026-08-07 확정)
WHERE NOT EXISTS (
  SELECT 1 FROM public.b2b_customers WHERE business_number = '112-81-56636'
);

-- 재실행 시 정보만 최신화 (예치금 잔액 deposit_balance 는 제외 — 절대 초기화 금지)
UPDATE public.b2b_customers SET
  name             = '굿에프엔비브릿지 (돼봉물류)',
  contact_name     = '이동언 이사',
  contact_phone    = '010-2670-4851',
  contact_email    = 'salems@nate.com',
  address          = '경기도 시흥시 수인로 2780-3, 1층',
  region           = 'seoul',
  is_active        = TRUE,
  is_prepaid       = TRUE,
  min_order_amount = 500000,
  updated_at       = NOW()
 WHERE business_number = '112-81-56636';

-- ============================================================
-- 2. 발주 품목 단가 — 전용상품 7종 전체 개방 (박스 단위 only)
-- ============================================================
-- 돼봉 상봉점(2종)과 달리 이 거래처는 전용상품 전부를 발주할 수 있다.
-- 2026-08-07 확정 — 단가 기준: "기존 B2B 단가를 그대로 이어붙인다"
--
--   품목                단가(세전) 단가(세포함)  근거
--   ─────────────────  ────────  ──────────  ──────────────────────────
--   비빔전용장          120,880    132,968    돼봉·아워홈 동일 (=가맹판가)
--   생밀면               59,000     64,900    돼봉·아워홈·메이즈랜드 동일
--   양념장              116,220    127,842    돼봉 기준 (=가맹판가)
--   왕만두               62,400     68,640    아워홈 기준
--   아삭한김치왕만두70    62,400     68,640    아워홈 기준
--   육수간장             71,250     78,375    아워홈 기준
--   고기국수육수         44,000     48,400    B2B 전례 없음 → 가맹판가
--
-- 낱팩(pack)은 열지 않는다 — 팩 단가 반올림 끝전 이슈 회피.
--   (아워홈은 육수간장·비빔전용장에 팩이 열려 있지만 여기는 박스만)
-- ============================================================

INSERT INTO public.b2b_customer_product_prices (
  customer_id, product_id, b2b_price, b2b_price_with_tax, available_units, is_active
)
SELECT c.id, p.id, v.ex_tax, v.with_tax, ARRAY['box']::TEXT[], TRUE
  FROM (VALUES
          ('비빔전용장',         120880, 132968),
          ('생밀면',              59000,  64900),
          ('양념장',             116220, 127842),
          ('왕만두',              62400,  68640),
          ('아삭한김치왕만두70',   62400,  68640),
          ('육수간장',            71250,  78375),
          ('고기국수육수',        44000,  48400)
       ) AS v(pname, ex_tax, with_tax)
  JOIN public.products p
    ON p.name = v.pname AND p.product_type = 'exclusive'
  CROSS JOIN public.b2b_customers c
 WHERE c.business_number = '112-81-56636'
ON CONFLICT (customer_id, product_id) DO UPDATE SET
  b2b_price          = EXCLUDED.b2b_price,
  b2b_price_with_tax = EXCLUDED.b2b_price_with_tax,
  available_units    = EXCLUDED.available_units,
  is_active          = TRUE;

-- ------------------------------------------------------------
-- 안전장치: 7종이 다 안 들어갔으면 전부 되돌린다.
--   (상품명이 바뀌었거나 오타가 있으면 조용히 빠지는 걸 막는다)
-- ------------------------------------------------------------
DO $$
DECLARE v_cnt INT;
BEGIN
  SELECT COUNT(*) INTO v_cnt
    FROM public.b2b_customer_product_prices pr
    JOIN public.b2b_customers c ON c.id = pr.customer_id
   WHERE c.business_number = '112-81-56636' AND pr.is_active;

  IF v_cnt < 7 THEN
    RAISE EXCEPTION
      '단가가 7종이 아니라 %종만 등록됐습니다. 상품명이 바뀌었는지 확인하세요. (아무것도 저장되지 않았습니다)',
      v_cnt;
  END IF;
END $$;

COMMIT;

-- ============================================================
-- (검증용 — 실행 후 아래 3개를 따로 돌려서 확인)
-- ============================================================
--
-- 1) 거래처가 1건만 생겼는지 + 설정값 확인
--    → is_prepaid=true, deposit_balance=0, min_order_amount=500000, region=seoul
--    → address = 경기도 시흥시 수인로 2780-3, 1층 (배송지)
-- SELECT name, business_number, contact_name, contact_phone, address, region,
--        is_prepaid, deposit_balance, min_order_amount, is_active
--   FROM public.b2b_customers
--  ORDER BY created_at;
--
-- 2) 단가 7종이 다 들어갔는지 + 기존 거래처와 나란히 비교
--    → 굿에프엔비브릿지 7줄, 돼봉 상봉점 2줄, 아워홈 5줄
--    → 겹치는 품목은 숫자가 서로 같아야 함
-- SELECT p.name AS 상품, c.name AS 거래처,
--        pr.b2b_price AS 세전, pr.b2b_price_with_tax AS 세포함,
--        pr.available_units AS 단위, pr.is_active AS 활성
--   FROM public.b2b_customer_product_prices pr
--   JOIN public.b2b_customers c ON c.id = pr.customer_id
--   JOIN public.products      p ON p.id = pr.product_id
--  WHERE pr.is_active
--  ORDER BY p.name, c.name;
--
-- 2-1) 전용상품 중 빠진 게 없는지 (결과가 0줄이어야 정상)
-- SELECT p.name AS 누락상품
--   FROM public.products p
--  WHERE p.product_type = 'exclusive'
--    AND NOT EXISTS (
--      SELECT 1 FROM public.b2b_customer_product_prices pr
--        JOIN public.b2b_customers c ON c.id = pr.customer_id
--       WHERE pr.product_id = p.id AND c.business_number = '112-81-56636'
--    );
--
-- 3) 기존 거래처(아워홈·메이즈랜드·돼봉 상봉점)가 안 건드려졌는지
-- SELECT name, is_prepaid, deposit_balance, min_order_amount, updated_at
--   FROM public.b2b_customers
--  WHERE business_number IS DISTINCT FROM '112-81-56636'
--  ORDER BY name;
-- ============================================================
