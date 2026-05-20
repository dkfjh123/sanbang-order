// 생밀면 재고/입출고/주문 검증
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(resolve(__dirname, '..', '.env.local'), 'utf8');
const env = Object.fromEntries(
  envText
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const idx = l.indexOf('=');
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
    })
);

const supabase = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// 1. 생밀면 관련 상품 모두 찾기 (생밀면이 여러 변형 가능)
const { data: products } = await supabase
  .from('products')
  .select('*')
  .ilike('name', '%생밀면%');

console.log('## 1. 생밀면 관련 상품');
products?.forEach((p) => {
  console.log(`  ${p.id} | ${p.name} | type=${p.product_type} | unit=${p.unit || '?'} | price=${p.price ?? '?'}`);
});
if (!products?.length) {
  console.log('  (없음) 다른 키워드 시도...');
  const { data: alt } = await supabase
    .from('products')
    .select('id, name, product_type')
    .or('name.ilike.%밀면%,name.ilike.%면%');
  alt?.forEach((p) => console.log(`  ALT: ${p.id} | ${p.name} | ${p.product_type}`));
  process.exit(0);
}

const productIds = products.map((p) => p.id);
const productNameMap = new Map(products.map((p) => [p.id, p.name]));

// 2. 현재 재고
console.log('\n## 2. 현재 inventory');
const { data: inv } = await supabase
  .from('inventory')
  .select('*')
  .in('product_id', productIds);
inv?.forEach((r) => {
  const name = productNameMap.get(r.product_id);
  console.log(`  ${name}`);
  Object.entries(r).forEach(([k, v]) => {
    if (k !== 'product_id' && k !== 'id') console.log(`    ${k}: ${v}`);
  });
});

// 3. inventory_transactions 전체 (시간순)
console.log('\n## 3. inventory_transactions (시간순 전체)');
const { data: tx } = await supabase
  .from('inventory_transactions')
  .select('*')
  .in('product_id', productIds)
  .order('created_at', { ascending: true });
console.log(`  총 ${tx?.length || 0}건`);
tx?.forEach((r) => {
  const name = productNameMap.get(r.product_id);
  console.log(`  ${r.created_at.slice(0, 16)} | ${name} | type=${r.type} | qty=${r.quantity}${r.unit || ''} | ${r.description || ''}`);
});

// 4. 입고/조정 누계
console.log('\n## 4. type별 누계');
const sumByType = {};
tx?.forEach((r) => {
  const key = `${r.type}/${r.unit || 'box'}`;
  sumByType[key] = (sumByType[key] || 0) + Number(r.quantity);
});
Object.entries(sumByType).forEach(([k, v]) => console.log(`  ${k}: ${v}`));

// 5. orders 중 생밀면 포함 — 상태별
console.log('\n## 5. orders (생밀면 포함, 시간순)');
const { data: items } = await supabase
  .from('order_items')
  .select('order_id, product_id, quantity, unit, price')
  .in('product_id', productIds);

const orderIds = [...new Set(items?.map((i) => i.order_id) || [])];
const { data: orders } = await supabase
  .from('orders')
  .select('id, store_id, status, created_at, shipped_at, cancelled_at')
  .in('id', orderIds)
  .order('created_at', { ascending: true });

const { data: stores } = await supabase.from('stores').select('id, name');
const storeMap = new Map(stores?.map((s) => [s.id, s.name]));

const itemsByOrder = new Map();
items?.forEach((i) => {
  if (!itemsByOrder.has(i.order_id)) itemsByOrder.set(i.order_id, []);
  itemsByOrder.get(i.order_id).push(i);
});

console.log(`  총 ${orders?.length || 0}건 주문`);
orders?.forEach((o) => {
  const its = itemsByOrder.get(o.id) || [];
  const desc = its.map((i) => `${productNameMap.get(i.product_id)} ${i.quantity}${i.unit}`).join(', ');
  console.log(`  ${o.created_at.slice(0, 16)} | ${storeMap.get(o.store_id) || o.store_id.slice(0, 8)} | ${o.status} | ${desc}`);
});

// 6. 상태별 수량 합
console.log('\n## 6. 상태별 수량 합 (생밀면)');
const sumByStatus = {};
orders?.forEach((o) => {
  const its = itemsByOrder.get(o.id) || [];
  its.forEach((i) => {
    const key = `${o.status}/${i.unit}`;
    sumByStatus[key] = (sumByStatus[key] || 0) + Number(i.quantity);
  });
});
Object.entries(sumByStatus).forEach(([k, v]) => console.log(`  ${k}: ${v}`));

// 7. 검증: 입고누계 - 출고(shipped 누계) - pending/confirmed 미출고 = 현재 quantity ?
console.log('\n## 7. 재고 검증 (단위별)');
const units = new Set();
tx?.forEach((r) => units.add(r.unit || 'box'));
items?.forEach((i) => units.add(i.unit));

for (const u of units) {
  const inbound = tx?.filter((r) => r.type === 'inbound' && (r.unit || 'box') === u)
    .reduce((s, r) => s + Number(r.quantity), 0) || 0;
  const outbound = tx?.filter((r) => r.type === 'outbound' && (r.unit || 'box') === u)
    .reduce((s, r) => s + Number(r.quantity), 0) || 0;
  const adjustment = tx?.filter((r) => r.type === 'adjustment' && (r.unit || 'box') === u)
    .reduce((s, r) => s + Number(r.quantity), 0) || 0;
  const shipped = orders?.filter((o) => o.status === 'shipped').flatMap((o) =>
    (itemsByOrder.get(o.id) || []).filter((i) => i.unit === u)
  ).reduce((s, i) => s + Number(i.quantity), 0) || 0;
  const pendingConfirmed = orders?.filter((o) => ['pending', 'confirmed'].includes(o.status)).flatMap((o) =>
    (itemsByOrder.get(o.id) || []).filter((i) => i.unit === u)
  ).reduce((s, i) => s + Number(i.quantity), 0) || 0;

  const currentInv = inv?.reduce((s, r) => {
    // unit 컬럼이 product에 묶여있을 수도 있고 inventory에 컬럼이 있을 수도 있어서 둘 다 시도
    return s + Number(r.quantity || 0);
  }, 0) || 0;

  console.log(`  [${u}] 입고누계=${inbound}, 출고누계(tx)=${outbound}, 조정=${adjustment}, shipped주문합=${shipped}, pending+confirmed합=${pendingConfirmed}`);
  console.log(`  [${u}] 현재 inventory.quantity 합=${currentInv}`);
  console.log(`  [${u}] 예상 (입고-shipped-pending/confirmed) = ${inbound - shipped - pendingConfirmed}`);
  console.log(`  [${u}] 차이: 현재 - 예상 = ${currentInv - (inbound - shipped - pendingConfirmed)}`);
}
