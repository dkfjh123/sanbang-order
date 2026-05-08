-- B2B customer-specific product price list.
-- Existing products.b2b_price values are kept as the Ahwome baseline, while
-- each customer now has its own explicit list of allowed products and units.

CREATE TABLE IF NOT EXISTS public.b2b_customer_product_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES public.b2b_customers(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  b2b_price BIGINT NOT NULL DEFAULT 0,
  b2b_price_with_tax BIGINT NOT NULL DEFAULT 0,
  available_units TEXT[] NOT NULL DEFAULT ARRAY['box']::TEXT[],
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT b2b_customer_product_prices_units_check
    CHECK (available_units <@ ARRAY['box', 'pack']::TEXT[] AND array_length(available_units, 1) >= 1),
  UNIQUE (customer_id, product_id)
);

ALTER TABLE public.b2b_customer_product_prices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_b2b_customer_product_prices_all" ON public.b2b_customer_product_prices;
CREATE POLICY "admin_b2b_customer_product_prices_all" ON public.b2b_customer_product_prices
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

DROP TRIGGER IF EXISTS b2b_customer_product_prices_updated_at ON public.b2b_customer_product_prices;
CREATE TRIGGER b2b_customer_product_prices_updated_at
  BEFORE UPDATE ON public.b2b_customer_product_prices
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE INDEX IF NOT EXISTS idx_b2b_customer_product_prices_customer
  ON public.b2b_customer_product_prices (customer_id, is_active);

CREATE INDEX IF NOT EXISTS idx_b2b_customer_product_prices_product
  ON public.b2b_customer_product_prices (product_id);

-- Ahwome: migrate the current products.b2b_price list into the customer-specific table.
INSERT INTO public.b2b_customer_product_prices (
  customer_id,
  product_id,
  b2b_price,
  b2b_price_with_tax,
  available_units,
  is_active
)
SELECT
  c.id,
  p.id,
  p.b2b_price,
  p.b2b_price_with_tax,
  CASE
    WHEN p.name IN ('육수간장', '비빔전용장') THEN ARRAY['box', 'pack']::TEXT[]
    ELSE ARRAY['box']::TEXT[]
  END,
  TRUE
FROM public.b2b_customers c
JOIN public.products p ON p.is_b2b_eligible = TRUE
WHERE c.name = '아워홈'
ON CONFLICT (customer_id, product_id) DO UPDATE SET
  b2b_price = EXCLUDED.b2b_price,
  b2b_price_with_tax = EXCLUDED.b2b_price_with_tax,
  available_units = EXCLUDED.available_units,
  is_active = TRUE;

-- Daebong Samgyeopsal: only two sauces, box-only, VAT included 107,800.
INSERT INTO public.b2b_customer_product_prices (
  customer_id,
  product_id,
  b2b_price,
  b2b_price_with_tax,
  available_units,
  is_active
)
SELECT
  c.id,
  p.id,
  98000,
  107800,
  ARRAY['box']::TEXT[],
  TRUE
FROM public.b2b_customers c
JOIN public.products p ON p.name IN ('비빔전용장', '비빔장', '양념장')
WHERE c.name = '돼봉삼겹살'
ON CONFLICT (customer_id, product_id) DO UPDATE SET
  b2b_price = EXCLUDED.b2b_price,
  b2b_price_with_tax = EXCLUDED.b2b_price_with_tax,
  available_units = ARRAY['box']::TEXT[],
  is_active = TRUE;
