// B2B(아워홈) 출고가 inventory_transactions에 기록되는지 확인
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(resolve(__dirname, '..', '.env.local'), 'utf8');
const env = Object.fromEntries(
  envText.split('\n').filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } });

console.log('## 1. b2b_orders 전체 (status, 총액, 출고일)');
const { data: b2bOrders } = await supabase
  .from('b2b_orders')
  .select('id, order_number, status, total_amount, shipped_at, created_at')
  .order('created_at', { ascending: false });
console.table(b2bOrders);

console.log('\n## 2. b2b_order_items (출고된 주문의 상품/수량/단위)');
const shippedB2bIds = b2bOrders?.filter((o) => o.status === 'shipped').map((o) => o.id) || [];
if (shippedB2bIds.length > 0) {
  const { data: items } = await supabase
    .from('b2b_order_items')
    .select('b2b_order_id, product_name, quantity, unit, b2b_orders(order_number)')
    .in('b2b_order_id', shippedB2bIds);
  items?.forEach((i) => {
    console.log(`  ${i.b2b_orders?.order_number} | ${i.product_name} | ${i.quantity}${i.unit}`);
  });
} else {
  console.log('  (출고된 B2B 주문 없음)');
}

console.log('\n## 3. inventory_transactions에서 B2B 관련 outbound 검색');
const { data: b2bOutbound } = await supabase
  .from('inventory_transactions')
  .select('product_id, quantity, description, created_at, type, unit')
  .eq('type', 'outbound')
  .ilike('description', '%B2B%')
  .order('created_at', { ascending: false });
console.log(`총 ${b2bOutbound?.length || 0}건`);
b2bOutbound?.forEach((tx) => {
  console.log(`  ${tx.created_at.slice(0, 10)} | ${tx.quantity}${tx.unit} | ${tx.description}`);
});

console.log('\n## 4. inventory_transactions의 4월 outbound 전체 (가맹점/B2B 모두)');
const { data: allOut } = await supabase
  .from('inventory_transactions')
  .select('description, quantity, created_at, unit')
  .eq('type', 'outbound')
  .gte('created_at', '2026-04-01')
  .lt('created_at', '2026-05-01')
  .order('created_at', { ascending: false });
console.log(`총 ${allOut?.length || 0}건`);
console.log('description 패턴별 카운트:');
const patterns = {};
allOut?.forEach((tx) => {
  const desc = tx.description || '';
  const key = desc.startsWith('발주 출고') ? '발주 출고' :
              desc.includes('B2B') ? 'B2B 관련' :
              desc;
  patterns[key] = (patterns[key] || 0) + 1;
});
console.log(patterns);
