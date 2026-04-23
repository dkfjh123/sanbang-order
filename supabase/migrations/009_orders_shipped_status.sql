-- orders.status CHECK 제약에 'shipped' 추가
-- 기존: pending, confirmed, shipping, delivered, cancelled
-- 변경: pending, confirmed, shipped, shipping, delivered, cancelled
-- (shinwa/admin이 "출고 처리"를 누르면 confirmed → shipped 로 전환)

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders
  ADD CONSTRAINT orders_status_check
  CHECK (status IN ('pending', 'confirmed', 'shipped', 'shipping', 'delivered', 'cancelled'));
