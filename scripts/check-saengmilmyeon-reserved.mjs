// 생밀면 reserved=12 원인 추적 — pending/confirmed 발주 목록 + B2B pending 목록
// READ-ONLY: 어떤 데이터도 변경하지 않음
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

// 생밀면 product_id
const { data: prod } = await supabase
  .from('products')
  .select('id, name')
  .eq('name', '생밀면')
  .single();
const PRODUCT_ID = prod.id;

// 현재 inventory (3분할 전부)
const { data: inv } = await supabase
  .from('inventory')
  .select('quantity, loose_pack_qty, on_hand, reserved, on_hand_pack, reserved_pack, updated_at')
  .eq('product_id', PRODUCT_ID)
  .single();

console.log('===== 생밀면 현재 inventory =====');
console.log(`  on_hand=${inv.on_hand} (총재고)`);
console.log(`  reserved=${inv.reserved} (나갈것들 — 박스)`);
console.log(`  quantity=${inv.quantity} (매장주문가능 — 박스)`);
console.log(`  on_hand_pack=${inv.on_hand_pack}, reserved_pack=${inv.reserved_pack}, loose_pack_qty=${inv.loose_pack_qty}`);
console.log(`  updated_at=${inv.updated_at}`);

// 1) 가맹점 pending + confirmed 박스 발주
console.log('\n===== 가맹점 pending/confirmed 박스 발주 =====');
const { data: items } = await supabase
  .from('order_items')
  .select('order_id, quantity, unit')
  .eq('product_id', PRODUCT_ID)
  .eq('unit', 'box');

let storeBoxSum = 0;
if (items?.length) {
  const orderIds = [...new Set(items.map((i) => i.order_id))];
  const { data: orders } = await supabase
    .from('orders')
    .select('id, order_number, store_id, status, created_at, ship_date')
    .in('id', orderIds)
    .in('status', ['pending', 'confirmed'])
    .order('ship_date', { ascending: true });

  const { data: stores } = await supabase.from('stores').select('id, name, short_name');
  const sm = new Map(stores?.map((s) => [s.id, s.short_name || s.name]));

  orders?.forEach((o) => {
    const its = items.filter((i) => i.order_id === o.id);
    its.forEach((i) => {
      console.log(`  ${o.order_number} | ${sm.get(o.store_id)} | ${o.status} | ship=${o.ship_date} | ${i.quantity}box`);
      storeBoxSum += i.quantity;
    });
  });
  console.log(`  → 가맹점 박스 합: ${storeBoxSum}`);
}

// 2) 가맹점 pending + confirmed 팩 발주 (참고용)
console.log('\n===== 가맹점 pending/confirmed 팩 발주 =====');
const { data: packItems } = await supabase
  .from('order_items')
  .select('order_id, quantity, unit')
  .eq('product_id', PRODUCT_ID)
  .eq('unit', 'pack');

let storePackSum = 0;
if (packItems?.length) {
  const orderIds = [...new Set(packItems.map((i) => i.order_id))];
  const { data: orders } = await supabase
    .from('orders')
    .select('id, order_number, store_id, status, ship_date')
    .in('id', orderIds)
    .in('status', ['pending', 'confirmed']);
  const { data: stores } = await supabase.from('stores').select('id, name, short_name');
  const sm = new Map(stores?.map((s) => [s.id, s.short_name || s.name]));
  orders?.forEach((o) => {
    const its = packItems.filter((i) => i.order_id === o.id);
    its.forEach((i) => {
      console.log(`  ${o.order_number} | ${sm.get(o.store_id)} | ${o.status} | ship=${o.ship_date} | ${i.quantity}pack`);
      storePackSum += i.quantity;
    });
  });
}
console.log(`  → 가맹점 팩 합: ${storePackSum}`);

// 3) B2B pending 박스 발주
console.log('\n===== B2B pending 박스 발주 =====');
const { data: b2bBoxItems } = await supabase
  .from('b2b_order_items')
  .select('order_id, quantity, unit')
  .eq('product_id', PRODUCT_ID)
  .eq('unit', 'box');

let b2bBoxSum = 0;
if (b2bBoxItems?.length) {
  const ids = [...new Set(b2bBoxItems.map((i) => i.order_id))];
  const { data: b2bOrders } = await supabase
    .from('b2b_orders')
    .select('id, order_number, status, ship_date')
    .in('id', ids)
    .eq('status', 'pending');
  b2bOrders?.forEach((o) => {
    const its = b2bBoxItems.filter((i) => i.order_id === o.id);
    its.forEach((i) => {
      console.log(`  ${o.order_number} | pending | ship=${o.ship_date} | ${i.quantity}box`);
      b2bBoxSum += i.quantity;
    });
  });
}
console.log(`  → B2B 박스 합: ${b2bBoxSum}`);

console.log('\n===== 결론 =====');
console.log(`  reserved (DB)            = ${inv.reserved}`);
console.log(`  가맹점 박스 + B2B 박스   = ${storeBoxSum + b2bBoxSum}`);
console.log(`  차이                     = ${inv.reserved - (storeBoxSum + b2bBoxSum)}`);
