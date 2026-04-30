// 전용상품 가격 조회 (매입가/판매가, 세전/세포함)
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

const { data } = await supabase
  .from('products')
  .select('name, spec, price, price_with_tax, cost_price, cost_price_with_tax, is_tax_free, is_active')
  .eq('product_type', 'exclusive')
  .order('sort_order', { ascending: true });

console.log('전용상품 가격 (DB 기준):');
console.table(data);
