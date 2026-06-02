// READ-ONLY — 031 source 백필 검증. SELECT만.
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(join(__dirname, '..', '.env.local'), 'utf-8');
const env = Object.fromEntries(envText.split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const { data, error } = await supabase
  .from('inventory_transactions')
  .select('source, quantity, type')
  .eq('type', 'inbound');
if (error) { console.error(error); process.exit(1); }

const agg = {};
for (const r of (data || [])) {
  const k = r.source === null ? '(NULL)' : r.source;
  (agg[k] ||= { cnt: 0, qty: 0 });
  agg[k].cnt++; agg[k].qty += r.quantity;
}
console.log('=== type=inbound 의 source 분포 ===');
for (const [k, v] of Object.entries(agg)) console.log(`  ${k.padEnd(16)} : ${v.cnt}건, ${v.qty}박스상당`);
console.log('\n기대: manual_inbound 40 / manual_adjust 3 / (NULL) 54');

// manual_adjust 3건 확인
const { data: adj } = await supabase
  .from('inventory_transactions')
  .select('product_id, quantity, description, created_at')
  .eq('source', 'manual_adjust');
console.log('\n=== manual_adjust (입고 제외) 건 ===');
for (const a of (adj || [])) console.log(`  +${a.quantity}  "${a.description}"`);
