// 생밀면 재고 정밀 검증 v2 — ABS 기준 running balance + 미출고 주문 확인
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

const PRODUCT_ID = '36428624-6823-4c5b-aa20-be012bccef32';

// 현재 inventory
const { data: inv } = await supabase
  .from('inventory')
  .select('quantity, loose_pack_qty, updated_at')
  .eq('product_id', PRODUCT_ID)
  .single();
console.log('현재 inventory:', inv);

// 트랜잭션 ABS 기반 running balance
const { data: tx } = await supabase
  .from('inventory_transactions')
  .select('id, type, quantity, unit, description, created_at')
  .eq('product_id', PRODUCT_ID)
  .order('created_at', { ascending: true });

console.log('\n## ABS 기준 running balance');
let bal_box = 0;
let bal_pack = 0;
let abs_in_box = 0, abs_out_box = 0;
let abs_in_pack = 0, abs_out_pack = 0;
const signedRaw = { in_box: 0, out_box: 0 };

for (const r of tx) {
  const u = r.unit || 'box';
  const sign = r.type === 'inbound' ? 1 : r.type === 'outbound' ? -1 : 0;
  const abs = Math.abs(Number(r.quantity));
  if (u === 'box') {
    bal_box += sign * abs;
    if (sign > 0) abs_in_box += abs; else abs_out_box += abs;
    if (r.type === 'inbound') signedRaw.in_box += Number(r.quantity);
    if (r.type === 'outbound') signedRaw.out_box += Number(r.quantity);
  } else {
    bal_pack += sign * abs;
    if (sign > 0) abs_in_pack += abs; else abs_out_pack += abs;
  }
}

console.log(`box  inbound 합(ABS): ${abs_in_box}, outbound 합(ABS): ${abs_out_box}, running balance: ${bal_box}`);
console.log(`pack inbound 합(ABS): ${abs_in_pack}, outbound 합(ABS): ${abs_out_pack}, running balance: ${bal_pack}`);
console.log(`raw signed: inbound=${signedRaw.in_box}, outbound=${signedRaw.out_box}, sum=${signedRaw.in_box + signedRaw.out_box}`);

// outbound 중 양수(=B2B convention) row만
const positiveOut = tx.filter((r) => r.type === 'outbound' && Number(r.quantity) > 0);
console.log(`\n## outbound 중 양수 저장된 row (B2B convention): ${positiveOut.length}건`);
positiveOut.forEach((r) => console.log(`  ${r.created_at.slice(0, 16)} | qty=${r.quantity}${r.unit || 'box'} | ${r.description}`));

// 미출고 주문 (pending/confirmed) 확인 — order_items 조회 단순화
console.log('\n## pending/confirmed 발주 (생밀면 포함)');
const { data: items, error: itemsErr } = await supabase
  .from('order_items')
  .select('order_id, product_id, quantity, unit')
  .eq('product_id', PRODUCT_ID);
if (itemsErr) console.log('  ERR:', itemsErr.message);
console.log(`  order_items 매칭: ${items?.length || 0}건`);

if (items?.length) {
  const orderIds = [...new Set(items.map((i) => i.order_id))];
  const { data: orders, error: ordErr } = await supabase
    .from('orders')
    .select('id, order_number, store_id, status, created_at')
    .in('id', orderIds)
    .order('created_at', { ascending: false });
  if (ordErr) console.log('  ORDERS ERR:', ordErr.message);

  const { data: stores } = await supabase.from('stores').select('id, name, short_name');
  const sm = new Map(stores?.map((s) => [s.id, s.short_name || s.name]));

  const statusCount = {};
  const pendingItems = [];
  orders?.forEach((o) => {
    statusCount[o.status] = (statusCount[o.status] || 0) + 1;
    if (['pending', 'confirmed'].includes(o.status)) {
      const its = items.filter((i) => i.order_id === o.id);
      its.forEach((i) => pendingItems.push({
        order: o.order_number,
        store: sm.get(o.store_id),
        status: o.status,
        qty: i.quantity,
        unit: i.unit,
        created: o.created_at.slice(0, 16),
      }));
    }
  });
  console.log('  상태별 주문수:', statusCount);
  console.log(`\n  현재 미출고(pending/confirmed) 발주 항목 ${pendingItems.length}건:`);
  pendingItems.forEach((p) =>
    console.log(`    ${p.created} | ${p.order} | ${p.store} | ${p.status} | ${p.qty}${p.unit}`)
  );
  const reservedBox = pendingItems.filter((p) => p.unit === 'box').reduce((s, p) => s + p.qty, 0);
  const reservedPack = pendingItems.filter((p) => p.unit === 'pack').reduce((s, p) => s + p.qty, 0);
  console.log(`  미출고 box 합: ${reservedBox}, pack 합: ${reservedPack}`);
}

// B2B 미출고 (b2b_orders pending) 확인
console.log('\n## B2B pending (생밀면)');
const { data: b2bItems } = await supabase
  .from('b2b_order_items')
  .select('order_id, product_id, quantity, unit')
  .eq('product_id', PRODUCT_ID);
if (b2bItems?.length) {
  const b2bIds = [...new Set(b2bItems.map((i) => i.order_id))];
  const { data: b2bOrders } = await supabase
    .from('b2b_orders')
    .select('id, order_number, status, created_at')
    .in('id', b2bIds);
  const pendingB2b = b2bOrders?.filter((o) => o.status === 'pending') || [];
  console.log(`  B2B pending ${pendingB2b.length}건`);
  pendingB2b.forEach((o) => {
    const its = b2bItems.filter((i) => i.order_id === o.id);
    its.forEach((i) => console.log(`    ${o.order_number} | ${o.status} | ${i.quantity}${i.unit}`));
  });
} else {
  console.log('  B2B 주문 없음');
}

// 최종 정합성 비교
console.log('\n## 최종 비교');
console.log(`  inventory.quantity (현재고 시스템 값): ${inv.quantity}`);
console.log(`  inventory.loose_pack_qty: ${inv.loose_pack_qty}`);
console.log(`  tx ABS running balance (box): ${bal_box}`);
console.log(`  tx ABS running balance (pack): ${bal_pack}`);
console.log(`  → 차이 (현재고 − tx누계 box): ${inv.quantity - bal_box}`);
