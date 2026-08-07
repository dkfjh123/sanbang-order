-- ============================================================
-- 041 / 042 실행 결과 확인용 — 읽기 전용 (SELECT만, 아무것도 안 바꿈)
-- ============================================================
-- 사용법: 아래 [확인 1] 블록만 통째로 복사 → SQL Editor 붙여넣기 → Run
--        그 다음 [확인 2], [확인 3] 도 하나씩 같은 방식으로.
--        한 번에 하나씩 돌려야 결과가 깔끔하게 보입니다.
-- ============================================================


-- ============================================================
-- [확인 1] 041 실행 후 — 새 거래처가 제대로 들어갔나 (자동 판정)
--   → 판정 칸이 전부 ✅ 면 정상입니다.
-- ============================================================

WITH c AS (
  SELECT * FROM public.b2b_customers WHERE business_number = '112-81-56636'
),
n AS (
  SELECT COUNT(*) AS cnt
    FROM public.b2b_customer_product_prices pr
    JOIN c ON c.id = pr.customer_id
   WHERE pr.is_active
)
SELECT 검사항목, 실제값, 판정 FROM (
  SELECT 1 AS 순서, '거래처가 만들어졌나' AS 검사항목,
         (SELECT COUNT(*) FROM c)::text || '건' AS 실제값,
         CASE WHEN (SELECT COUNT(*) FROM c) = 1 THEN '✅' ELSE '❌ 확인필요' END AS 판정
  UNION ALL
  SELECT 2, '발주 가능 품목이 7종인가',
         (SELECT cnt FROM n)::text || '종',
         CASE WHEN (SELECT cnt FROM n) = 7 THEN '✅' ELSE '❌ 확인필요' END
  UNION ALL
  SELECT 3, '결제방식이 선입금인가',
         COALESCE((SELECT CASE WHEN is_prepaid THEN '선입금' ELSE '후불' END FROM c), '거래처없음'),
         CASE WHEN (SELECT is_prepaid FROM c) THEN '✅' ELSE '❌ 확인필요' END
  UNION ALL
  SELECT 4, '최소 발주금액이 50만원인가',
         COALESCE((SELECT to_char(min_order_amount, 'FM999,999,999') FROM c), '-') || '원',
         CASE WHEN (SELECT min_order_amount FROM c) = 500000 THEN '✅' ELSE '❌ 확인필요' END
  UNION ALL
  SELECT 5, '권역이 육지(8.5%)인가',
         COALESCE((SELECT CASE WHEN region = 'seoul' THEN '육지 8.5%' ELSE '제주 12.5%' END FROM c), '-'),
         CASE WHEN (SELECT region FROM c) = 'seoul' THEN '✅' ELSE '❌ 확인필요' END
  UNION ALL
  SELECT 6, '배송지가 시흥 물류센터인가',
         COALESCE((SELECT address FROM c), '-'),
         CASE WHEN (SELECT address FROM c) = '경기도 시흥시 수인로 2780-3, 1층' THEN '✅' ELSE '❌ 확인필요' END
  UNION ALL
  SELECT 7, '예치금이 0원으로 시작하나',
         COALESCE((SELECT to_char(deposit_balance, 'FM999,999,999') FROM c), '-') || '원',
         CASE WHEN (SELECT deposit_balance FROM c) = 0 THEN '✅' ELSE '⚠️ 이미 충전됨(정상일 수 있음)' END
) t
ORDER BY 순서;


-- ============================================================
-- [확인 2] 041 실행 후 — 기존 거래처가 안 건드려졌나 (눈으로 확인)
--   → 굿에프엔비브릿지만 '최종수정'이 방금 시각.
--     아워홈·메이즈랜드·돼봉 상봉점의 '최종수정'이 예전 날짜 그대로면 정상.
--     ('최종수정' = 그 줄이 마지막으로 바뀐 시각. 오늘로 바뀌었으면 건드려진 것)
--   → '발주품목수' 도 확인: 돼봉 상봉점 2종 / 아워홈 5종 이 그대로여야 함.
-- ============================================================

SELECT c.name                                                   AS 거래처,
       c.business_number                                        AS 사업자번호,
       CASE WHEN c.is_prepaid THEN '선입금' ELSE '후불' END      AS 결제방식,
       to_char(c.deposit_balance,  'FM999,999,999') || '원'      AS 예치금,
       to_char(c.min_order_amount, 'FM999,999,999') || '원'      AS 최소발주,
       COUNT(pr.id) FILTER (WHERE pr.is_active)                  AS 발주품목수,
       to_char(c.updated_at AT TIME ZONE 'Asia/Seoul',
               'YYYY-MM-DD HH24:MI')                             AS 최종수정
  FROM public.b2b_customers c
  LEFT JOIN public.b2b_customer_product_prices pr ON pr.customer_id = c.id
 GROUP BY c.id
 ORDER BY c.created_at;


-- ============================================================
-- [확인 3] 042 실행 후 — 로그인 계정이 제대로 묶였나
--   → 두 줄이 나오고, '연결거래처'가 서로 달라야 정상.
--     dbpork@naver.com  → 돼봉삼겹살 상봉점
--     salems@nate.com   → 굿에프엔비브릿지 (돼봉물류)
-- ============================================================

SELECT pr.email              AS 아이디,
       c.name                AS 연결거래처,
       c.business_number     AS 사업자번호,
       pr.role               AS 역할
  FROM public.profiles pr
  LEFT JOIN public.b2b_customers c ON c.id = pr.b2b_customer_id
 WHERE pr.role = 'b2b'
 ORDER BY pr.email;
