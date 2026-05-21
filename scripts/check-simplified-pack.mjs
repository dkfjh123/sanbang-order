// 단순화 옵션(박스 환산) 기준 정합성 검증
// reserved      = 가맹점 박스(pending+confirmed) + B2B 박스(pending) + CEIL(B2B 팩(pending) / pack_per_box)
// reserved_pack = 가맹점 팩(pending+confirmed)  ← 자투리 전용
// 등식: on_hand=quantity+reserved, on_hand_pack=loose+reserved_pack
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

const { data: products } = await supabase
  .from('products')
  .select('id, name, pack_per_box')
  .eq('product_type', 'exclusive')
  .order('name');
const ppbByPid = new Map(products.map((p) => [p.id, p.pack_per_box]));

const { data: invs } = await supabase
  .from('inventory')
  .select('product_id, quantity, loose_pack_qty, on_hand, reserved, on_hand_pack, reserved_pack')
  .in('product_id', products.map((p) => p.id));
const invByPid = new Map(invs.map((i) => [i.product_id, i]));

const { data: storeItems } = await supabase
  .from('order_items')
  .select('order_id, product_id, quantity, unit')
  .in('product_id', products.map((p) => p.id));
const storeOrderIds = [...new Set(storeItems.map((i) => i.order_id))];
const { data: storeOrders } = await supabase
  .from('orders')
  .select('id, status')
  .in('id', storeOrderIds)
  .in('status', ['pending', 'confirmed']);
const activeStoreIds = new Set(storeOrders.map((o) => o.id));

const { data: b2bItems } = await supabase
  .from('b2b_order_items')
  .select('order_id, product_id, quantity, unit')
  .in('product_id', products.map((p) => p.id));
const b2bIds = [...new Set(b2bItems.map((i) => i.order_id))];
const { data: b2bOrders } = await supabase
  .from('b2b_orders')
  .select('id, status')
  .in('id', b2bIds)
  .eq('status', 'pending');
const activeB2bIds = new Set(b2bOrders.map((o) => o.id));

function sumOpen(items, active, pid, unit) {
  return items
    .filter((i) => i.product_id === pid && i.unit === unit && active.has(i.order_id))
    .reduce((s, i) => s + i.quantity, 0);
}

console.log('===== 단순화 옵션 기준 정합성 검증 =====\n');
console.log('  상품              | DB 현재값                              | 기대값(단순화)                          | 일치');
console.log('  -----------------+--------------------------------------+--------------------------------------+----');

let allOk = true;
for (const p of products) {
  const inv = invByPid.get(p.id);
  if (!inv) continue;
  const ppb = ppbByPid.get(p.id) || 1;

  const storeBox  = sumOpen(storeItems,  activeStoreIds,  p.id, 'box');
  const storePack = sumOpen(storeItems,  activeStoreIds,  p.id, 'pack');
  const b2bBox    = sumOpen(b2bItems,    activeB2bIds,    p.id, 'box');
  const b2bPack   = sumOpen(b2bItems,    activeB2bIds,    p.id, 'pack');
  const b2bPackAsBox = b2bPack > 0 ? Math.ceil(b2bPack / ppb) : 0;

  // 단순화 기대값
  const expReserved      = storeBox + b2bBox + b2bPackAsBox;
  const expReservedPack  = storePack;  // 가맹점 팩만 (자투리 발주)
  const expOnHand        = inv.quantity       + expReserved;
  const expOnHandPack    = inv.loose_pack_qty + expReservedPack;

  const ok = inv.reserved      === expReserved      &&
             inv.reserved_pack === expReservedPack  &&
             inv.on_hand       === expOnHand        &&
             inv.on_hand_pack  === expOnHandPack;
  if (!ok) allOk = false;

  console.log(`  ${p.name.padEnd(17)} | res=${String(inv.reserved).padEnd(3)} res_pack=${String(inv.reserved_pack).padEnd(3)} oh=${String(inv.on_hand).padEnd(3)} oh_pack=${String(inv.on_hand_pack).padEnd(3)} | res=${String(expReserved).padEnd(3)} res_pack=${String(expReservedPack).padEnd(3)} oh=${String(expOnHand).padEnd(3)} oh_pack=${String(expOnHandPack).padEnd(3)} | ${ok ? '✓' : '✗'}`);
  if (!ok) {
    console.log(`    참고: ppb=${ppb}, storeBox=${storeBox}, storePack=${storePack}, b2bBox=${b2bBox}, b2bPack=${b2bPack}, b2bPackAsBox=${b2bPackAsBox}`);
  }
}

console.log('\n===== 등식 검증 =====');
let eqOk = true;
for (const inv of invs) {
  const p = products.find((x) => x.id === inv.product_id);
  const eq1 = inv.on_hand      === inv.quantity       + inv.reserved;
  const eq2 = inv.on_hand_pack === inv.loose_pack_qty + inv.reserved_pack;
  if (!eq1 || !eq2) eqOk = false;
  console.log(`  ${p.name.padEnd(17)} | box ${eq1 ? '✓' : '✗'} (on_hand=${inv.on_hand}, q+r=${inv.quantity + inv.reserved}) | pack ${eq2 ? '✓' : '✗'} (on_hand_pack=${inv.on_hand_pack}, l+rp=${inv.loose_pack_qty + inv.reserved_pack})`);
}

console.log(`\n===== 최종 =====`);
console.log(`  단순화 기대값 일치: ${allOk ? '★ 모두 ✓' : '✗ 일부 불일치'}`);
console.log(`  등식 일치:          ${eqOk ? '★ 모두 ✓' : '✗ 일부 불일치'}`);
