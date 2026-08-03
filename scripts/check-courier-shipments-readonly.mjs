// READ-ONLY — 택배 발송분(예치금 미반영) 추적: 협재 189,200 / 우도 80,300
// 시스템에 주문·매출로 잡혀 있는지, 세금계산서 발행 대상인지 확인. SELECT만 수행.
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(join(__dirname, '..', '.env.local'), 'utf-8');
const env = Object.fromEntries(
  envText.split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  })
);
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const f = (n) => Math.round(n ?? 0).toLocaleString('ko-KR');
const kst = (iso) => iso ? new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16) : '-';
const kstDate = (iso) => iso ? new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 10) : '';

async function fetchAll(table, select, applyFilters) {
  const rows = []; const page = 1000;
  for (let from = 0; ; from += page) {
    let q = supabase.from(table).select(select).range(from, from + page - 1);
    if (applyFilters) q = applyFilters(q);
    const { data, error } = await q;
    if (error) { console.error(`[${table}]`, error.message); process.exit(1); }
    rows.push(...data);
    if (data.length < page) break;
  }
  return rows;
}

const stores = await fetchAll('stores', 'id, name, short_name, is_direct, region, business_number, owner_name, deposit_balance');
const products = await fetchAll('products', 'id, name, product_type, pack_per_box, price, price_with_tax, is_tax_free');
const orders = await fetchAll('orders',
  'id, order_number, store_id, status, total_amount, ship_date, created_at, order_items(product_name, quantity, unit, unit_price, unit_price_with_tax, is_tax_free, subtotal)',
  q => q.order('created_at'));
const depTx = await fetchAll('deposit_transactions', '*', q => q.order('created_at'));
const depReq = await fetchAll('deposit_requests', '*', q => q.order('created_at'));

const nameOf = (id) => { const s = stores.find(x => x.id === id); return s ? (s.short_name || s.name) : String(id).slice(0, 8); };
const TARGETS = [
  { store: '협재점', amount: 189200 },
  { store: '우도점', amount: 80300 },
];

for (const t of TARGETS) {
  const st = stores.find(s => (s.short_name || s.name) === t.store);
  console.log('');
  console.log('████████████████████████████████████████████████████████');
  console.log(`  ${t.store} — ${f(t.amount)}원 추적`);
  console.log('████████████████████████████████████████████████████████');
  if (!st) { console.log('  ⚠️ 매장을 찾을 수 없음'); continue; }
  console.log(`  사업자번호: ${st.business_number || '(미등록)'} / 대표: ${st.owner_name || '(미등록)'} / 현재 예치금 ${f(st.deposit_balance)}원`);

  // 1) 충전요청에 해당 금액이 있는지 (전 기간)
  console.log('\n── 1) 충전요청 중 해당 금액 ──');
  const reqs = depReq.filter(r => r.store_id === st.id && r.amount === t.amount);
  if (!reqs.length) console.log('   없음');
  for (const r of reqs) {
    console.log(`   요청 ${kst(r.created_at)} | ${f(r.amount)}원 | 상태 ${r.status} | 처리 ${kst(r.reviewed_at)} | 비고: ${r.description || ''}`);
  }

  // 2) 예치금 거래에 해당 금액이 있는지 (전 기간, 절댓값)
  console.log('\n── 2) 예치금 거래 중 해당 금액(±) ──');
  const txs = depTx.filter(x => x.store_id === st.id && Math.abs(x.amount) === t.amount);
  if (!txs.length) console.log('   없음 → 예치금에 전혀 반영되지 않음');
  for (const x of txs) {
    console.log(`   ${kst(x.created_at)} | ${x.type} | ${x.amount >= 0 ? '+' : ''}${f(x.amount)}원 | 잔액 ${f(x.balance_after)} | ${x.description || ''}`);
  }

  // 3) 주문 중 해당 금액이 있는지 (전 기간)
  console.log('\n── 3) 주문금액이 해당 금액인 주문 ──');
  const os = orders.filter(o => o.store_id === st.id && o.total_amount === t.amount);
  if (!os.length) console.log('   없음 → 시스템에 주문(매출)으로 잡혀있지 않음');
  for (const o of os) {
    console.log(`   ${o.order_number} [${o.status}] 주문 ${kstDate(o.created_at)} / 출고 ${o.ship_date || '(없음)'} / ${f(o.total_amount)}원`);
    for (const it of o.order_items) console.log(`      · ${it.product_name} ${it.quantity}${it.unit === 'pack' ? '팩' : '박스'} × ${f(it.unit_price_with_tax)} = ${f(it.subtotal)}${it.is_tax_free ? ' (면세)' : ''}`);
  }

  // 4) 품목 소계가 해당 금액인 경우
  console.log('\n── 4) 주문 안에 소계가 해당 금액인 품목 ──');
  let found4 = 0;
  for (const o of orders.filter(o => o.store_id === st.id)) {
    for (const it of o.order_items) {
      if (it.subtotal === t.amount) {
        found4++;
        console.log(`   ${o.order_number} [${o.status}] 출고 ${o.ship_date || '(없음)'} · ${it.product_name} ${it.quantity}${it.unit === 'pack' ? '팩' : '박스'} = ${f(it.subtotal)}`);
      }
    }
  }
  if (!found4) console.log('   없음');

  // 5) 해당 매장 7월 주문 전체
  console.log('\n── 5) 7월 주문 전체 (귀속 확인용) ──');
  const july = orders.filter(o => o.store_id === st.id &&
    ((o.ship_date && o.ship_date >= '2026-07-01' && o.ship_date <= '2026-07-31') ||
     (!o.ship_date && kstDate(o.created_at) >= '2026-07-01' && kstDate(o.created_at) <= '2026-07-31')));
  for (const o of july) {
    console.log(`   ${o.order_number} [${o.status}] 주문 ${kstDate(o.created_at)} / 출고 ${o.ship_date || '(없음)'} / ${f(o.total_amount)}원`);
  }
  console.log(`   → 7월 주문 ${july.length}건, 합계 ${f(july.filter(o => ['confirmed','shipped'].includes(o.status)).reduce((s, o) => s + o.total_amount, 0))}원 (확정+출고완료)`);

  // 6) 해당 매장 7월 예치금 거래 전체
  console.log('\n── 6) 7월 예치금 거래 전체 ──');
  const jtx = depTx.filter(x => x.store_id === st.id && kstDate(x.created_at) >= '2026-07-01' && kstDate(x.created_at) <= '2026-07-31');
  for (const x of jtx) console.log(`   ${kst(x.created_at)} | ${String(x.type).padEnd(13)} | ${(x.amount >= 0 ? '+' : '') + f(x.amount)}원 | 잔액 ${f(x.balance_after)} | ${x.description || ''}`);

  // 7) 금액 조합 추정 — 이 금액이 어떤 상품 조합인지
  console.log('\n── 7) 금액 조합 추정 (전용상품 단가 기준) ──');
  const cands = [];
  for (const p of products) {
    for (const [unitName, price] of [['박스', p.price_with_tax], ['팩', p.pack_per_box > 1 ? Math.round(p.price_with_tax / p.pack_per_box) : null]]) {
      if (!price || price <= 0) continue;
      if (t.amount % price === 0) cands.push(`${p.name} ${unitName} ${f(price)}원 × ${t.amount / price}개 = ${f(t.amount)}`);
    }
  }
  if (!cands.length) console.log('   단일 상품 배수로는 안 떨어짐 (여러 품목 조합일 가능성)');
  else cands.slice(0, 10).forEach(c => console.log('   · ' + c));
}

// ── 전체: 7월 반려된 충전요청 vs 실제 입금 여부 ──
console.log('\n\n████████████████████████████████████████████████████████');
console.log('  7월 반려 충전요청 전체 (실제 입금됐다면 매출/계산서 누락 후보)');
console.log('████████████████████████████████████████████████████████');
for (const r of depReq.filter(r => r.status === 'rejected' && kstDate(r.created_at) >= '2026-07-01' && kstDate(r.created_at) <= '2026-07-31')) {
  console.log(`   ${kst(r.created_at)} | ${nameOf(r.store_id).padEnd(8)} | ${f(r.amount)}원 | 처리 ${kst(r.reviewed_at)} | ${r.description || ''}`);
}

// ── 7월 사업자번호 등록 현황 (계산서 발행 가능 여부) ──
console.log('\n\n████████████████████████████████████████████████████████');
console.log('  매장별 사업자번호 등록 현황 (세금계산서 발행에 필요)');
console.log('████████████████████████████████████████████████████████');
for (const s of stores.sort((a, b) => (a.short_name || a.name).localeCompare(b.short_name || b.name, 'ko'))) {
  console.log(`   ${(s.short_name || s.name).padEnd(16)} ${s.is_direct ? '[직영]' : '[가맹]'} 사업자 ${s.business_number || '⚠️ 미등록'} / 대표 ${s.owner_name || '⚠️ 미등록'}`);
}
