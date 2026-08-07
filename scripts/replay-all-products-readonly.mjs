// 전 전용상품 재고 리플레이 — READ ONLY
// 2026-06-10(033 보정 직후)부터 모든 사건을 재생해 DB 현재값과 대조한다.
// 특히 2026-07-30 03:22 함덕점 이중 출고처리가 상품별로 어떻게 작용했는지 본다.
//
// 재고 차감 RPC(apply_inventory_delta)는 어떤 칸이든 음수가 되면 예외를 던지고,
// 출고처리 경로는 그 에러를 받지 않는다 → '조용한 실패'(재고 그대로, 주문만 출고완료).
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
const kst = (d) => new Date(new Date(d).getTime() + 9 * 3600e3).toISOString().replace('T', ' ').slice(0, 19);
const pad = (s, n) => {
  const w = [...String(s)].reduce((a, c) => a + (c.charCodeAt(0) > 0x2000 ? 2 : 1), 0);
  return String(s) + ' '.repeat(Math.max(0, n - w));
};

const { data: products } = await sb.from('products')
  .select('id, name, pack_per_box').eq('product_type', 'exclusive').order('name');
const { data: bk } = await sb.from('backup_inventory_20260610').select('*');
const bkByPid = new Map(bk.map((b) => [b.product_id, b]));
const { data: invs } = await sb.from('inventory').select('*');
const invByPid = new Map(invs.map((i) => [i.product_id, i]));

const DOUBLE_ORDER = 'ORD-20260728-0204';   // 이중 출고처리가 일어난 주문
const summary = [];

for (const p of products) {
  const ppb = p.pack_per_box || 1;
  const b = bkByPid.get(p.id);
  if (!b) { console.log(`  ${p.name}: 6/10 백업 없음 — 건너뜀`); continue; }
  let q = b.quantity, r = b.reserved, oh = b.on_hand;
  const START = b.updated_at;

  const { data: txs } = await sb.from('inventory_transactions')
    .select('type, quantity, unit, description, created_at, source')
    .eq('product_id', p.id).gte('created_at', START).order('created_at');

  const ev = [];
  for (const t of (txs || [])) {
    const d = t.description || '';
    const n = Math.abs(t.quantity);
    if (t.unit === 'pack') continue;                        // 팩 칸은 별도 — 박스 리플레이에서 제외
    if (/20260610 정합보정/.test(d)) {                      // 033 보정: 절대값으로 세팅
      const m = d.match(/reserved (\d+)→(\d+), quantity (\d+)→(\d+)/);
      if (m) ev.push({ at: t.created_at, kind: '033 보정', set: { r: +m[2], q: +m[4] }, memo: d.slice(0, 40) });
      continue;
    }
    if (/발주 출고 \(ORD/.test(d))                 ev.push({ at: t.created_at, kind: '가맹 발주등록', n, dq: -n, dr: +n, doh: 0 });
    else if (/발주 수정.*추가 출고/.test(d))        ev.push({ at: t.created_at, kind: '가맹 수정↑', n, dq: -n, dr: +n, doh: 0, clampR: true });
    else if (/발주 수정.*수량 감소 복구/.test(d))   ev.push({ at: t.created_at, kind: '가맹 수정↓', n, dq: +n, dr: -n, doh: 0, clampR: true });
    else if (/발주 취소 복구|발주 실패 롤백/.test(d)) ev.push({ at: t.created_at, kind: '가맹 취소', n, dq: +n, dr: -n, doh: 0 });
    else if (/B2B 발주 등록/.test(d))               ev.push({ at: t.created_at, kind: 'B2B 등록', n, dq: -n, dr: +n, doh: 0 });
    else if (/B2B 발주 취소|B2B 발주 삭제/.test(d)) ev.push({ at: t.created_at, kind: 'B2B 취소', n, dq: +n, dr: -n, doh: 0 });
    else if (/B2B 출고취소 반품/.test(d))           ev.push({ at: t.created_at, kind: 'B2B 출고취소', n, dq: +n, dr: 0, doh: +n });
    else if (t.source === 'manual_inbound')         ev.push({ at: t.created_at, kind: '입고', n, dq: +n, dr: 0, doh: +n });
    else if (t.source === 'manual_adjust' || t.type === 'adjustment')
                                                    ev.push({ at: t.created_at, kind: '수기조정', n: t.quantity, dq: t.quantity, dr: 0, doh: t.quantity });
    else if (t.type === 'outbound')                 ev.push({ at: t.created_at, kind: '수기출고', n, dq: -n, dr: 0, doh: -n });
    else if (t.type === 'inbound')                  ev.push({ at: t.created_at, kind: '수기입고', n, dq: +n, dr: 0, doh: +n });
  }

  // 가맹 출고처리
  const { data: oi } = await sb.from('order_items').select('order_id, quantity, unit').eq('product_id', p.id);
  const ids = [...new Set((oi || []).map((x) => x.order_id))];
  const boxByOrder = new Map();
  for (const x of (oi || [])) {
    if ((x.unit || 'box') !== 'box') continue;
    boxByOrder.set(x.order_id, (boxByOrder.get(x.order_id) || 0) + x.quantity);
  }
  let ordNum = new Map();
  if (ids.length) {
    const { data: ords } = await sb.from('orders').select('id, order_number').in('id', ids);
    ordNum = new Map((ords || []).map((o) => [o.id, o.order_number]));
    const { data: logs } = await sb.from('order_logs').select('order_id, created_at').in('order_id', ids).eq('action', '출고 처리');
    for (const l of (logs || [])) {
      if (l.created_at < START) continue;
      const n = boxByOrder.get(l.order_id) || 0;
      if (!n) continue;
      ev.push({ at: l.created_at, kind: '가맹 출고처리', n, dq: 0, dr: -n, doh: -n, ship: true, ord: ordNum.get(l.order_id) });
    }
  }

  // B2B 출고
  const { data: bi } = await sb.from('b2b_order_items').select('order_id, quantity, unit').eq('product_id', p.id);
  const bids = [...new Set((bi || []).map((x) => x.order_id))];
  if (bids.length) {
    const boxByB = new Map();
    for (const x of (bi || [])) {
      const box = (x.unit || 'box') === 'pack' ? Math.ceil(x.quantity / ppb) : x.quantity;
      boxByB.set(x.order_id, (boxByB.get(x.order_id) || 0) + box);
    }
    const { data: bl } = await sb.from('b2b_order_logs').select('order_id, action, created_at').in('order_id', bids);
    for (const l of (bl || [])) {
      if ((l.action || '') !== 'ship' || l.created_at < START) continue;
      const n = boxByB.get(l.order_id) || 0;
      if (!n) continue;
      ev.push({ at: l.created_at, kind: 'B2B 출고처리', n, dq: 0, dr: -n, doh: -n, ship: true });
    }
  }

  ev.sort((a, x) => (a.at < x.at ? -1 : a.at > x.at ? 1 : 0));

  // 재생
  let dupApplied = null, silentFails = [];
  let dupSeen = 0;
  for (const e of ev) {
    if (e.set) { if (e.set.r !== undefined) r = e.set.r; if (e.set.q !== undefined) q = e.set.q; continue; }
    if (e.ship && (r + e.dr < 0 || oh + e.doh < 0)) {
      silentFails.push({ at: e.at, n: e.n, ord: e.ord, rAt: r });
      if (e.ord === DOUBLE_ORDER) { dupSeen++; if (dupSeen === 2) dupApplied = false; }
      continue;
    }
    if (e.ord === DOUBLE_ORDER && e.ship) { dupSeen++; if (dupSeen === 2) dupApplied = true; }
    q += e.dq;
    r = e.clampR ? Math.max(0, r + e.dr) : r + e.dr;
    oh += e.doh;
  }

  const inv = invByPid.get(p.id) || {};
  summary.push({ name: p.name, q, r, oh, inv, dupApplied, dupSeen, silentFails });
}

console.log(`\n===== 전 전용상품 리플레이 (2026-06-10 → 현재) =====\n`);
console.log('  ' + pad('상품', 22) + '리플레이(가능/나갈것/총재고)   실제DB(가능/나갈것/총재고)   일치');
console.log('  ' + '-'.repeat(92));
for (const s of summary) {
  const ok = s.q === s.inv.quantity && s.r === s.inv.reserved && s.oh === s.inv.on_hand;
  console.log('  ' + pad(s.name, 22)
    + `${String(s.q).padStart(6)} /${String(s.r).padStart(5)} /${String(s.oh).padStart(6)}      `
    + `${String(s.inv.quantity).padStart(6)} /${String(s.inv.reserved).padStart(5)} /${String(s.inv.on_hand).padStart(6)}      `
    + (ok ? '✓' : '✗'));
}

console.log(`\n===== 7/30 함덕점 이중 출고처리(${DOUBLE_ORDER})가 상품별로 어떻게 됐나 =====\n`);
for (const s of summary) {
  const dup = s.dupApplied === true ? '★ 두 번째도 실행됨 → 재고 이중 차감'
    : s.dupApplied === false ? '두 번째는 조용히 실패 → 피해 없음'
    : '이 주문에 없는 상품';
  console.log('  ' + pad(s.name, 22) + dup);
}

console.log(`\n===== 조용한 실패가 일어난 출고처리 =====\n`);
let any = false;
for (const s of summary) {
  if (!s.silentFails.length) continue;
  any = true;
  console.log(`  [${s.name}]`);
  for (const f of s.silentFails) console.log(`     ${kst(f.at)}  ${f.ord || 'B2B'}  ${f.n}박스 차감 시도 — 그때 나갈것 ${f.rAt}박스뿐 → 실패`);
}
if (!any) console.log('  (없음)');
console.log('\n===== 끝 (읽기 전용) =====\n');
