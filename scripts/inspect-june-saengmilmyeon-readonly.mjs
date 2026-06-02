// READ-ONLY — 6월 생밀면 출고로그 + 동일옥 생밀면 주문 진상조사. SELECT만.
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(join(__dirname, '..', '.env.local'), 'utf-8');
const env = Object.fromEntries(envText.split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const KR = (iso) => new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

const { data: prod } = await supabase.from('products').select('id, name').ilike('name', '%생밀면%').single();
console.log('상품:', prod.name, prod.id);

// 6월(KR) 생밀면 전체 트랜잭션
const { data: txs } = await supabase
  .from('inventory_transactions')
  .select('type, quantity, unit, description, created_at')
  .eq('product_id', prod.id)
  .gte('created_at', '2026-06-01T00:00:00+09:00')
  .lt('created_at', '2026-07-01T00:00:00+09:00')
  .order('created_at');
console.log(`\n=== 6월 생밀면 트랜잭션 ${txs?.length || 0}건 (이력보기와 동일 범위) ===`);
for (const t of (txs || [])) console.log(`  [${KR(t.created_at)}] ${t.type} ${t.quantity}${t.unit === 'pack' ? '팩' : '박스'}  "${t.description || ''}"`);

// 동일옥 매장
const { data: stores } = await supabase.from('stores').select('id, name, short_name, allow_split_shipping');
const dongilok = (stores || []).find(s => (s.short_name || s.name || '').includes('동일옥'));
console.log(`\n동일옥: id=${dongilok?.id} split=${dongilok?.allow_split_shipping}`);

// 동일옥의 생밀면 포함 주문 (최근순, 5~6월)
const { data: orders } = await supabase
  .from('orders')
  .select('order_number, status, ship_date, created_at, order_items(product_name, quantity)')
  .eq('store_id', dongilok.id)
  .gte('created_at', '2026-05-20T00:00:00+09:00')
  .order('created_at', { ascending: false });
console.log(`\n=== 동일옥 최근 주문 (5/20~) ${orders?.length || 0}건 ===`);
for (const o of (orders || [])) {
  const milmyeon = o.order_items.find(it => it.product_name.includes('생밀면'));
  console.log(`  ${o.order_number}  status=${o.status}  발주생성=${KR(o.created_at)}  배송일=${o.ship_date}  생밀면=${milmyeon ? milmyeon.quantity + '박스' : '없음'}`);
}
