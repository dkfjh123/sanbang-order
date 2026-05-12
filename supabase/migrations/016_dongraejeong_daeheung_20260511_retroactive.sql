-- ============================================================
-- 산방식당 — 동래정 대흥점 2026-05-11 입금·출고 수기 반영
-- ============================================================
-- 배경:
--   계정 생성(2026-05-12) 이전인 5/11 (월)에 점주가 산방에프앤비에 ₩122,100 입금하고
--   왕만두 2박스를 출고 받았음. 시스템 외에서 처리된 건이라 다음 항목을 수기로 보정:
--     1) orders + order_items  → /shipments, 정산관리 1·2섹션, 신화푸드 수수료 정산 반영
--     2) inventory −2 박스 + inventory_transactions outbound  → 재고관리 일치
--     3) deposit_transactions: 입금 +122,100, 발주차감 −122,100 → 잔액 0으로 종료
--
-- 멱등성:
--   같은 매장의 2026-05-11 출고가 이미 존재하면 RAISE NOTICE 후 종료. 재실행 안전.

DO $$
DECLARE
  v_store_id UUID;
  v_product_id UUID;
  v_admin_id UUID;
  v_order_id UUID;
  v_unit_price BIGINT;
  v_unit_price_with_tax BIGINT;
  v_is_tax_free BOOLEAN;
  v_pack_per_box INT;
  v_total BIGINT;
  v_seq BIGINT;
  v_order_number TEXT;
  v_ship_ts TIMESTAMPTZ := TIMESTAMPTZ '2026-05-11 10:00:00+09';
  v_deposit_ts TIMESTAMPTZ := TIMESTAMPTZ '2026-05-11 09:00:00+09';
BEGIN
  -- 매장 / 상품 / 관리자 ID 조회
  SELECT id INTO v_store_id
    FROM public.stores
    WHERE short_name = '동래정 대흥점';
  IF v_store_id IS NULL THEN
    RAISE EXCEPTION '동래정 대흥점 매장을 찾을 수 없습니다. 015 마이그레이션이 먼저 적용됐는지 확인하세요.';
  END IF;

  SELECT id, price, price_with_tax, is_tax_free, pack_per_box
    INTO v_product_id, v_unit_price, v_unit_price_with_tax, v_is_tax_free, v_pack_per_box
    FROM public.products
    WHERE name = '왕만두';
  IF v_product_id IS NULL THEN
    RAISE EXCEPTION '왕만두 상품을 찾을 수 없습니다.';
  END IF;

  SELECT id INTO v_admin_id
    FROM public.profiles
    WHERE email = 'dkfjh1234@gmail.com' AND role = 'admin'
    LIMIT 1;
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION '관리자(dkfjh1234@gmail.com) 프로필을 찾을 수 없습니다.';
  END IF;

  -- 멱등성 가드: 이미 동일 매장 5/11 출고 기록이 있으면 종료
  IF EXISTS (
    SELECT 1 FROM public.orders
    WHERE store_id = v_store_id AND ship_date = DATE '2026-05-11'
  ) THEN
    RAISE NOTICE '동래정 대흥점 2026-05-11 출고 기록이 이미 존재합니다. 건너뜁니다.';
    RETURN;
  END IF;

  v_total := 2 * v_unit_price_with_tax;
  v_seq := nextval('order_number_seq');
  v_order_number := 'ORD-20260511-' || LPAD(v_seq::TEXT, 4, '0');

  -- 1) orders
  INSERT INTO public.orders (
    order_number, store_id, ordered_by,
    status, total_amount, memo,
    ship_date, created_at
  ) VALUES (
    v_order_number, v_store_id, v_admin_id,
    'confirmed', v_total,
    '수기 반영: 계정 생성 이전 입금·출고분 (2026-05-11)',
    DATE '2026-05-11', v_ship_ts
  )
  RETURNING id INTO v_order_id;

  -- 2) order_items (왕만두 2박스)
  INSERT INTO public.order_items (
    order_id, product_id, product_name, product_type,
    quantity, unit_price, unit_price_with_tax,
    is_tax_free, subtotal, unit, pack_per_box, ship_date
  ) VALUES (
    v_order_id, v_product_id, '왕만두', 'exclusive',
    2, v_unit_price, v_unit_price_with_tax,
    v_is_tax_free, v_total, 'box', COALESCE(v_pack_per_box, 1), DATE '2026-05-11'
  );

  -- 3) inventory 차감 (-2 박스)
  UPDATE public.inventory
  SET quantity = quantity - 2,
      updated_at = NOW()
  WHERE product_id = v_product_id;

  -- 4) inventory_transactions outbound
  INSERT INTO public.inventory_transactions (
    product_id, type, quantity, description, created_by, created_at
  ) VALUES (
    v_product_id, 'outbound', -2,
    '발주 출고 (' || v_order_number || ') - 동래정 대흥점 [수기 반영]',
    v_admin_id, v_ship_ts
  );

  -- 5) deposit_transactions: 입금 +122,100 (5/11 09:00)
  INSERT INTO public.deposit_transactions (
    store_id, type, amount, balance_after, description, created_by, created_at
  ) VALUES (
    v_store_id, 'deposit', v_total, v_total,
    '입금 (수기 반영: 계정 생성 이전 처리분)',
    v_admin_id, v_deposit_ts
  );

  -- 6) deposit_transactions: 발주 차감 −122,100 (5/11 10:00)
  INSERT INTO public.deposit_transactions (
    store_id, type, amount, balance_after, description, order_id, created_by, created_at
  ) VALUES (
    v_store_id, 'order_deduct', -v_total, 0,
    '발주 차감 (' || v_order_number || ')',
    v_order_id, v_admin_id, v_ship_ts
  );

  -- 7) stores.deposit_balance 0으로 확정 (이미 0이지만 명시적으로)
  UPDATE public.stores
  SET deposit_balance = 0, updated_at = NOW()
  WHERE id = v_store_id;

  RAISE NOTICE '동래정 대흥점 % 출고 기록 완료 (왕만두 2박스, ₩%)', v_order_number, v_total;
END $$;
