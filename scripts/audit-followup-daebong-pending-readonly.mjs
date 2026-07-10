// READ-ONLY — 후속 확인: 돼봉 B2B 원장 전체 + 미출고/출고일누락 주문 점검. SELECT만 수행.
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
const kst = (iso) => new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16);

// 1. 돼봉 B2B 예치금 원장 전체
const { data: txs } = await supabase.from('b2b_deposit_transactions').select('*').order('created_at');
console.log('=== 돼봉 B2B 예치금 원장 전체 ===');
for (const t of txs || []) {
  console.log(`  ${kst(t.created_at)}  [${t.type.padEnd(12)}] ${(t.amount >= 0 ? '+' : '') + f(t.amount)}원 → 잔액 ${f(t.balance_after)}원  ${t.description || ''}`);
}

// 2. 예치금이 차감됐는데 아직 미출고이거나 출고일이 비어있는 주문 (돈은 나갔는데 물건이 안 나간 것)
const { data: orders } = await supabase
  .from('orders')
  .select('order_number, status, total_amount, ship_date, created_at, stores(short_name, name, is_direct)')
  .order('created_at');
console.log('\n=== 출고일 누락 or 미확정 상태 주문 (전 기간) ===');
let found = 0;
for (const o of orders || []) {
  const bad = (!o.ship_date && o.status !== 'cancelled') || !['confirmed', 'shipped', 'cancelled'].includes(o.status);
  if (bad) {
    found++;
    console.log(`  ${o.order_number} [${o.status}] ${o.stores?.short_name || o.stores?.name} ${f(o.total_amount)}원 출고일:${o.ship_date || '없음'} 주문일:${kst(o.created_at)}`);
  }
}
if (!found) console.log('  ✅ 없음 — 취소 제외 모든 주문에 출고일 있음, 상태도 정상');

// 3. B2B 주문도 동일 점검
const { data: bo } = await supabase
  .from('b2b_orders')
  .select('order_number, status, total_amount, ship_date, created_at, b2b_customers(name)')
  .order('created_at');
console.log('\n=== B2B 출고일 누락 or 미확정 주문 (전 기간) ===');
let f2 = 0;
for (const o of bo || []) {
  const bad = (!o.ship_date && o.status !== 'cancelled') || !['confirmed', 'shipped', 'cancelled'].includes(o.status);
  if (bad) {
    f2++;
    console.log(`  ${o.order_number} [${o.status}] ${o.b2b_customers?.name} ${f(o.total_amount)}원 출고일:${o.ship_date || '없음'} 주문일:${kst(o.created_at)}`);
  }
}
if (!f2) console.log('  ✅ 없음');

// 4. 5·6월 취소 주문 목록 (참고)
console.log('\n=== 5·6월 취소된 주문 (참고 — 환불 정상처리 여부는 본 점검 C-2에서 확인됨) ===');
for (const o of (orders || []).filter(o => o.status === 'cancelled' && o.created_at >= '2026-04-30' && o.created_at < '2026-07-01')) {
  console.log(`  ${o.order_number} ${o.stores?.short_name || o.stores?.name} ${f(o.total_amount)}원 (주문일 ${kst(o.created_at)})`);
}
