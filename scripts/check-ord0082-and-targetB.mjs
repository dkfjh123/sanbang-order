// (1) ORD-20260520-0082 발주 항목이 좀비 패턴과 일치하는지 검증
// (2) 옵션 B(가맹점+B2B 모두 reserved에 반영) 기준 보정 목표값 재계산
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

// ============================================================
// (1) ORD-20260520-0082 검증
// ============================================================
console.log('===== (1) ORD-20260520-0082 발주 항목 vs 좀비 패턴 =====\n');

const { data: ord82 } = await supabase
  .from('orders')
  .select('id, order_number, store_id, status, ship_date, updated_at')
  .eq('order_number', 'ORD-20260520-0082')
  .single();

const { data: store82 } = await supabase
  .from('stores')
  .select('name, short_name')
  .eq('id', ord82.store_id)
  .single();

console.log(`  ${ord82.order_number} | ${store82.short_name || store82.name} | ${ord82.status} | upd=${ord82.updated_at} (UTC)`);

const { data: items82 } = await supabase
  .from('order_items')
  .select('product_id, product_name, quantity, unit')
  .eq('order_id', ord82.id);

// 좀비 패턴 (전 단계에서 확인된 값)
const zombiePattern = {
  '고기국수육수': 3,
  '생밀면': 7,
  '아삭한김치왕만두70': 3,
  '양념장': 1,
  '왕만두': 7,
  '육수간장': 1,
};

console.log('\n  ORD-0082 발주 vs 좀비:');
let matches = 0;
let mismatches = 0;
for (const it of items82) {
  const zombie = zombiePattern[it.product_name] ?? 0;
  const match = (it.unit === 'box' && it.quantity === zombie);
  console.log(`    ${it.product_name.padEnd(17)} | ${it.quantity}${it.unit}  | 좀비=${zombie}  | ${match ? '✓ 일치' : '✗ 불일치'}`);
  if (match) matches++; else mismatches++;
}

// 좀비에는 있는데 ORD-0082에 없는 상품 확인
const items82Names = new Set(items82.map((i) => i.product_name));
for (const [name, zombie] of Object.entries(zombiePattern)) {
  if (!items82Names.has(name) && zombie > 0) {
    console.log(`    ${name.padEnd(17)} | (ORD-0082에 없음) | 좀비=${zombie}  | ✗ 미설명`);
    mismatches++;
  }
}

console.log(`\n  결론: ${mismatches === 0 ? '★ ORD-0082가 좀비의 단일 원인으로 확정' : `일부 상품 불일치 — 다른 원인 있을 수 있음 (matches=${matches}, mismatches=${mismatches})`}`);

// ============================================================
// (2) 옵션 B 기준 보정 목표값 재계산
//     reserved = 가맹점(pending+confirmed) 박스 + B2B(pending) 박스
//     reserved_pack = 가맹점(pending+confirmed) 팩 + B2B(pending) 팩
// ============================================================
console.log('\n\n===== (2) 옵션 B 기준 보정 목표값 =====\n');

const { data: products } = await supabase
  .from('products')
  .select('id, name')
  .eq('product_type', 'exclusive')
  .order('name');

const { data: invs } = await supabase
  .from('inventory')
  .select('product_id, quantity, loose_pack_qty, on_hand, reserved, on_hand_pack, reserved_pack')
  .in('product_id', products.map((p) => p.id));
const invByPid = new Map(invs.map((i) => [i.product_id, i]));

// 가맹점 박스/팩
const { data: storeItems } = await supabase
  .from('order_items')
  .select('order_id, product_id, quantity, unit')
  .in('product_id', products.map((p) => p.id))
  .in('unit', ['box', 'pack']);
const storeOrderIds = [...new Set(storeItems.map((i) => i.order_id))];
const { data: storeOrders } = await supabase
  .from('orders')
  .select('id, status')
  .in('id', storeOrderIds)
  .in('status', ['pending', 'confirmed']);
const activeStoreIds = new Set(storeOrders.map((o) => o.id));

// B2B 박스/팩
const { data: b2bItems } = await supabase
  .from('b2b_order_items')
  .select('order_id, product_id, quantity, unit')
  .in('product_id', products.map((p) => p.id))
  .in('unit', ['box', 'pack']);
const b2bIds = [...new Set(b2bItems.map((i) => i.order_id))];
const { data: b2bOrders } = await supabase
  .from('b2b_orders')
  .select('id, status')
  .in('id', b2bIds)
  .eq('status', 'pending');
const activeB2bIds = new Set(b2bOrders.map((o) => o.id));

function sumOpen(items, activeIds, pid, unit) {
  return items
    .filter((i) => i.product_id === pid && i.unit === unit && activeIds.has(i.order_id))
    .reduce((s, i) => s + i.quantity, 0);
}

console.log('  상품              | DB 현재                                | 옵션B 목표');
console.log('  -----------------+--------------------------------------+-------------------------------------');

const targets = [];
for (const p of products) {
  const inv = invByPid.get(p.id);
  if (!inv) continue;

  const storeBox  = sumOpen(storeItems,  activeStoreIds,  p.id, 'box');
  const storePack = sumOpen(storeItems,  activeStoreIds,  p.id, 'pack');
  const b2bBox    = sumOpen(b2bItems,    activeB2bIds,    p.id, 'box');
  const b2bPack   = sumOpen(b2bItems,    activeB2bIds,    p.id, 'pack');

  const newReserved      = storeBox  + b2bBox;
  const newReservedPack  = storePack + b2bPack;
  const newOnHand        = inv.quantity       + newReserved;
  const newOnHandPack    = inv.loose_pack_qty + newReservedPack;

  const diffReserved     = newReserved      - (inv.reserved      || 0);
  const diffReservedPack = newReservedPack  - (inv.reserved_pack || 0);
  const diffOnHand       = newOnHand        - (inv.on_hand       || 0);
  const diffOnHandPack   = newOnHandPack    - (inv.on_hand_pack  || 0);

  const noChange = diffReserved === 0 && diffReservedPack === 0 && diffOnHand === 0 && diffOnHandPack === 0;
  targets.push({ p, inv, newReserved, newReservedPack, newOnHand, newOnHandPack, diffReserved, diffReservedPack, diffOnHand, diffOnHandPack, noChange });

  console.log(`  ${p.name.padEnd(17)} | res=${String(inv.reserved).padEnd(3)} res_pack=${String(inv.reserved_pack).padEnd(3)} oh=${String(inv.on_hand).padEnd(3)} oh_pack=${String(inv.on_hand_pack).padEnd(3)} | res=${String(newReserved).padEnd(3)} res_pack=${String(newReservedPack).padEnd(3)} oh=${String(newOnHand).padEnd(3)} oh_pack=${String(newOnHandPack).padEnd(3)}`);
}

console.log('\n===== 변경 요약 (옵션B) =====');
const needsChange = targets.filter((t) => !t.noChange);
if (needsChange.length === 0) {
  console.log('  변경 없음 (이미 일치)');
} else {
  for (const t of needsChange) {
    const parts = [];
    if (t.diffReserved     !== 0) parts.push(`reserved ${t.inv.reserved} → ${t.newReserved} (${t.diffReserved >= 0 ? '+' : ''}${t.diffReserved})`);
    if (t.diffReservedPack !== 0) parts.push(`reserved_pack ${t.inv.reserved_pack} → ${t.newReservedPack} (${t.diffReservedPack >= 0 ? '+' : ''}${t.diffReservedPack})`);
    if (t.diffOnHand       !== 0) parts.push(`on_hand ${t.inv.on_hand} → ${t.newOnHand} (${t.diffOnHand >= 0 ? '+' : ''}${t.diffOnHand})`);
    if (t.diffOnHandPack   !== 0) parts.push(`on_hand_pack ${t.inv.on_hand_pack} → ${t.newOnHandPack} (${t.diffOnHandPack >= 0 ? '+' : ''}${t.diffOnHandPack})`);
    console.log(`  ${t.p.name}`);
    parts.forEach((s) => console.log(`    ${s}`));
  }
}

console.log('\n  ※ 옵션B 의도:');
console.log('     reserved      = (가맹점 pending+confirmed 박스) + (B2B pending 박스)');
console.log('     reserved_pack = (가맹점 pending+confirmed 팩)  + (B2B pending 팩)');
console.log('     on_hand       = quantity       + reserved');
console.log('     on_hand_pack  = loose_pack_qty + reserved_pack');
