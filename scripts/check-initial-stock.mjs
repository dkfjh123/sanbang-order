// 시스템 도입 초기 미기록 재고 확인 — READ ONLY
// 각 전용상품에 대해: (현재고 + 출고누계 ABS - 입고누계 ABS) = 초기 미기록 재고
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

// 전체 inventory_transactions의 가장 오래된 created_at
const { data: oldest } = await supabase
  .from('inventory_transactions')
  .select('created_at, type, quantity, description, product_id')
  .order('created_at', { ascending: true })
  .limit(5);
console.log('## 가장 오래된 inventory_transactions 5건');
oldest?.forEach((r) => console.log(`  ${r.created_at} | ${r.type} | ${r.quantity} | ${r.description}`));

// 전용상품 전체 대상 — 초기 미기록 재고 추정
const { data: products } = await supabase
  .from('products')
  .select('id, name')
  .eq('product_type', 'exclusive')
  .order('name');

console.log('\n## 전용상품별 미기록 초기 재고 추정');
console.log('  (= 현재고 + 출고합ABS - 입고합ABS)\n');
for (const p of products) {
  const { data: inv } = await supabase
    .from('inventory')
    .select('quantity, loose_pack_qty, updated_at')
    .eq('product_id', p.id)
    .maybeSingle();
  const { data: txs } = await supabase
    .from('inventory_transactions')
    .select('type, quantity, unit, created_at')
    .eq('product_id', p.id)
    .order('created_at', { ascending: true });
  const boxTx = txs?.filter((t) => (t.unit || 'box') === 'box') || [];
  const inAbs = boxTx.filter((t) => t.type === 'inbound').reduce((s, t) => s + Math.abs(t.quantity), 0);
  const outAbs = boxTx.filter((t) => t.type === 'outbound').reduce((s, t) => s + Math.abs(t.quantity), 0);
  const adjSum = boxTx.filter((t) => t.type === 'adjustment').reduce((s, t) => s + Number(t.quantity), 0);
  const computed = inAbs - outAbs + adjSum;
  const initial = (inv?.quantity ?? 0) - computed;
  const firstTx = txs?.[0]?.created_at?.slice(0, 16) || '-';
  console.log(`  ${p.name.padEnd(20, ' ')} | 현재=${inv?.quantity ?? 0} | 입누=${inAbs} | 출누=${outAbs} | 조정=${adjSum} | 미기록초기=${initial} | 첫tx=${firstTx}`);
}

// 4/20 이전 트랜잭션 카운트
const { count: beforeApril20 } = await supabase
  .from('inventory_transactions')
  .select('id', { count: 'exact', head: true })
  .lt('created_at', '2026-04-20T00:00:00');
console.log(`\n## 2026-04-20 이전 inventory_transactions: ${beforeApril20}건`);
