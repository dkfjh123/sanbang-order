-- ============================================================
-- 044_add_exclusive_durucigi_sauce.sql
-- 전용상품 신규 등록 — 산방두루치기소스 (8번째 전용상품)
-- ============================================================
-- 근거: 비에이치푸드케어(주) 거래명세서 2026-08-03 (일련번호 2026/08/03-61)
--   품목  산방두루치기소스 [2KG*6개입]
--   수량  17박스 / 단가 63,000원(공급가) / 공급가액 1,071,000 / 부가세 107,100
--   배송지 (주)신화푸드 경기 광주시 곤지암읍 신대길 119
--
-- 확정 사항 (2026-08-18 사장님):
--   · 보관 = 냉장
--   · 낱팩(낱개) 판매 함 → is_loose_pack_sellable = TRUE
--     단 "낱개로 들어온 분량만 낱개로 판다". 박스를 헐어 낱팩을 만드는 일은 없다.
--     → allow_unit_change = FALSE (출고 시 박스→팩 단위변경 안 함)
--     가맹점 낱팩 발주는 원래부터 loose_pack_qty(낱팩 재고) 한도 안에서만 되고
--     박스를 분해하지 않으므로, 이 조합이 사장님 의도와 정확히 맞는다.
--     ※ 박스 분해가 일어나는 유일한 경로는 B2B 팩 출고다. 나중에 B2B 단가를 등록할 때
--       b2b_customer_product_prices.available_units 를 ['box'] 로만 두면 그 경로도 막힌다.
--   · 동래정 대흥점·신풍역점은 제외 (두 곳은 왕만두/아삭한김치왕만두70 만 주문 가능한
--     화이트리스트 매장이라, 여기에 넣지 않으면 자동으로 제외된다 → 아무 작업 없음)
--   · 나머지 가맹점 8곳은 화이트리스트가 비어 있어 '전체 허용' → 자동으로 주문 가능해짐
--   · B2B 공급 대상 → is_b2b_eligible = TRUE 로 표시.
--     단, B2B 발주 화면은 b2b_customer_product_prices(거래처별 단가)에 행이 있어야만
--     상품을 보여주므로, 단가를 넣기 전까지는 어느 거래처에도 노출되지 않는다.
--
-- 단가 (2026-08-18 사장님 제공 단가표 기준, 모두 부가세 포함):
--   ① 산방푸드 매입가        69,300   (= 명세서 단가 63,000 × 1.1)
--   ② 산방푸드 → 에프앤비    90,200   (산방푸드 마진 20,900 / 23.2%)
--   ⑤ 가맹점 최종 판매가    114,400   (세전 104,000)
--   ※ 단가표의 '물류수수료 12%' 칸은 시스템과 무관하다. 신화 물류수수료는
--     정산에서 가맹판가 × 지역요율(제주 12.5% / 육지 8.5%)로 자동 계산된다.
--     제주 기준 실제 수수료 14,300 → 에프앤비 마진 9,900 (8.7%), 통합 마진 30,800 (26.9%).
--
-- ★ is_active = FALSE(판매중지) 로 등록한다 — 단가는 다 넣지만 판매 개시는 별도 결정.
--   창고에 재고가 0 이라 어차피 주문은 서버에서 막히지만(재고 부족 에러),
--   발주 화면에 미리 보여 점주가 헛클릭하는 것을 막기 위해 꺼둔 채 시작한다.
--
--   [판매 개시할 때 할 일 — 딱 하나]
--   상품관리 화면 > 산방두루치기소스 > '판매중' 체크 > 저장 (비밀번호 확인 있음).
--   가격은 이미 다 들어가 있으므로 손댈 것이 없다.
--
--   [B2B 공급 시작할 때]
--   b2b_customer_product_prices 에 거래처별 단가를 등록해야 비로소 B2B 화면에 뜬다.
--
-- 재고: inventory 행을 0 으로 만들어 둔다. 실제 입고는 재고관리 화면 > 입/출고 등록 에서
--       박스분과 낱팩분을 각각 넣는다 (2026-08-18 실입고 = 16박스 + 2팩, 두 번 등록).
--       판매중지 상태여도 재고관리 화면에 보이도록, 그리고 낱팩 단위 입고가 가능하도록
--       같은 커밋에서 화면과 API 를 고쳤다.
--       ※ 8/3 거래명세서는 17박스(=102팩)인데 실입고는 16박스2팩(=98팩)으로 4팩(8KG) 적다.
--         실물이 16박스2팩인 것은 2026-08-18 사장님 확인 완료 → 시스템은 실물 기준으로 잡는다.
--         (매입 정산은 명세서 17박스 기준이므로, 차액은 별도 판단 사항)
--
-- 멱등성: 같은 이름의 전용상품이 이미 있으면 통째로 건너뛴다. 재실행 안전.
-- 절대원칙: 본인이 Supabase SQL Editor 에서 직접 실행. AI 는 파일만 생성.
-- 예상 소요: 1초 미만.
-- ============================================================

BEGIN;

DO $$
DECLARE
  v_id UUID;
BEGIN
  -- 멱등 가드 — 이미 등록돼 있으면 아무것도 하지 않는다
  SELECT id INTO v_id
    FROM public.products
   WHERE name = '산방두루치기소스' AND product_type = 'exclusive';

  IF v_id IS NOT NULL THEN
    RAISE NOTICE '산방두루치기소스가 이미 등록되어 있습니다 (id=%). 건너뜁니다.', v_id;
    RETURN;
  END IF;

  INSERT INTO public.products (
    name, category, product_type, brand, manufacturer,
    storage, unit, spec,
    price, price_with_tax, is_tax_free,
    cost_price, cost_price_with_tax,
    sanbang_food_sale_price_with_tax,
    pack_per_box, is_loose_pack_sellable, allow_unit_change,
    is_b2b_eligible, b2b_price, b2b_price_with_tax,
    sort_order, is_active
  ) VALUES (
    '산방두루치기소스',
    '소스/장류',
    'exclusive',
    '산방식당',
    '비에이치푸드케어',
    'refrigerated',
    'BOX',
    '12KG (2KG×6ea)',
    104000,     -- price (가맹점 판매가, 세전) = 114,400 ÷ 1.1
    114400,     -- price_with_tax (가맹점 판매가, 세포함)
    FALSE,      -- is_tax_free : 명세서에 부가세 107,100 부과 → 과세
    63000,      -- cost_price (매입가, 세전) = 1,071,000 ÷ 17박스
    69300,      -- cost_price_with_tax (매입가, 세포함) = 63,000 × 1.1
    90200,      -- sanbang_food_sale_price_with_tax (산방푸드 → 에프앤비/직영점 판매가)
    6,          -- pack_per_box : 2KG × 6개입
    TRUE,       -- is_loose_pack_sellable : 가맹점 낱팩 판매 허용 (낱팩 재고 한도 내에서만)
    FALSE,      -- allow_unit_change : 박스를 헐어 팩으로 바꾸는 일은 없음
    TRUE,       -- is_b2b_eligible : B2B 공급 대상 (실제 노출은 거래처별 단가 등록 후)
    0,          -- b2b_price — 미정
    0,          -- b2b_price_with_tax — 미정
    8,          -- sort_order : 전용상품 8번째
    FALSE       -- is_active : 입고 완료 후 상품관리 화면에서 '판매중'으로 켠다
  )
  RETURNING id INTO v_id;

  -- 재고 행 생성 (전부 0). 등식 on_hand = quantity + reserved 만족.
  INSERT INTO public.inventory (
    product_id, quantity, reserved, on_hand,
    loose_pack_qty, reserved_pack, on_hand_pack
  ) VALUES (v_id, 0, 0, 0, 0, 0, 0);

  RAISE NOTICE '산방두루치기소스 등록 완료 (id=%). 판매중지 상태이며 재고 0으로 시작합니다.', v_id;
END $$;

COMMIT;

-- ----------------------------------------------------------------
-- [확인] 등록 결과
-- ----------------------------------------------------------------
SELECT p.sort_order AS 순번, p.name AS 상품명, p.manufacturer AS 제조사,
       p.storage AS 보관, p.spec AS 규격, p.pack_per_box AS 박스입수,
       p.cost_price_with_tax AS 매입가_부포,
       p.sanbang_food_sale_price_with_tax AS 산방푸드판매가,
       p.price_with_tax AS 가맹점판매가,
       p.is_active AS 판매중,
       COALESCE(i.on_hand, 0) AS 총재고
  FROM public.products p
  LEFT JOIN public.inventory i ON i.product_id = p.id
 WHERE p.product_type = 'exclusive'
 ORDER BY p.sort_order;
