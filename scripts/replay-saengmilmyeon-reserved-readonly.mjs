// 생밀면 재고 3칸 전체 재생(리플레이) — READ ONLY
// 시작점: 2026-06-10 033 보정 직후 = quantity 36 / reserved 45 / on_hand 81
// 이후 모든 사건을 시간순으로 다시 계산해서, DB 현재값(178/2/180)과 어긋나는 지점을 찾는다.
//
// 코드상 규칙 (032 델타 가이드 + 각 API 확인):
//   가맹 발주등록 : quantity -N, reserved +N              (tx "발주 출고 (ORD-)")
//   가맹 발주수정 : quantity -diff, reserved = MAX(0, reserved+diff)   (tx "발주 수정")
//   가맹 출고처리 : reserved -N, on_hand -N               (order_logs '출고 처리', tx 없음)
//   가맹 취소     : quantity +N, reserved -N              (tx "발주 취소 복구")
//   B2B 등록      : quantity -N, reserved +N              (tx "B2B 발주 등록")
//   B2B 출고      : reserved -N, on_hand -N               (b2b_order_logs, tx 없음)
//   입고/조정     : quantity +C, on_hand +C
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
const kst = (d) => new Date(new Date(d).getTime() + 9 * 3600e3).toISOString().replace('T', ' ').slice(0, 16);

const { data: p } = await sb.from('products').select('id, pack_per_box').eq('name', '생밀면').single();
const ppb = p.pack_per_box || 1;

// 시작점 = 033 보정 tx 시각
const { data: baseTx } = await sb.from('inventory_transactions')
  .select('created_at, description').eq('product_id', p.id)
  .like('description', '%20260610 정합보정%').single();
const START = baseTx.created_at;
let q = 36, r = 45, oh = 81;
console.log(`\n===== 생밀면 재고 리플레이 =====`);
console.log(`시작: ${kst(START)}  (033 보정 직후)  주문가능 ${q} / 나갈것 ${r} / 총재고 ${oh}\n`);

// ---- 사건 수집 ----
const ev = [];

// 재고 트랜잭션 기반 사건
const { data: txs } = await sb.from('inventory_transactions')
  .select('type, quantity, unit, description, created_at, source')
  .eq('product_id', p.id).gt('created_at', START).order('created_at');
for (const t of (txs || [])) {
  const d = t.description || '';
  const n = Math.abs(t.quantity);
  if (/발주 출고 \(ORD/.test(d))            ev.push({ at: t.created_at, kind: '가맹 발주등록', n, dq: -n, dr: +n, doh: 0, memo: d });
  else if (/발주 수정.*추가 출고/.test(d))   ev.push({ at: t.created_at, kind: '가맹 수정(늘림)', n, dq: -n, dr: +n, doh: 0, clampR: true, memo: d });
  else if (/발주 수정.*수량 감소 복구/.test(d)) ev.push({ at: t.created_at, kind: '가맹 수정(줄임)', n, dq: +n, dr: -n, doh: 0, clampR: true, memo: d });
  else if (/발주 취소 복구/.test(d))         ev.push({ at: t.created_at, kind: '가맹 취소', n, dq: +n, dr: -n, doh: 0, memo: d });
  else if (/B2B 발주 등록/.test(d))          ev.push({ at: t.created_at, kind: 'B2B 등록', n, dq: -n, dr: +n, doh: 0, memo: d });
  else if (/B2B 발주 취소|B2B 발주 삭제/.test(d)) ev.push({ at: t.created_at, kind: 'B2B 취소', n, dq: +n, dr: -n, doh: 0, memo: d });
  else if (/B2B 출고취소 반품/.test(d))      ev.push({ at: t.created_at, kind: 'B2B 출고취소', n, dq: +n, dr: 0, doh: +n, memo: d });
  else if (t.source === 'manual_inbound')    ev.push({ at: t.created_at, kind: '입고 등록', n, dq: +n, dr: 0, doh: +n, memo: d });
  else if (t.type === 'outbound')            ev.push({ at: t.created_at, kind: '수기 출고', n, dq: -n, dr: 0, doh: -n, memo: d });
  else if (t.source === 'manual_adjust' || t.type === 'adjustment')
                                             ev.push({ at: t.created_at, kind: '수기 조정', n: t.quantity, dq: 0, dr: 0, doh: 0, memo: d + ' ※수동확인필요' });
  else                                       ev.push({ at: t.created_at, kind: '미분류', n, dq: 0, dr: 0, doh: 0, memo: d + ' ※미분류' });
}

// 가맹 출고처리 (order_logs)
const { data: oi } = await sb.from('order_items').select('order_id, quantity, unit').eq('product_id', p.id);
const ids = [...new Set((oi || []).map((x) => x.order_id))];
const { data: ords } = await sb.from('orders').select('id, order_number, stores(short_name, name)').in('id', ids);
const ordById = new Map((ords || []).map((o) => [o.id, o]));
const qtyByOrder = new Map();
for (const x of (oi || [])) {
  const box = (x.unit || 'box') === 'pack' ? Math.ceil(x.quantity / ppb) : x.quantity;
  qtyByOrder.set(x.order_id, (qtyByOrder.get(x.order_id) || 0) + box);
}
const { data: logs } = await sb.from('order_logs').select('order_id, action, created_at').in('order_id', ids).eq('action', '출고 처리');
for (const l of (logs || [])) {
  if (l.created_at <= START) continue;
  const n = qtyByOrder.get(l.order_id) || 0;
  const o = ordById.get(l.order_id);
  ev.push({ at: l.created_at, kind: '가맹 출고처리', n, dq: 0, dr: -n, doh: -n, memo: `${o?.order_number} ${o?.stores?.short_name || o?.stores?.name || ''}` });
}

// B2B 출고 (b2b_order_logs)
const { data: bi } = await sb.from('b2b_order_items').select('order_id, quantity, unit').eq('product_id', p.id);
const bids = [...new Set((bi || []).map((x) => x.order_id))];
const { data: bords } = await sb.from('b2b_orders').select('id, order_number, b2b_customers(name)').in('id', bids);
const bById = new Map((bords || []).map((o) => [o.id, o]));
const bQty = new Map();
for (const x of (bi || [])) {
  const box = (x.unit || 'box') === 'pack' ? Math.ceil(x.quantity / ppb) : x.quantity;
  bQty.set(x.order_id, (bQty.get(x.order_id) || 0) + box);
}
const { data: blogs, error: blErr } = await sb.from('b2b_order_logs').select('order_id, action, created_at').in('order_id', bids);
if (blErr) console.log('  ※ b2b_order_logs 조회 실패:', blErr.message);
for (const l of (blogs || [])) {
  if (l.created_at <= START) continue;
  if ((l.action || '') !== 'ship') continue;   // b2b_order_logs.action = create | ship | cancel
  const n = bQty.get(l.order_id) || 0;
  const o = bById.get(l.order_id);
  ev.push({ at: l.created_at, kind: 'B2B 출고처리', n, dq: 0, dr: -n, doh: -n, memo: `${o?.order_number} ${o?.b2b_customers?.name || ''}` });
}

ev.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

// ---- 재생 ----
console.log('  시각              사건            수량   → 주문가능  나갈것  총재고   비고');
console.log('  ' + '-'.repeat(104));
// apply_inventory_delta 는 어떤 칸이든 음수가 되면 예외를 던진다.
// 출고처리 경로(가맹/B2B)는 그 에러를 받지 않고 무시하므로 → 재고는 안 변하고 주문만 출고완료가 된다.
// 이 '조용한 실패'를 그대로 재현한다.
for (const e of ev) {
  const rBefore = r;
  const isShip = /출고처리/.test(e.kind);
  if (isShip && (r + e.dr < 0 || oh + e.doh < 0)) {
    console.log(`  ${kst(e.at)}  ${String(e.kind).padEnd(14)} ${String(e.n).padStart(4)}   → ${String(q).padStart(7)} ${String(r).padStart(7)} ${String(oh).padStart(7)}   ★★ 조용한 실패 (나갈것 ${r}에서 ${e.n} 차감 불가 → 재고 그대로, 주문만 출고완료) ${e.memo.slice(0, 40)}`);
    continue;
  }
  q += e.dq;
  r = e.clampR ? Math.max(0, r + e.dr) : r + e.dr;
  oh += e.doh;
  const clamped = e.clampR && (rBefore + e.dr) < 0;
  const eqBad = oh !== q + r;
  console.log(`  ${kst(e.at)}  ${String(e.kind).padEnd(14)} ${String(e.n).padStart(4)}   → ${String(q).padStart(7)} ${String(r).padStart(7)} ${String(oh).padStart(7)}   ${clamped ? '★클램프발생 ' : ''}${eqBad ? `★등식깨짐(${q}+${r}≠${oh}) ` : ''}${e.memo.slice(0, 40)}`);
}

const { data: inv } = await sb.from('inventory').select('quantity, reserved, on_hand').eq('product_id', p.id).single();
console.log('\n  ' + '-'.repeat(104));
console.log(`  리플레이 최종 : 주문가능 ${q} / 나갈것 ${r} / 총재고 ${oh}`);
console.log(`  실제 DB      : 주문가능 ${inv.quantity} / 나갈것 ${inv.reserved} / 총재고 ${inv.on_hand}`);
console.log(`  차이         : 주문가능 ${inv.quantity - q} / 나갈것 ${inv.reserved - r} / 총재고 ${inv.on_hand - oh}`);
console.log('\n===== 끝 (읽기 전용) =====\n');
