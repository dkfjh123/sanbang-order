// 028 적용 후 검증
// 사용자 합의 실재고 vs DB on_hand, quantity = on_hand - reserved, 등식
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

const EXPECTED = {
  '고기국수육수':       { on_hand: 24, note: '변경 없음' },
  '비빔전용장':         { on_hand: 5 },
  '생밀면':             { on_hand: 38 },
  '아삭한김치왕만두70': { on_hand: 20 },
  '왕만두':             { on_hand: 54 },
  '육수간장':           { on_hand: 26 },
  '양념장':             { on_hand: 29, note: '028 제외 — 별건' },
};

const { data: products } = await supabase
  .from('products')
  .select('id, name')
  .eq('product_type', 'exclusive')
  .order('name');

const { data: invs } = await supabase
  .from('inventory')
  .select('product_id, quantity, loose_pack_qty, on_hand, reserved, on_hand_pack, reserved_pack')
  .in('product_id', products.map((p) => p.id));
const invByPid = new Map(invs.map((i) => [i.product_id, i]));

console.log('===== 028 적용 후 검증 =====\n');
console.log('  상품              | 기대 on_hand | DB | quantity(=oh-r) | reserved | 등식 | 메모');
console.log('  -----------------+-------------+----+-----------------+----------+------+------');

let allMatch = true;
let allEq = true;
for (const p of products) {
  const inv = invByPid.get(p.id);
  if (!inv) continue;
  const exp = EXPECTED[p.name];
  if (!exp) continue;

  const expectedQty = exp.on_hand - inv.reserved;
  const onHandMatch = inv.on_hand === exp.on_hand;
  const quantityMatch = inv.quantity === expectedQty;
  const eqOk = inv.on_hand === inv.quantity + inv.reserved;

  if (!onHandMatch) allMatch = false;
  if (!eqOk) allEq = false;

  console.log(`  ${p.name.padEnd(17)} | ${String(exp.on_hand).padEnd(11)} | ${String(inv.on_hand).padEnd(2)} | ${inv.quantity} (기대 ${expectedQty}) ${quantityMatch ? '✓' : '✗'} | ${String(inv.reserved).padEnd(8)} | ${eqOk ? '✓' : '✗'}    | ${onHandMatch ? '✓ 일치' : '✗ 불일치'}${exp.note ? ' — ' + exp.note : ''}`);
}

console.log(`\n===== 최종 =====`);
console.log(`  실재고 일치 (양념장 제외 검증):  ${allMatch ? '★ 모두 ✓' : '✗ 일부 불일치'}`);
console.log(`  등식 일치:                       ${allEq ? '★ 모두 ✓' : '✗ 일부 불일치'}`);

// 추가 — 팩 칸 상태
console.log('\n===== 팩 칸 상태 (참고) =====');
for (const p of products) {
  const inv = invByPid.get(p.id);
  if (!inv) continue;
  const eqPack = inv.on_hand_pack === inv.loose_pack_qty + inv.reserved_pack;
  console.log(`  ${p.name.padEnd(17)} | loose=${inv.loose_pack_qty} reserved_pack=${inv.reserved_pack} on_hand_pack=${inv.on_hand_pack} | 팩등식 ${eqPack ? '✓' : '✗'}`);
}
