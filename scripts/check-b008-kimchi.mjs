// B-20260520-008 + 아삭한김치왕만두70 재고 이력 조회 (READ-ONLY)
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(resolve(__dirname, '..', '.env.local'), 'utf8');
const env = Object.fromEntries(
  envText.split('\n').filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => {
    const i = l.indexOf('=');
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  })
);
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ORDER = 'B-20260520-008';
const PRODUCT = '아삭한김치왕만두70';

console.log(`===== ${ORDER} 조회 =====\n`);

const { data: order, error: oErr } = await supabase
  .from('b2b_orders')
  .select('id, order_number, status, ship_date, order_date, created_at, updated_at')
  .eq('order_number', ORDER)
  .maybeSingle();

if (oErr) console.error('b2b_orders error:', oErr.message);
else console.log('주문:', order);

if (order) {
  const { data: items } = await supabase
    .from('b2b_order_items')
    .select('product_id, product_name, quantity, unit, pack_per_box')
    .eq('order_id', order.id);
  console.log('\n발주 항목:');
  items?.forEach((i) => console.log(`  ${i.product_name} | ${i.quantity}${i.unit}`));
}

const { data: txs } = await supabase
  .from('inventory_transactions')
  .select('created_at, type, quantity, unit, description, product_id')
  .ilike('description', `%${ORDER}%`)
  .order('created_at');

console.log(`\n주문번호 포함 inventory_transactions: ${txs?.length ?? 0}건`);
txs?.forEach((t) => {
  console.log(`  ${t.created_at} | ${t.type} | ${t.quantity}${t.unit} | ${t.description}`);
});

const { data: prod } = await supabase.from('products').select('id, name').eq('name', PRODUCT).single();
console.log(`\n===== ${PRODUCT} (5/18~) =====\n`);

const { data: inv } = await supabase
  .from('inventory')
  .select('quantity, reserved, on_hand, loose_pack_qty, reserved_pack, on_hand_pack')
  .eq('product_id', prod.id)
  .single();
console.log('inventory:', inv);

const { data: txsKimchi } = await supabase
  .from('inventory_transactions')
  .select('created_at, type, quantity, unit, description')
  .eq('product_id', prod.id)
  .gte('created_at', '2026-05-18')
  .order('created_at');

console.log(`transactions (5/18~): ${txsKimchi?.length ?? 0}건`);
txsKimchi?.forEach((t) => {
  console.log(`  ${t.created_at.slice(0, 19)} | ${t.type} | ${t.quantity}${t.unit} | ${t.description}`);
});
