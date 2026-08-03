// READ-ONLY — 7월 B2B(돼봉·아워홈) 세금계산서 금액 확인: 실제 공급가 컬럼 vs 세포함 역산
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

// b2b_order_items 컬럼 확인
const { data: sample } = await supabase.from('b2b_order_items').select('*').limit(1);
console.log('■ b2b_order_items 컬럼:', Object.keys(sample?.[0] || {}).join(', '));
console.log('');

const { data: b2b, error } = await supabase
  .from('b2b_orders')
  .select('order_number, status, ship_date, created_at, total_amount, b2b_customers(name, business_number, region), b2b_order_items(*)')
  .in('status', ['confirmed', 'shipped'])
  .gte('ship_date', '2026-07-01').lte('ship_date', '2026-07-31')
  .order('ship_date');
if (error) { console.error(error.message); process.exit(1); }

const byCust = new Map();
for (const o of b2b) {
  const name = o.b2b_customers?.name || '?';
  if (!byCust.has(name)) byCust.set(name, { biz: o.b2b_customers?.business_number, orders: [], supplyCol: 0, vatCol: 0, withTax: 0, hasCol: true });
  const r = byCust.get(name);
  r.orders.push(o);
  console.log(`\n■ ${name} — ${o.order_number} [${o.status}] 출고 ${o.ship_date} / 주문금액 ${f(o.total_amount)}원`);
  for (const it of o.b2b_order_items) {
    const exTax = it.subtotal_ex_tax ?? (it.unit_price != null ? it.unit_price * it.quantity : null);
    const back = Math.round(it.subtotal / 1.1);
    if (exTax == null) r.hasCol = false;
    r.supplyCol += exTax ?? back;
    r.vatCol += it.subtotal - (exTax ?? back);
    r.withTax += it.subtotal;
    console.log(`   · ${it.product_name} ${it.quantity}${it.unit === 'pack' ? '팩' : '박스'}`);
    console.log(`     단가 공급가 ${it.unit_price != null ? f(it.unit_price) : '(없음)'} / 세포함 ${f(it.unit_price_with_tax)} | 소계 세포함 ${f(it.subtotal)} / 공급가컬럼 ${exTax != null ? f(exTax) : '(없음)'} / 역산 ${f(back)}${exTax != null && exTax !== back ? '  ⚠️ 차이 ' + f(exTax - back) : ''}`);
  }
}

console.log('\n\n■ 7월 B2B 거래처별 계산서 금액');
console.log('');
for (const [name, r] of byCust) {
  const back = Math.round(r.withTax / 1.1);
  console.log(`▶ ${name}  (사업자 ${r.biz || '⚠️ 미등록'})  주문 ${r.orders.length}건`);
  console.log(`   세포함 합계(실제 결제액) : ${f(r.withTax)}원`);
  console.log(`   공급가액 (DB 컬럼 기준)  : ${f(r.supplyCol)}원 ${r.hasCol ? '' : '(일부 컬럼 없어 역산 사용)'}`);
  console.log(`   부가세   (DB 컬럼 기준)  : ${f(r.vatCol)}원`);
  console.log(`   ─────────────────────────────`);
  console.log(`   공급가액 (세포함 역산)   : ${f(back)}원   ${r.supplyCol !== back ? '⚠️ 컬럼값과 ' + f(r.supplyCol - back) + '원 차이' : '(컬럼값과 동일)'}`);
  console.log(`   부가세   (역산)          : ${f(r.withTax - back)}원`);
  console.log(`   홈택스 자동(공급가×10%)  : ${f(Math.floor(r.supplyCol * 0.1))}원`);
  console.log('');
}
