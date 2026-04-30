// 왕만두 4월 inbound 데이터 정밀 조회 (timezone 포함)
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
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } });

const { data: prods } = await supabase.from('products').select('id, name').eq('name', '왕만두');
const wangmandu = prods?.[0];
console.log('왕만두 product:', wangmandu);

const { data: txs } = await supabase
  .from('inventory_transactions')
  .select('id, type, quantity, description, created_at, unit')
  .eq('product_id', wangmandu.id)
  .gte('created_at', '2026-04-25')
  .lt('created_at', '2026-05-02')
  .order('created_at', { ascending: false });

console.log('\n왕만두 4/25~5/1 inventory_transactions:');
txs?.forEach((tx) => {
  const utc = new Date(tx.created_at);
  const krStr = new Date(utc.getTime() + 9 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  console.log(`  ${tx.created_at} (KR ${krStr}) | ${tx.type} | ${tx.quantity}${tx.unit || 'box'} | ${tx.description || ''}`);
});

// 현재 재고
const { data: inv } = await supabase
  .from('inventory')
  .select('quantity, loose_pack_qty, updated_at')
  .eq('product_id', wangmandu.id)
  .single();
console.log('\n현재 왕만두 재고:', inv);
