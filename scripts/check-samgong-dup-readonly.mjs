// 삼공밥상 중복 등록 2건의 연결 데이터 확인 (읽기 전용)
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(resolve(__dirname, '..', '.env.local'), 'utf8');
const env = Object.fromEntries(envText.split('\n').filter((l) => l && !l.startsWith('#') && l.includes('='))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } });

const A = '56f3964a-9411-42ac-a19f-63be624eb5f3'; // 06:22 등록 (계정 연결, 예치금 40만)
const B = '698372c5-8e8c-43c0-bc1c-24ada9010700'; // 06:14 등록 (계정 없음)

for (const [label, id] of [['A(06:22 계정연결)', A], ['B(06:14 중복의심)', B]]) {
  console.log(`\n########## ${label} ${id} ##########`);
  for (const t of ['orders', 'deposit_transactions', 'deposit_requests', 'store_allowed_products', 'profiles']) {
    const col = t === 'profiles' ? 'store_id' : 'store_id';
    const { data, error, count } = await sb.from(t).select('*', { count: 'exact' }).eq(col, id).limit(5);
    if (error) { console.log(`${t}: ERR ${error.message}`); continue; }
    console.log(`${t}: ${count}건`, count ? JSON.stringify(data.slice(0, 2)) : '');
  }
}
