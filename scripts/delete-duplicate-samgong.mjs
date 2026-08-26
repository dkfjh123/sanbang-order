// 삼공밥상 중복 등록 1건 삭제 (046 마이그레이션과 동일 동작)
// 안전장치: 주문·예치금·입금요청·계정·화이트리스트가 하나라도 있으면 삭제하지 않고 중단
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

const TARGET = '698372c5-8e8c-43c0-bc1c-24ada9010700'; // 삭제 대상 (사업자번호 5505001149)
const KEEP = '56f3964a-9411-42ac-a19f-63be624eb5f3';   // 유지 (550-50-01149, 계정·예치금 연결)

const { data: row } = await sb.from('stores').select('*').eq('id', TARGET).maybeSingle();
if (!row) {
  console.log('대상 없음 — 이미 삭제되었습니다.');
  process.exit(0);
}
console.log('삭제 대상:', row.name, '/', row.business_number, '/', row.address);

for (const t of ['orders', 'deposit_transactions', 'deposit_requests', 'profiles', 'store_allowed_products']) {
  const { count, error } = await sb.from(t).select('*', { count: 'exact', head: true }).eq('store_id', TARGET);
  if (error) { console.error(`${t} 확인 실패: ${error.message}`); process.exit(1); }
  if (count > 0) { console.error(`중단 — ${t}에 ${count}건이 연결되어 있습니다.`); process.exit(1); }
  console.log(`  ${t}: 0건 ✓`);
}

const { error: delErr } = await sb.from('stores').delete().eq('id', TARGET);
if (delErr) { console.error('삭제 실패:', delErr.message); process.exit(1); }
console.log('삭제 완료.');

// 남은 삼공밥상 사업자번호 형식 통일
const { data: keep } = await sb.from('stores').select('id, name, business_number').eq('id', KEEP).maybeSingle();
if (keep && keep.business_number !== '550-50-01149') {
  await sb.from('stores').update({ business_number: '550-50-01149' }).eq('id', KEEP);
  console.log('사업자번호 형식 통일: 550-50-01149');
}

const { data: after } = await sb.from('stores').select('id, name, business_number, address').ilike('name', '%삼공%');
console.log('\n남은 삼공밥상:');
console.table(after);
