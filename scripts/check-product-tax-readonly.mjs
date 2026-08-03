// READ-ONLY — 생밀면/육수간장 단가·과세여부 확인
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

const { data: products } = await supabase.from('products').select('*').in('name', ['생밀면', '육수간장']);
for (const p of products) {
  console.log(`\n■ ${p.name} (${p.product_type})`);
  console.log(`   면세여부: ${p.is_tax_free ? '면세' : '과세'}`);
  console.log(`   가맹 공급가: ${f(p.price)}원 / 세포함: ${f(p.price_with_tax)}원  (차액 ${f(p.price_with_tax - p.price)})`);
  console.log(`   낱팩/박스: ${p.pack_per_box || 1}`);
  console.log(`   산방푸드 판매가(세포함): ${f(p.sanbang_food_sale_price_with_tax)}원`);
}

// 최근 실제 주문에서 쓰인 단가 확인
const { data: items } = await supabase
  .from('order_items')
  .select('product_name, quantity, unit, unit_price, unit_price_with_tax, is_tax_free, subtotal, orders(order_number, ship_date, store_id)')
  .in('product_name', ['생밀면', '육수간장'])
  .order('created_at', { ascending: false })
  .limit(12);
console.log('\n\n■ 최근 실제 주문 단가 (검증용)');
for (const it of items || []) {
  console.log(`   ${it.orders?.order_number} ${it.orders?.ship_date} | ${it.product_name} ${it.quantity}${it.unit === 'pack' ? '팩' : '박스'} | 공급가 ${f(it.unit_price)} / 세포함 ${f(it.unit_price_with_tax)} | ${it.is_tax_free ? '면세' : '과세'} | 소계 ${f(it.subtotal)}`);
}
