// 생밀면 총재고(on_hand) 역산 — READ ONLY
// 기준점: 028 마이그레이션 = 2026-05-21 사장님 실사 확정 on_hand 38박스
// 이후 실물 이동만 누적:  +입고(manual_inbound 등)  -실제 출고완료(가맹 shipped + B2B shipped)
// → 계산값이 현재 DB on_hand(180)와 맞는지, quantity(178)와 맞는지 판정
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
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const BASE_DATE = '2026-05-21';   // 028 실사 확정일
const BASE_ONHAND = 38;           // 028 확정 실재고

const { data: p } = await sb.from('products').select('id, name, pack_per_box').eq('name', '생밀면').single();
const { data: inv } = await sb.from('inventory')
  .select('quantity, loose_pack_qty, on_hand, reserved').eq('product_id', p.id).single();

console.log(`\n===== 생밀면 총재고 역산 =====`);
console.log(`기준점: ${BASE_DATE} 실사 확정 on_hand = ${BASE_ONHAND}박스 (028 마이그레이션)\n`);

// ---- (1) 입고 (실물 들어온 것) ----
const { data: allTx } = await sb.from('inventory_transactions')
  .select('type, quantity, unit, description, created_at, source')
  .eq('product_id', p.id)
  .gt('created_at', `${BASE_DATE}T23:59:59+09:00`)
  .order('created_at');

// 실물 입고 판정: source=manual_inbound. (031 백필 이전 데이터는 설명 패턴으로 보조판정)
function isPhysicalInbound(t) {
  if (t.type !== 'inbound') return false;
  if (t.source === 'manual_inbound') return true;
  if (t.source === 'manual_adjust') return false;
  if (t.source) return false;
  const d = t.description || '';
  if (/^(발주|B2B|b2b)/.test(d)) return false;              // 발주/B2B 자동 복구 = quantity 이동, 실물 아님
  if (/복구|조정|정합|차감|회수/.test(d)) return false;
  return true;
}
const inbounds = (allTx || []).filter(isPhysicalInbound);
const inSum = inbounds.reduce((a, t) => a + Math.abs(t.quantity), 0);

// 수기 조정(manual_adjust / adjustment)
// 단, 설명에 "on_hand ... 유지" 라고 적힌 건은 quantity 만 고친 것 → on_hand 역산에서 제외
const adjustsAll = (allTx || []).filter((t) => t.source === 'manual_adjust' || t.type === 'adjustment');
const isOnHandNeutral = (t) => /on_hand[^,]*유지/.test(t.description || '');
const adjusts = adjustsAll.filter((t) => !isOnHandNeutral(t));
const adjustsNeutral = adjustsAll.filter(isOnHandNeutral);
const adjSum = adjusts.reduce((a, t) => a + (t.type === 'inbound' ? Math.abs(t.quantity) : t.type === 'outbound' ? -Math.abs(t.quantity) : t.quantity), 0);

// 수기 출고(manual outbound) — 조정 아닌 순수 출고 등록
const manualOut = (allTx || []).filter((t) => t.type === 'outbound' && !/^(발주|B2B|b2b)/.test(t.description || ''));
const manualOutSum = manualOut.reduce((a, t) => a + Math.abs(t.quantity), 0);

// ---- (2) 실제 출고완료 (물건이 나간 것) ----
const { data: oiAll } = await sb.from('order_items').select('*').eq('product_id', p.id);
const ordIds = [...new Set((oiAll || []).map((r) => r.order_id))];
const { data: ords } = await sb.from('orders')
  .select('id, order_number, status, ship_date, stores(short_name, name)').in('id', ordIds);
const ordById = new Map((ords || []).map((o) => [o.id, o]));
const shippedStore = (oiAll || [])
  .map((r) => ({ r, o: ordById.get(r.order_id) }))
  .filter(({ o }) => o && o.status === 'shipped' && o.ship_date > BASE_DATE);
const storeBox = shippedStore.reduce((a, { r }) => a + (r.unit === 'pack' ? Math.ceil(r.quantity / (p.pack_per_box || 1)) : r.quantity), 0);

const { data: biAll } = await sb.from('b2b_order_items').select('*').eq('product_id', p.id);
const bIds = [...new Set((biAll || []).map((r) => r.order_id))];
const { data: bords } = await sb.from('b2b_orders')
  .select('id, order_number, status, ship_date, b2b_customers(name)').in('id', bIds);
const bById = new Map((bords || []).map((o) => [o.id, o]));
const shippedB2b = (biAll || [])
  .map((r) => ({ r, o: bById.get(r.order_id) }))
  .filter(({ o }) => o && o.status === 'shipped' && o.ship_date > BASE_DATE);
const b2bBox = shippedB2b.reduce((a, { r }) => a + (r.unit === 'pack' ? r.quantity / (p.pack_per_box || 1) : r.quantity), 0);

// ---- (3) 결과 ----
const calc = BASE_ONHAND + inSum + adjSum - manualOutSum - storeBox - b2bBox;

console.log(`  (+) 입고 등록 합계            : +${inSum}박스  (${inbounds.length}건)`);
console.log(`  (+/-) 수기 조정(adjustment)   : ${adjSum >= 0 ? '+' : ''}${adjSum}박스  (${adjusts.length}건)`);
console.log(`  (-) 수기 출고 등록            : -${manualOutSum}박스  (${manualOut.length}건)`);
console.log(`  (-) 가맹점 출고완료           : -${storeBox}박스  (${shippedStore.length}줄)`);
console.log(`  (-) B2B 출고완료              : -${b2bBox}박스  (${shippedB2b.length}줄)`);
console.log(`  ${'-'.repeat(52)}`);
console.log(`  역산 총재고                   = ${BASE_ONHAND} + ${inSum} + ${adjSum} - ${manualOutSum} - ${storeBox} - ${b2bBox} = ${calc}박스\n`);

console.log(`  현재 DB 총재고(on_hand)   : ${inv.on_hand}박스   → 역산과 차이 ${inv.on_hand - calc}`);
console.log(`  현재 DB 주문가능(quantity): ${inv.quantity}박스   → 역산과 차이 ${inv.quantity - calc}`);
console.log(`  현재 DB 나갈것(reserved)  : ${inv.reserved}박스`);

console.log(`\n----- 판정 -----`);
if (calc === inv.on_hand) console.log(`  ★ 역산 = on_hand(${inv.on_hand}) → 실물은 ${inv.on_hand}박스. 좀비 reserved ${inv.reserved} 때문에 '주문가능'이 ${inv.reserved}박스 적게 잡혀 있음.`);
else if (calc === inv.quantity) console.log(`  ★ 역산 = quantity(${inv.quantity}) → 실물은 ${inv.quantity}박스. on_hand 가 ${inv.reserved}박스 부풀어 있음.`);
else console.log(`  ? 역산(${calc})이 둘 다와 불일치 — 추가 추적 필요`);

console.log(`\n----- 입고 내역 (역산에 포함된 것) -----`);
for (const t of inbounds) console.log(`  ${t.created_at.slice(0, 10)}  +${Math.abs(t.quantity)}  [${t.source || 'null'}]  ${t.description || ''}`);
console.log(`\n----- 조정/수기출고 내역 (역산에 포함된 것) -----`);
for (const t of [...adjusts, ...manualOut]) console.log(`  ${t.created_at.slice(0, 10)}  ${t.type} ${t.quantity}  [${t.source || 'null'}]  ${t.description || ''}`);
if (!adjusts.length && !manualOut.length) console.log('  (없음)');

console.log(`\n----- on_hand 무관 조정 (quantity 만 고친 건 — 역산 제외) -----`);
for (const t of adjustsNeutral) console.log(`  ${t.created_at.slice(0, 10)}  ${t.type} ${t.quantity}  ${t.description || ''}`);
if (!adjustsNeutral.length) console.log('  (없음)');

console.log(`\n----- 역산에서 제외한 tx (quantity 이동일 뿐 실물 아님) -----`);
const excluded = (allTx || []).filter((t) => !isPhysicalInbound(t) && !adjustsAll.includes(t) && !manualOut.includes(t));
for (const t of excluded) console.log(`  ${t.created_at.slice(0, 10)}  ${t.type} ${t.quantity}  ${t.description || ''}`);

console.log('\n===== 끝 (읽기 전용) =====\n');
