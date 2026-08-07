// 현재 재고 전체 스냅샷 — READ ONLY (조회만, 어떤 값도 쓰지 않음)
//
// 보여주는 것
//   1) 상품별 재고 3분할: 총재고(on_hand) / 나갈것(reserved) / 주문가능(quantity)  + 팩 칸
//   2) 등식 검증: on_hand = quantity + reserved,  on_hand_pack = loose + reserved_pack
//   3) reserved 근거: 미출고 발주(pending/confirmed) + 미출고 B2B(pending) 상세
//   4) 재고 가치: 산방푸드 판매가(sanbang_food_sale_price_with_tax) 기준
//   5) 최근 입고(manual_inbound) 내역
//
// 실행: node scripts/check-current-stock-readonly.mjs
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

const now = new Date();
const kst = new Date(now.getTime() + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16);
const won = (n) => '₩' + Math.round(n).toLocaleString('ko-KR');
const pad = (s, n) => {
  // 한글 폭 보정 (한글 2칸)
  const w = [...String(s)].reduce((a, c) => a + (c.charCodeAt(0) > 0x2000 ? 2 : 1), 0);
  return String(s) + ' '.repeat(Math.max(0, n - w));
};
const num = (v, n) => String(v ?? 0).padStart(n);

console.log(`\n===== 현재 재고 스냅샷 (${kst} KST) =====\n`);

// ---------- 기준 데이터 ----------
const { data: products, error: pErr } = await supabase
  .from('products')
  .select('id, name, spec, unit, storage, product_type, is_active, pack_per_box, sanbang_food_sale_price_with_tax, cost_price_with_tax, price_with_tax, is_loose_pack_sellable')
  .order('product_type')
  .order('name');
if (pErr) { console.error('products 조회 실패:', pErr.message); process.exit(1); }
const prodById = new Map(products.map((p) => [p.id, p]));

const { data: invs, error: iErr } = await supabase
  .from('inventory')
  .select('product_id, quantity, loose_pack_qty, on_hand, reserved, on_hand_pack, reserved_pack, updated_at');
if (iErr) { console.error('inventory 조회 실패:', iErr.message); process.exit(1); }
const invByPid = new Map(invs.map((r) => [r.product_id, r]));

// ---------- 미출고 예약 근거 (발주 / B2B) ----------
const { data: orders } = await supabase
  .from('orders')
  .select('id, order_number, status, order_date, store_id, stores(short_name, name)')
  .in('status', ['pending', 'confirmed']);
const openOrderIds = (orders || []).map((o) => o.id);
const orderInfo = new Map((orders || []).map((o) => [o.id, o]));

let openItems = [];
if (openOrderIds.length) {
  const { data } = await supabase
    .from('order_items')
    .select('order_id, product_id, product_name, quantity, unit')
    .in('order_id', openOrderIds);
  openItems = data || [];
}

const { data: b2bOrders } = await supabase
  .from('b2b_orders')
  .select('id, order_number, status, order_date, b2b_customers(name)')
  .eq('status', 'pending');
const openB2bIds = (b2bOrders || []).map((o) => o.id);
const b2bInfo = new Map((b2bOrders || []).map((o) => [o.id, o]));

let openB2bItems = [];
if (openB2bIds.length) {
  const { data } = await supabase
    .from('b2b_order_items')
    .select('order_id, product_id, product_name, quantity, unit')
    .in('order_id', openB2bIds);
  openB2bItems = data || [];
}

const nameToPid = new Map(products.map((p) => [p.name, p.id]));
const resv = new Map(); // pid -> {box, pack, details:[]}
const bump = (pid, qty, unit, label) => {
  if (!pid) return;
  if (!resv.has(pid)) resv.set(pid, { box: 0, pack: 0, details: [] });
  const r = resv.get(pid);
  if (unit === 'pack') r.pack += qty; else r.box += qty;
  r.details.push(`${label} ${qty}${unit === 'pack' ? '팩' : '박스'}`);
};
for (const it of openItems) {
  const o = orderInfo.get(it.order_id);
  const store = o?.stores?.short_name || o?.stores?.name || '매장';
  bump(it.product_id || nameToPid.get(it.product_name), it.quantity, it.unit || 'box',
    `발주 ${o?.order_number || ''}(${o?.status}, ${store}, ${o?.order_date || ''})`);
}
for (const it of openB2bItems) {
  const o = b2bInfo.get(it.order_id);
  const cust = o?.b2b_customers?.name || 'B2B';
  bump(it.product_id || nameToPid.get(it.product_name), it.quantity, it.unit || 'box',
    `B2B ${o?.order_number || ''}(${o?.status}, ${cust}, ${o?.order_date || ''})`);
}

// ---------- 출력 ----------
function section(title, rows) {
  console.log(`\n## ${title}`);
  if (!rows.length) { console.log('  (없음)'); return { value: 0 }; }
  console.log('  ' + pad('상품', 22) + pad('보관', 6) + '총재고  나갈것  주문가능 |  팩총  팩나갈  팩가능 | 등식 |        재고가치');
  console.log('  ' + '-'.repeat(112));
  let total = 0;
  for (const p of rows) {
    const inv = invByPid.get(p.id) || { quantity: 0, loose_pack_qty: 0, on_hand: 0, reserved: 0, on_hand_pack: 0, reserved_pack: 0 };
    const boxOk = (inv.on_hand ?? 0) === (inv.quantity ?? 0) + (inv.reserved ?? 0);
    const packOk = (inv.on_hand_pack ?? 0) === (inv.loose_pack_qty ?? 0) + (inv.reserved_pack ?? 0);
    const sfsp = p.sanbang_food_sale_price_with_tax || 0;
    const ppb = p.pack_per_box || 1;
    const packPrice = ppb > 1 ? Math.round(sfsp / ppb) : sfsp;
    const value = (inv.quantity || 0) * sfsp + (inv.loose_pack_qty || 0) * packPrice;
    total += value;
    const storage = { frozen: '냉동', refrigerated: '냉장', room_temp: '상온' }[p.storage] || '-';
    const low = (inv.quantity ?? 0) <= 3 ? ' ← 부족' : '';
    console.log('  ' + pad(p.name, 22) + pad(storage, 6)
      + num(inv.on_hand, 5) + num(inv.reserved, 8) + num(inv.quantity, 9)
      + ' |' + num(inv.on_hand_pack, 6) + num(inv.reserved_pack, 7) + num(inv.loose_pack_qty, 8)
      + ' |  ' + (boxOk ? '✓' : '✗박스') + (packOk ? '' : '✗팩') + '  |'
      + won(value).padStart(14) + low);
  }
  console.log('  ' + '-'.repeat(112));
  console.log('  ' + pad('소계', 22) + ' '.repeat(66) + won(total).padStart(14));
  return { value: total };
}

const exclusive = products.filter((p) => p.product_type === 'exclusive' && p.is_active !== false);
const general = products.filter((p) => p.product_type !== 'exclusive' && p.is_active !== false && invByPid.has(p.id));

const ex = section('전용상품 (산방에프앤비 소유 재고)', exclusive);
const ge = section('범용상품 (신화유통 등)', general);

console.log(`\n## 총 재고 가치 (주문가능 수량 × 산방푸드 판매가)`);
console.log(`   전용상품 ${won(ex.value)}  +  범용상품 ${won(ge.value)}  =  ${won(ex.value + ge.value)}`);

// 등식 위반 요약
const bad = invs.filter((i) => (i.on_hand ?? 0) !== (i.quantity ?? 0) + (i.reserved ?? 0)
  || (i.on_hand_pack ?? 0) !== (i.loose_pack_qty ?? 0) + (i.reserved_pack ?? 0));
console.log(`\n## 정합성(등식) 검사: ${bad.length === 0 ? '★ 위반 0건 — 모두 정상' : `✗ ${bad.length}건 위반`}`);
for (const b of bad) console.log(`   - ${prodById.get(b.product_id)?.name || b.product_id}: on_hand=${b.on_hand} quantity=${b.quantity} reserved=${b.reserved} / pack ${b.on_hand_pack}=${b.loose_pack_qty}+${b.reserved_pack}`);

// reserved 근거 상세
console.log(`\n## '나갈것들(reserved)' 근거 — 미출고 발주/B2B`);
let any = false;
for (const p of products) {
  const r = resv.get(p.id);
  if (!r || (!r.box && !r.pack)) continue;
  any = true;
  const inv = invByPid.get(p.id) || {};
  const matchBox = (inv.reserved ?? 0) === r.box;
  const matchPack = (inv.reserved_pack ?? 0) === r.pack;
  console.log(`\n  [${p.name}] 미출고 합계 ${r.box}박스 / ${r.pack}팩  ` +
    `(DB reserved=${inv.reserved ?? 0}${matchBox ? ' ✓' : ' ✗불일치'}, reserved_pack=${inv.reserved_pack ?? 0}${matchPack ? ' ✓' : ' ✗불일치'})`);
  r.details.forEach((d) => console.log(`     · ${d}`));
}
if (!any) console.log('  (미출고 발주/B2B 없음)');

// 최근 입고
const since = new Date(now.getTime() - 60 * 86400000).toISOString();
const { data: txs } = await supabase
  .from('inventory_transactions')
  .select('product_id, type, quantity, unit, description, created_at, source')
  .gte('created_at', since)
  .eq('type', 'inbound')
  .order('created_at', { ascending: false });
const inbound = (txs || []).filter((t) => t.source === 'manual_inbound');
console.log(`\n## 최근 60일 입고 등록 (manual_inbound) — ${inbound.length}건`);
if (!inbound.length) console.log('  (없음)');
for (const t of inbound.slice(0, 40)) {
  console.log(`  ${t.created_at.slice(0, 10)}  ${pad(prodById.get(t.product_id)?.name || t.product_id, 20)} +${t.quantity}${t.unit === 'pack' ? '팩' : '박스'}   ${t.description || ''}`);
}

console.log('\n===== 끝 (읽기 전용 — 데이터 변경 없음) =====\n');
