// 입고내역(inventory_transactions type=inbound) 현황 조회
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

console.log('## 1. inventory_transactions 컬럼 (샘플 1건)');
const { data: sample } = await supabase
  .from('inventory_transactions')
  .select('*')
  .limit(1)
  .maybeSingle();
console.log(sample);

console.log('\n## 2. type 별 카운트');
const { data: allTx } = await supabase
  .from('inventory_transactions')
  .select('type, quantity, created_at, product_id')
  .order('created_at', { ascending: false })
  .limit(2000);
const byType = {};
allTx?.forEach((r) => { byType[r.type] = (byType[r.type] || 0) + 1; });
console.log(byType);

console.log('\n## 3. 4월 입고(inbound) 내역 — 전용상품 기준');
const { data: products } = await supabase
  .from('products')
  .select('id, name, product_type')
  .eq('product_type', 'exclusive');
const exclusiveIds = new Set(products?.map((p) => p.id));
const exclusiveNames = new Map(products?.map((p) => [p.id, p.name]));

const { data: inbound } = await supabase
  .from('inventory_transactions')
  .select('id, product_id, quantity, description, created_at, unit')
  .eq('type', 'inbound')
  .gte('created_at', '2026-04-01')
  .lt('created_at', '2026-05-01')
  .order('created_at', { ascending: true });

const exclusiveInbound = (inbound || []).filter((r) => exclusiveIds.has(r.product_id));
console.log(`총 ${inbound?.length || 0}건 (전용 ${exclusiveInbound.length}건)`);
exclusiveInbound.forEach((r) => {
  console.log(`  ${r.created_at.slice(0, 10)} | ${exclusiveNames.get(r.product_id)} | ${r.quantity}${r.unit || 'box'} | ${r.description || ''}`);
});

console.log('\n## 4. 전체 inbound 최근 10건 (전용/범용 무관)');
const { data: latest } = await supabase
  .from('inventory_transactions')
  .select('id, product_id, quantity, description, created_at, unit')
  .eq('type', 'inbound')
  .order('created_at', { ascending: false })
  .limit(10);
latest?.forEach((r) => {
  console.log(`  ${r.created_at.slice(0, 10)} | ${exclusiveNames.get(r.product_id) || `(범용 ${r.product_id.slice(0, 6)})`} | ${r.quantity}${r.unit || 'box'} | ${r.description || ''}`);
});
