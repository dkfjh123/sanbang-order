// READ-ONLY — 아워홈 7월 거래명세서(성림상사) vs 시스템 금액 대조
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

// 사장님이 보내주신 거래명세서 4장 (성림상사 = 아워홈)
const STATEMENTS = [
  { date: '2026-07-03', supply: 979530, vat: 97953, total: 1077483 },
  { date: '2026-07-13', supply: 3046866, vat: 304686, total: 3351552 },
  { date: '2026-07-20', supply: 2904192, vat: 290419, total: 3194611 },
  { date: '2026-07-27', supply: 2300030, vat: 230003, total: 2530033 },
];

const { data: custs } = await supabase.from('b2b_customers').select('*');
const ourhome = custs.find(c => c.name === '아워홈');
console.log(`■ 아워홈 거래처 설정: 선입금(is_prepaid) = ${ourhome?.is_prepaid} / 권역 ${ourhome?.region} / 사업자 ${ourhome?.business_number || '⚠️ 미등록'}`);
console.log(`   → ${ourhome?.is_prepaid ? '예치금에서 차감됨' : '후불 — 예치금 차감 없음. 명세서 금액으로 결제받음'}`);
console.log('');

const { data: b2b } = await supabase
  .from('b2b_orders')
  .select('order_number, status, ship_date, total_amount, b2b_customers(name), b2b_order_items(*)')
  .in('status', ['confirmed', 'shipped'])
  .gte('ship_date', '2026-07-01').lte('ship_date', '2026-07-31')
  .order('ship_date');

const oh = b2b.filter(o => o.b2b_customers?.name === '아워홈');

console.log('■ 주문별 대조 (명세서 vs 시스템)');
console.log('');
let sSupply = 0, sVatStmt = 0, sVatSys = 0, sTotalStmt = 0, sTotalSys = 0;
for (const o of oh) {
  const st = STATEMENTS.find(s => s.date === o.ship_date);
  // 시스템: 품목 세포함 소계 합
  const sysTotal = o.b2b_order_items.reduce((s, i) => s + i.subtotal, 0);
  // 공급가액: 품목 공급가(단가×수량) 합
  const supply = o.b2b_order_items.reduce((s, i) => s + (i.subtotal_ex_tax ?? i.unit_price * i.quantity), 0);
  // 명세서 방식: 품목별 공급가 × 10% 절사
  const vatStmt = o.b2b_order_items.reduce((s, i) => s + Math.floor((i.subtotal_ex_tax ?? i.unit_price * i.quantity) * 0.1), 0);
  const vatSys = sysTotal - supply;

  sSupply += supply; sVatStmt += vatStmt; sVatSys += vatSys;
  sTotalStmt += supply + vatStmt; sTotalSys += sysTotal;

  console.log(`▶ ${o.order_number} (출고 ${o.ship_date})`);
  console.log(`   공급가액   시스템 ${f(supply).padStart(11)}  |  명세서 ${st ? f(st.supply).padStart(11) : '  (없음)'}  ${st && st.supply === supply ? '✅ 일치' : st ? '⚠️ 차이 ' + f(supply - st.supply) : ''}`);
  console.log(`   부가세     시스템 ${f(vatSys).padStart(11)}  |  명세서 ${st ? f(st.vat).padStart(11) : '  (없음)'}  ${st && st.vat === vatSys ? '✅ 일치' : st ? '⚠️ 차이 ' + f(vatSys - st.vat) : ''}`);
  console.log(`   └ 명세서방식 재계산(품목별 공급가×10% 절사) = ${f(vatStmt)}  ${st && st.vat === vatStmt ? '✅ 명세서와 일치' : ''}`);
  console.log(`   합계       시스템 ${f(sysTotal).padStart(11)}  |  명세서 ${st ? f(st.total).padStart(11) : '  (없음)'}  ${st && st.total === sysTotal ? '✅ 일치' : st ? '⚠️ 차이 ' + f(sysTotal - st.total) : ''}`);
  console.log(`   (참고) b2b_orders.total_amount = ${f(o.total_amount)}`);
  console.log('');
}

const stSupply = STATEMENTS.reduce((s, x) => s + x.supply, 0);
const stVat = STATEMENTS.reduce((s, x) => s + x.vat, 0);
const stTotal = STATEMENTS.reduce((s, x) => s + x.total, 0);

console.log('■ 7월 아워홈 총계');
console.log('');
console.log(`                    명세서 4장        시스템          차이`);
console.log(`   공급가액   ${f(stSupply).padStart(14)} ${f(sSupply).padStart(14)} ${f(sSupply - stSupply).padStart(10)}`);
console.log(`   부가세     ${f(stVat).padStart(14)} ${f(sVatSys).padStart(14)} ${f(sVatSys - stVat).padStart(10)}`);
console.log(`   합계       ${f(stTotal).padStart(14)} ${f(sTotalSys).padStart(14)} ${f(sTotalSys - stTotal).padStart(10)}`);
console.log('');
console.log(`   명세서방식으로 시스템 데이터 재계산: 공급가 ${f(sSupply)} + 부가세 ${f(sVatStmt)} = ${f(sSupply + sVatStmt)}`);
console.log(`   → 명세서 합계 ${f(stTotal)} 과 ${sSupply + sVatStmt === stTotal ? '✅ 정확히 일치' : '⚠️ 차이 ' + f(sSupply + sVatStmt - stTotal)}`);
