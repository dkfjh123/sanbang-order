// 전 전용상품 reserved 좀비 추적
// 정상 reserved = 현재 pending+confirmed 가맹점 박스 합 (B2B는 코드상 reserved 안 건드림)
// 좀비 = DB reserved - 정상값
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

// 전 전용상품
const { data: products } = await supabase
  .from('products')
  .select('id, name')
  .eq('product_type', 'exclusive')
  .order('name');

// 전 inventory
const { data: invs } = await supabase
  .from('inventory')
  .select('product_id, quantity, loose_pack_qty, on_hand, reserved, on_hand_pack, reserved_pack')
  .in('product_id', products.map((p) => p.id));
const invByPid = new Map(invs.map((i) => [i.product_id, i]));

// 전 pending+confirmed 가맹점 박스 발주
const { data: storeBoxItems } = await supabase
  .from('order_items')
  .select('order_id, product_id, quantity')
  .in('product_id', products.map((p) => p.id))
  .eq('unit', 'box');
const storeBoxOrderIds = [...new Set(storeBoxItems.map((i) => i.order_id))];
const { data: storeBoxOrders } = await supabase
  .from('orders')
  .select('id, status')
  .in('id', storeBoxOrderIds)
  .in('status', ['pending', 'confirmed']);
const activeStoreBoxOrderIds = new Set(storeBoxOrders.map((o) => o.id));

// 전 pending+confirmed 가맹점 팩 발주
const { data: storePackItems } = await supabase
  .from('order_items')
  .select('order_id, product_id, quantity')
  .in('product_id', products.map((p) => p.id))
  .eq('unit', 'pack');
const storePackOrderIds = [...new Set(storePackItems.map((i) => i.order_id))];
const { data: storePackOrders } = await supabase
  .from('orders')
  .select('id, status')
  .in('id', storePackOrderIds)
  .in('status', ['pending', 'confirmed']);
const activeStorePackOrderIds = new Set(storePackOrders.map((o) => o.id));

// 전 pending B2B 박스 발주 (참고용, reserved와 무관)
const { data: b2bBoxItems } = await supabase
  .from('b2b_order_items')
  .select('order_id, product_id, quantity')
  .in('product_id', products.map((p) => p.id))
  .eq('unit', 'box');
const b2bBoxIds = [...new Set(b2bBoxItems.map((i) => i.order_id))];
const { data: b2bBoxOrders } = await supabase
  .from('b2b_orders')
  .select('id, status')
  .in('id', b2bBoxIds)
  .eq('status', 'pending');
const activeB2bBoxOrderIds = new Set(b2bBoxOrders.map((o) => o.id));

// 전 pending B2B 팩 발주
const { data: b2bPackItems } = await supabase
  .from('b2b_order_items')
  .select('order_id, product_id, quantity')
  .in('product_id', products.map((p) => p.id))
  .eq('unit', 'pack');
const b2bPackIds = [...new Set(b2bPackItems.map((i) => i.order_id))];
const { data: b2bPackOrders } = await supabase
  .from('b2b_orders')
  .select('id, status')
  .in('id', b2bPackIds)
  .eq('status', 'pending');
const activeB2bPackOrderIds = new Set(b2bPackOrders.map((o) => o.id));

// 집계
function sumBy(items, activeIds, pid) {
  return items
    .filter((i) => i.product_id === pid && activeIds.has(i.order_id))
    .reduce((s, i) => s + i.quantity, 0);
}

console.log('===== 전 전용상품 reserved 좀비 추적 =====\n');
console.log('  상품              | DB값                              | 정상값(가맹점 미출고)  | 좀비           | B2B 참고');
console.log('  -----------------+---------------------------------+----------------------+----------------+----------');

const summary = [];
for (const p of products) {
  const inv = invByPid.get(p.id);
  if (!inv) continue;

  const storeBoxOpen  = sumBy(storeBoxItems,  activeStoreBoxOrderIds,  p.id);
  const storePackOpen = sumBy(storePackItems, activeStorePackOrderIds, p.id);
  const b2bBoxOpen    = sumBy(b2bBoxItems,    activeB2bBoxOrderIds,    p.id);
  const b2bPackOpen   = sumBy(b2bPackItems,   activeB2bPackOrderIds,   p.id);

  const boxZombie  = (inv.reserved      || 0) - storeBoxOpen;
  const packZombie = (inv.reserved_pack || 0) - storePackOpen;

  const onHandEq     = inv.on_hand      === (inv.quantity       + (inv.reserved      || 0));
  const onHandPackEq = inv.on_hand_pack === (inv.loose_pack_qty + (inv.reserved_pack || 0));

  summary.push({ p, inv, storeBoxOpen, storePackOpen, b2bBoxOpen, b2bPackOpen, boxZombie, packZombie, onHandEq, onHandPackEq });

  console.log(`  ${p.name.padEnd(17)} | reserved=${String(inv.reserved).padEnd(3)} reserved_pack=${String(inv.reserved_pack).padEnd(3)} | box=${String(storeBoxOpen).padEnd(3)} pack=${String(storePackOpen).padEnd(3)} | box=${String(boxZombie).padStart(3)} pack=${String(packZombie).padStart(3)} | b2b_box=${b2bBoxOpen} b2b_pack=${b2bPackOpen}`);
}

console.log('\n===== 등식 검증 (on_hand = quantity + reserved) =====');
for (const r of summary) {
  const boxOk = r.onHandEq ? '✓' : `✗ on_hand=${r.inv.on_hand} vs quantity+reserved=${r.inv.quantity + r.inv.reserved}`;
  const packOk = r.onHandPackEq ? '✓' : `✗ on_hand_pack=${r.inv.on_hand_pack} vs loose+reserved_pack=${r.inv.loose_pack_qty + r.inv.reserved_pack}`;
  console.log(`  ${r.p.name.padEnd(17)} | box ${boxOk} | pack ${packOk}`);
}

console.log('\n===== 보정 필요 (좀비 != 0) =====');
const needsFix = summary.filter((r) => r.boxZombie !== 0 || r.packZombie !== 0);
if (needsFix.length === 0) {
  console.log('  없음');
} else {
  for (const r of needsFix) {
    console.log(`  ${r.p.name}`);
    if (r.boxZombie !== 0) {
      const target = r.storeBoxOpen;
      const newOnHand = r.inv.quantity + target;
      console.log(`    box: reserved ${r.inv.reserved} → ${target} (좀비 ${r.boxZombie}박스 제거), on_hand ${r.inv.on_hand} → ${newOnHand}`);
    }
    if (r.packZombie !== 0) {
      const target = r.storePackOpen;
      const newOnHandPack = r.inv.loose_pack_qty + target;
      console.log(`    pack: reserved_pack ${r.inv.reserved_pack} → ${target} (좀비 ${r.packZombie}팩 제거), on_hand_pack ${r.inv.on_hand_pack} → ${newOnHandPack}`);
    }
  }
}

console.log('\n  ※ 정상값 = 현재 pending+confirmed 가맹점 박스/팩 발주 합');
console.log('  ※ B2B는 코드상 reserved에 영향 안 줌 (B2B POST/SHIP/CANCEL 모두 reserved 무시)');
console.log('  ※ B2B 미출고는 참고용으로만 표시 — 별도로 추적 필요');
