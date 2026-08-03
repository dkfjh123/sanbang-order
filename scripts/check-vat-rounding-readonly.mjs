// READ-ONLY — 7월 매장별 부가세 끝수 차이 원인 추적 (품목별 합계 vs 홈택스 절사)
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

const { data: orders } = await supabase
  .from('orders')
  .select('order_number, ship_date, status, stores(short_name, name, is_direct), order_items(product_name, quantity, unit, unit_price, unit_price_with_tax, is_tax_free, subtotal)')
  .in('status', ['confirmed', 'shipped'])
  .gte('ship_date', '2026-07-01').lte('ship_date', '2026-07-31')
  .order('ship_date');

const byStore = new Map();
for (const o of orders) {
  if (o.stores?.is_direct) continue;
  const name = o.stores?.short_name || o.stores?.name;
  if (!byStore.has(name)) byStore.set(name, { supply: 0, vat: 0, withTax: 0, odd: [] });
  const r = byStore.get(name);
  for (const it of o.order_items) {
    if (it.is_tax_free) continue;
    const supply = it.unit_price * it.quantity;
    const vat = (it.unit_price_with_tax - it.unit_price) * it.quantity;
    r.supply += supply; r.vat += vat; r.withTax += it.subtotal;
    // 단가 자체가 공급가×1.1 과 어긋나는 품목 찾기
    const expectedWithTax = Math.round(it.unit_price * 1.1);
    if (expectedWithTax !== it.unit_price_with_tax) {
      r.odd.push({ ord: o.order_number, ship: o.ship_date, name: it.product_name, unit: it.unit, qty: it.quantity,
                   up: it.unit_price, upt: it.unit_price_with_tax, exp: expectedWithTax, gap: (it.unit_price_with_tax - expectedWithTax) * it.quantity });
    }
  }
}

console.log('■ 2026년 7월 매장별 — 품목별 부가세 합계 vs 홈택스 절사(공급가합계×10%)');
console.log('');
console.log('매장            공급가합계      품목별부가세    홈택스세액      차이   세포함합계');
console.log('─────────────────────────────────────────────────────────────────────────────');
for (const [name, r] of [...byStore.entries()].sort((a, b) => b[1].supply - a[1].supply)) {
  const hometax = Math.floor(r.supply * 0.1);
  const diff = hometax - r.vat;
  console.log(`${name.padEnd(14)} ${f(r.supply).padStart(12)} ${f(r.vat).padStart(14)} ${f(hometax).padStart(14)} ${(diff === 0 ? '0' : (diff > 0 ? '+' : '') + diff).padStart(6)} ${f(r.withTax).padStart(12)}`);
}
console.log('');

for (const [name, r] of byStore) {
  if (!r.odd.length) continue;
  console.log(`\n■ ${name} — 단가가 (공급가 × 1.1)과 어긋나는 품목 ${r.odd.length}줄`);
  for (const o of r.odd) {
    console.log(`   ${o.ord} (출고 ${o.ship}) ${o.name} ${o.qty}${o.unit === 'pack' ? '팩' : '박스'}`);
    console.log(`      공급가 ${f(o.up)} → 세포함 기록 ${f(o.upt)} / 계산상 ${f(o.exp)} · 차이 ${o.gap > 0 ? '+' : ''}${o.gap}원(수량반영)`);
  }
}
