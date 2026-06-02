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

const { data: orders, error } = await supabase
  .from('orders')
  .select('*, stores(name, short_name, is_direct, region), order_items(*)')
  .in('status', ['confirmed', 'shipped'])
  .gte('ship_date', '2026-05-01')
  .lte('ship_date', '2026-05-31')
  .order('ship_date');

if (error) {
  console.error('Error:', error);
  process.exit(1);
}

console.log('--- Store summary of discrepancies (unit_price === unit_price_with_tax for taxable items) ---');
const storesWithIssues = {};

for (const order of orders) {
  const storeName = order.stores?.short_name || order.stores?.name || 'Unknown';
  
  for (const item of order.order_items) {
    if (!item.is_tax_free && item.unit_price === item.unit_price_with_tax) {
      if (!storesWithIssues[storeName]) {
        storesWithIssues[storeName] = [];
      }
      storesWithIssues[storeName].push({
        order_number: order.order_number,
        ship_date: order.ship_date,
        product_name: item.product_name,
        quantity: item.quantity,
        unit_price_with_tax: item.unit_price_with_tax,
        unit_price: item.unit_price,
        subtotal: item.subtotal
      });
    }
  }
}

for (const [storeName, issues] of Object.entries(storesWithIssues)) {
  console.log(`\nStore: ${storeName} (Total issue items: ${issues.length})`);
  for (const iss of issues) {
    console.log(`  - [${iss.ship_date}][${iss.order_number}] ${iss.product_name} × ${iss.quantity}: price=${iss.unit_price_with_tax}, supply=${iss.unit_price}`);
  }
}
