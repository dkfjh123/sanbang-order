// 삼공밥상 등록 현황 조회 (읽기 전용)
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(resolve(__dirname, '..', '.env.local'), 'utf8');
const env = Object.fromEntries(
  envText.split('\n').filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } });

const KEY = '삼공';

// 1) stores (가맹점)
const { data: stores, error: e1 } = await sb.from('stores').select('*').ilike('name', `%${KEY}%`);
console.log('=== stores (가맹점 테이블) ===');
if (e1) console.log('ERR', e1.message);
console.log(JSON.stringify(stores, null, 2));

// 2) b2b_customers (B2B 거래처)
const { data: cust, error: e2 } = await sb.from('b2b_customers').select('*').ilike('name', `%${KEY}%`);
console.log('=== b2b_customers (B2B 거래처 테이블) ===');
if (e2) console.log('ERR', e2.message);
console.log(JSON.stringify(cust, null, 2));

// 3) 최근 생성된 stores / b2b_customers 5건씩 (이름 다를 수 있으니)
const { data: recentStores } = await sb.from('stores')
  .select('short_name, name, region, is_direct, created_at').order('created_at', { ascending: false }).limit(5);
console.log('=== 최근 등록 가맹점 5 ==='); console.table(recentStores);
const { data: recentCust } = await sb.from('b2b_customers')
  .select('name, region, is_active, created_at').order('created_at', { ascending: false }).limit(5);
console.log('=== 최근 등록 B2B 거래처 5 ==='); console.table(recentCust);

// 4) 로그인 계정(profiles) 연결 확인
const ids = [...(stores ?? []).map((s) => s.id)];
if (ids.length) {
  const { data: profs } = await sb.from('profiles').select('id, email, name, role, store_id').in('store_id', ids);
  console.log('=== 연결된 로그인 계정 (profiles) ==='); console.table(profs);
  const { data: allow } = await sb.from('store_allowed_products')
    .select('store_id, product_id, products(code, name)').in('store_id', ids);
  console.log('=== 발주 허용 상품 화이트리스트 ===');
  console.log(JSON.stringify(allow, null, 2));
  const { data: ords } = await sb.from('orders').select('order_number, status, total_amount, created_at').in('store_id', ids).order('created_at', { ascending: false }).limit(5);
  console.log('=== 최근 주문 5 ==='); console.table(ords);
}
const cids = [...(cust ?? []).map((c) => c.id)];
if (cids.length) {
  const { data: profs2 } = await sb.from('profiles').select('id, email, name, role, b2b_customer_id').in('b2b_customer_id', cids);
  console.log('=== B2B 연결 계정 ==='); console.table(profs2);
  const { data: prices } = await sb.from('b2b_customer_prices').select('*, products(code, name)').in('b2b_customer_id', cids);
  console.log('=== B2B 거래처 단가 ==='); console.log(JSON.stringify(prices, null, 2));
}
