// 전 전용상품 총재고 실물 역산 (팩 단위 환산) — READ ONLY
// 박스↔낱팩 분해가 있는 상품(B2B 팩 출고 시 박스를 헐어 자투리를 낱팩으로 돌림) 때문에
// 박스 단위 역산은 부정확하다. 모든 수량을 '팩'으로 환산해 비교한다.
//
//   현재 총팩 = on_hand × 박스입수 + on_hand_pack
//   역산 총팩 = 5/21 실사박스 × 박스입수
//               + 입고(박스×입수 + 팩)
//               − 가맹 출고완료(박스×입수 + 팩)
//               − B2B 출고완료(박스×입수 + 팩)
//               ± 수기조정
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
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const BASE_DATE = '2026-05-21';
const BASE = { '고기국수육수': 24, '비빔전용장': 5, '생밀면': 38, '아삭한김치왕만두70': 20, '왕만두': 54, '육수간장': 26 };
const pad = (s, n) => {
  const w = [...String(s)].reduce((a, c) => a + (c.charCodeAt(0) > 0x2000 ? 2 : 1), 0);
  return String(s) + ' '.repeat(Math.max(0, n - w));
};

const { data: products } = await sb.from('products')
  .select('id, name, pack_per_box').eq('product_type', 'exclusive').order('name');
const { data: invs } = await sb.from('inventory')
  .select('product_id, quantity, reserved, on_hand, loose_pack_qty, reserved_pack, on_hand_pack');
const invByPid = new Map(invs.map((i) => [i.product_id, i]));

console.log(`\n===== 전 전용상품 실물 역산 (팩 단위, 기준 ${BASE_DATE} 실사) =====\n`);
console.log('  ' + pad('상품', 22) + '입수  기준팩  +입고  -가맹  -B2B  ±조정  =역산팩   DB총팩   차이(팩)  차이(박스)');
console.log('  ' + '-'.repeat(104));

const flagged = [];
for (const p of products) {
  const base = BASE[p.name];
  const inv = invByPid.get(p.id) || {};
  const ppb = p.pack_per_box || 1;
  const dbPacks = (inv.on_hand || 0) * ppb + (inv.on_hand_pack || 0);
  if (base === undefined) {
    console.log('  ' + pad(p.name, 22) + String(ppb).padStart(3) + '   — 실사 기준 없음 → 역산 불가.  DB 총팩 ' + dbPacks + ` (박스 ${inv.on_hand}, 낱팩 ${inv.on_hand_pack})`);
    continue;
  }
  const basePacks = base * ppb;

  const { data: txs } = await sb.from('inventory_transactions')
    .select('type, quantity, unit, description, created_at, source')
    .eq('product_id', p.id).gt('created_at', `${BASE_DATE}T23:59:59+09:00`);
  let inPacks = 0, adjPacks = 0;
  for (const t of (txs || [])) {
    const mult = (t.unit === 'pack') ? 1 : ppb;
    if (t.type === 'inbound' && t.source === 'manual_inbound') { inPacks += Math.abs(t.quantity) * mult; continue; }
    if (t.source === 'manual_adjust' || t.type === 'adjustment') {
      // 장부 정합보정([028 실재고], [20260610 정합보정], [039 유령제거] …)은
      // 숫자를 고친 것일 뿐 실물이 움직인 게 아니다 → 역산에서 제외.
      if (/^\[/.test(t.description || '')) continue;
      if (/on_hand[^,]*유지/.test(t.description || '')) continue;
      // B2B 출고 자투리는 박스 분해의 '내부 이동'일 뿐 총량 변화가 아님 → 제외
      if (/자투리/.test(t.description || '')) continue;
      adjPacks += (t.type === 'inbound' ? Math.abs(t.quantity) : t.type === 'outbound' ? -Math.abs(t.quantity) : t.quantity) * mult;
    }
  }

  const { data: oi } = await sb.from('order_items').select('order_id, quantity, unit').eq('product_id', p.id);
  const ids = [...new Set((oi || []).map((x) => x.order_id))];
  let storePacks = 0;
  if (ids.length) {
    const { data: ords } = await sb.from('orders').select('id, status, ship_date').in('id', ids);
    const ok = new Map((ords || []).map((o) => [o.id, o]));
    for (const x of (oi || [])) {
      const o = ok.get(x.order_id);
      if (!o || o.status !== 'shipped' || !(o.ship_date > BASE_DATE)) continue;
      storePacks += x.quantity * ((x.unit || 'box') === 'pack' ? 1 : ppb);
    }
  }

  const { data: bi } = await sb.from('b2b_order_items').select('order_id, quantity, unit').eq('product_id', p.id);
  const bids = [...new Set((bi || []).map((x) => x.order_id))];
  let b2bPacks = 0;
  if (bids.length) {
    const { data: bo } = await sb.from('b2b_orders').select('id, status, ship_date').in('id', bids);
    const bk = new Map((bo || []).map((o) => [o.id, o]));
    for (const x of (bi || [])) {
      const o = bk.get(x.order_id);
      if (!o || o.status !== 'shipped' || !(o.ship_date > BASE_DATE)) continue;
      b2bPacks += x.quantity * ((x.unit || 'box') === 'pack' ? 1 : ppb);
    }
  }

  const calc = basePacks + inPacks + adjPacks - storePacks - b2bPacks;
  const diff = dbPacks - calc;
  if (diff !== 0) flagged.push({ name: p.name, calc, dbPacks, diff, ppb, inv });

  console.log('  ' + pad(p.name, 22) + String(ppb).padStart(3) + String(basePacks).padStart(7)
    + String(inPacks).padStart(8) + String(storePacks).padStart(7) + String(b2bPacks).padStart(7)
    + String(adjPacks).padStart(7) + String(calc).padStart(9) + String(dbPacks).padStart(9)
    + String(diff).padStart(10) + (diff / ppb).toFixed(2).padStart(11) + (diff === 0 ? '  ✓' : '  ✗'));
}

console.log('\n===== 판정 =====');
if (!flagged.length) console.log('  ★ 전 상품 역산 = DB. 실물과 어긋난 상품 없음.');
else for (const f of flagged) {
  console.log(`  ✗ ${f.name}: DB ${f.dbPacks}팩(박스 ${f.inv.on_hand} + 낱팩 ${f.inv.on_hand_pack}) / 역산 ${f.calc}팩 → ${f.diff > 0 ? '+' : ''}${f.diff}팩 = ${(f.diff / f.ppb).toFixed(2)}박스 어긋남`);
}
console.log('\n  ※ 전제: 입고 등록 누락 없음. 최종 확정은 창고 실물 카운트.');
console.log('\n===== 끝 (읽기 전용) =====\n');
