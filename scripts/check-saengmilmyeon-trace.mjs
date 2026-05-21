// 생밀면 reserved 70→12 추적
// 023 baseline(2026-05-21 00:40) 이후 어떤 박스 발주가 어떻게 처리됐는지
// READ-ONLY
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

const { data: prod } = await supabase.from('products').select('id, name').eq('name', '생밀면').single();
const PID = prod.id;
const BASELINE = '2026-05-21T00:40:40.136217+00:00'; // 023 적용 시각

// 1) 023 baseline 시점에 잡혀 있었던 박스 발주 = 023 적용 전에 등록된 pending+confirmed + B2B pending
//    그 중 5/21에 상태 변경된 것 추적
console.log('===== 가맹점 박스 발주 — 5/21 상태 변경 추적 =====');
const { data: items } = await supabase
  .from('order_items')
  .select('order_id, quantity, unit')
  .eq('product_id', PID)
  .eq('unit', 'box');

const orderIds = [...new Set(items.map((i) => i.order_id))];
const { data: orders } = await supabase
  .from('orders')
  .select('id, order_number, store_id, status, created_at, ship_date, updated_at')
  .in('id', orderIds)
  .order('created_at', { ascending: true });

const { data: stores } = await supabase.from('stores').select('id, name, short_name');
const sm = new Map(stores?.map((s) => [s.id, s.short_name || s.name]));

let baselinePendingBox = 0;
let postBaselineNewBox = 0;
let shippedSinceBaselineBox = 0;
let cancelledSinceBaselineBox = 0;

for (const o of orders || []) {
  const its = items.filter((i) => i.order_id === o.id);
  const qty = its.reduce((s, i) => s + i.quantity, 0);
  const beforeBaseline = new Date(o.created_at) < new Date(BASELINE);
  const isPendingOrConfirmed = ['pending', 'confirmed'].includes(o.status);

  if (beforeBaseline && isPendingOrConfirmed) baselinePendingBox += qty;
  if (beforeBaseline && o.status === 'shipped') {
    if (new Date(o.updated_at) >= new Date(BASELINE)) shippedSinceBaselineBox += qty;
  }
  if (beforeBaseline && o.status === 'cancelled') {
    if (new Date(o.updated_at) >= new Date(BASELINE)) cancelledSinceBaselineBox += qty;
  }
  if (!beforeBaseline && isPendingOrConfirmed) postBaselineNewBox += qty;

  console.log(`  ${o.order_number} | ${sm.get(o.store_id)} | ${o.status} | created=${o.created_at.slice(0,16)} | upd=${o.updated_at.slice(0,16)} | ${qty}box`);
}

console.log(`\n  baseline 시점 가맹점 pending/confirmed box 합: ${baselinePendingBox}`);
console.log(`  baseline 이후 신규 등록된 가맹점 미출고 box: ${postBaselineNewBox}`);
console.log(`  baseline 이후 출고완료된 가맹점 box: ${shippedSinceBaselineBox}`);
console.log(`  baseline 이후 취소된 가맹점 box: ${cancelledSinceBaselineBox}`);

// 2) B2B 박스 발주
console.log('\n===== B2B 박스 발주 — 5/21 상태 변경 추적 =====');
const { data: b2bItems } = await supabase
  .from('b2b_order_items')
  .select('order_id, quantity, unit')
  .eq('product_id', PID)
  .eq('unit', 'box');

const b2bIds = [...new Set(b2bItems.map((i) => i.order_id))];
const { data: b2bOrders } = await supabase
  .from('b2b_orders')
  .select('id, order_number, status, created_at, ship_date, updated_at')
  .in('id', b2bIds)
  .order('created_at', { ascending: true });

let baselineB2bPendingBox = 0;
let postBaselineNewB2bBox = 0;
let shippedSinceBaselineB2bBox = 0;
let cancelledSinceBaselineB2bBox = 0;

for (const o of b2bOrders || []) {
  const its = b2bItems.filter((i) => i.order_id === o.id);
  const qty = its.reduce((s, i) => s + i.quantity, 0);
  const beforeBaseline = new Date(o.created_at) < new Date(BASELINE);

  if (beforeBaseline && o.status === 'pending') baselineB2bPendingBox += qty;
  if (beforeBaseline && o.status === 'shipped') {
    if (new Date(o.updated_at) >= new Date(BASELINE)) shippedSinceBaselineB2bBox += qty;
  }
  if (beforeBaseline && o.status === 'cancelled') {
    if (new Date(o.updated_at) >= new Date(BASELINE)) cancelledSinceBaselineB2bBox += qty;
  }
  if (!beforeBaseline && o.status === 'pending') postBaselineNewB2bBox += qty;

  console.log(`  ${o.order_number} | ${o.status} | created=${o.created_at.slice(0,16)} | upd=${o.updated_at.slice(0,16)} | ship=${o.ship_date} | ${qty}box`);
}

console.log(`\n  baseline 시점 B2B pending box 합: ${baselineB2bPendingBox}`);
console.log(`  baseline 이후 신규 B2B pending box: ${postBaselineNewB2bBox}`);
console.log(`  baseline 이후 출고완료된 B2B box: ${shippedSinceBaselineB2bBox}`);
console.log(`  baseline 이후 취소된 B2B box: ${cancelledSinceBaselineB2bBox}`);

// 3) 종합 계산
const baselineReserved = baselinePendingBox + baselineB2bPendingBox;
console.log('\n===== 종합 =====');
console.log(`  baseline 추정 reserved = 가맹점(${baselinePendingBox}) + B2B(${baselineB2bPendingBox}) = ${baselineReserved}`);
console.log(`  (023 마이그레이션 예상값 70과 비교: ${baselineReserved === 70 ? '일치' : `차이 ${70 - baselineReserved}`})`);

console.log(`\n  reserved 변화 시뮬레이션 (이론):`);
console.log(`    시작:                  ${baselineReserved}`);
console.log(`    - 가맹점 ship:         ${shippedSinceBaselineBox}`);
console.log(`    - 가맹점 cancel:       ${cancelledSinceBaselineBox}`);
console.log(`    + 가맹점 신규 발주:    ${postBaselineNewBox}  (PR2 배포 후만 +reserved)`);
console.log(`    - B2B ship:            (코드상 reserved 무시 = 0 차감) ← 좀비 잔존`);
console.log(`    + B2B 신규 발주:       (코드상 reserved 가산 없음 = 0 가산)`);

const expectedReserved = baselineReserved - shippedSinceBaselineBox - cancelledSinceBaselineBox + postBaselineNewBox;
console.log(`    = 예상 reserved:       ${expectedReserved}`);
console.log(`\n  실제 reserved:         12`);
console.log(`  차이:                  ${expectedReserved - 12}`);

console.log(`\n  ※ "정상이라면" reserved는 = 현재 미출고 가맹점 박스 합:`);
const currentStorePending = baselinePendingBox - shippedSinceBaselineBox - cancelledSinceBaselineBox + postBaselineNewBox;
console.log(`     가맹점 미출고: ${currentStorePending}`);
console.log(`     B2B 미출고는 코드상 reserved에 안 잡힘 → 가맹점만 잡혀야 정상`);
