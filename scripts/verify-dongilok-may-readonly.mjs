// READ-ONLY 진단 — 동일옥 5월 정산 검증. UPDATE/INSERT/DELETE 절대 없음. SELECT만.
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

const won = (n) => '₩' + (n ?? 0).toLocaleString();

// 1) 동일옥 매장 찾기
const { data: stores } = await supabase
  .from('stores')
  .select('id, name, short_name, is_direct, region, deposit_balance, allow_split_shipping');
const dongilok = (stores || []).filter(s =>
  (s.name && s.name.includes('동일옥')) || (s.short_name && s.short_name.includes('동일옥')));

console.log('=== 동일옥 매장 ===');
for (const s of dongilok) {
  console.log(`  ${s.short_name || s.name}  id=${s.id}  region=${s.region}  direct=${s.is_direct}  split=${s.allow_split_shipping}  예치금=${won(s.deposit_balance)}`);
}
const dongilokIds = dongilok.map(s => s.id);
if (dongilokIds.length === 0) { console.log('동일옥 매장을 못 찾음'); process.exit(0); }

// 2) 5월 출고기준 주문 (정산과 동일 조건: confirmed/shipped, ship_date 5월)
const { data: orders } = await supabase
  .from('orders')
  .select('*, order_items(*)')
  .in('store_id', dongilokIds)
  .in('status', ['confirmed', 'shipped'])
  .gte('ship_date', '2026-05-01')
  .lte('ship_date', '2026-05-31')
  .order('ship_date');

console.log(`\n=== 5월 동일옥 주문 ${orders?.length || 0}건 (confirmed/shipped) ===`);

// 3) products 현재가 (정상값 기준) 로드
const allPids = [...new Set((orders || []).flatMap(o => o.order_items.map(it => it.product_id)).filter(Boolean))];
const { data: prods } = await supabase
  .from('products')
  .select('id, name, price, price_with_tax, is_tax_free, product_type')
  .in('id', allPids.length ? allPids : ['00000000-0000-0000-0000-000000000000']);
const prodById = new Map((prods || []).map(p => [p.id, p]));

// 4) 정산 집계 재현 + 정합성 진단
let sumSupply = 0, sumTax = 0, sumTaxableTotal = 0, sumTaxFree = 0, sumTotal = 0;
const problems = [];

for (const o of orders) {
  console.log(`\n--- [${o.ship_date}] ${o.order_number} (status=${o.status}, total_amount=${won(o.total_amount)}) ---`);
  let orderItemsSum = 0;
  for (const it of o.order_items) {
    const p = it.product_id ? prodById.get(it.product_id) : null;
    const expectedSubtotal = it.unit_price_with_tax * it.quantity;
    const subtotalOk = it.subtotal === expectedSubtotal;
    orderItemsSum += it.subtotal;

    // 정산 집계 재현
    const supply = it.unit_price * it.quantity;
    const tax = (it.unit_price_with_tax - it.unit_price) * it.quantity;
    if (it.is_tax_free) { sumTaxFree += it.subtotal; }
    else { sumSupply += supply; sumTax += tax; sumTaxableTotal += it.subtotal; }
    sumTotal += it.subtotal;

    const flags = [];
    if (!it.is_tax_free && it.unit_price === it.unit_price_with_tax) flags.push('⚠️과세인데 공급가=세포함가(부가세0)');
    if (!subtotalOk) flags.push(`⚠️subtotal불일치(저장:${it.subtotal} vs 계산:${expectedSubtotal})`);
    if (p) {
      if (it.unit_price_with_tax !== p.price_with_tax) flags.push(`세포함가≠product(주문:${it.unit_price_with_tax} vs 상품:${p.price_with_tax})`);
      if (it.unit_price !== p.price) flags.push(`공급가≠product(주문:${it.unit_price} vs 상품:${p.price})`);
      if (it.is_tax_free !== p.is_tax_free) flags.push(`면세플래그≠product(주문:${it.is_tax_free} vs 상품:${p.is_tax_free})`);
    } else if (it.product_id) {
      flags.push('상품 조회 실패');
    }

    console.log(`   · ${it.product_name} ×${it.quantity}  공급가=${it.unit_price} 세포함=${it.unit_price_with_tax} subtotal=${won(it.subtotal)} 면세=${it.is_tax_free} created=${it.created_at}`);
    if (flags.length) { console.log(`       ${flags.join(' | ')}`); flags.forEach(f => problems.push(`${o.order_number} / ${it.product_name}: ${f}`)); }
  }
  // total_amount vs 아이템합
  if (o.total_amount !== orderItemsSum) {
    console.log(`   ⚠️ total_amount(${o.total_amount}) ≠ 아이템 subtotal 합(${orderItemsSum})`);
    problems.push(`${o.order_number}: total_amount≠아이템합`);
  }
}

// 5) 정산 1섹션 수치 재현
console.log('\n=== 정산 1섹션(동일옥) 재현 ===');
console.log(`  과세 공급가 : ${won(sumSupply)}`);
console.log(`  부가세      : ${won(sumTax)}`);
console.log(`  과세 합계   : ${won(sumTaxableTotal)}`);
console.log(`  면세 합계   : ${won(sumTaxFree)}`);
console.log(`  총 매출     : ${won(sumTotal)}`);
console.log(`  (정상이라면 부가세 ≈ 과세공급가 × 10%, 즉 ${won(Math.round(sumSupply * 0.1))})`);

// 6) order_logs — 수정 흔적 확인
const orderIds = (orders || []).map(o => o.id);
const { data: logs } = await supabase
  .from('order_logs')
  .select('*')
  .in('order_id', orderIds.length ? orderIds : ['00000000-0000-0000-0000-000000000000'])
  .order('created_at');
console.log(`\n=== order_logs (${logs?.length || 0}건) ===`);
for (const l of (logs || [])) {
  console.log(`  [${l.created_at}] ${l.action} by ${l.changed_by_name || '?'}(${l.changed_by_role || '?'}): ${l.description || ''}`);
}

// 7) 요약
console.log('\n============== 요약 ==============');
if (problems.length === 0) {
  console.log('✅ 발견된 정합성 문제 없음');
} else {
  console.log(`⚠️ 정합성 이슈 ${problems.length}건:`);
  for (const p of problems) console.log('   - ' + p);
}
