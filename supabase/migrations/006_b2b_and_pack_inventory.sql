-- ============================================================
-- 산방식당 발주시스템 — Phase 6: B2B(아워홈) 채널 + 팩 단위 재고
-- ============================================================
-- 원칙: 기존 스키마/로직/데이터에 영향을 주지 않는다.
--   1) products / inventory / inventory_transactions 는 ADD COLUMN 만 수행.
--      모든 신규 컬럼은 DEFAULT 값을 가져 기존 로우가 자동으로 호환됨.
--   2) B2B 관련 테이블은 전부 신규로 추가. 기존 orders/order_items 와 분리.
--   3) 기존 가맹점 발주/재고 조정 코드 경로는 신규 컬럼을 건드리지 않아도
--      동일하게 동작한다. (loose_pack_qty 는 DEFAULT 0, pack_per_box 는 DEFAULT 1)
--   4) 낱팩 가맹점 판매는 옵트인(is_loose_pack_sellable DEFAULT FALSE)이라
--      가맹점 화면에 당장은 노출되지 않는다.
-- ============================================================

-- ============================================================
-- 1. products: 박스 입수 + B2B 가격 + 낱팩 판매 플래그
-- ============================================================
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS pack_per_box INT NOT NULL DEFAULT 1
    CHECK (pack_per_box >= 1),
  ADD COLUMN IF NOT EXISTS b2b_price BIGINT NOT NULL DEFAULT 0,            -- 아워홈 공급가(세전)
  ADD COLUMN IF NOT EXISTS b2b_price_with_tax BIGINT NOT NULL DEFAULT 0,   -- 아워홈 공급가(세포함)
  ADD COLUMN IF NOT EXISTS is_b2b_eligible BOOLEAN NOT NULL DEFAULT FALSE, -- B2B 발주 대상 여부
  ADD COLUMN IF NOT EXISTS is_loose_pack_sellable BOOLEAN NOT NULL DEFAULT FALSE; -- 가맹점에 낱팩 판매 허용

-- ============================================================
-- 2. inventory: 낱팩 재고 추가 (기존 quantity = 박스 그대로 유지)
-- ============================================================
ALTER TABLE public.inventory
  ADD COLUMN IF NOT EXISTS loose_pack_qty INT NOT NULL DEFAULT 0
    CHECK (loose_pack_qty >= 0);

-- ============================================================
-- 3. inventory_transactions: 단위 구분 추가 (기존 로우는 자동으로 'box')
-- ============================================================
ALTER TABLE public.inventory_transactions
  ADD COLUMN IF NOT EXISTS unit TEXT NOT NULL DEFAULT 'box'
    CHECK (unit IN ('box', 'pack'));

-- ============================================================
-- 4. b2b_customers (B2B 거래처 — 현재는 아워홈 1건)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.b2b_customers (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  business_number TEXT,
  contact_name TEXT,
  contact_phone TEXT,
  contact_email TEXT,
  address TEXT,
  memo TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.b2b_customers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_b2b_customers_all" ON public.b2b_customers
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

CREATE TRIGGER b2b_customers_updated_at
  BEFORE UPDATE ON public.b2b_customers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- 5. b2b_orders (B2B 발주 — 관리자가 이메일 받아서 수동 입력)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.b2b_orders (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_number TEXT UNIQUE NOT NULL,
  b2b_customer_id UUID NOT NULL REFERENCES public.b2b_customers(id),
  ordered_by UUID NOT NULL REFERENCES auth.users(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'shipped', 'cancelled')),
  total_amount BIGINT NOT NULL DEFAULT 0,         -- 세포함 합계
  total_amount_ex_tax BIGINT NOT NULL DEFAULT 0,  -- 세전 합계
  memo TEXT,
  order_date DATE NOT NULL DEFAULT CURRENT_DATE,  -- 이메일 받은 일자
  ship_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.b2b_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_b2b_orders_all" ON public.b2b_orders
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

CREATE TRIGGER b2b_orders_updated_at
  BEFORE UPDATE ON public.b2b_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX IF NOT EXISTS idx_b2b_orders_customer ON public.b2b_orders (b2b_customer_id, order_date DESC);
CREATE INDEX IF NOT EXISTS idx_b2b_orders_ship_date ON public.b2b_orders (ship_date);

-- ============================================================
-- 6. b2b_order_items (B2B 발주 상세 — 박스/팩 혼합)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.b2b_order_items (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES public.b2b_orders(id) ON DELETE CASCADE,
  product_id UUID REFERENCES public.products(id),
  product_name TEXT NOT NULL,             -- 스냅샷
  unit TEXT NOT NULL CHECK (unit IN ('box', 'pack')),
  quantity INT NOT NULL CHECK (quantity > 0),
  pack_per_box INT NOT NULL CHECK (pack_per_box >= 1), -- 스냅샷(재고 차감 계산 기준)
  unit_price BIGINT NOT NULL,             -- 세전 단가
  unit_price_with_tax BIGINT NOT NULL,    -- 세포함 단가
  is_tax_free BOOLEAN DEFAULT FALSE,
  subtotal BIGINT NOT NULL,               -- 세포함 합계
  subtotal_ex_tax BIGINT NOT NULL,        -- 세전 합계
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.b2b_order_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_b2b_order_items_all" ON public.b2b_order_items
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

CREATE INDEX IF NOT EXISTS idx_b2b_order_items_order ON public.b2b_order_items (order_id);

-- ============================================================
-- 7. b2b_order_logs (B2B 주문 변경 이력)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.b2b_order_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES public.b2b_orders(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  description TEXT,
  changed_by UUID REFERENCES auth.users(id),
  changed_by_name TEXT,
  changed_by_role TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.b2b_order_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_b2b_order_logs_all" ON public.b2b_order_logs
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- ============================================================
-- 8. B2B 주문번호 시퀀스
-- ============================================================
CREATE SEQUENCE IF NOT EXISTS b2b_order_number_seq START 1;

-- ============================================================
-- 9. 재고 차감 RPC — 박스/낱팩 이원 재고 안전 조정
-- ============================================================
-- 원칙:
--   - 박스 발주(unit='box', qty=N): inventory.quantity -= N
--   - 팩 발주 (unit='pack', qty=K):
--       1) 낱팩 재고에서 먼저 차감 (loose_pack_qty -= min(K, loose_pack_qty))
--       2) 남은 수량이 있으면 박스를 깨서 충당:
--          필요 박스 = ceil(remain / pack_per_box)
--          quantity -= 필요 박스
--          loose_pack_qty += (필요 박스 * pack_per_box - remain)  (남은 낱팩)
--   - 낱팩 승격: loose_pack_qty >= pack_per_box 이면
--          quantity += floor(loose_pack_qty / pack_per_box)
--          loose_pack_qty := loose_pack_qty % pack_per_box
-- 음수 재고는 허용하지 않음 (예외 발생).
--
-- p_delta: 양수=차감(출고), 음수=복구(취소). 기존 inventory 로직과 혼선 방지를 위해
--          B2B 전용 함수로 분리하고, 기존 가맹점 발주 경로는 건드리지 않는다.
-- ============================================================
CREATE OR REPLACE FUNCTION public.apply_b2b_inventory_delta(
  p_product_id UUID,
  p_unit TEXT,        -- 'box' | 'pack'
  p_delta INT,        -- 양수 = 출고(차감), 음수 = 복구(가산)
  p_description TEXT,
  p_actor UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_pack_per_box INT;
  v_box_qty INT;
  v_loose_qty INT;
  v_abs INT := ABS(p_delta);
  v_outbound BOOLEAN := (p_delta > 0);
  v_need_packs INT;
  v_from_loose INT;
  v_remain INT;
  v_need_boxes INT;
  v_leftover INT;
BEGIN
  IF p_unit NOT IN ('box', 'pack') THEN
    RAISE EXCEPTION 'invalid unit: %', p_unit;
  END IF;
  IF p_delta = 0 THEN
    RETURN;
  END IF;

  SELECT pack_per_box INTO v_pack_per_box
    FROM public.products WHERE id = p_product_id;
  IF v_pack_per_box IS NULL THEN
    RAISE EXCEPTION 'product not found: %', p_product_id;
  END IF;

  -- 재고 로우 확보 (없으면 생성)
  INSERT INTO public.inventory (product_id, quantity, loose_pack_qty)
  VALUES (p_product_id, 0, 0)
  ON CONFLICT (product_id) DO NOTHING;

  SELECT quantity, loose_pack_qty INTO v_box_qty, v_loose_qty
    FROM public.inventory WHERE product_id = p_product_id FOR UPDATE;

  IF p_unit = 'box' THEN
    IF v_outbound THEN
      IF v_box_qty < v_abs THEN
        RAISE EXCEPTION '박스 재고 부족: 보유 %, 필요 %', v_box_qty, v_abs;
      END IF;
      v_box_qty := v_box_qty - v_abs;
    ELSE
      v_box_qty := v_box_qty + v_abs;
    END IF;

  ELSE -- 'pack'
    IF v_outbound THEN
      v_need_packs := v_abs;
      v_from_loose := LEAST(v_loose_qty, v_need_packs);
      v_loose_qty := v_loose_qty - v_from_loose;
      v_remain := v_need_packs - v_from_loose;
      IF v_remain > 0 THEN
        v_need_boxes := CEIL(v_remain::NUMERIC / v_pack_per_box)::INT;
        IF v_box_qty < v_need_boxes THEN
          RAISE EXCEPTION '재고 부족: 박스 %, 낱팩 %, 필요팩 %', v_box_qty, v_loose_qty + v_from_loose, v_abs;
        END IF;
        v_box_qty := v_box_qty - v_need_boxes;
        v_leftover := v_need_boxes * v_pack_per_box - v_remain;
        v_loose_qty := v_loose_qty + v_leftover;
      END IF;
    ELSE
      -- 복구: 낱팩에 더한 뒤 박스로 승격
      v_loose_qty := v_loose_qty + v_abs;
      IF v_loose_qty >= v_pack_per_box THEN
        v_box_qty := v_box_qty + (v_loose_qty / v_pack_per_box);
        v_loose_qty := v_loose_qty % v_pack_per_box;
      END IF;
    END IF;
  END IF;

  UPDATE public.inventory
     SET quantity = v_box_qty,
         loose_pack_qty = v_loose_qty,
         updated_at = NOW()
   WHERE product_id = p_product_id;

  INSERT INTO public.inventory_transactions (
    product_id, type, quantity, unit, description, created_by
  ) VALUES (
    p_product_id,
    CASE WHEN v_outbound THEN 'outbound' ELSE 'inbound' END,
    v_abs,
    p_unit,
    p_description,
    p_actor
  );
END;
$$;

-- 관리자만 호출 가능 (함수 내부는 SECURITY DEFINER 지만 호출 권한은 분리)
REVOKE ALL ON FUNCTION public.apply_b2b_inventory_delta(UUID, TEXT, INT, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_b2b_inventory_delta(UUID, TEXT, INT, TEXT, UUID) TO authenticated;
