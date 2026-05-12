#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(join(__dirname, '..', '.env.local'), 'utf-8');
const env = Object.fromEntries(
  envText.split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => {
    const i = l.indexOf('='); return [l.slice(0,i).trim(), l.slice(i+1).trim()];
  })
);
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const { data: store } = await supabase
  .from('stores')
  .select('id, short_name, deposit_balance')
  .or('short_name.eq.동일옥,name.ilike.%동일옥%')
  .single();

console.log(`=== 동일옥 (${store.id}) — 예치금 ₩${store.deposit_balance.toLocaleString()} ===`);

const { data: orders } = await supabase
  .from('orders')
  .select('id, order_number, status, total_amount, ship_date, created_at, memo, order_items(product_name, quantity, subtotal, unit)')
  .eq('store_id', store.id)
  .order('created_at', { ascending: false })
  .limit(10);

console.log(`\n=== 최근 주문 10건 ===`);
for (const o of orders || []) {
  console.log(`\n[${o.order_number}] ${o.status.toUpperCase()} / ₩${o.total_amount.toLocaleString()} / 배송일 ${o.ship_date || '-'} / ${new Date(o.created_at).toLocaleString('ko-KR')}`);
  if (o.memo) console.log(`  메모: ${o.memo}`);
  (o.order_items || []).forEach(it => {
    console.log(`  - ${it.product_name} × ${it.quantity}${it.unit === 'pack' ? '팩' : '박스'} (₩${it.subtotal.toLocaleString()})`);
  });
}

const { data: deposits } = await supabase
  .from('deposit_transactions')
  .select('id, type, amount, balance_after, memo, created_at')
  .eq('store_id', store.id)
  .order('created_at', { ascending: false })
  .limit(10);

console.log(`\n=== 예치금 거래 최근 10건 ===`);
for (const d of deposits || []) {
  console.log(`[${new Date(d.created_at).toLocaleString('ko-KR')}] ${d.type} ${d.amount > 0 ? '+' : ''}${d.amount.toLocaleString()} → 잔액 ₩${d.balance_after.toLocaleString()} ${d.memo ? '/ ' + d.memo : ''}`);
}
