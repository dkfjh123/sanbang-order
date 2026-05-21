// 양념장 14박스 차이 추적
// inventory_transactions ABS running balance vs 실제 inventory 추적
// READ-ONLY
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

const { data: prod } = await supabase
  .from('products')
  .select('id, name, pack_per_box')
  .eq('name', '양념장')
  .single();
const PID = prod.id;

const { data: inv } = await supabase
  .from('inventory')
  .select('quantity, loose_pack_qty, on_hand, reserved, on_hand_pack, reserved_pack')
  .eq('product_id', PID)
  .single();

console.log('===== 양념장 현재 inventory =====');
console.log(`  quantity=${inv.quantity}, reserved=${inv.reserved}, on_hand=${inv.on_hand}`);
console.log(`  loose_pack_qty=${inv.loose_pack_qty}, reserved_pack=${inv.reserved_pack}, on_hand_pack=${inv.on_hand_pack}`);
console.log(`  pack_per_box=${prod.pack_per_box}`);

// 전 inventory_transactions
const { data: tx } = await supabase
  .from('inventory_transactions')
  .select('id, type, quantity, unit, description, created_at')
  .eq('product_id', PID)
  .order('created_at', { ascending: true });

console.log(`\n===== inventory_transactions 흐름 (${tx.length}건) =====\n`);
console.log('  시각              | type        |   qty | unit | description');
console.log('  -----------------+-------------+-------+------+-------------');

let bal_box = 0, bal_pack = 0;
let in_box = 0, out_box = 0, adj_box = 0;
let in_pack = 0, out_pack = 0;
const rows = [];
for (const r of tx) {
  const u = r.unit || 'box';
  const sign = r.type === 'inbound' ? 1 : r.type === 'outbound' ? -1 : 0;
  const abs = Math.abs(Number(r.quantity));
  if (u === 'box') {
    bal_box += sign * abs;
    if (sign > 0) in_box += abs;
    else if (sign < 0) out_box += abs;
    else adj_box += Number(r.quantity);
  } else {
    bal_pack += sign * abs;
    if (sign > 0) in_pack += abs;
    else if (sign < 0) out_pack += abs;
  }
  rows.push({ r, bal_box, bal_pack });
}

for (const { r, bal_box: b, bal_pack: bp } of rows) {
  const t = r.created_at.slice(0, 16);
  const typ = (r.type || '').padEnd(11);
  const qty = String(r.quantity).padStart(5);
  const un = (r.unit || 'box').padEnd(4);
  const desc = (r.description || '').slice(0, 60);
  console.log(`  ${t} | ${typ} | ${qty} | ${un} | ${desc}  → bal_box=${b}`);
}

console.log(`\n===== 합계 =====`);
console.log(`  box  inbound  합(ABS): ${in_box}`);
console.log(`  box  outbound 합(ABS): ${out_box}`);
console.log(`  box  adjustment(부호 그대로): ${adj_box}`);
console.log(`  box  ABS running balance:    ${bal_box}`);
console.log(`  pack inbound  합(ABS): ${in_pack}`);
console.log(`  pack outbound 합(ABS): ${out_pack}`);
console.log(`  pack ABS running balance:    ${bal_pack}`);

console.log(`\n===== 비교 =====`);
console.log(`  현재 inventory.on_hand:   ${inv.on_hand}`);
console.log(`  tx ABS running balance:   ${bal_box}`);
console.log(`  차이 (on_hand - bal):     ${inv.on_hand - bal_box}`);

console.log(`\n  ※ ABS running balance 는 inbound/outbound 만 누적 (sign 적용).`);
console.log(`     adjustment 는 별도. 0 quantity adjustment 는 추적용 row 라 무영향.`);
console.log(`     운영 초기 baseline 값 (mig 010 이전) 이 있다면 bal 에 포함 안 됨.`);

// outbound 중 양수 quantity 저장 row (B2B convention)
const positiveOut = tx.filter((r) => r.type === 'outbound' && Number(r.quantity) > 0);
if (positiveOut.length > 0) {
  console.log(`\n===== outbound 중 양수 quantity 저장된 row (${positiveOut.length}건, B2B convention) =====`);
  for (const r of positiveOut) {
    console.log(`  ${r.created_at.slice(0,16)} | qty=${r.quantity}${r.unit || 'box'} | ${r.description}`);
  }
}

// outbound 중 음수 quantity 저장 row (가맹점 convention)
const negativeOut = tx.filter((r) => r.type === 'outbound' && Number(r.quantity) < 0);
console.log(`\n  outbound 중 음수 quantity (가맹점 convention): ${negativeOut.length}건`);

// adjustment row 자세히
const adjs = tx.filter((r) => r.type === 'adjustment');
console.log(`\n===== adjustment row (${adjs.length}건) =====`);
for (const r of adjs) {
  console.log(`  ${r.created_at.slice(0,16)} | qty=${r.quantity}${r.unit || 'box'} | ${r.description || ''}`);
}
