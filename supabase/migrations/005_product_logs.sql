-- ============================================================
-- 산방식당 발주시스템 — Phase 5: 상품 변경 이력 (product_logs)
-- ============================================================
-- 상품 등록/수정/삭제/단가 변경 등 모든 변경을 DB 트리거로 자동 기록.
-- 관리자(admin)만 조회 가능.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.product_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id UUID,                       -- FK 걸지 않음: 상품 삭제 후에도 로그 보존
  product_name TEXT,                     -- 당시 상품명 스냅샷
  product_type TEXT,                     -- 'exclusive' | 'general'
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  changes JSONB,                         -- update: {field: {old, new}} / create,delete: 전체 row
  changed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  changed_by_name TEXT,
  changed_by_role TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_logs_created_at ON public.product_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_logs_product_id ON public.product_logs (product_id);

ALTER TABLE public.product_logs ENABLE ROW LEVEL SECURITY;

-- 관리자만 조회 가능
CREATE POLICY "admin_read_product_logs" ON public.product_logs
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- INSERT는 트리거(SECURITY DEFINER)를 통해서만 이루어지므로 클라이언트 직접 INSERT 금지
-- (정책 없음 = 거부)

-- ============================================================
-- 트리거 함수: 상품 변경 자동 기록
-- ============================================================
CREATE OR REPLACE FUNCTION public.log_product_change()
RETURNS TRIGGER AS $$
DECLARE
  v_actor_id    UUID;
  v_actor_name  TEXT;
  v_actor_role  TEXT;
  v_changes     JSONB;
  v_product_id  UUID;
  v_product_name TEXT;
  v_product_type TEXT;
  v_action      TEXT;
BEGIN
  v_actor_id := auth.uid();
  IF v_actor_id IS NOT NULL THEN
    SELECT name, role INTO v_actor_name, v_actor_role
    FROM public.profiles WHERE id = v_actor_id;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_action := 'create';
    v_product_id := NEW.id;
    v_product_name := NEW.name;
    v_product_type := NEW.product_type;
    v_changes := to_jsonb(NEW);

  ELSIF TG_OP = 'UPDATE' THEN
    v_action := 'update';
    v_product_id := NEW.id;
    v_product_name := NEW.name;
    v_product_type := NEW.product_type;

    -- 실제로 바뀐 필드만 diff로 추출
    SELECT jsonb_object_agg(n.key, jsonb_build_object('old', o.value, 'new', n.value))
    INTO v_changes
    FROM jsonb_each(to_jsonb(NEW)) n
    LEFT JOIN jsonb_each(to_jsonb(OLD)) o ON n.key = o.key
    WHERE n.value IS DISTINCT FROM o.value
      AND n.key NOT IN ('updated_at', 'created_at');

    -- 변경사항이 없으면 로그 남기지 않음 (updated_at만 바뀐 경우 등)
    IF v_changes IS NULL THEN
      RETURN NEW;
    END IF;

  ELSIF TG_OP = 'DELETE' THEN
    v_action := 'delete';
    v_product_id := OLD.id;
    v_product_name := OLD.name;
    v_product_type := OLD.product_type;
    v_changes := to_jsonb(OLD);
  END IF;

  INSERT INTO public.product_logs (
    product_id, product_name, product_type, action, changes,
    changed_by, changed_by_name, changed_by_role
  ) VALUES (
    v_product_id, v_product_name, v_product_type, v_action, v_changes,
    v_actor_id, v_actor_name, v_actor_role
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 트리거 연결
DROP TRIGGER IF EXISTS products_log_trigger ON public.products;
CREATE TRIGGER products_log_trigger
  AFTER INSERT OR UPDATE OR DELETE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.log_product_change();
