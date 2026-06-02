import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'node:fs';
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
  .order('created_at', { ascending: false })
  .limit(100);

if (error) {
  console.error('Error:', error);
} else {
  // Write to a scratch file
  writeFileSync(join(__dirname, '..', 'product_logs_recent.json'), JSON.stringify(logs, null, 2));
  console.log(`Saved ${logs.length} product logs to product_logs_recent.json`);
}
