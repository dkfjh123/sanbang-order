// [읽기 전용] 2026-07-13 아워홈 B2B 발주 — 사이트 금액 vs 거래명세서 금액 비교 진단
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(resolve(__dirname, '..', '.env.local'), 'utf8');
const env = Object.fromEntries(
  envText.split('\n').filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } });

// 거래명세서(종이) 기준값
const STATEMENT = [
  { name: '생밀면', qty: 19, unitPriceExTax: 59000, supply: 1121000, vat: 112100 },
  { name: '육수간장원액', qty: 7, unitPriceExTax: 23750, supply: 166250, vat: 16625 },
  { name: '비빔전용장', qty: 16, unitPriceExTax: 24176, supply: 386816, vat: 38681 },
  { name: '육즙가득만두(고기', qty: 11, unitPriceExTax: 62400, supply: 686400, vat: 68640 },
  { name: '육즙가득만두(김치', qty: 11, unitPriceExTax: 62400, supply: 686400, vat: 68640 },
];
const STMT_SUPPLY = 3046866, STMT_VAT = 304686, STMT_TOTAL = 3351552;

console.log('## 1. 아워홈 거래처 확인');
const { data: customers } = await supabase
  .from('b2b_customers')
  .select('id, name, is_active, is_prepaid')
  .ilike('name', '%아워홈%');
console.table(customers);
const ourhome = customers?.[0];

console.log('\n## 2. 7월 아워홈 B2B 주문 목록');
const { data: orders } = await supabase
  .from('b2b_orders')
  .select('id, order_number, status, order_date, ship_date, total_amount, total_amount_ex_tax, created_at')
  .eq('b2b_customer_id', ourhome.id)
  .gte('order_date', '2026-07-01')
  .order('created_at', { ascending: false });
console.table(orders?.map(o => ({
  order_number: o.order_number, status: o.status, order_date: o.order_date,
  ship_date: o.ship_date, 합계_세포함: o.total_amount, 공급가액: o.total_amount_ex_tax,
  부가세: o.total_amount - o.total_amount_ex_tax,
})));

// 오늘(7/13) 주문 우선, 없으면 가장 최근 주문
const target = orders?.find(o => o.order_date === '2026-07-13' || o.ship_date === '2026-07-13') || orders?.[0];
if (!target) { console.log('7월 아워홈 주문 없음'); process.exit(0); }

console.log(`\n## 3. 대상 주문 ${target.order_number} 품목별 상세`);
const { data: items } = await supabase
  .from('b2b_order_items')
  .select('product_id, product_name, unit, quantity, pack_per_box, unit_price, unit_price_with_tax, is_tax_free, subtotal, subtotal_ex_tax')
  .eq('order_id', target.id);

for (const it of items || []) {
  console.log(`\n  [${it.product_name}] ${it.quantity}${it.unit === 'box' ? '박스' : '팩'} (입수 ${it.pack_per_box})`);
  console.log(`    사이트 단가: 세전 ${it.unit_price.toLocaleString()} / 세포함 ${it.unit_price_with_tax.toLocaleString()}`);
  console.log(`    사이트 금액: 공급가액 ${it.subtotal_ex_tax.toLocaleString()} / 합계(세포함) ${it.subtotal.toLocaleString()} / 부가세 ${(it.subtotal - it.subtotal_ex_tax).toLocaleString()}`);
  const stmt = STATEMENT.find(s => it.product_name.includes(s.name) || s.name.includes(it.product_name.slice(0, 4)));
  if (stmt) {
    console.log(`    명세서 금액: 단가 ${stmt.unitPriceExTax.toLocaleString()} × ${stmt.qty} = 공급가액 ${stmt.supply.toLocaleString()} / 부가세 ${stmt.vat.toLocaleString()} / 합계 ${(stmt.supply + stmt.vat).toLocaleString()}`);
    const diffSupply = it.subtotal_ex_tax - stmt.supply;
    const diffTotal = it.subtotal - (stmt.supply + stmt.vat);
    if (diffSupply !== 0 || diffTotal !== 0) {
      console.log(`    >>> 차이: 공급가액 ${diffSupply >= 0 ? '+' : ''}${diffSupply.toLocaleString()} / 합계 ${diffTotal >= 0 ? '+' : ''}${diffTotal.toLocaleString()}`);
    } else {
      console.log('    >>> 일치');
    }
  }
}

const sumEx = (items || []).reduce((s, i) => s + i.subtotal_ex_tax, 0);
const sumWith = (items || []).reduce((s, i) => s + i.subtotal, 0);
console.log('\n## 4. 총액 비교');
console.log(`  사이트: 공급가액 ${sumEx.toLocaleString()} / 부가세 ${(sumWith - sumEx).toLocaleString()} / 합계 ${sumWith.toLocaleString()} (b2b_orders.total_amount=${target.total_amount.toLocaleString()})`);
console.log(`  명세서: 공급가액 ${STMT_SUPPLY.toLocaleString()} / 부가세 ${STMT_VAT.toLocaleString()} / 합계 ${STMT_TOTAL.toLocaleString()}`);
console.log(`  차이:   공급가액 ${(sumEx - STMT_SUPPLY).toLocaleString()} / 합계 ${(sumWith - STMT_TOTAL).toLocaleString()}`);

console.log('\n## 5. 아워홈 단가표 (b2b_customer_product_prices) + 상품 입수');
const pids = [...new Set((items || []).map(i => i.product_id))];
const [{ data: prices }, { data: products }] = await Promise.all([
  supabase.from('b2b_customer_product_prices')
    .select('product_id, b2b_price, b2b_price_with_tax, available_units, is_active')
    .eq('customer_id', ourhome.id).in('product_id', pids),
  supabase.from('products').select('id, name, pack_per_box').in('id', pids),
]);
const pmap = new Map((products || []).map(p => [p.id, p]));
for (const pr of prices || []) {
  const p = pmap.get(pr.product_id);
  console.log(`  ${p?.name} | 박스가 세전 ${pr.b2b_price.toLocaleString()} / 세포함 ${pr.b2b_price_with_tax.toLocaleString()} | 입수 ${p?.pack_per_box} | 팩환산 세전 ${Math.round(pr.b2b_price / (p?.pack_per_box || 1)).toLocaleString()} / 세포함 ${Math.round(pr.b2b_price_with_tax / (p?.pack_per_box || 1)).toLocaleString()} | active=${pr.is_active}`);
}
