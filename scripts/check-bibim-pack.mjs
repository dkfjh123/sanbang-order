// 비빔전용장 팩 총재고 3 검증
// (1) inventory_transactions running balance (pack) 추적
// (2) reserved_pack=3 의 출처 (가맹점 + B2B pending 팩 발주)
// READ-ONLY
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

const { data: prod } = await supabase
  .from('products')
  .select('id, name, pack_per_box, allow_unit_change')
  .eq('name', '비빔전용장')
  .single();
const PID = prod.id;

console.log(`===== 비빔전용장 (id=${PID.slice(0, 8)}...) =====`);
console.log(`  pack_per_box=${prod.pack_per_box}, allow_unit_change=${prod.allow_unit_change}`);

const { data: inv } = await supabase
  .from('inventory')
  .select('quantity, loose_pack_qty, on_hand, reserved, on_hand_pack, reserved_pack, updated_at')
  .eq('product_id', PID)
  .single();

console.log('\n현재 inventory:');
console.log(`  박스: quantity=${inv.quantity}, on_hand=${inv.on_hand}, reserved=${inv.reserved}`);
console.log(`  팩:   loose_pack_qty=${inv.loose_pack_qty}, on_hand_pack=${inv.on_hand_pack}, reserved_pack=${inv.reserved_pack}`);
console.log(`  등식 박스: ${inv.on_hand === inv.quantity + inv.reserved ? '✓' : '✗'}`);
console.log(`  등식 팩:   ${inv.on_hand_pack === inv.loose_pack_qty + inv.reserved_pack ? '✓' : '✗'}`);

// ============================================================
// (1) inventory_transactions running balance
// ============================================================
const { data: tx } = await supabase
  .from('inventory_transactions')
  .select('id, type, quantity, unit, description, created_at')
  .eq('product_id', PID)
  .order('created_at', { ascending: true });

console.log(`\n===== (1) inventory_transactions 흐름 (${tx.length}건) =====`);
console.log('  시각              | type        | qty   | unit | description');
console.log('  -----------------+-------------+-------+------+-----------------------');

let bal_box = 0, bal_pack = 0;
for (const r of tx) {
  const u = r.unit || 'box';
  const sign = r.type === 'inbound' ? 1 : r.type === 'outbound' ? -1 : 0;
  const abs = Math.abs(Number(r.quantity));
  if (u === 'box') bal_box += sign * abs;
  else bal_pack += sign * abs;

  const t = r.created_at.slice(0, 16);
  const typ = r.type.padEnd(11);
  const qty = String(r.quantity).padStart(5);
  const un = u.padEnd(4);
  const desc = (r.description || '').slice(0, 60);
  console.log(`  ${t} | ${typ} | ${qty} | ${un} | ${desc}`);
}

console.log(`\n  ABS running balance: box=${bal_box}, pack=${bal_pack}`);
console.log(`  실제 DB:             on_hand=${inv.on_hand}, on_hand_pack=${inv.on_hand_pack}`);
console.log(`  ※ ABS bal과 on_hand 차이는 baseline/보정 SQL에 의한 직접 update 때문. tx는 quantity 흐름만 기록.`);

// ============================================================
// (2) reserved_pack=3 의 출처
// ============================================================
console.log('\n===== (2) reserved_pack=3 출처 추적 =====');

// 가맹점 pending+confirmed 팩 발주
const { data: storeItems } = await supabase
  .from('order_items')
  .select('order_id, quantity, unit')
  .eq('product_id', PID)
  .eq('unit', 'pack');

let storePack = 0;
if (storeItems?.length) {
  const orderIds = [...new Set(storeItems.map((i) => i.order_id))];
  const { data: orders } = await supabase
    .from('orders')
    .select('id, order_number, store_id, status, created_at, ship_date')
    .in('id', orderIds)
    .in('status', ['pending', 'confirmed']);
  const { data: stores } = await supabase.from('stores').select('id, name, short_name');
  const sm = new Map(stores?.map((s) => [s.id, s.short_name || s.name]));
  console.log('\n  가맹점 pending/confirmed 팩 발주:');
  for (const o of orders || []) {
    const its = storeItems.filter((i) => i.order_id === o.id);
    for (const i of its) {
      console.log(`    ${o.order_number} | ${sm.get(o.store_id)} | ${o.status} | ship=${o.ship_date} | ${i.quantity}pack`);
      storePack += i.quantity;
    }
  }
  console.log(`    → 가맹점 팩 합: ${storePack}`);
} else {
  console.log('  가맹점 팩 발주 없음');
}

// B2B pending 팩 발주
const { data: b2bItems } = await supabase
  .from('b2b_order_items')
  .select('order_id, quantity, unit, product_name, unit_price, unit_price_with_tax')
  .eq('product_id', PID)
  .eq('unit', 'pack');

let b2bPack = 0;
if (b2bItems?.length) {
  const ids = [...new Set(b2bItems.map((i) => i.order_id))];
  const { data: b2bOrders } = await supabase
    .from('b2b_orders')
    .select('id, order_number, b2b_customer_id, status, created_at, ship_date, memo')
    .in('id', ids)
    .eq('status', 'pending');
  const { data: customers } = await supabase.from('b2b_customers').select('id, name');
  const cm = new Map(customers?.map((c) => [c.id, c.name]));
  console.log('\n  B2B pending 팩 발주:');
  for (const o of b2bOrders || []) {
    const its = b2bItems.filter((i) => i.order_id === o.id);
    for (const i of its) {
      console.log(`    ${o.order_number} | ${cm.get(o.b2b_customer_id) || '?'} | created=${o.created_at.slice(0,16)} | ship=${o.ship_date} | ${i.quantity}pack | ${i.product_name}`);
      b2bPack += i.quantity;
    }
    if (o.memo) console.log(`       memo: ${o.memo}`);
  }
  console.log(`    → B2B 팩 합: ${b2bPack}`);
} else {
  console.log('\n  B2B 팩 발주 없음');
}

console.log(`\n===== 종합 =====`);
console.log(`  reserved_pack(DB)  = ${inv.reserved_pack}`);
console.log(`  가맹점 팩 + B2B 팩 = ${storePack + b2bPack}`);
console.log(`  일치 여부          = ${inv.reserved_pack === storePack + b2bPack ? '✓ 일치' : '✗ 불일치'}`);

console.log(`\n  on_hand_pack(DB)   = ${inv.on_hand_pack}`);
console.log(`  loose_pack_qty + reserved_pack = ${inv.loose_pack_qty + inv.reserved_pack}`);
console.log(`  → on_hand_pack=3 의 의미: 창고에 비빔전용장 낱팩 3개가 박혀 있어야 함 (B2B로 곧 나갈 3팩)`);
