// READ-ONLY — 월별 재고 검증 (유령 재고 + 실물 역산).
// SELECT만 수행. DB 변경 없음. (로컬 마감 폴더에 md 파일만 생성)
//
// 사용법:  node scripts/closing-inventory-monthly-readonly.mjs 2026-08
//
// 산출물: 마감/<YYYY-MM>/재고검증_<YYYY-MM>.md
//
// ■ 왜 이 검증이 필요한가 (2026-08-07 생밀면 사건)
//   시스템에는 등식 자물쇠(총재고 = 주문가능 + 나갈것)가 걸려 있지만,
//   총재고와 나갈것이 '같은 양만큼' 함께 부풀면 등식은 그대로 성립한다.
//   실제로 2026-07-30 출고처리 이중 실행 + 재고차감 실패 무시가 겹쳐
//   생밀면 총재고가 실물보다 2박스 많았는데 등식 검사로는 잡히지 않았다.
//   → 등식 검사만으로는 부족하다. 아래 2가지를 같이 본다.
//
//   (1) 유령 재고 : 나갈것(reserved) vs 실제 미출고 발주 대조
//   (2) 실물 역산 : 2026-05-21 실사 확정값에서 출발해
//                   + 입고 - 실제 출고완료 를 누적한 값 vs DB 총재고
//                   (낱팩 분해가 있으므로 전부 '팩' 단위로 환산해서 비교)
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

const envText = readFileSync(join(projectRoot, '.env.local'), 'utf-8');
const env = Object.fromEntries(
  envText.split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  })
);
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const arg = process.argv[2];
if (!/^\d{4}-\d{2}$/.test(arg || '')) {
  console.error('사용법: node scripts/closing-inventory-monthly-readonly.mjs 2026-08');
  process.exit(1);
}
const [Y, M] = arg.split('-').map(Number);
const label = `${Y}년 ${M}월`;

// 역산 기준점 — 028 마이그레이션에서 사장님이 직접 카운트해 확정한 실재고(2026-05-21).
// 양념장은 028 에서 제외되어 기준이 없었으나, 2026-08-07 08:30 신화 실물 카운트(23박스)가
// 시스템 값과 정확히 일치함을 확인하여 그 시점을 기준으로 추가했다.
const BASE_DATE = '2026-05-21';
const BASE = {
  '고기국수육수': 24,
  '비빔전용장': 5,
  '생밀면': 38,
  '아삭한김치왕만두70': 20,
  '왕만두': 54,
  '육수간장': 26,
};
// 기준일이 다른 상품 (상품명 → { date, boxes })
const BASE_ALT = {
  '양념장': { date: '2026-08-07', boxes: 23 },
};

const out = [];
const say = (s = '') => out.push(s);
const kst = (iso) => iso ? new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16) : '';

say(`# ${label} 재고 검증 보고 (마감)`);
say('');
say(`- 조회 시각: ${kst(new Date().toISOString())} (KST)`);
say(`- 역산 기준점: ${BASE_DATE} 실사 확정값 (028 마이그레이션)`);
for (const [n, a] of Object.entries(BASE_ALT)) say(`  - ${n}: ${a.date} 실사 ${a.boxes}박스 기준`);
say('- 이 문서는 **읽기 전용 조회 결과**입니다. DB를 바꾸지 않습니다.');
say('');

// ---------- 기준 데이터 ----------
const { data: products } = await supabase
  .from('products').select('id, name, pack_per_box')
  .eq('product_type', 'exclusive').order('name');
const { data: invs } = await supabase
  .from('inventory')
  .select('product_id, quantity, reserved, on_hand, loose_pack_qty, reserved_pack, on_hand_pack');
const invByPid = new Map(invs.map(i => [i.product_id, i]));

// ---------- A. 현재 재고 ----------
say('## A. 현재 재고');
say('');
say('| 상품 | 총재고 | 나갈것 | 주문가능 | 낱팩(총/예약/가능) | 등식 |');
say('|---|---:|---:|---:|---|:--:|');
let eqBad = 0;
for (const p of products) {
  const i = invByPid.get(p.id) || {};
  const ok = (i.on_hand ?? 0) === (i.quantity ?? 0) + (i.reserved ?? 0)
    && (i.on_hand_pack ?? 0) === (i.loose_pack_qty ?? 0) + (i.reserved_pack ?? 0);
  if (!ok) eqBad++;
  say(`| ${p.name} | ${i.on_hand ?? 0} | ${i.reserved ?? 0} | ${i.quantity ?? 0} | ${i.on_hand_pack ?? 0} / ${i.reserved_pack ?? 0} / ${i.loose_pack_qty ?? 0} | ${ok ? '✓' : '**✗**'} |`);
}
say('');
say(`등식 위반: **${eqBad}건**`);
say('');
// 낱팩 누적 점검 — 한 박스 분량 이상 쌓인 낱팩은 박스로 환산되어야 한다(040).
// 창고는 낱팩이 모이면 박스로 세므로, 안 맞으면 화면 숫자가 실물과 달라 보인다.
const loosePiled = products
  .map(p => ({ p, i: invByPid.get(p.id) || {} }))
  .filter(({ p, i }) => (p.pack_per_box || 1) > 1 && (i.loose_pack_qty || 0) >= (p.pack_per_box || 1));
if (loosePiled.length) {
  say('**낱팩 누적 확인 필요**');
  say('');
  for (const { p, i } of loosePiled) {
    const c = Math.floor(i.loose_pack_qty / p.pack_per_box);
    say(`- ${p.name}: 낱팩 ${i.loose_pack_qty}팩 (1박스=${p.pack_per_box}팩) → **${c}박스로 환산 가능** (잔여 ${i.loose_pack_qty % p.pack_per_box}팩)`);
  }
  say('');
}

// ---------- B. 유령 재고 ----------
say('## B. 유령 재고 점검');
say('');
say('「나갈것」에 잡혀 있는데 실제로는 나갈 발주가 없는 물량입니다. **0이어야 정상입니다.**');
say('');
say('| 상품 | 나갈것(DB) | 실제 미출고 발주 | 유령 | 판정 |');
say('|---|---:|---:|---:|:--:|');

const ghosts = [];
for (const p of products) {
  const i = invByPid.get(p.id) || {};
  const [{ data: oi }, { data: bi }] = await Promise.all([
    supabase.from('order_items').select('order_id, quantity, unit').eq('product_id', p.id).eq('unit', 'box'),
    supabase.from('b2b_order_items').select('order_id, quantity, unit').eq('product_id', p.id).eq('unit', 'box'),
  ]);
  let open = 0;
  const oids = [...new Set((oi || []).map(x => x.order_id))];
  if (oids.length) {
    const { data: ords } = await supabase.from('orders').select('id, status').in('id', oids);
    const openIds = new Set((ords || []).filter(o => ['pending', 'confirmed'].includes(o.status)).map(o => o.id));
    open += (oi || []).filter(x => openIds.has(x.order_id)).reduce((a, x) => a + x.quantity, 0);
  }
  const bids = [...new Set((bi || []).map(x => x.order_id))];
  if (bids.length) {
    const { data: bo } = await supabase.from('b2b_orders').select('id, status').in('id', bids);
    const openB = new Set((bo || []).filter(o => o.status === 'pending').map(o => o.id));
    open += (bi || []).filter(x => openB.has(x.order_id)).reduce((a, x) => a + x.quantity, 0);
  }
  const ghost = (i.reserved ?? 0) - open;
  if (ghost !== 0) ghosts.push({ name: p.name, ghost, reserved: i.reserved ?? 0, open });
  say(`| ${p.name} | ${i.reserved ?? 0} | ${open} | ${ghost} | ${ghost === 0 ? '✓' : '**✗**'} |`);
}
say('');
say(`유령 재고: **${ghosts.length}건**`);
say('');

// ---------- C. 실물 역산 ----------
say('## C. 실물 역산 (팩 단위)');
say('');
say(`${BASE_DATE} 실사값에서 출발해 **입고를 더하고 실제 출고완료를 뺀** 값입니다.`);
say('박스를 헐어 낱팩으로 파는 상품이 있어 전부 팩으로 환산해 비교합니다.');
say('');
say('| 상품 | 입수 | 기준 | +입고 | −가맹출고 | −B2B출고 | ±조정 | 역산(팩) | DB(팩) | 차이(박스) | 판정 |');
say('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|:--:|');

const drifted = [];
const unverifiable = [];
for (const p of products) {
  const ppb = p.pack_per_box || 1;
  const i = invByPid.get(p.id) || {};
  const dbPacks = (i.on_hand || 0) * ppb + (i.on_hand_pack || 0);
  const alt = BASE_ALT[p.name];
  const base = alt ? alt.boxes : BASE[p.name];
  const baseDate = alt ? alt.date : BASE_DATE;
  if (base === undefined) {
    unverifiable.push({ name: p.name, dbPacks, ppb, on_hand: i.on_hand, on_hand_pack: i.on_hand_pack });
    say(`| ${p.name} | ${ppb} | — | — | — | — | — | **역산 불가** | ${dbPacks} | — | ⚠️ |`);
    continue;
  }

  const { data: txs } = await supabase.from('inventory_transactions')
    .select('type, quantity, unit, description, source')
    .eq('product_id', p.id).gt('created_at', `${baseDate}T23:59:59+09:00`);
  let inPacks = 0, adjPacks = 0;
  for (const t of (txs || [])) {
    const mult = t.unit === 'pack' ? 1 : ppb;
    if (t.type === 'inbound' && t.source === 'manual_inbound') { inPacks += Math.abs(t.quantity) * mult; continue; }
    if (t.source === 'manual_adjust' || t.type === 'adjustment') {
      // 장부 정합보정([028 실재고], [20260610 정합보정], [039 유령제거] …)은 숫자를 고친 것일 뿐
      // 실물이 움직인 게 아니다 → 역산에서 제외.
      if (/^\[/.test(t.description || '')) continue;
      if (/on_hand[^,]*유지/.test(t.description || '')) continue;
      // B2B 출고 자투리는 박스 분해의 '내부 이동' — 총량 변화 아님 → 제외
      if (/자투리/.test(t.description || '')) continue;
      adjPacks += (t.type === 'inbound' ? Math.abs(t.quantity) : t.type === 'outbound' ? -Math.abs(t.quantity) : t.quantity) * mult;
    }
  }

  const { data: oi } = await supabase.from('order_items').select('order_id, quantity, unit').eq('product_id', p.id);
  const ids = [...new Set((oi || []).map(x => x.order_id))];
  let storePacks = 0;
  if (ids.length) {
    const { data: ords } = await supabase.from('orders').select('id, status, ship_date').in('id', ids);
    const ok = new Map((ords || []).map(o => [o.id, o]));
    for (const x of (oi || [])) {
      const o = ok.get(x.order_id);
      if (!o || o.status !== 'shipped' || !(o.ship_date > baseDate)) continue;
      storePacks += x.quantity * ((x.unit || 'box') === 'pack' ? 1 : ppb);
    }
  }

  const { data: bi } = await supabase.from('b2b_order_items').select('order_id, quantity, unit').eq('product_id', p.id);
  const bids = [...new Set((bi || []).map(x => x.order_id))];
  let b2bPacks = 0;
  if (bids.length) {
    const { data: bo } = await supabase.from('b2b_orders').select('id, status, ship_date').in('id', bids);
    const bk = new Map((bo || []).map(o => [o.id, o]));
    for (const x of (bi || [])) {
      const o = bk.get(x.order_id);
      if (!o || o.status !== 'shipped' || !(o.ship_date > baseDate)) continue;
      b2bPacks += x.quantity * ((x.unit || 'box') === 'pack' ? 1 : ppb);
    }
  }

  const calc = base * ppb + inPacks + adjPacks - storePacks - b2bPacks;
  const diff = dbPacks - calc;
  if (diff !== 0) drifted.push({ name: p.name, calc, dbPacks, diff, ppb });
  say(`| ${p.name} | ${ppb} | ${base * ppb} | ${inPacks} | ${storePacks} | ${b2bPacks} | ${adjPacks} | ${calc} | ${dbPacks} | ${(diff / ppb).toFixed(2)} | ${diff === 0 ? '✓' : '**✗**'} |`);
}
say('');
say(`실물과 어긋난 상품: **${drifted.length}건**`);
say('');

// ---------- D. 출고처리 이중 실행 점검 ----------
say('## D. 출고 처리 이중 실행 점검');
say('');
say(`${label}에 「출고 처리」 이력이 같은 주문에 2번 이상 찍힌 건입니다. **0건이어야 정상입니다.**`);
say('');
say('> 이게 잡히면 재고가 이중 차감됐을 수 있습니다. B·C 항목을 함께 보세요.');
say('');
// 해당 월(KST)에 찍힌 출고 처리 이력만 본다 — 지난달 사건이 매달 다시 뜨지 않도록.
const mFrom = `${arg}-01T00:00:00+09:00`;
const mTo = `${new Date(Date.UTC(Y, M, 1)).toISOString().slice(0, 10)}T00:00:00+09:00`;
const { data: dupLogs } = await supabase
  .from('order_logs').select('order_id, created_at, changed_by_name')
  .eq('action', '출고 처리')
  .gte('created_at', mFrom).lt('created_at', mTo);
const cnt = new Map();
for (const l of (dupLogs || [])) cnt.set(l.order_id, (cnt.get(l.order_id) || 0) + 1);
const dupIds = [...cnt.entries()].filter(([, c]) => c >= 2).map(([id]) => id);
if (!dupIds.length) {
  say('중복 없음 ✓');
} else {
  const { data: dords } = await supabase
    .from('orders').select('id, order_number, ship_date, stores(short_name, name)').in('id', dupIds);
  say('| 주문번호 | 매장 | 배송일 | 출고처리 횟수 |');
  say('|---|---|---|---:|');
  for (const o of (dords || [])) {
    say(`| ${o.order_number} | ${o.stores?.short_name || o.stores?.name || ''} | ${o.ship_date || ''} | **${cnt.get(o.id)}** |`);
  }
}
say('');
say(`이중 실행: **${dupIds.length}건**`);
say('');

// ---------- E. 판정 ----------
say('## E. 판정');
say('');
const problems = eqBad + ghosts.length + drifted.length + dupIds.length + loosePiled.length;
if (problems === 0) {
  say('**이상 없음 ✓** — 등식·유령·실물역산·이중실행 모두 통과.');
} else {
  say(`**확인 필요 ${problems}건**`);
  say('');
  if (eqBad) say(`- 등식 위반 ${eqBad}건 — 재고 3칸의 계산이 안 맞습니다. 즉시 점검 필요.`);
  for (const { p, i } of loosePiled) say(`- 낱팩 누적 · ${p.name}: ${i.loose_pack_qty}팩 (${Math.floor(i.loose_pack_qty / p.pack_per_box)}박스 분량) — 박스 환산이 안 되고 있습니다.`);
  for (const g of ghosts) say(`- 유령 재고 · ${g.name}: 나갈것 ${g.reserved}인데 실제 미출고는 ${g.open} → 유령 ${g.ghost}박스`);
  for (const d of drifted) say(`- 실물 불일치 · ${d.name}: DB ${d.dbPacks}팩 / 역산 ${d.calc}팩 → ${(d.diff / d.ppb).toFixed(2)}박스 차이`);
  if (dupIds.length) say(`- 출고 처리 이중 실행 ${dupIds.length}건 — 위 D 표의 주문을 확인하세요.`);
  say('');
  say('> 실물 역산은 「입고 등록이 빠짐없이 되어 있다」는 전제입니다.');
  say('> 차이가 나면 **창고 실물을 세어 확정**한 뒤 보정하세요.');
}
say('');
if (unverifiable.length) {
  say('### 검증 불가 상품');
  say('');
  for (const u of unverifiable) {
    say(`- **${u.name}**: ${BASE_DATE} 실사 기준이 없어 역산할 수 없습니다. (현재 DB: ${u.on_hand}박스 + ${u.on_hand_pack}팩)`);
  }
  say('');
  say(`> 창고 실물을 **한 번만** 세어 알려주시면, 이 스크립트의 \`BASE\` 에 추가해 다음 달부터 자동 검증됩니다.`);
  say('');
}

// ---------- 저장 ----------
const outDir = join(projectRoot, '마감', arg);
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `재고검증_${arg}.md`);
writeFileSync(outPath, out.join('\n'), 'utf-8');

console.log('');
console.log(out.join('\n'));
console.log('');
console.log(`📄 저장 완료: 마감/${arg}/재고검증_${arg}.md`);
