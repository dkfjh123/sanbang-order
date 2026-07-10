// READ-ONLY — 2026년 6월 출고기준 "산방에프앤비가 발행할 세금계산서" 집계 (가맹점 + B2B). SELECT만 수행.
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

const f = (n) => (n ?? 0).toLocaleString();
const START = '2026-06-01', END = '2026-06-30';

// 홈택스 세금계산서 방식: 과세 공급가액 합계 × 10% 원단위 절사
const hometaxVat = (supply) => Math.floor(supply * 0.1);

// ---------------------------------------------------------------------------
// 1. 가맹점 (orders) — 직영 제외, 출고기준(ship_date), confirmed/shipped
// ---------------------------------------------------------------------------
const { data: orders, error: oErr } = await supabase
  .from('orders')
  .select('order_number, store_id, status, ship_date, stores(name, short_name, is_direct, owner_name, business_number), order_items(product_name, quantity, unit_price, unit_price_with_tax, is_tax_free, subtotal)')
  .in('status', ['confirmed', 'shipped'])
  .gte('ship_date', START).lte('ship_date', END)
  .order('ship_date');
if (oErr) { console.error('orders 조회 실패:', oErr); process.exit(1); }

// ---------------------------------------------------------------------------
// 2. B2B (b2b_orders) — 출고기준(ship_date), confirmed/shipped
// ---------------------------------------------------------------------------
const { data: b2b, error: bErr } = await supabase
  .from('b2b_orders')
  .select('order_number, status, ship_date, b2b_customers(name, business_number, region), b2b_order_items(product_name, quantity, unit_price, unit_price_with_tax, is_tax_free, subtotal, subtotal_ex_tax)')
  .in('status', ['confirmed', 'shipped'])
  .gte('ship_date', START).lte('ship_date', END)
  .order('ship_date');
if (bErr) { console.error('b2b_orders 조회 실패:', bErr); process.exit(1); }

// 집계 컨테이너 {name, biz, supply(과세공급가), taxFree(면세), channel}
const map = new Map();
const getRow = (key, name, biz, channel) => {
  let r = map.get(key);
  if (!r) { r = { name, biz: biz || '미등록', supply: 0, taxFree: 0, channel }; map.set(key, r); }
  return r;
};

let statusCount = { orders_shipped: 0, orders_confirmed: 0, b2b_shipped: 0, b2b_confirmed: 0 };

// 가맹점 집계
for (const o of orders) {
  if (o.status === 'shipped') statusCount.orders_shipped++; else statusCount.orders_confirmed++;
  if (o.stores?.is_direct) continue; // 직영점 = 내부거래, 계산서 발행 X
  const key = `store:${o.store_id}`;
  const r = getRow(key, o.stores?.short_name || o.stores?.name || key, o.stores?.business_number, '가맹점');
  for (const it of o.order_items) {
    if (it.is_tax_free) r.taxFree += it.subtotal;
    else r.supply += it.unit_price * it.quantity; // 과세 공급가액(세전)
  }
}

// B2B 집계
for (const o of b2b) {
  if (o.status === 'shipped') statusCount.b2b_shipped++; else statusCount.b2b_confirmed++;
  const name = o.b2b_customers?.name || 'B2B 거래처';
  const key = `b2b:${name}`;
  const r = getRow(key, name, o.b2b_customers?.business_number, 'B2B');
  for (const it of o.b2b_order_items) {
    if (it.is_tax_free) r.taxFree += it.subtotal;
    else r.supply += (it.subtotal_ex_tax ?? it.unit_price * it.quantity); // 과세 공급가액(세전)
  }
}

// 출력
console.log(`\n============================================================================================`);
console.log(`  2026년 6월(출고기준) 산방에프앤비 발행 세금계산서 집계 — 가맹점 + B2B`);
console.log(`============================================================================================`);
console.log(`  주문건수: 가맹점 출고완료 ${statusCount.orders_shipped} / 출고예정 ${statusCount.orders_confirmed}`
  + `  |  B2B 출고완료 ${statusCount.b2b_shipped} / 출고예정 ${statusCount.b2b_confirmed}`);
console.log(`--------------------------------------------------------------------------------------------`);
console.log(
  '거래처'.padEnd(16) + '구분'.padEnd(7) + '사업자번호'.padEnd(15) +
  '과세공급가'.padStart(13) + '부가세'.padStart(12) + '면세'.padStart(12) + '합계'.padStart(13)
);
console.log('-'.repeat(92));

const rows = [...map.values()].sort((a, b) =>
  a.channel === b.channel ? a.name.localeCompare(b.name, 'ko') : (a.channel === '가맹점' ? -1 : 1));

const T = { supply: 0, vat: 0, taxFree: 0, total: 0 };
const sub = { 가맹점: { supply: 0, vat: 0, taxFree: 0, total: 0 }, B2B: { supply: 0, vat: 0, taxFree: 0, total: 0 } };

for (const r of rows) {
  const vat = hometaxVat(r.supply);
  const total = r.supply + vat + r.taxFree;
  T.supply += r.supply; T.vat += vat; T.taxFree += r.taxFree; T.total += total;
  const s = sub[r.channel]; s.supply += r.supply; s.vat += vat; s.taxFree += r.taxFree; s.total += total;
  console.log(
    r.name.slice(0, 15).padEnd(15) + ' ' + r.channel.padEnd(6) + (r.biz).padEnd(15) +
    f(r.supply).padStart(13) + f(vat).padStart(12) + f(r.taxFree).padStart(12) + f(total).padStart(13)
  );
}

console.log('-'.repeat(92));
for (const ch of ['가맹점', 'B2B']) {
  const s = sub[ch];
  console.log(`[${ch} 소계]`.padEnd(38) + f(s.supply).padStart(13) + f(s.vat).padStart(12) + f(s.taxFree).padStart(12) + f(s.total).padStart(13));
}
console.log('='.repeat(92));
console.log('[전체 합계]'.padEnd(38) + f(T.supply).padStart(13) + f(T.vat).padStart(12) + f(T.taxFree).padStart(12) + f(T.total).padStart(13));
console.log('='.repeat(92));
console.log('* 부가세 = 과세 공급가액 × 10% 원단위 절사 (거래처별 홈택스 세금계산서 방식)');
console.log('* 합계 = 과세 공급가액 + 부가세 + 면세 공급가액');
console.log('* 직영점(대한상공회의소점)은 내부거래로 발행 대상 제외');
console.log('* 출고기준 = ship_date 2026-06-01~06-30, 상태 confirmed(출고예정)+shipped(출고완료)');
