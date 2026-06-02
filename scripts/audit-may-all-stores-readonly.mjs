// READ-ONLY — 5월 출고기준 전 매장 정산 정합성 전수 점검. SELECT만.
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

const { data: orders } = await supabase
  .from('orders')
  .select('id, order_number, store_id, status, total_amount, ship_date, stores(name, short_name, is_direct), order_items(product_name, quantity, unit_price, unit_price_with_tax, is_tax_free, subtotal)')
  .in('status', ['confirmed', 'shipped'])
  .gte('ship_date', '2026-05-01')
  .lte('ship_date', '2026-05-31')
  .order('ship_date');

const storeNames = new Set();
const problems = [];   // {store, order, item, type, detail}
let itemCount = 0;

for (const o of orders) {
  const store = o.stores?.short_name || o.stores?.name || `store:${o.store_id}`;
  storeNames.add(store);

  // 주문 레벨: total_amount vs 항목합
  const itemsSum = o.order_items.reduce((s, it) => s + it.subtotal, 0);
  if (o.total_amount !== itemsSum) {
    problems.push({ store, order: o.order_number, item: '-', type: 'total_amount≠항목합', detail: `${o.total_amount} vs ${itemsSum}` });
  }

  for (const it of o.order_items) {
    itemCount++;
    // subtotal 정합성
    const expSub = it.unit_price_with_tax * it.quantity;
    if (it.subtotal !== expSub) {
      problems.push({ store, order: o.order_number, item: it.product_name, type: 'subtotal불일치', detail: `저장 ${it.subtotal} vs 계산 ${expSub}` });
    }

    if (it.is_tax_free) {
      // 면세인데 공급가≠세포함가 → 세금이 끼어있음
      if (it.unit_price !== it.unit_price_with_tax) {
        problems.push({ store, order: o.order_number, item: it.product_name, type: '면세인데 공급가≠세포함가', detail: `공급가 ${it.unit_price} / 세포함 ${it.unit_price_with_tax}` });
      }
    } else {
      // 과세
      const tax = it.unit_price_with_tax - it.unit_price;
      if (tax === 0) {
        problems.push({ store, order: o.order_number, item: it.product_name, type: '⚠️과세인데 부가세0', detail: `공급가=세포함가=${it.unit_price}` });
      } else if (tax < 0) {
        problems.push({ store, order: o.order_number, item: it.product_name, type: '⚠️부가세 음수', detail: `공급가 ${it.unit_price} > 세포함 ${it.unit_price_with_tax}` });
      } else if (it.unit_price > 0) {
        const ratio = tax / it.unit_price;
        if (ratio < 0.08 || ratio > 0.12) {
          problems.push({ store, order: o.order_number, item: it.product_name, type: `부가세율 이상(${(ratio * 100).toFixed(1)}%)`, detail: `공급가 ${it.unit_price} / 세포함 ${it.unit_price_with_tax}` });
        }
      }
    }
  }
}

console.log(`=== 5월(출고기준) 전수 점검 ===`);
console.log(`주문 ${orders.length}건 / 품목 ${itemCount}줄 / 매장 ${storeNames.size}곳`);
console.log(`매장: ${[...storeNames].sort((a, b) => a.localeCompare(b, 'ko')).join(', ')}`);

if (problems.length === 0) {
  console.log('\n✅ 정합성 문제 0건 — 모든 매장 정상');
} else {
  console.log(`\n⚠️ 이슈 ${problems.length}건:`);
  const byStore = {};
  for (const p of problems) (byStore[p.store] ||= []).push(p);
  for (const [store, ps] of Object.entries(byStore)) {
    console.log(`\n[${store}] ${ps.length}건`);
    for (const p of ps) console.log(`   - ${p.order} / ${p.item}: ${p.type} (${p.detail})`);
  }
}
