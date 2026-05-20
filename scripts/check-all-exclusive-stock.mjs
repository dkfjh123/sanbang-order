// 전용상품 전체 재고 통합 검증 — READ ONLY
// 각 전용상품: inventory.quantity / loose_pack_qty / pending+confirmed 발주 reserved / B2B pending reserved
// → 신화 창고에 있어야 할 박스 수 추정
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

const { data: products } = await supabase
  .from('products')
  .select('id, name, pack_per_box')
  .eq('product_type', 'exclusive')
  .order('name');

const productIds = products.map((p) => p.id);
const nameMap = new Map(products.map((p) => [p.id, p.name]));

// inventory
const { data: inv } = await supabase
  .from('inventory')
  .select('product_id, quantity, loose_pack_qty')
  .in('product_id', productIds);
const invMap = new Map(inv.map((r) => [r.product_id, r]));

// 발주 미출고 (pending/confirmed) order_items
const { data: items } = await supabase
  .from('order_items')
  .select('order_id, product_id, quantity, unit')
  .in('product_id', productIds);
const orderIds = [...new Set(items.map((i) => i.order_id))];
const { data: orders } = await supabase
  .from('orders')
  .select('id, order_number, status, store_id')
  .in('id', orderIds);
const openOrderIds = new Set(orders.filter((o) => ['pending', 'confirmed'].includes(o.status)).map((o) => o.id));
const stores = await supabase.from('stores').select('id, short_name, name');
const storeMap = new Map(stores.data.map((s) => [s.id, s.short_name || s.name]));
const orderInfo = new Map(orders.map((o) => [o.id, o]));

const reservedByProd = new Map(); // productId -> {box, pack, details:[]}
for (const it of items) {
  if (!openOrderIds.has(it.order_id)) continue;
  if (!reservedByProd.has(it.product_id)) reservedByProd.set(it.product_id, { box: 0, pack: 0, details: [] });
  const r = reservedByProd.get(it.product_id);
  if (it.unit === 'pack') r.pack += it.quantity;
  else r.box += it.quantity;
  const o = orderInfo.get(it.order_id);
  r.details.push(`${o.order_number}(${o.status},${storeMap.get(o.store_id)}) ${it.quantity}${it.unit}`);
}

// B2B 미출고 (pending) b2b_order_items
const { data: b2bItems } = await supabase
  .from('b2b_order_items')
  .select('order_id, product_id, quantity, unit')
  .in('product_id', productIds);
const b2bIds = [...new Set(b2bItems.map((i) => i.order_id))];
const { data: b2bOrders } = await supabase
  .from('b2b_orders')
  .select('id, order_number, status')
  .in('id', b2bIds);
const openB2bIds = new Set(b2bOrders.filter((o) => o.status === 'pending').map((o) => o.id));
const b2bOrderInfo = new Map(b2bOrders.map((o) => [o.id, o]));

const b2bReservedByProd = new Map();
for (const it of b2bItems) {
  if (!openB2bIds.has(it.order_id)) continue;
  if (!b2bReservedByProd.has(it.product_id)) b2bReservedByProd.set(it.product_id, { box: 0, pack: 0, details: [] });
  const r = b2bReservedByProd.get(it.product_id);
  if (it.unit === 'pack') r.pack += it.quantity;
  else r.box += it.quantity;
  const o = b2bOrderInfo.get(it.order_id);
  r.details.push(`${o.order_number}(B2B,${o.status}) ${it.quantity}${it.unit}`);
}

// 출력
console.log('## 전용상품 통합 재고 — 2026-05-20 KST 기준');
console.log('     |   quantity    |  loose | 발주미출고(reserved)        | B2B미출고                | 신화창고 추정(=qty+reserved_box)');
console.log('-----|---------------|--------|-----------------------------|---------------------------|---------------------------------');
for (const p of products) {
  const i = invMap.get(p.id) || { quantity: 0, loose_pack_qty: 0 };
  const r = reservedByProd.get(p.id) || { box: 0, pack: 0, details: [] };
  const b = b2bReservedByProd.get(p.id) || { box: 0, pack: 0, details: [] };
  const reservedBox = r.box + b.box;
  const reservedPack = r.pack + b.pack;
  const onHandEstimate = (i.quantity || 0) + reservedBox; // 박스 기준 (낱개는 별도)
  console.log(
    `${p.name.padEnd(13, ' ')} | qty=${String(i.quantity).padStart(3, ' ')} loose=${String(i.loose_pack_qty || 0).padStart(2, ' ')}  | pack/box=${i.pack_per_box ?? '?'} | 발주 ${r.box}box+${r.pack}pack | B2B ${b.box}box+${b.pack}pack | on_hand 추정 ${onHandEstimate}box (+낱개 ${i.loose_pack_qty || 0}pack, +미출고팩 ${reservedPack})`
  );
}

console.log('\n## 미출고 발주 상세');
for (const p of products) {
  const r = reservedByProd.get(p.id) || { details: [] };
  const b = b2bReservedByProd.get(p.id) || { details: [] };
  if (!r.details.length && !b.details.length) continue;
  console.log(`\n[${p.name}]`);
  [...r.details, ...b.details].forEach((d) => console.log(`  ${d}`));
}
