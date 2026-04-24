#!/usr/bin/env node
// 동일옥 오늘 주문 + 예치금 잔액 + 테스트로 의심되는 항목 조회 (읽기 전용)
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '.env.local');
const envText = readFileSync(envPath, 'utf-8');
const env = Object.fromEntries(
  envText
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

// 동일옥 매장
const { data: store } = await supabase
  .from('stores')
  .select('id, short_name, name, region, delivery_days, allow_split_shipping, deposit_balance')
  .or('short_name.eq.동일옥,name.ilike.%동일옥%')
  .single();

if (!store) {
  console.error('동일옥 매장을 찾을 수 없습니다.');
  process.exit(1);
}

console.log('=== 동일옥 매장 정보 ===');
console.log(`id: ${store.id}`);
console.log(`이름: ${store.short_name} (${store.name})`);
console.log(`배송요일: ${JSON.stringify(store.delivery_days)}`);
console.log(`배송일 선택: ${store.allow_split_shipping}`);
console.log(`예치금 잔액: ₩${store.deposit_balance.toLocaleString()}`);

// 오늘(로컬 KST) 자정부터
const now = new Date();
const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
const todayStartISO = todayStart.toISOString();

const { data: orders, error } = await supabase
  .from('orders')
  .select('id, order_number, status, total_amount, ship_date, created_at, memo, order_items(product_name, quantity, subtotal, unit)')
  .eq('store_id', store.id)
  .gte('created_at', todayStartISO)
  .order('created_at', { ascending: false });

if (error) {
  console.error('주문 조회 실패:', error);
  process.exit(1);
}

console.log(`\n=== 오늘 (${todayStart.toLocaleDateString('ko-KR')} 이후) 동일옥 주문: ${orders?.length || 0}건 ===`);

if (!orders || orders.length === 0) {
  console.log('오늘 주문 없음.');
  process.exit(0);
}

let totalActive = 0;
for (const o of orders) {
  const active = o.status !== 'cancelled';
  if (active) totalActive += o.total_amount;
  console.log(`\n[${o.order_number}] ${o.status.toUpperCase()} / 총 ₩${o.total_amount.toLocaleString()} / 배송일 ${o.ship_date || '-'} / ${new Date(o.created_at).toLocaleString('ko-KR')}`);
  if (o.memo) console.log(`  메모: ${o.memo}`);
  (o.order_items || []).forEach((it) => {
    console.log(`  - ${it.product_name} × ${it.quantity}${it.unit === 'pack' ? '팩' : '박스'} (₩${it.subtotal.toLocaleString()})`);
  });
}

console.log(`\n=== 요약 ===`);
const byStatus = {};
orders.forEach((o) => { byStatus[o.status] = (byStatus[o.status] || 0) + 1; });
console.log('상태별 건수:', byStatus);
console.log(`활성(취소 아님) 주문 총액: ₩${totalActive.toLocaleString()}`);
console.log(`현재 예치금: ₩${store.deposit_balance.toLocaleString()}`);
