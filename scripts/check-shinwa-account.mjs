// 신화 계정 정보 조회 — READ ONLY (이메일만)
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

const { data } = await supabase
  .from('profiles')
  .select('id, name, email, role, created_at')
  .eq('role', 'shinwa');

console.log('신화 계정 목록:');
for (const p of data) {
  console.log(`  - ${p.name || '(이름없음)'} | ${p.email} | id=${p.id} | 생성=${p.created_at}`);
}
