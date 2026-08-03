// READ-ONLY — 월별 "산방에프앤비가 발행할 세금계산서" 집계 (가맹점 + B2B).
// SELECT만 수행. DB 변경 없음. (로컬 마감 폴더에 md 파일만 생성)
//
// 사용법:  node scripts/closing-tax-invoice-monthly-readonly.mjs 2026-07
//
// 시스템 밖 거래(택배 발송 등 주문이 없는 건)는 마감/<월>/수기추가분.json 에 적어두면 자동 합산된다.
//   [{ "대상": "협재점", "일자": "2026-07-28", "내용": "생밀면 4박스", "세포함금액": 189200, "과세": true, "비고": "..." }]
//
// 산출물: 마감/<YYYY-MM>/세금계산서_<YYYY-MM>.md
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
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
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const arg = process.argv[2];
if (!/^\d{4}-\d{2}$/.test(arg || '')) {
  console.error('사용법: node scripts/closing-tax-invoice-monthly-readonly.mjs 2026-07');
  process.exit(1);
}
const [Y, M] = arg.split('-').map(Number);
const START = `${arg}-01`;
const END = new Date(Date.UTC(Y, M, 0)).toISOString().slice(0, 10);
const label = `${Y}년 ${M}월`;

const f = (n) => Math.round(n ?? 0).toLocaleString('ko-KR');
// 홈택스 세금계산서: 과세 공급가액 합계 × 10% 원단위 절사
const hometaxVat = (supply) => Math.floor(supply * 0.1);

async function fetchAll(table, select, applyFilters) {
  const rows = []; const page = 1000;
  for (let from = 0; ; from += page) {
    let q = supabase.from(table).select(select).range(from, from + page - 1);
    if (applyFilters) q = applyFilters(q);
    const { data, error } = await q;
    if (error) { console.error(`[${table}]`, error.message); process.exit(1); }
    rows.push(...data);
    if (data.length < page) break;
  }
  return rows;
}

console.log(`${label} 세금계산서 집계 — 조회 중...`);

const orders = await fetchAll('orders',
  'order_number, store_id, status, ship_date, stores(name, short_name, is_direct, owner_name, business_number), order_items(product_name, quantity, unit, unit_price, unit_price_with_tax, is_tax_free, subtotal)',
  q => q.in('status', ['confirmed', 'shipped']).gte('ship_date', START).lte('ship_date', END).order('ship_date'));
const b2b = await fetchAll('b2b_orders',
  'order_number, status, ship_date, b2b_customers(name, business_number, region), b2b_order_items(product_name, quantity, unit_price, unit_price_with_tax, is_tax_free, subtotal, subtotal_ex_tax)',
  q => q.in('status', ['confirmed', 'shipped']).gte('ship_date', START).lte('ship_date', END).order('ship_date'));

const b2bCustomers = await fetchAll('b2b_customers', 'id, name, is_prepaid, business_number');
const isPrepaid = new Map(b2bCustomers.map(c => [c.name, c.is_prepaid]));

// ── 집계 ──
// vatItems  = 품목 세포함 소계 − 공급가액  (= 예치금에서 실제 빠져나간 금액 기준)
// vatStmt   = Σ floor(품목별 공급가 × 10%) (= 거래명세서·홈택스 방식)
const rows = new Map();
const getRow = (key, name, biz, owner, channel, basis) => {
  let r = rows.get(key);
  if (!r) { r = { name, biz: biz || '', owner: owner || '', channel, basis, supply: 0, vatItems: 0, vatStmt: 0, taxFree: 0, orderCnt: 0, manual: [] }; rows.set(key, r); }
  return r;
};

let directSupply = 0, directVat = 0, directTaxFree = 0;
for (const o of orders) {
  if (o.stores?.is_direct) {
    for (const it of o.order_items) {
      if (it.is_tax_free) directTaxFree += it.subtotal;
      else { directSupply += it.unit_price * it.quantity; directVat += (it.unit_price_with_tax - it.unit_price) * it.quantity; }
    }
    continue; // 직영 = 내부거래, 계산서 발행 대상 아님
  }
  const key = `store:${o.store_id}`;
  // 가맹점은 예치금에서 세포함 금액이 그대로 빠져나감 → 예치금 차감액 기준
  const r = getRow(key, o.stores?.short_name || o.stores?.name || key, o.stores?.business_number, o.stores?.owner_name, '가맹점', '예치금');
  r.orderCnt++;
  for (const it of o.order_items) {
    if (it.is_tax_free) { r.taxFree += it.subtotal; continue; }
    const supply = it.unit_price * it.quantity;
    r.supply += supply;
    r.vatItems += (it.unit_price_with_tax - it.unit_price) * it.quantity;
    r.vatStmt += Math.floor(supply * 0.1);
  }
}
for (const o of b2b) {
  const c = o.b2b_customers;
  const key = `b2b:${c?.name || o.order_number}`;
  // 선입금 거래처는 예치금 차감, 후불 거래처는 거래명세서로 결제받음
  const basis = isPrepaid.get(c?.name) ? '예치금' : '명세서';
  const r = getRow(key, c?.name || 'B2B', c?.business_number, '', 'B2B', basis);
  r.orderCnt++;
  for (const it of o.b2b_order_items) {
    if (it.is_tax_free) { r.taxFree += it.subtotal; continue; }
    // 공급가액은 DB 기록값(subtotal_ex_tax, 없으면 단가×수량)을 그대로 사용.
    // 세포함에서 ÷1.1 로 역산하면 낱팩 단가 반올림 때문에 몇 원 어긋난다.
    const supply = it.subtotal_ex_tax ?? (it.unit_price != null ? it.unit_price * it.quantity : Math.round(it.subtotal / 1.1));
    r.supply += supply;
    r.vatItems += it.subtotal - supply;
    r.vatStmt += Math.floor(supply * 0.1);
  }
}
// 권장 세액 — 기준에 따라 결정
const recVat = (r) => r.basis === '명세서' ? r.vatStmt : r.vatItems;

// ── 수기 추가분 (택배 발송 등 시스템 밖 거래) ──
const manualPath = join(projectRoot, '마감', arg, '수기추가분.json');
let manualList = [];
if (existsSync(manualPath)) {
  try { manualList = JSON.parse(readFileSync(manualPath, 'utf-8')); }
  catch (e) { console.error(`⚠️ 수기추가분.json 읽기 실패: ${e.message}`); }
}
const manualUnmatched = [];
for (const m of manualList) {
  const amt = Number(m['세포함금액']) || 0;
  const isTaxed = m['과세'] !== false;
  const supply = isTaxed ? Math.round(amt / 1.1) : 0;
  const vat = isTaxed ? amt - supply : 0;
  const entry = { ...m, amt, supply, vat, isTaxed };
  const target = [...rows.values()].find(r => r.name === m['대상']);
  if (target) {
    target.manual.push(entry);
    if (isTaxed) { target.supply += supply; target.vatItems += vat; target.vatStmt += Math.floor(supply * 0.1); }
    else target.taxFree += amt;
  } else {
    manualUnmatched.push(entry);
  }
}

const out = [];
const say = (s = '') => out.push(s);

say(`# ${label} 세금계산서 발행 집계 (산방에프앤비 → 각 매장·거래처)`);
say('');
say(`- 대상: **${START} ~ ${END}** · 출고일(ship_date) 기준 · 확정+출고완료 주문`);
say(`- 방법: 읽기전용 스크립트 \`scripts/closing-tax-invoice-monthly-readonly.mjs ${arg}\` — SELECT만 수행, DB 변경 없음`);
say(`- **직영점(대한상공회의소점)은 내부거래라 계산서 발행 대상이 아닙니다.**`);
say(`- **권장 세액 = 품목별 부가세 합계**(= 매장이 실제 결제한 금액과 일치). 홈택스 자동계산값도 함께 표기합니다.`);
say('');
say(`> ⛔ **수기 추가분은 시스템(DB)에 반영하지 않습니다.** 주문·예치금 어디에도 넣지 않고,`);
say(`> 이 문서에서만 합산해 **계산서 발행할 때 내부적으로 더하는 용도**입니다.`);
say(`> 따라서 정산검증·예치금 md의 매출·잔액 숫자와는 이 금액만큼 차이가 나는 것이 정상입니다.`);
say('');

// ── 메인 표 ──
say('## 1. 발행 대상 (매장·거래처별)');
say('');
say('| 대상 | 사업자번호 | 대표 | 채널 | 결제방식 | 과세 공급가액 | **세액** | 면세 | **발행 합계** |');
say('|---|---|---|---|---|---:|---:|---:|---:|');
let tSupply = 0, tVat = 0, tFree = 0;
const sorted = [...rows.values()].sort((a, b) => (b.supply + b.taxFree) - (a.supply + a.taxFree));
for (const r of sorted) {
  const vat = recVat(r);
  tSupply += r.supply; tVat += vat; tFree += r.taxFree;
  const bizWarn = r.biz ? r.biz : '⚠️ 미등록';
  say(`| ${r.name}${r.manual.length ? ' *' : ''} | ${bizWarn} | ${r.owner || '-'} | ${r.channel} | ${r.basis} | ${f(r.supply)} | **${f(vat)}** | ${f(r.taxFree)} | **${f(r.supply + vat + r.taxFree)}** |`);
}
say(`| **합계** | | | | | **${f(tSupply)}** | **${f(tVat)}** | **${f(tFree)}** | **${f(tSupply + tVat + tFree)}** |`);
say('');
if (sorted.some(r => r.manual.length)) say('`*` 표시 = 시스템 주문 외 수기 추가분이 합산된 대상 (아래 2번 참고)');
say('');
say('**세액을 어느 기준으로 잡았나 — 실제로 돈이 오간 방식에 맞췄습니다.**');
say('');
say('| 결제방식 | 대상 | 세액 계산 | 이유 |');
say('|---|---|---|---|');
say('| 예치금 | 가맹점 · 선입금 B2B | 품목 세포함 합계 − 공급가액 | 예치금에서 **세포함 금액이 그대로** 빠져나갔으므로 그 금액이 실제 결제액 |');
say('| 명세서 | 후불 B2B | Σ(품목별 공급가 × 10%, 원단위 절사) | 거래명세서로 청구·결제하므로 **명세서 금액**이 실제 받을 돈 |');
say('');
say('> 낱팩(팩) 단가는 박스가를 팩 수로 나눠 반올림하기 때문에, 두 방식이 몇 원 차이납니다.');
say('> 위 표는 **각 거래처가 실제로 낸(낼) 돈**에 맞춰져 있습니다.');
say('');
say(`> (참고) 직영점 출고분 — 과세 공급가 ${f(directSupply)}원 / 부가세 ${f(directVat)}원 / 면세 ${f(directTaxFree)}원. **계산서 발행 대상 아님.**`);
say('');

// ── 수기 추가분 ──
say('## 2. 시스템 주문 외 수기 추가분 (택배 발송 등)');
say('');
const anyManual = manualList.length > 0;
if (!anyManual) {
  say(`\`마감/${arg}/수기추가분.json\` 이 없거나 비어 있습니다. 해당 없음.`);
} else {
  say('시스템에 주문이 없어 매출·예치금에 잡히지 않은 거래입니다. **계산서에는 반드시 포함해야 합니다.**');
  say('');
  say('| 대상 | 일자 | 내용 | 세포함 금액 | 공급가액 | 부가세 | 비고 |');
  say('|---|---|---|---:|---:|---:|---|');
  for (const r of sorted) {
    for (const m of r.manual) {
      say(`| ${r.name} | ${m['일자'] || '(미확인)'} | ${m['내용'] || ''} | ${f(m.amt)} | ${f(m.supply)} | ${f(m.vat)} | ${m['비고'] || ''} |`);
    }
  }
  for (const m of manualUnmatched) {
    say(`| ⚠️ ${m['대상']} (당월 주문 없음) | ${m['일자'] || '(미확인)'} | ${m['내용'] || ''} | ${f(m.amt)} | ${f(m.supply)} | ${f(m.vat)} | ${m['비고'] || ''} |`);
  }
  const mSum = manualList.reduce((s, m) => s + (Number(m['세포함금액']) || 0), 0);
  say(`| **합계** | | | **${f(mSum)}** | | | |`);
  say('');
  if (manualUnmatched.length) {
    say(`> ⚠️ ${manualUnmatched.length}건은 당월 시스템 주문이 없는 대상이라 위 1번 표에 합산되지 않았습니다. 별도로 계산서를 발행하세요.`);
    say('');
  }
}
say('');

// ── 시스템 표시값과 홈택스 세액 차이 ──
say('## 3. 세액 끝수 차이 (참고)');
say('');
const diffs = sorted.map(r => ({ r, diff: r.vatStmt - r.vatItems })).filter(x => x.diff !== 0);
if (!diffs.length) {
  say('차이 없음 — 두 방식의 세액이 모두 같습니다. (낱팩 품목이 없는 달)');
} else {
  say('낱팩 단가 반올림 때문에 두 계산 방식이 몇 원 다릅니다. 위 1번 표는 **결제방식에 맞는 쪽**을 이미 골라 넣었습니다.');
  say('');
  say('| 대상 | 결제방식 | 공급가액 | 예치금 기준 세액 | 명세서 기준 세액 | 차이 | **채택** |');
  say('|---|---|---:|---:|---:|---:|---|');
  for (const x of diffs) {
    say(`| ${x.r.name} | ${x.r.basis} | ${f(x.r.supply)} | ${f(x.r.vatItems)} | ${f(x.r.vatStmt)} | ${x.diff > 0 ? '+' : ''}${f(x.diff)} | **${x.r.basis === '명세서' ? f(x.r.vatStmt) : f(x.r.vatItems)}** |`);
  }
  say('');
  say('- **왜 생기나**: 낱팩 단가는 박스가를 팩 수로 나눠 **원 단위로 반올림**합니다.');
  say('  (예: 비빔전용장 박스 공급가 120,880 ÷ 5팩 = 24,176원)');
  say('  그래서 「팩 세포함 단가 × 수량」과 「공급가액 × 10%」가 몇 원 어긋납니다.');
  say('- **가맹점·선입금 B2B**는 예치금에서 세포함 금액이 그대로 빠졌으니 그 금액이 맞습니다.');
  say('- **후불 B2B**는 거래명세서로 청구했으니 명세서 금액이 맞습니다.');
  say('- 홈택스 전자세금계산서는 **세액을 직접 입력·수정할 수 있으므로**, 자동계산값이 달라도 위 채택값을 넣으면 됩니다.');
  say('');
  say(`> ⚠️ 가맹점에도 별도 거래명세서를 발행하고 계시다면, 그 명세서 금액과 예치금 차감액이`);
  say(`> 몇 원 다를 수 있습니다. 명세서를 쓰신다면 위 「명세서 기준 세액」 쪽으로 맞추세요.`);
}
say('');

// ── 사업자번호 누락 ──
const noBiz = sorted.filter(r => !r.biz);
say('## 4. 발행 전 확인');
say('');
if (noBiz.length) {
  say(`- ⚠️ **사업자번호 미등록 ${noBiz.length}곳**: ${noBiz.map(r => r.name).join(', ')} → 발행 전 등록 필요`);
} else {
  say('- ✅ 발행 대상 전원 사업자번호 등록되어 있습니다.');
}
say(`- 발행 건수: **${sorted.length}건** (가맹점 ${sorted.filter(r => r.channel === '가맹점').length} + B2B ${sorted.filter(r => r.channel === 'B2B').length})`);
say(`- 총 공급가액 **${f(tSupply)}원** + 세액 **${f(tVat)}원**${tFree ? ` + 면세 ${f(tFree)}원` : ''} = **${f(tSupply + tVat + tFree)}원**`);
say('');
say('---');
say('');
say('## 발행 체크리스트');
say('');
for (const r of sorted) {
  const vat = recVat(r);
  say(`- [ ] **${r.name}** (${r.biz || '⚠️사업자번호 확인필요'}) — 공급가 **${f(r.supply)}** / 세액 **${f(vat)}**${r.taxFree ? ` / 면세 ${f(r.taxFree)}` : ''} → 합계 **${f(r.supply + vat + r.taxFree)}원**`);
}
for (const m of manualUnmatched) {
  say(`- [ ] **${m['대상']}** — 공급가 ${f(m.supply)} / 세액 ${f(m.vat)} (수기 추가분 단독)`);
}
say('');

const outDir = join(projectRoot, '마감', arg);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `세금계산서_${arg}.md`), out.join('\n'), 'utf-8');

console.log('');
console.log(out.join('\n'));
console.log('');
console.log(`📄 저장 완료: 마감/${arg}/세금계산서_${arg}.md`);
