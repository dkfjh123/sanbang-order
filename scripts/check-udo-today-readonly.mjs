// 우도점 오늘 주문 확인 — READ ONLY (조회만, 어떤 값도 쓰지 않음)
// 실행: node scripts/check-udo-today-readonly.mjs
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(resolve(__dirname, '..', '.env.local'), 'utf8');
const env = Object.fromEntries(
  envText.split('\n').filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => {
    const i = l.indexOf('=');
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  })
);
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const kstNow = new Date(Date.now() + 9 * 3600 * 1000);
const today = kstNow.toISOString().slice(0, 10);
console.log(`\n===== 우도점 주문 확인 (조회시각 ${kstNow.toISOString().replace('T',' ').slice(0,16)} KST / 오늘=${today}) =====\n`);

// 1) 우도 매장 찾기
const { data: stores, error: sErr } = await supabase.from('stores').select('*');
if (sErr) { console.error('stores 조회 실패:', sErr.message); process.exit(1); }
const udo = stores.filter((s) => (s.name || '').includes('우도') || (s.short_name || '').includes('우도'));
console.log('## 우도 매장');
for (const s of udo) {
  console.log(`  id=${s.id}`);
  console.log(`  이름=${s.name} / 약칭=${s.short_name} / 지역=${s.region ?? '-'} / 활성=${s.is_active}`);
  console.log(`  결제방식=${s.payment_type ?? '-'} / 예치금잔액=${s.deposit_balance ?? '-'} / 최소주문=${s.min_order_amount ?? '-'}`);
  if (s.notes) console.log(`  메모=${s.notes}`);
}
if (!udo.length) { console.log('  (없음)'); process.exit(0); }
const udoIds = udo.map((s) => s.id);

// 2) 최근 주문 (오늘 포함 최근 14일)
const since = new Date(Date.now() - 14 * 86400000).toISOString();
const { data: orders, error: oErr } = await supabase
  .from('orders')
  .select('*')
  .in('store_id', udoIds)
  .gte('created_at', since)
  .order('created_at', { ascending: false });
if (oErr) { console.error('orders 조회 실패:', oErr.message); process.exit(1); }

const kstOf = (iso) => new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16);
const won = (n) => '₩' + Number(n || 0).toLocaleString('ko-KR');

const todays = (orders || []).filter((o) => kstOf(o.created_at).slice(0, 10) === today);
console.log(`\n## 오늘(${today} KST) 접수된 우도점 주문: ${todays.length}건`);

const ids = (orders || []).map((o) => o.id);
let itemsByOrder = new Map();
if (ids.length) {
  const { data: items } = await supabase.from('order_items').select('*').in('order_id', ids);
  for (const it of items || []) {
    if (!itemsByOrder.has(it.order_id)) itemsByOrder.set(it.order_id, []);
    itemsByOrder.get(it.order_id).push(it);
  }
}

function printOrder(o) {
  console.log(`\n  ── ${o.order_number}  [${o.status}]  접수 ${kstOf(o.created_at)} KST`);
  console.log(`     출고예정(ship_date)=${o.ship_date ?? '-'}   배송예정(delivery_date)=${o.delivery_date ?? '-'}   합계=${won(o.total_amount)}`);
  if (o.order_date) console.log(`     order_date=${o.order_date}`);
  if (o.memo) console.log(`     메모: ${o.memo}`);
  const its = itemsByOrder.get(o.id) || [];
  if (!its.length) { console.log('     (품목 없음)'); return; }
  console.log('     품목:');
  for (const it of its) {
    const unit = it.unit === 'pack' ? '팩' : (it.unit || 'box') === 'box' ? '박스' : it.unit;
    console.log(`       · ${it.product_name}  ${it.quantity}${unit}  단가(세포함) ${won(it.unit_price_with_tax)}  소계 ${won(it.subtotal)}${it.is_tax_free ? '  (면세)' : ''}`);
  }
}

for (const o of todays) printOrder(o);
if (!todays.length) console.log('  (오늘 접수 건 없음)');

const others = (orders || []).filter((o) => !todays.includes(o));
console.log(`\n## 참고: 최근 14일 그 외 우도점 주문 ${others.length}건`);
for (const o of others) {
  console.log(`  ${kstOf(o.created_at)}  ${o.order_number}  [${o.status}]  출고 ${o.ship_date ?? '-'}  ${won(o.total_amount)}`);
}

console.log('\n===== 끝 (읽기 전용 — 데이터 변경 없음) =====\n');
