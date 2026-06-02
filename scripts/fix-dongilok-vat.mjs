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

const corrections = [
  {
    order_number: 'ORD-20260507-0056',
    items: [
      { name: '왕만두', correct_unit_price: 55500 },
      { name: '생밀면', correct_unit_price: 43000 },
      { name: '아삭한김치왕만두70', correct_unit_price: 55500 },
      { name: '비빔전용장', correct_unit_price: 120880 },
      { name: '양조식초(오뚜기) 1.8L', correct_unit_price: 2409 },
      { name: '진간장(부천몽고) 1.8L', correct_unit_price: 4173 }
    ]
  },
  {
    order_number: 'ORD-20260509-0060',
    items: [
      { name: '왕만두', correct_unit_price: 55500 },
      { name: '생밀면', correct_unit_price: 43000 },
      { name: '아삭한김치왕만두70', correct_unit_price: 55500 }
    ]
  }
];

console.log('=== Starting VAT correction for Dongilok May orders ===');

for (const corr of corrections) {
  const { data: order, error: orderError } = await supabase
    .from('orders')
    .select('id')
    .eq('order_number', corr.order_number)
    .single();
    
  if (orderError || !order) {
    console.error(`Order ${corr.order_number} not found:`, orderError);
    continue;
  }
  
  console.log(`\nProcessing Order: ${corr.order_number} (ID: ${order.id})`);
  
  for (const item of corr.items) {
    const { data: updated, error: updateError } = await supabase
      .from('order_items')
      .update({ unit_price: item.correct_unit_price })
      .eq('order_id', order.id)
      .eq('product_name', item.name)
      .select();
      
    if (updateError) {
      console.error(`  Failed to update ${item.name}:`, updateError);
    } else if (updated && updated.length > 0) {
      console.log(`  Updated ${item.name}: unit_price -> ${item.correct_unit_price}`);
    } else {
      console.log(`  No item found matching ${item.name}`);
    }
  }
}

console.log('\n=== VAT correction complete ===');
