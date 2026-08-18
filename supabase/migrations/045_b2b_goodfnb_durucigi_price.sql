-- ============================================================
-- 045_b2b_goodfnb_durucigi_price.sql
-- 굿에프엔비브릿지(돼봉물류) 단가에 산방두루치기소스 추가 — 8종째
-- ============================================================
-- 확정 (2026-08-18 사장님): **돼봉 단가 = 가맹점 판매가와 동일**
--   세전 104,000 / 부가세 포함 114,400
--
-- 대상 거래처: 굿에프엔비브릿지(돼봉물류) — 사업자번호 112-81-56636
--   ※ 돼봉삼겹살 상봉점(862-31-01565)에는 넣지 않았다.
--     상봉점은 생밀면·비빔전용장 2종만 쓰는 개별 점포이고 양념장도 이미 비활성 처리되어
--     물류사로 정리되는 흐름이라, 물류사에만 추가하는 것이 자연스럽다.
--     상봉점에도 열려면 아래 WHERE 의 사업자번호만 바꿔 한 번 더 실행하면 된다.
--
-- 단위: 박스만(['box']). 낱팩을 열지 않는 이유 2가지
--   1) 박스가 쪼개지는 유일한 경로가 B2B 팩 출고다. 사장님 방침 "박스는 안 쪼갠다" 유지.
--   2) 팩 단가 부가세 끝전 차이 이슈 회피 (아워홈 사례, 041 주석과 같은 이유).
--
-- 참고 수익 (육지 8.5% 기준):
--   114,400 − 산방푸드 판매가 90,200 − 신화 물류수수료 9,724 = 에프앤비 마진 14,476 (12.7%)
--
-- 선행조건: 044(산방두루치기소스 등록)가 먼저 적용돼 있어야 한다.
--           044 는 2026-08-18 12:23 적용 완료 확인함.
--
-- 멱등성: ON CONFLICT DO UPDATE — 여러 번 실행해도 안전.
--         예치금 잔액은 건드리지 않는다.
-- 절대원칙: 본인이 Supabase SQL Editor 에서 직접 실행. AI 는 파일만 생성.
-- 예상 소요: 1초 미만.
-- ============================================================

BEGIN;

INSERT INTO public.b2b_customer_product_prices (
  customer_id, product_id, b2b_price, b2b_price_with_tax, available_units, is_active
)
SELECT c.id, p.id, v.ex_tax, v.with_tax, ARRAY['box']::TEXT[], TRUE
  FROM (VALUES
          ('산방두루치기소스', 104000, 114400)
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
-- 안전장치: 8종이 다 안 들어갔으면 전부 되돌린다.
--   (상품이 아직 등록 안 됐거나 이름이 다르면 조용히 빠지는 것을 막는다)
-- ------------------------------------------------------------
DO $$
DECLARE v_cnt INT;
BEGIN
  SELECT COUNT(*) INTO v_cnt
    FROM public.b2b_customer_product_prices pr
    JOIN public.b2b_customers c ON c.id = pr.customer_id
   WHERE c.business_number = '112-81-56636' AND pr.is_active;

  IF v_cnt < 8 THEN
    RAISE EXCEPTION
      '단가가 8종이 아니라 %종만 등록됐습니다. 044(산방두루치기소스 등록)를 먼저 실행했는지 확인하세요. (아무것도 저장되지 않았습니다)',
      v_cnt;
  END IF;
END $$;

COMMIT;

-- ----------------------------------------------------------------
-- [확인] 굿에프엔비브릿지 단가 8종
-- ----------------------------------------------------------------
SELECT p.sort_order AS 순번,
       p.name AS 상품명,
       pr.b2b_price AS 돼봉단가_세전,
       pr.b2b_price_with_tax AS 돼봉단가_부포,
       p.price_with_tax AS 가맹점판가,
       pr.b2b_price_with_tax - p.price_with_tax AS 가맹대비차액,
       pr.available_units AS 주문단위,
       pr.is_active AS 활성
  FROM public.b2b_customer_product_prices pr
  JOIN public.b2b_customers c ON c.id = pr.customer_id
  JOIN public.products p      ON p.id = pr.product_id
 WHERE c.business_number = '112-81-56636'
 ORDER BY p.sort_order;
