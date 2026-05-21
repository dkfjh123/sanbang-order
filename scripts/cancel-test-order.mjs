#!/usr/bin/env node
// 테스트 주문 완전 삭제 (purge) — 점주 가시성 있는 모든 흔적을 제거.
//
// 일반 "취소"는 orders.status='cancelled' + 환불 레코드 추가 방식이지만
// 점주 예치금 충전현황에는 "발주 차감"과 "발주 환불" 두 줄이 모두 남게 됩니다.
// 테스트 주문은 처음부터 없었던 것처럼 완전히 지워야 하므로 다음을 수행:
//
//  1) inventory_transactions: 해당 주문번호가 description 에 포함된 out/in 레코드 삭제
//  2) deposit_transactions: order_id = 해당 주문 레코드 삭제
//  3) stores.deposit_balance 에 총액을 그대로 더해 원상복구 (환불 레코드는 남기지 않음)
//  4) inventory.quantity 에 각 아이템 수량을 그대로 더해 원상복구 (inbound 레코드 남기지 않음)
//  5) orders 삭제 (order_items / order_logs 는 ON DELETE CASCADE 로 자동 삭제)
//
// 사용:
//   node scripts/cancel-test-order.mjs ORD-20260424-0029           # dry-run
//   node scripts/cancel-test-order.mjs ORD-20260424-0029 --execute # 실제 실행
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '.env.local');
const envText = readFileSync(envPath, 'utf-8');
const env = Object.fromEntries(
  envText.split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => {
    const i = l.indexOf('=');
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  })
);
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const orderNumber = process.argv[2];
const execute = process.argv.includes('--execute');

if (!orderNumber) {
  console.error('사용법: node scripts/cancel-test-order.mjs <ORDER_NUMBER> [--execute]');
  process.exit(1);
}

console.log(`\n=== 주문 PURGE ${execute ? '실행 모드 ⚠️' : '드라이런 (변경 없음)'} ===`);
console.log(`대상 주문번호: ${orderNumber}\n`);

const { data: order, error: orderErr } = await supabase
  .from('orders')
  .select('id, status, total_amount, store_id, stores(id, short_name, is_direct, deposit_balance)')
  .eq('order_number', orderNumber)
  .single();

if (orderErr || !order) {
  console.error('주문을 찾을 수 없습니다:', orderErr?.message);
  process.exit(1);
}

if (order.status === 'shipped') {
  console.error('이미 출고된 주문은 삭제하지 않습니다.');
  process.exit(1);
}

const { data: items } = await supabase
  .from('order_items')
  .select('product_id, product_name, quantity, unit, pack_per_box')
  .eq('order_id', order.id);

const { data: depositTx } = await supabase
  .from('deposit_transactions')
  .select('id, type, amount, description')
  .eq('order_id', order.id);

const { data: invTx } = await supabase
  .from('inventory_transactions')
  .select('id, type, quantity, description')
  .ilike('description', `%${orderNumber}%`);

console.log('[주문 기본 정보]');
console.log(`  매장: ${order.stores.short_name}`);
console.log(`  상태: ${order.status}`);
console.log(`  총액: ₩${order.total_amount.toLocaleString()}`);
console.log(`  매장 현재 예치금: ₩${order.stores.deposit_balance.toLocaleString()}`);

console.log(`\n[order_items ${items?.length || 0}건] — 재고 복구 대상`);
for (const it of items || []) {
  console.log(`  - ${it.product_name} × ${it.quantity}${it.unit === 'pack' ? '팩' : '박스'}`);
}

console.log(`\n[deposit_transactions ${depositTx?.length || 0}건] — 삭제 예정`);
for (const d of depositTx || []) {
  console.log(`  - ${d.type} / ₩${d.amount.toLocaleString()} / ${d.description}`);
}

console.log(`\n[inventory_transactions ${invTx?.length || 0}건] — 삭제 예정 (description에 주문번호 포함)`);
for (const t of invTx || []) {
  console.log(`  - ${t.type} / ${t.quantity} / ${t.description}`);
}

const refundAmount = order.stores.is_direct ? 0 : order.total_amount;
const newDepositBalance = order.stores.deposit_balance + refundAmount;

console.log('\n[예정 DB 작업 순서]');
console.log(`  1) inventory_transactions.delete where description LIKE '%${orderNumber}%'  (${invTx?.length || 0}건)`);
console.log(`  2) deposit_transactions.delete where order_id = ${order.id}  (${depositTx?.length || 0}건)`);
if (!order.stores.is_direct) {
  console.log(`  3) stores.deposit_balance: ₩${order.stores.deposit_balance.toLocaleString()} → ₩${newDepositBalance.toLocaleString()}  (+₩${refundAmount.toLocaleString()})`);
}
for (const it of items || []) {
  if ((it.unit || 'box') === 'box') {
    console.log(`  4) inventory[${it.product_name}].quantity += ${it.quantity}  (박스 복구, 이력 미기록)`);
  } else {
    const ppb = it.pack_per_box || 1;
    console.log(`  4) inventory[${it.product_name}]: 낱팩 복구 ${it.quantity}팩 (ppb=${ppb}, 승격 고려)`);
  }
}
console.log(`  5) orders.delete where id = ${order.id}  (order_items / order_logs 자동 CASCADE)`);

if (!execute) {
  console.log(`\n✋ 드라이런 완료. 실행하려면: node scripts/cancel-test-order.mjs ${orderNumber} --execute`);
  process.exit(0);
}

console.log('\n▶ 실행 시작...');

// 1. inventory_transactions 삭제
if ((invTx?.length || 0) > 0) {
  const ids = invTx.map((t) => t.id);
  const { error } = await supabase.from('inventory_transactions').delete().in('id', ids);
  if (error) { console.error('inventory_transactions 삭제 실패:', error); process.exit(1); }
  console.log(`  ✓ inventory_transactions ${ids.length}건 삭제`);
}

// 2. deposit_transactions 삭제
if ((depositTx?.length || 0) > 0) {
  const { error } = await supabase.from('deposit_transactions').delete().eq('order_id', order.id);
  if (error) { console.error('deposit_transactions 삭제 실패:', error); process.exit(1); }
  console.log(`  ✓ deposit_transactions ${depositTx.length}건 삭제`);
}

// 3. 예치금 잔액 원복
if (!order.stores.is_direct) {
  const { error } = await supabase.from('stores').update({ deposit_balance: newDepositBalance }).eq('id', order.stores.id);
  if (error) { console.error('stores 업데이트 실패:', error); process.exit(1); }
  console.log(`  ✓ stores.deposit_balance ${order.stores.deposit_balance} → ${newDepositBalance}`);
}

// 4. 재고 복구
for (const it of items || []) {
  const unit = it.unit || 'box';
  if (unit === 'box') {
    const { data: inv } = await supabase.from('inventory').select('quantity').eq('product_id', it.product_id).single();
    if (inv) {
      const { error } = await supabase
        .from('inventory')
        .update({ quantity: inv.quantity + it.quantity })
        .eq('product_id', it.product_id);
      if (error) { console.error('inventory 복구 실패:', error); process.exit(1); }
      console.log(`  ✓ inventory[${it.product_name}] ${inv.quantity} → ${inv.quantity + it.quantity}`);
    } else {
      console.log(`  ⚠ inventory 레코드 없음: ${it.product_name} (범용상품일 가능성, 스킵)`);
    }
  } else {
    // 팩 복구 (단순화 옵션): loose_pack_qty 복구 + reserved_pack 차감. 박스 분해 안 함.
    const { data: inv } = await supabase
      .from('inventory')
      .select('loose_pack_qty, reserved_pack')
      .eq('product_id', it.product_id)
      .single();
    if (inv) {
      const { error } = await supabase.from('inventory').update({
        loose_pack_qty: (inv.loose_pack_qty || 0) + it.quantity,
        reserved_pack:  Math.max(0, (inv.reserved_pack || 0) - it.quantity),
      }).eq('product_id', it.product_id);
      if (error) { console.error('팩 복구 실패:', error); process.exit(1); }
      console.log(`  ✓ pack ${it.product_name} loose +${it.quantity}, reserved_pack -${it.quantity}`);
    }
  }
}

// 5. orders 삭제 (order_items, order_logs CASCADE)
{
  const { error } = await supabase.from('orders').delete().eq('id', order.id);
  if (error) { console.error('orders 삭제 실패:', error); process.exit(1); }
  console.log(`  ✓ orders 삭제 (order_items, order_logs CASCADE)`);
}

console.log('\n✅ PURGE 완료. 점주 눈에 흔적 남지 않음.');
console.log('※ 참고: order_number 시퀀스 자체는 되돌릴 수 없으며, 해당 번호는 결번으로 남습니다 (문제 없음).');
