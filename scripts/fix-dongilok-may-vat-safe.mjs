// 동일옥 5월 2건(ORD-20260507-0056, ORD-20260509-0060) 공급가 보정.
// - 과세 품목인데 unit_price === unit_price_with_tax 인 줄만 대상
// - 정상값은 products.price 에서 가져오고, round(세포함/1.1) 과 교차검증
// - unit_price 한 컬럼만 UPDATE (subtotal/total_amount/예치금/재고 불변)
// - 변경 전 값 출력(되돌리기용), 이미 정상이면 건너뜀(중복 실행 안전)
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

const TARGET_ORDERS = ['ORD-20260507-0056', 'ORD-20260509-0060'];

const rollback = [];   // 되돌리기용 기록
let fixedCount = 0, skipCount = 0;

for (const orderNum of TARGET_ORDERS) {
  const { data: order } = await supabase
    .from('orders')
    .select('id, order_number, order_items(id, product_id, product_name, quantity, unit_price, unit_price_with_tax, is_tax_free, subtotal)')
    .eq('order_number', orderNum)
    .single();
  if (!order) { console.log(`❌ ${orderNum} 없음`); continue; }

  console.log(`\n=== ${orderNum} ===`);
  for (const it of order.order_items) {
    // 대상 조건: 과세 + 공급가===세포함가
    if (it.is_tax_free || it.unit_price !== it.unit_price_with_tax) {
      console.log(`  · (건너뜀) ${it.product_name}: 이미 정상 (공급가 ${it.unit_price} / 세포함 ${it.unit_price_with_tax})`);
      skipCount++;
      continue;
    }

    // 정상값: products.price (없으면 보정 불가 → 건너뜀)
    let correct = null, prodPriceWithTax = null;
    if (it.product_id) {
      const { data: p } = await supabase
        .from('products').select('price, price_with_tax').eq('id', it.product_id).single();
      if (p) { correct = p.price; prodPriceWithTax = p.price_with_tax; }
    }
    if (correct == null) {
      console.log(`  ⚠️ (건너뜀) ${it.product_name}: products 단가 조회 실패`);
      skipCount++;
      continue;
    }

    // 교차검증 1: 주문 세포함가 === products 세포함가
    if (prodPriceWithTax !== it.unit_price_with_tax) {
      console.log(`  ⚠️ (건너뜀) ${it.product_name}: 세포함가 불일치 (주문 ${it.unit_price_with_tax} vs 상품 ${prodPriceWithTax}) — 수동 확인 필요`);
      skipCount++;
      continue;
    }
    // 교차검증 2: round(세포함/1.1) ≈ correct (±2)
    const derived = Math.round(it.unit_price_with_tax / 1.1);
    if (Math.abs(derived - correct) > 2) {
      console.log(`  ⚠️ (건너뜀) ${it.product_name}: 세전 검산 불일치 (÷1.1=${derived} vs 상품가 ${correct}) — 수동 확인 필요`);
      skipCount++;
      continue;
    }

    // UPDATE — unit_price 만
    const { error } = await supabase
      .from('order_items')
      .update({ unit_price: correct })
      .eq('id', it.id);
    if (error) {
      console.log(`  ❌ ${it.product_name}: 실패 ${error.message}`);
      continue;
    }
    rollback.push({ id: it.id, order: orderNum, product: it.product_name, from: it.unit_price, to: correct });
    console.log(`  ✅ ${it.product_name} ×${it.quantity}: 공급가 ${it.unit_price} → ${correct} (세포함/subtotal 불변: ${it.unit_price_with_tax}/${it.subtotal})`);
    fixedCount++;
  }
}

console.log(`\n============== 완료 ==============`);
console.log(`수정 ${fixedCount}줄, 건너뜀 ${skipCount}줄`);
if (rollback.length) {
  console.log('\n[되돌리기용 변경 전 값]');
  for (const r of rollback) console.log(`  ${r.order} / ${r.product}: ${r.to} → (원복시) ${r.from}`);
}
