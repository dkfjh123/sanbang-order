// READ-ONLY — 5월 매장별 부가세 단수차 대조 (시스템 건별합산 vs 홈택스 공급가액×10% 절사). SELECT만.
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

const { data: orders } = await supabase
  .from('orders')
  .select('store_id, status, ship_date, stores(name, short_name, is_direct), order_items(quantity, unit_price, unit_price_with_tax, is_tax_free, subtotal)')
  .in('status', ['confirmed', 'shipped'])
  .gte('ship_date', '2026-05-01')
  .lte('ship_date', '2026-05-31');

const map = new Map();
for (const o of orders) {
  if (o.stores?.is_direct) continue; // 계산서 발행 대상 = 직영 제외 (정산 1섹션과 동일)
  const name = o.stores?.short_name || o.stores?.name || o.store_id;
  let r = map.get(name);
  if (!r) { r = { name, supply: 0, taxSys: 0, taxableTotal: 0, taxFree: 0 }; map.set(name, r); }
  for (const it of o.order_items) {
    if (it.is_tax_free) { r.taxFree += it.subtotal; continue; }
    r.supply += it.unit_price * it.quantity;
    r.taxSys += (it.unit_price_with_tax - it.unit_price) * it.quantity;
    r.taxableTotal += it.subtotal;
  }
}

const rows = [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'));

console.log('5월 매장별 부가세 대조 (과세분, 직영 제외)\n');
console.log('매장'.padEnd(20) + '공급가'.padStart(13) + '시스템부가세'.padStart(14) + '홈택스(절사)'.padStart(14) + '차이'.padStart(7) + '과세합계'.padStart(14));
console.log('-'.repeat(82));
let T = { supply: 0, taxSys: 0, hometax: 0, taxableTotal: 0 };
for (const r of rows) {
  const hometax = Math.floor(r.supply * 0.1);  // 공급가액 × 10% 원단위 절사
  const diff = r.taxSys - hometax;
  T.supply += r.supply; T.taxSys += r.taxSys; T.hometax += hometax; T.taxableTotal += r.taxableTotal;
  console.log(
    r.name.padEnd(18) +
    f(r.supply).padStart(14) +
    f(r.taxSys).padStart(14) +
    f(hometax).padStart(14) +
    (diff === 0 ? '0' : (diff > 0 ? '+' : '') + diff).padStart(7) +
    f(r.taxableTotal).padStart(14)
  );
}
console.log('-'.repeat(82));
console.log(
  '합계'.padEnd(17) +
  f(T.supply).padStart(14) +
  f(T.taxSys).padStart(14) +
  f(T.hometax).padStart(14) +
  ((T.taxSys - T.hometax) === 0 ? '0' : '+' + (T.taxSys - T.hometax)).padStart(7) +
  f(T.taxableTotal).padStart(14)
);
console.log('\n* 공급가 + 시스템부가세 = 과세합계 = 동일옥 등 매장이 실제 결제한 금액');
console.log('* 차이 = 시스템(품목별 반올림 합산) − 홈택스(공급가액×10% 절사). 단수차(보통 0~수원).');
