import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(join(__dirname, '..', '.env.local'), 'utf-8');
const env = Object.fromEntries(
  envText.split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => {
    const i = l.indexOf('='); return [l.slice(0,i).trim(), l.slice(i+1).trim()];
  })
);
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const orderNumbers = ['ORD-20260507-0056', 'ORD-20260509-0060'];

for (const orderNum of orderNumbers) {
  const { data: order } = await supabase
    .from('orders')
    .select('id')
    .eq('order_number', orderNum)
    .single();
    
  if (!order) continue;
  
  const { data: logs } = await supabase
    .from('order_logs')
    .select('*')
    .eq('order_id', order.id)
    .order('created_at');
    
  console.log(`\n=== Logs for ${orderNum} ===`);
  if (!logs || logs.length === 0) {
    console.log('No logs found.');
  } else {
    for (const log of logs) {
      console.log(`[${log.created_at}] ${log.action} by ${log.changed_by_name} (${log.changed_by_role}): ${log.description || ''}`);
    }
  }
}
