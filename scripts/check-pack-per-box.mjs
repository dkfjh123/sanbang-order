// products.pack_per_box 확인 — READ ONLY
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
  .from('products')
  .select('name, pack_per_box, is_loose_pack_sellable')
  .eq('product_type', 'exclusive')
  .order('name');

console.log('상품명 | pack_per_box (박스 1개당 팩 수) | 낱개팩 판매허용');
console.log('-'.repeat(70));
for (const p of data) {
  console.log(`${p.name.padEnd(20)} | ${String(p.pack_per_box ?? '(NULL)').padStart(3)} | ${p.is_loose_pack_sellable}`);
}
