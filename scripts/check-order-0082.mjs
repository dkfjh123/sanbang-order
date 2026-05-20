// ORD-20260520-0082 (대한상공회의소점) 상세 — READ ONLY
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

const { data: order } = await supabase
  .from('orders')
  .select('*')
  .eq('order_number', 'ORD-20260520-0082')
  .single();

console.log('## 발주 0082 풀 필드');
console.log(JSON.stringify(order, null, 2));

console.log('\n## 다른 pending 발주들도 같이 비교');
const { data: pendings } = await supabase
  .from('orders')
  .select('order_number, status, created_at, delivery_date, order_deadline, store_id')
  .eq('status', 'pending')
  .order('created_at', { ascending: false });
console.log(JSON.stringify(pendings, null, 2));
