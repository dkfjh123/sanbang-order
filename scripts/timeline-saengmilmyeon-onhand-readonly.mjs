// 생밀면 총재고 시점별 역산 — READ ONLY
// 5/21 실사 38박스에서 출발해 날짜별로 (입고 - 실제출고)를 누적하고,
// 남아 있는 DB 스냅샷(백업 테이블)과 대조해 '2박스가 언제 어긋났는지' 특정한다.
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

const BASE_DATE = '2026-05-21';
const BASE_ONHAND = 38;

const { data: p } = await sb.from('products').select('id, name, pack_per_box').eq('name', '생밀면').single();
const ppb = p.pack_per_box || 1;

// 실물 입고
const { data: allTx } = await sb.from('inventory_transactions')
  .select('type, quantity, unit, description, created_at, source')
  .eq('product_id', p.id).gt('created_at', `${BASE_DATE}T23:59:59+09:00`).order('created_at');
const events = [];
for (const t of (allTx || [])) {
  if (t.type === 'inbound' && t.source === 'manual_inbound') {
    events.push({ date: t.created_at.slice(0, 10), d: Math.abs(t.quantity), what: `입고 ${t.description || ''}` });
  }
}
// 실제 출고 (가맹)
const { data: oi } = await sb.from('order_items').select('*').eq('product_id', p.id);
const ordIds = [...new Set((oi || []).map((r) => r.order_id))];
const { data: ords } = await sb.from('orders').select('id, order_number, status, ship_date, stores(short_name, name)').in('id', ordIds);
const ordById = new Map((ords || []).map((o) => [o.id, o]));
for (const r of (oi || [])) {
  const o = ordById.get(r.order_id);
  if (!o || o.status !== 'shipped' || !(o.ship_date > BASE_DATE)) continue;
  const box = r.unit === 'pack' ? Math.ceil(r.quantity / ppb) : r.quantity;
  events.push({ date: o.ship_date, d: -box, what: `출고 ${o.order_number} ${o.stores?.short_name || o.stores?.name || ''}` });
}
// 실제 출고 (B2B)
const { data: bi } = await sb.from('b2b_order_items').select('*').eq('product_id', p.id);
const bIds = [...new Set((bi || []).map((r) => r.order_id))];
const { data: bords } = await sb.from('b2b_orders').select('id, order_number, status, ship_date, b2b_customers(name)').in('id', bIds);
const bById = new Map((bords || []).map((o) => [o.id, o]));
for (const r of (bi || [])) {
  const o = bById.get(r.order_id);
  if (!o || o.status !== 'shipped' || !(o.ship_date > BASE_DATE)) continue;
  const box = r.unit === 'pack' ? r.quantity / ppb : r.quantity;
  events.push({ date: o.ship_date, d: -box, what: `B2B출고 ${o.order_number} ${o.b2b_customers?.name || ''}` });
}

events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

// 대조할 스냅샷 (백업 테이블에 남아 있는 실제 DB 값)
const SNAPSHOTS = [
  { date: '2026-06-10', on_hand: 81, src: 'backup_inventory_20260610 (033 직전)' },
];

console.log(`\n===== 생밀면 총재고 시점별 역산 =====`);
console.log(`출발: ${BASE_DATE} 실사 확정 ${BASE_ONHAND}박스\n`);
console.log(`  날짜         역산 총재고   DB 스냅샷    차이`);
console.log(`  ${'-'.repeat(56)}`);

let bal = BASE_ONHAND;
let i = 0;
const monthEnds = ['2026-05-31', '2026-06-10', '2026-06-30', '2026-07-31', '2026-08-07'];
for (const cut of monthEnds) {
  while (i < events.length && events[i].date <= cut) { bal += events[i].d; i++; }
  const snap = SNAPSHOTS.find((s) => s.date === cut);
  const diff = snap ? snap.on_hand - bal : null;
  console.log(`  ${cut}   ${String(bal).padStart(6)}      ${snap ? String(snap.on_hand).padStart(6) : '     -'}   ${diff === null ? '' : (diff === 0 ? '   ✓ 일치' : `   ✗ DB가 ${diff}박스 많음`)}`);
}

const { data: inv } = await sb.from('inventory').select('quantity, on_hand, reserved').eq('product_id', p.id).single();
console.log(`\n  현재 DB: 총재고 ${inv.on_hand} / 나갈것 ${inv.reserved} / 주문가능 ${inv.quantity}`);
console.log(`  현재 역산: ${bal}박스  → DB 총재고가 ${inv.on_hand - bal}박스 많음\n`);

console.log(`===== 끝 (읽기 전용) =====\n`);
