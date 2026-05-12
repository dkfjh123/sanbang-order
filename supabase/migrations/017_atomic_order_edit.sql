-- ============================================================
-- 산방식당 — 기존 가맹점 발주 수정 원자 처리
-- ============================================================
-- 주문 품목, 주문 총액, 재고, 예치금 변경을 하나의 DB 트랜잭션에서 처리한다.
-- 중간 단계에서 재고 부족/예치금 부족/삽입 오류가 발생하면 전체 변경이 롤백된다.

CREATE OR REPLACE FUNCTION public.update_store_order_items_atomic(
  p_order_id UUID,
  p_items JSONB,
  p_actor UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order RECORD;
  v_store RECORD;
  v_item RECORD;
  v_old_qty_map JSONB := '{}'::JSONB;
  v_new_qty_map JSONB := '{}'::JSONB;
  v_key TEXT;
  v_product_id UUID;
  v_unit TEXT;
  v_old_qty INT;
  v_new_qty INT;
  v_qty_diff INT;
  v_new_total BIGINT := 0;
  v_diff BIGINT := 0;
  v_updated_inventory INT;
  v_inventory_qty INT;
  v_new_balance BIGINT;
  v_product_type TEXT;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION '상품을 선택해주세요.';
  END IF;

  SELECT o.*
    INTO v_order
    FROM public.orders o
   WHERE o.id = p_order_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '주문을 찾을 수 없습니다.';
  END IF;

  SELECT s.*
    INTO v_store
    FROM public.stores s
   WHERE s.id = v_order.store_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '가맹점을 찾을 수 없습니다.';
  END IF;

  FOR v_item IN
    SELECT *
      FROM jsonb_to_recordset(p_items) AS x(
        product_id UUID,
        product_name TEXT,
        product_type TEXT,
        quantity INT,
        unit_price BIGINT,
        unit_price_with_tax BIGINT,
        is_tax_free BOOLEAN,
        unit TEXT,
        pack_per_box INT
      )
  LOOP
    IF v_item.product_id IS NULL THEN
      RAISE EXCEPTION '상품 정보가 올바르지 않습니다.';
    END IF;
    IF v_item.product_name IS NULL OR btrim(v_item.product_name) = '' THEN
      RAISE EXCEPTION '상품명이 올바르지 않습니다.';
    END IF;
    IF v_item.product_type NOT IN ('exclusive', 'general') THEN
      RAISE EXCEPTION '상품 구분이 올바르지 않습니다.';
    END IF;
    IF v_item.quantity IS NULL OR v_item.quantity <= 0 THEN
      RAISE EXCEPTION '상품 수량은 1개 이상이어야 합니다.';
    END IF;
    IF v_item.unit_price IS NULL OR v_item.unit_price < 0
       OR v_item.unit_price_with_tax IS NULL OR v_item.unit_price_with_tax < 0 THEN
      RAISE EXCEPTION '상품 단가가 올바르지 않습니다.';
    END IF;
    IF COALESCE(v_item.unit, 'box') NOT IN ('box', 'pack') THEN
      RAISE EXCEPTION '상품 단위가 올바르지 않습니다.';
    END IF;
    IF COALESCE(v_item.pack_per_box, 1) < 1 THEN
      RAISE EXCEPTION '박스 입수가 올바르지 않습니다.';
    END IF;

    v_new_total := v_new_total + (v_item.unit_price_with_tax * v_item.quantity);
    v_key := v_item.product_id::TEXT || '|' || COALESCE(v_item.unit, 'box');
    v_new_qty_map := jsonb_set(
      v_new_qty_map,
      ARRAY[v_key],
      to_jsonb(COALESCE((v_new_qty_map ->> v_key)::INT, 0) + v_item.quantity),
      TRUE
    );
  END LOOP;

  IF v_new_total < COALESCE(v_store.min_order_amount, 150000) THEN
    RAISE EXCEPTION '최소발주금액은 %원입니다.', to_char(COALESCE(v_store.min_order_amount, 150000), 'FM999,999,999,999');
  END IF;

  v_diff := v_new_total - v_order.total_amount;
  IF NOT v_store.is_direct AND v_diff > 0 AND v_store.deposit_balance < v_diff THEN
    RAISE EXCEPTION '예치금이 부족합니다. 추가 필요 금액: %원', to_char(v_diff, 'FM999,999,999,999');
  END IF;

  FOR v_item IN
    SELECT product_id, quantity, COALESCE(unit, 'box') AS unit
      FROM public.order_items
     WHERE order_id = p_order_id
       AND product_id IS NOT NULL
  LOOP
    v_key := v_item.product_id::TEXT || '|' || v_item.unit;
    v_old_qty_map := jsonb_set(
      v_old_qty_map,
      ARRAY[v_key],
      to_jsonb(COALESCE((v_old_qty_map ->> v_key)::INT, 0) + v_item.quantity),
      TRUE
    );
  END LOOP;

  FOR v_key IN
    SELECT jsonb_object_keys(v_old_qty_map || v_new_qty_map)
  LOOP
    v_product_id := split_part(v_key, '|', 1)::UUID;
    v_unit := split_part(v_key, '|', 2);
    v_old_qty := COALESCE((v_old_qty_map ->> v_key)::INT, 0);
    v_new_qty := COALESCE((v_new_qty_map ->> v_key)::INT, 0);
    v_qty_diff := v_new_qty - v_old_qty;

    IF v_qty_diff = 0 THEN
      CONTINUE;
    END IF;

    IF v_unit = 'box' THEN
      SELECT product_type
        INTO v_product_type
        FROM public.products
       WHERE id = v_product_id;

      SELECT quantity
        INTO v_inventory_qty
        FROM public.inventory
       WHERE product_id = v_product_id
       FOR UPDATE;

      IF NOT FOUND THEN
        IF v_qty_diff > 0 AND v_product_type = 'exclusive' THEN
          RAISE EXCEPTION '재고가 부족하여 수량을 변경할 수 없습니다.';
        END IF;
        CONTINUE;
      END IF;

      v_updated_inventory := v_inventory_qty - v_qty_diff;
      IF v_updated_inventory < 0 THEN
        RAISE EXCEPTION '재고가 부족하여 수량을 변경할 수 없습니다.';
      END IF;

      UPDATE public.inventory
         SET quantity = v_updated_inventory,
             updated_at = NOW()
       WHERE product_id = v_product_id;

      INSERT INTO public.inventory_transactions (
        product_id, type, quantity, unit, description, created_by
      ) VALUES (
        v_product_id,
        CASE WHEN v_qty_diff > 0 THEN 'outbound' ELSE 'inbound' END,
        -v_qty_diff,
        'box',
        '발주 수정 (' || v_order.order_number || ') - ' ||
          CASE WHEN v_qty_diff > 0 THEN '추가 출고' ELSE '수량 감소 복구' END,
        p_actor
      );
    ELSE
      PERFORM public.apply_b2b_inventory_delta(
        v_product_id,
        'pack',
        v_qty_diff,
        '발주 수정 (' || v_order.order_number || ') · 낱팩 ' ||
          CASE WHEN v_qty_diff > 0 THEN '추가' ELSE '감소' END,
        p_actor
      );
    END IF;
  END LOOP;

  DELETE FROM public.order_items
   WHERE order_id = p_order_id;

  INSERT INTO public.order_items (
    order_id,
    product_id,
    product_name,
    product_type,
    quantity,
    unit_price,
    unit_price_with_tax,
    is_tax_free,
    subtotal,
    unit,
    pack_per_box,
    ship_date
  )
  SELECT
    p_order_id,
    x.product_id,
    x.product_name,
    x.product_type,
    x.quantity,
    x.unit_price,
    x.unit_price_with_tax,
    COALESCE(x.is_tax_free, FALSE),
    x.unit_price_with_tax * x.quantity,
    COALESCE(x.unit, 'box'),
    COALESCE(x.pack_per_box, 1),
    v_order.ship_date
  FROM jsonb_to_recordset(p_items) AS x(
    product_id UUID,
    product_name TEXT,
    product_type TEXT,
    quantity INT,
    unit_price BIGINT,
    unit_price_with_tax BIGINT,
    is_tax_free BOOLEAN,
    unit TEXT,
    pack_per_box INT
  );

  UPDATE public.orders
     SET total_amount = v_new_total
   WHERE id = p_order_id;

  v_new_balance := v_store.deposit_balance;
  IF NOT v_store.is_direct AND v_diff <> 0 THEN
    UPDATE public.stores
       SET deposit_balance = deposit_balance - v_diff
     WHERE id = v_store.id
     RETURNING deposit_balance INTO v_new_balance;

    INSERT INTO public.deposit_transactions (
      store_id, type, amount, balance_after, description, order_id, created_by
    ) VALUES (
      v_store.id,
      'adjustment',
      -v_diff,
      v_new_balance,
      '발주 수정 (' || v_order.order_number || ')',
      p_order_id,
      p_actor
    );
  END IF;

  RETURN jsonb_build_object(
    'success', TRUE,
    'total_amount', v_new_total,
    'diff_amount', v_diff,
    'deposit_balance', v_new_balance
  );
END;
$$;

REVOKE ALL ON FUNCTION public.update_store_order_items_atomic(UUID, JSONB, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_store_order_items_atomic(UUID, JSONB, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.update_store_order_items_atomic(UUID, JSONB, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.update_store_order_items_atomic(UUID, JSONB, UUID) TO service_role;
