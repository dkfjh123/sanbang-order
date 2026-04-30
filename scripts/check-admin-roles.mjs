// dkfjh1234@gmail.com 계정의 profile.email을 auth.users.email과 정합성 맞춤
// (auth는 dkfjh1234@gmail.com / profile은 admin@sanbang.co.kr 로 stale)
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(resolve(__dirname, '..', '.env.local'), 'utf8');
const env = Object.fromEntries(
  envText
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const idx = l.indexOf('=');
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
    })
);

const supabase = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const TARGETS = ['dkfjh1234@gmail.com', 'jjojjokies@gmail.com'];

const { data: usersList } = await supabase.auth.admin.listUsers({ perPage: 200 });
const matched = usersList.users.filter((u) =>
  TARGETS.some((e) => (u.email || '').toLowerCase() === e.toLowerCase())
);

for (const u of matched) {
  const { data: prof } = await supabase
    .from('profiles')
    .select('id, email, role')
    .eq('id', u.id)
    .maybeSingle();

  if (!prof) {
    console.log(`[skip] ${u.email}: profile 없음`);
    continue;
  }

  const updates = {};
  if (prof.email !== u.email) updates.email = u.email;
  if (prof.role !== 'admin') updates.role = 'admin';

  if (Object.keys(updates).length === 0) {
    console.log(`[ok]   ${u.email}: 변경 불필요 (role=${prof.role}, email=${prof.email})`);
    continue;
  }

  const { error } = await supabase.from('profiles').update(updates).eq('id', u.id);
  if (error) {
    console.log(`[err]  ${u.email}:`, error.message);
  } else {
    console.log(`[fix]  ${u.email}: ${JSON.stringify(updates)} 적용 (이전 role=${prof.role}, email=${prof.email})`);
  }
}
