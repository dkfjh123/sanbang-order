-- ============================================================
-- 산방식당 발주시스템 — Phase 2: 핵심 테이블 (products, orders, inventory, notices 등)
-- ============================================================

-- ============================================================
-- 1. products (상품)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.products (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  product_type TEXT NOT NULL CHECK (product_type IN ('exclusive', 'general')),
  unit TEXT NOT NULL,
  spec TEXT,
  price BIGINT NOT NULL,               -- 공급가(세전)
  price_with_tax BIGINT NOT NULL,       -- 판매가(세포함)
  is_tax_free BOOLEAN DEFAULT FALSE,
  storage TEXT CHECK (storage IN ('frozen', 'refrigerated', 'room_temp')),
  cost_price BIGINT DEFAULT 0,          -- 매입원가(세전) - 정산용
  cost_price_with_tax BIGINT DEFAULT 0, -- 매입원가(세포함) - 정산용
  sort_order INT DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

-- 관리자: 전체 접근
CREATE POLICY "admin_products_all" ON public.products
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- 가맹점/신화: 조회만
CREATE POLICY "store_read_products" ON public.products
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('store', 'shinwa'))
  );

-- 신화푸드: 범용상품 수정 가능
CREATE POLICY "shinwa_manage_general_products" ON public.products
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'shinwa')
    AND product_type = 'general'
  );

CREATE TRIGGER products_updated_at
  BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- 2. orders (주문)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.orders (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_number TEXT UNIQUE NOT NULL,
  store_id UUID NOT NULL REFERENCES public.stores(id),
  ordered_by UUID NOT NULL REFERENCES auth.users(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'shipping', 'delivered', 'cancelled')),
  total_amount BIGINT NOT NULL DEFAULT 0,
  memo TEXT,
  ship_date DATE,
  delivery_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

-- 관리자: 전체 접근
CREATE POLICY "admin_orders_all" ON public.orders
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- 가맹점: 자기 매장 주문만
CREATE POLICY "store_read_own_orders" ON public.orders
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'store' AND store_id = orders.store_id)
  );

CREATE POLICY "store_insert_own_orders" ON public.orders
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'store' AND store_id = orders.store_id)
  );

CREATE POLICY "store_update_own_orders" ON public.orders
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'store' AND store_id = orders.store_id)
  );

-- 신화푸드: 전체 주문 조회 + 상태 변경
CREATE POLICY "shinwa_read_all_orders" ON public.orders
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'shinwa')
  );

CREATE POLICY "shinwa_update_orders" ON public.orders
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'shinwa')
  );

CREATE TRIGGER orders_updated_at
  BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- 3. order_items (주문 상세)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.order_items (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  product_id UUID REFERENCES public.products(id),
  product_name TEXT NOT NULL,
  product_type TEXT NOT NULL CHECK (product_type IN ('exclusive', 'general')),
  quantity INT NOT NULL CHECK (quantity > 0),
  unit_price BIGINT NOT NULL,
  unit_price_with_tax BIGINT NOT NULL,
  is_tax_free BOOLEAN DEFAULT FALSE,
  subtotal BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;

-- 관리자: 전체 접근
CREATE POLICY "admin_order_items_all" ON public.order_items
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- 가맹점: 자기 주문 항목만
CREATE POLICY "store_read_own_items" ON public.order_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.orders o
      JOIN public.profiles p ON p.id = auth.uid()
      WHERE o.id = order_items.order_id AND p.role = 'store' AND p.store_id = o.store_id
    )
  );

-- 신화푸드: 전체 조회
CREATE POLICY "shinwa_read_all_items" ON public.order_items
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'shinwa')
  );

-- ============================================================
-- 4. order_logs (주문 변경 이력)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.order_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  description TEXT,
  changed_by UUID REFERENCES auth.users(id),
  changed_by_name TEXT,
  changed_by_role TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.order_logs ENABLE ROW LEVEL SECURITY;

-- 관리자: 전체 접근
CREATE POLICY "admin_order_logs_all" ON public.order_logs
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- 가맹점: 자기 주문 로그만
CREATE POLICY "store_read_own_logs" ON public.order_logs
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.orders o
      JOIN public.profiles p ON p.id = auth.uid()
      WHERE o.id = order_logs.order_id AND p.role = 'store' AND p.store_id = o.store_id
    )
  );

-- 가맹점: 로그 작성 가능
CREATE POLICY "store_insert_logs" ON public.order_logs
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'store')
  );

-- 신화푸드: 전체 조회 + 작성
CREATE POLICY "shinwa_read_all_logs" ON public.order_logs
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'shinwa')
  );

CREATE POLICY "shinwa_insert_logs" ON public.order_logs
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'shinwa')
  );

-- ============================================================
-- 5. deposit_transactions (예치금 거래 내역)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.deposit_transactions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  store_id UUID NOT NULL REFERENCES public.stores(id),
  type TEXT NOT NULL CHECK (type IN ('deposit', 'order_deduct', 'order_refund', 'adjustment')),
  amount BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  description TEXT,
  order_id UUID REFERENCES public.orders(id),
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.deposit_transactions ENABLE ROW LEVEL SECURITY;

-- 관리자: 전체 접근
CREATE POLICY "admin_deposit_tx_all" ON public.deposit_transactions
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- 가맹점: 자기 매장 내역만
CREATE POLICY "store_read_own_deposit_tx" ON public.deposit_transactions
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'store' AND store_id = deposit_transactions.store_id)
  );

-- ============================================================
-- 6. inventory (재고)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.inventory (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id UUID UNIQUE NOT NULL REFERENCES public.products(id),
  quantity INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.inventory ENABLE ROW LEVEL SECURITY;

-- 관리자: 전체 접근
CREATE POLICY "admin_inventory_all" ON public.inventory
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

CREATE TRIGGER inventory_updated_at
  BEFORE UPDATE ON public.inventory
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- 7. inventory_transactions (입출고 이력)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.inventory_transactions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id UUID NOT NULL REFERENCES public.products(id),
  type TEXT NOT NULL CHECK (type IN ('inbound', 'outbound', 'adjustment')),
  quantity INT NOT NULL,
  description TEXT,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.inventory_transactions ENABLE ROW LEVEL SECURITY;

-- 관리자: 전체 접근
CREATE POLICY "admin_inventory_tx_all" ON public.inventory_transactions
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- ============================================================
-- 8. notices (공지사항)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.notices (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  is_pinned BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  target_type TEXT NOT NULL DEFAULT 'all' CHECK (target_type IN ('all', 'selected')),
  target_store_ids UUID[] DEFAULT '{}',
  created_by UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.notices ENABLE ROW LEVEL SECURITY;

-- 관리자: 전체 접근
CREATE POLICY "admin_notices_all" ON public.notices
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- 가맹점/신화: 활성 공지만 조회
CREATE POLICY "read_active_notices" ON public.notices
  FOR SELECT USING (
    is_active = TRUE
    AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('store', 'shinwa'))
  );

CREATE TRIGGER notices_updated_at
  BEFORE UPDATE ON public.notices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- 9. 주문번호 시퀀스 + RPC 함수
-- ============================================================
CREATE SEQUENCE IF NOT EXISTS order_number_seq START 1;

CREATE OR REPLACE FUNCTION public.nextval(seq_name TEXT)
RETURNS BIGINT
LANGUAGE SQL
SECURITY DEFINER
AS $$
  SELECT nextval(seq_name::regclass);
$$;
