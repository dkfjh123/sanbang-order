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

const { data: logs, error } = await supabase
  .from('product_logs')
  .select('*')
  .gte('created_at', '2026-05-01')
  .lte('created_at', '2026-05-20')
  .order('created_at');

if (error) {
  console.error('Error fetching logs:', error);
  process.exit(1);
}

console.log(`Found ${logs.length} product logs in May 1-20:`);
for (const log of logs) {
  console.log(`\n[${log.created_at}] ${log.product_name} (${log.action}) by ${log.changed_by_name} (${log.changed_by_role})`);
  console.log('Changes:', JSON.stringify(log.changes, null, 2));
}
