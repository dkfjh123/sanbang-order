// 삼공밥상 현재 주문 확인 (읽기 전용)
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(resolve(__dirname, '..', '.env.local'), 'utf8');
const env = Object.fromEntries(envText.split('\n').filter((l) => l && !l.startsWith('#') && l.includes('='))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } });
const A = '56f3964a-9411-42ac-a19f-63be624eb5f3';
const { data: orders } = await sb.from('orders')
  .select('id, order_number, status, ship_date, total_amount, created_at')
  .eq('store_id', A).order('created_at', { ascending: false });
console.log('=== 삼공밥상 주문 ==='); console.table(orders);
for (const o of orders ?? []) {
  const { data: items } = await sb.from('order_items')
    .select('quantity, unit, ship_date, products(code, name)').eq('order_id', o.id);
  console.log(`--- ${o.order_number} 품목 ---`);
  console.table((items ?? []).map((i) => ({ 상품: i.products?.name, 수량: i.quantity, 단위: i.unit, 출고일: i.ship_date })));
}
const { data: st } = await sb.from('stores').select('short_name, region, delivery_days, deposit_balance').eq('id', A).single();
console.log('=== 현재 매장 설정 ==='); console.table([st]);
