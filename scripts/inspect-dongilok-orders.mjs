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
  const { data: order, error } = await supabase
    .from('orders')
    .select('*, order_items(*)')
    .eq('order_number', orderNum)
    .single();
    
  if (error) {
    console.error(`Error fetching ${orderNum}:`, error);
    continue;
  }
  
  // Get profile
  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', order.ordered_by)
    .single();
  
  console.log(`\n================ ${orderNum} ================`);
  console.log(`Status: ${order.status}`);
  console.log(`Ordered by: ${profile?.email} (${profile?.role})`);
  console.log(`Created at: ${order.created_at}`);
  console.log(`Ship date: ${order.ship_date}`);
  console.log(`Memo: ${order.memo}`);
  console.log(`Order Items:`);
  for (const item of order.order_items) {
    console.log(`  - ${item.product_name}:`);
    console.log(`    qty: ${item.quantity}`);
    console.log(`    unit_price: ${item.unit_price}`);
    console.log(`    unit_price_with_tax: ${item.unit_price_with_tax}`);
    console.log(`    is_tax_free: ${item.is_tax_free}`);
    console.log(`    subtotal: ${item.subtotal}`);
  }
}
