// READ-ONLY — 월별 정산 전반 검증 (손익·매출·매입·신화정산·부가세·예치금 정합성).
// SELECT만 수행. DB 변경 없음. (로컬 마감 폴더에 md 파일만 생성)
//
// 사용법:  node scripts/closing-audit-monthly-readonly.mjs 2026-07
//
// 산출물: 마감/<YYYY-MM>/정산검증_<YYYY-MM>.md
//
// 손익·신화정산 로직은 정산 페이지(src/app/(dashboard)/settlement/page.tsx)와 동일하게 재현.
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
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const arg = process.argv[2];
if (!/^\d{4}-\d{2}$/.test(arg || '')) {
  console.error('사용법: node scripts/closing-audit-monthly-readonly.mjs 2026-07');
  process.exit(1);
}
const [Y, M] = arg.split('-').map(Number);
const mStart = `${arg}-01`;
const mEnd = new Date(Date.UTC(Y, M, 0)).toISOString().slice(0, 10);
const label = `${Y}년 ${M}월`;

const f = (n) => Math.round(n ?? 0).toLocaleString('ko-KR');
const kst = (iso) => iso ? new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16) : '';
const kstDate = (iso) => iso ? new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 10) : '';
const inMonthKST = (iso) => { const d = kstDate(iso); return d >= mStart && d <= mEnd; };
const shipInMonth = (d) => !!d && d >= mStart && d <= mEnd;

async function fetchAll(table, select, applyFilters) {
  const rows = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    let q = supabase.from(table).select(select).range(from, from + page - 1);
    if (applyFilters) q = applyFilters(q);
    const { data, error } = await q;
    if (error) { console.error(`[${table}] 조회 오류:`, error.message); process.exit(1); }
    rows.push(...data);
    if (data.length < page) break;
  }
  return rows;
}

console.log(`${label} 정산 검증 — 데이터 조회 중...`);

const stores = await fetchAll('stores', 'id, name, short_name, is_direct, region, deposit_balance');
const products = await fetchAll('products', 'id, name, product_type, pack_per_box, price_with_tax, sanbang_food_sale_price_with_tax, cost_price_with_tax');
const orders = await fetchAll('orders',
  'id, order_number, store_id, status, total_amount, ship_date, created_at, order_items(product_id, product_name, product_type, quantity, unit, unit_price, unit_price_with_tax, is_tax_free, subtotal)',
  q => q.order('created_at'));
const depTx = await fetchAll('deposit_transactions', '*', q => q.order('created_at'));
const depReq = await fetchAll('deposit_requests', '*', q => q.order('created_at'));
const b2bCustomers = await fetchAll('b2b_customers', 'id, name, region, is_prepaid, deposit_balance');
const b2bOrders = await fetchAll('b2b_orders',
  'id, order_number, b2b_customer_id, status, total_amount, ship_date, created_at, b2b_order_items(product_name, unit, quantity, pack_per_box, unit_price_with_tax, subtotal)',
  q => q.order('created_at'));
const b2bDepTx = await fetchAll('b2b_deposit_transactions', '*', q => q.order('created_at'));
const b2bDepReq = await fetchAll('b2b_deposit_requests', '*', q => q.order('created_at'));

const storeById = new Map(stores.map(s => [s.id, s]));
const storeName = (id) => { const s = storeById.get(id); return s ? (s.short_name || s.name) : `매장:${String(id).slice(0, 8)}`; };
const productById = new Map(products.map(p => [p.id, p]));
const productByName = new Map(products.filter(p => p.product_type === 'exclusive').map(p => [p.name, p]));
const b2bCustById = new Map(b2bCustomers.map(c => [c.id, c]));

const SHINWA_FEE_RATE = { jeju: 0.125, seoul: 0.085 };
const GENERAL_SUPPLY_RATE = 0.97;
const ACTIVE = new Set(['confirmed', 'shipped']);

const out = [];
const say = (s = '') => out.push(s);

say(`# ${label} 정산 검증 보고 (마감)`);
say('');
say(`- 대상: **${mStart} ~ ${mEnd}** (출고일 기준 / 예치금은 승인일 KST 기준)`);
say(`- 방법: 읽기전용 스크립트 \`scripts/closing-audit-monthly-readonly.mjs ${arg}\` — SELECT만 수행, DB 변경 없음`);
say(`- 손익·신화정산 계산식은 정산 페이지(\`settlement/page.tsx\`)와 **동일 로직으로 재현**했습니다.`);
say(`- 모든 금액은 **부가세 포함**입니다(부가세 표는 예외 — 공급가/부가세 분리 표기).`);
say('');

// ================================================================
// PART A. 매출
// ================================================================
const mo = orders.filter(o => ACTIVE.has(o.status) && shipInMonth(o.ship_date));
const mb = b2bOrders.filter(o => ACTIVE.has(o.status) && shipInMonth(o.ship_date));

const storeSales = new Map();
let directExclusive = 0, directGeneral = 0;
for (const o of mo) {
  const st = storeById.get(o.store_id);
  const isDirect = st?.is_direct || false;
  for (const it of o.order_items) {
    if (isDirect) {
      if (it.product_type === 'exclusive') directExclusive += it.subtotal; else directGeneral += it.subtotal;
      continue;
    }
    let r = storeSales.get(o.store_id);
    if (!r) { r = { name: storeName(o.store_id), exclusive: 0, general: 0, total: 0, taxBase: 0, tax: 0, taxFree: 0 }; storeSales.set(o.store_id, r); }
    if (it.product_type === 'exclusive') r.exclusive += it.subtotal; else r.general += it.subtotal;
    r.total += it.subtotal;
    if (it.is_tax_free) r.taxFree += it.subtotal;
    else { r.taxBase += it.unit_price * it.quantity; r.tax += (it.unit_price_with_tax - it.unit_price) * it.quantity; }
  }
}
const b2bByCust = new Map();
for (const o of mb) {
  const name = b2bCustById.get(o.b2b_customer_id)?.name || 'B2B';
  let r = b2bByCust.get(name);
  if (!r) { r = { total: 0, cnt: 0 }; b2bByCust.set(name, r); }
  r.total += o.b2b_order_items.reduce((s, i) => s + i.subtotal, 0);
  r.cnt++;
}
const storeRevenue = [...storeSales.values()].reduce((s, r) => s + r.total, 0);
const b2bRevenue = [...b2bByCust.values()].reduce((s, r) => s + r.total, 0);
const revenue = storeRevenue + b2bRevenue;

say('## A. 매출 (직영점 제외 — 산방에프앤비 매출)');
say('');
say('| 매장 | 전용상품 | 범용상품 | 총 매출 |');
say('|---|---:|---:|---:|');
for (const r of [...storeSales.values()].sort((a, b) => b.total - a.total)) {
  say(`| ${r.name} | ${f(r.exclusive)} | ${f(r.general)} | ${f(r.total)} |`);
}
for (const [name, r] of b2bByCust) say(`| B2B·${name} (${r.cnt}건) | ${f(r.total)} | 0 | ${f(r.total)} |`);
say(`| **합계** | | | **${f(revenue)}** |`);
say('');
say(`- 가맹점 ${f(storeRevenue)}원 + B2B ${f(b2bRevenue)}원 = **${f(revenue)}원**`);
say(`- (참고) 직영점(상공회의소점) 출고분 — 전용 ${f(directExclusive)}원 / 범용 ${f(directGeneral)}원 → **내부거래로 매출에 넣지 않음**`);
say('');

// 부가세 구성
say('### A-2. 부가세 구성 (가맹점, 직영 제외)');
say('');
say('| 매장 | 과세 공급가 | 부가세 | 과세 합계 | 면세 합계 | 총 매출 |');
say('|---|---:|---:|---:|---:|---:|');
let tB = 0, tT = 0, tF = 0;
for (const r of [...storeSales.values()].sort((a, b) => b.total - a.total)) {
  tB += r.taxBase; tT += r.tax; tF += r.taxFree;
  say(`| ${r.name} | ${f(r.taxBase)} | ${f(r.tax)} | ${f(r.taxBase + r.tax)} | ${f(r.taxFree)} | ${f(r.total)} |`);
}
say(`| **합계** | **${f(tB)}** | **${f(tT)}** | **${f(tB + tT)}** | **${f(tF)}** | **${f(tB + tT + tF)}** |`);
say('');
const taxSumCheck = Math.abs((tB + tT + tF) - storeRevenue) < 1;
say(`- 검산: 과세합계+면세합계 = ${f(tB + tT + tF)}원 ${taxSumCheck ? '= 가맹 매출 합계 ✅' : `≠ 가맹 매출 ${f(storeRevenue)}원 ⚠️`}`);
say('');

// ================================================================
// PART B. 매입원가 + 신화 정산 + 영업이익
// ================================================================
let exclusiveCogs = 0;
const cogsMissing = [];
for (const o of mo) {
  if (storeById.get(o.store_id)?.is_direct) continue;
  for (const it of o.order_items) {
    if (it.product_type !== 'exclusive' || !it.product_id) continue;
    const p = productById.get(it.product_id);
    if (!p) { cogsMissing.push(`${o.order_number}/${it.product_name}`); continue; }
    const ppb = p.pack_per_box || 1;
    const boxPrice = p.sanbang_food_sale_price_with_tax || 0;
    const packPrice = ppb > 1 ? Math.round(boxPrice / ppb) : boxPrice;
    exclusiveCogs += it.quantity * (it.unit === 'pack' ? packPrice : boxPrice);
  }
}
for (const o of mb) {
  for (const it of o.b2b_order_items) {
    const p = productByName.get(it.product_name);
    if (!p) { cogsMissing.push(`${o.order_number}/${it.product_name}(B2B)`); continue; }
    const ppb = p.pack_per_box || 1;
    const boxPrice = p.sanbang_food_sale_price_with_tax || 0;
    const packPrice = ppb > 1 ? Math.round(boxPrice / ppb) : boxPrice;
    exclusiveCogs += it.quantity * (it.unit === 'pack' ? packPrice : boxPrice);
  }
}

const shinwa = new Map();
for (const o of mo) {
  const st = storeById.get(o.store_id);
  const region = st?.region || 'jeju';
  const key = `store:${o.store_id}`;
  let r = shinwa.get(key);
  if (!r) r = shinwa.set(key, { name: storeName(o.store_id), region, feeRate: SHINWA_FEE_RATE[region], exclusiveFeeBase: 0, generalSales: 0, isDirect: st?.is_direct || false }).get(key);
  for (const it of o.order_items) {
    if (it.product_type === 'exclusive') r.exclusiveFeeBase += it.subtotal;
    else r.generalSales += it.subtotal;
  }
}
for (const o of mb) {
  const cust = b2bCustById.get(o.b2b_customer_id);
  const region = cust?.region || 'seoul';
  const key = `b2b:${o.b2b_customer_id}`;
  let r = shinwa.get(key);
  if (!r) r = shinwa.set(key, { name: `B2B·${cust?.name || 'B2B'}`, region, feeRate: SHINWA_FEE_RATE[region], exclusiveFeeBase: 0, generalSales: 0, isDirect: false }).get(key);
  for (const it of o.b2b_order_items) {
    const p = productByName.get(it.product_name);
    if (!p) continue;
    const ppb = p.pack_per_box || 1;
    const boxPrice = p.price_with_tax;
    const packPrice = ppb > 1 ? Math.round(boxPrice / ppb) : boxPrice;
    r.exclusiveFeeBase += it.quantity * (it.unit === 'pack' ? packPrice : boxPrice);
  }
}
let shinwaFee = 0, shinwaFeeDirect = 0, generalSupply = 0, generalSales = 0;
shinwa.forEach(r => {
  r.fee = Math.round(r.exclusiveFeeBase * r.feeRate);
  r.supply = Math.round(r.generalSales * GENERAL_SUPPLY_RATE);
  shinwaFee += r.fee;
  if (r.isDirect) shinwaFeeDirect += r.fee;
  generalSupply += r.supply;
  generalSales += r.generalSales;
});

const costs = exclusiveCogs + shinwaFee + generalSupply;
const profit = revenue - costs;

say('## B. 신화푸드 정산 (전용 배송수수료 + 범용 공급대금)');
say('');
say('| 매장/거래처 | 권역 | 수수료율 | 전용 수수료 베이스 | 전용 수수료 | 범용 매출 | 범용 공급대금(97%) | 신화 지급계 |');
say('|---|---|---:|---:|---:|---:|---:|---:|');
for (const r of [...shinwa.values()].sort((a, b) => (b.fee + b.supply) - (a.fee + a.supply))) {
  say(`| ${r.name}${r.isDirect ? ' *(직영)*' : ''} | ${r.region === 'jeju' ? '제주' : '육지'} | ${(r.feeRate * 100).toFixed(1)}% | ${f(r.exclusiveFeeBase)} | ${f(r.fee)} | ${f(r.generalSales)} | ${f(r.supply)} | ${f(r.fee + r.supply)} |`);
}
say(`| **합계** | | | | **${f(shinwaFee)}** | **${f(generalSales)}** | **${f(generalSupply)}** | **${f(shinwaFee + generalSupply)}** |`);
say('');
say(`- 직영점(상공회의소점) 몫 수수료 **${f(shinwaFeeDirect)}원**은 매출이 없는데도 산방에프앤비가 부담합니다.`);
say(`- 범용 마진: ${f(generalSales)} − ${f(generalSupply)} = **${f(generalSales - generalSupply)}원** (3%)`);
say('');

say('## C. 영업이익');
say('');
say('| 항목 | 금액(원) |');
say('|---|---:|');
say(`| 매출 (가맹 + B2B) | ${f(revenue)} |`);
say(`| − 전용상품 매입원가 (산방푸드 공급대금, 출고분) | -${f(exclusiveCogs)} |`);
say(`| − 신화푸드 전용 배송수수료 | -${f(shinwaFee)} |`);
say(`| − 신화푸드 범용 공급대금(97%) | -${f(generalSupply)} |`);
say(`| **비용 합계** | **-${f(costs)}** |`);
say(`| **★ 영업이익** | **${f(profit)}** |`);
say(`| 이익률 | ${revenue > 0 ? (profit / revenue * 100).toFixed(1) : 0}% |`);
say('');
say('> 운영비(인건비·임차료 등)와 부가세 납부액은 포함되지 않은 **출고기준 매출총이익 성격**의 숫자입니다.');
if (cogsMissing.length) {
  say('');
  say(`> ⚠️ 원가 매핑 누락 ${cogsMissing.length}건: ${cogsMissing.join(', ')} — 원가가 0으로 잡혀 이익이 과대계상됩니다.`);
}
say('');

// ================================================================
// PART D. 예치금 요약
// ================================================================
const monthDeposits = depTx.filter(t => t.type === 'deposit' && inMonthKST(t.created_at));
const monthB2bDeposits = b2bDepTx.filter(t => t.type === 'deposit' && inMonthKST(t.created_at));
const chargeTotal = monthDeposits.reduce((s, t) => s + t.amount, 0) + monthB2bDeposits.reduce((s, t) => s + t.amount, 0);
const monthDeduct = [...depTx, ...b2bDepTx].filter(t => (t.type === 'order_deduct' || t.type === 'order_refund') && inMonthKST(t.created_at));
const monthAdjust = [...depTx, ...b2bDepTx].filter(t => (t.type === 'adjustment' || t.type === 'withdrawal') && inMonthKST(t.created_at));

say('## D. 예치금 요약');
say('');
say('| 항목 | 건수 | 금액(원) |');
say('|---|---:|---:|');
say(`| 충전(입금) | ${monthDeposits.length + monthB2bDeposits.length} | ${f(chargeTotal)} |`);
say(`| 발주 차감·환불 | ${monthDeduct.length} | ${f(monthDeduct.reduce((s, t) => s + t.amount, 0))} |`);
say(`| 수동조정·출금 | ${monthAdjust.length} | ${f(monthAdjust.reduce((s, t) => s + t.amount, 0))} |`);
say('');
say(`- 상세는 [예치금_충전내역_${arg}.md](예치금_충전내역_${arg}.md) 참고.`);
say('');
// 예치금 차감 합계 vs 주문 매출 대조 (직영 제외, 당월 주문일 기준이 아니라 차감 발생 기준)
say(`- 참고: 당월 발주 차감·환불 순액 ${f(monthDeduct.reduce((s, t) => s + t.amount, 0))}원 vs 당월 출고 매출 ${f(revenue)}원 — 차감은 **주문 시점**, 매출은 **출고 시점** 기준이라 월별로 차이가 납니다(정상).`);
say('');

// ================================================================
// PART E. 정합성 점검
// ================================================================
const issues = [];
const checks = [];

// E-1. 예치금 원장 체인 (전 기간)
{
  const txByStore = new Map();
  for (const t of depTx) {
    if (!txByStore.has(t.store_id)) txByStore.set(t.store_id, []);
    txByStore.get(t.store_id).push(t);
  }
  for (const [sid, txs] of txByStore) {
    txs.sort((a, b) => a.created_at.localeCompare(b.created_at));
    let prev = null;
    for (const t of txs) {
      if (prev !== null && prev + t.amount !== t.balance_after) {
        issues.push(`[원장체인] ${storeName(sid)} ${kst(t.created_at)} ${t.type} ${f(t.amount)}원: 직전잔액 ${f(prev)} + 금액 = ${f(prev + t.amount)} 이어야 하나 기록 ${f(t.balance_after)} (차이 ${f(t.balance_after - prev - t.amount)})`);
      }
      prev = t.balance_after;
    }
    const cur = storeById.get(sid)?.deposit_balance;
    if (prev !== null && cur !== undefined && prev !== cur) {
      issues.push(`[잔액불일치] ${storeName(sid)}: 원장 마지막 잔액 ${f(prev)}원 ≠ 현재 잔액 ${f(cur)}원 (차이 ${f(cur - prev)})`);
    }
  }
  checks.push(`E-1. 예치금 원장 사슬 재계산 — 매장 ${txByStore.size}곳 / 거래 ${depTx.length}건 (전 기간)`);
}

// E-2. 주문 ↔ 예치금 차감 대조 (당월 주문)
{
  const txByOrder = new Map();
  for (const t of depTx) {
    if (!t.order_id) continue;
    if (!txByOrder.has(t.order_id)) txByOrder.set(t.order_id, []);
    txByOrder.get(t.order_id).push(t);
  }
  let n = 0;
  for (const o of orders) {
    const st = storeById.get(o.store_id);
    if (!st || st.is_direct) continue;
    const basis = o.ship_date || kstDate(o.created_at);
    if (basis < mStart || basis > mEnd) continue;
    n++;
    const txs = txByOrder.get(o.id) || [];
    const sum = txs.reduce((s, t) => s + t.amount, 0);
    const expected = o.status === 'cancelled' ? 0 : -o.total_amount;
    if (sum !== expected) {
      issues.push(`[차감불일치] ${o.order_number} [${o.status}] ${storeName(o.store_id)} 주문액 ${f(o.total_amount)}원: 예치금 거래 합계 ${f(sum)}원 (기대 ${f(expected)}원, 거래 ${txs.length}건)`);
    }
    const deducts = txs.filter(t => t.type === 'order_deduct');
    if (o.status !== 'cancelled' && deducts.length > 1) {
      issues.push(`[중복차감의심] ${o.order_number} ${storeName(o.store_id)}: order_deduct ${deducts.length}건`);
    }
  }
  for (const [oid, txs] of txByOrder) {
    if (!orders.find(o => o.id === oid)) {
      issues.push(`[고아거래] 존재하지 않는 주문(${oid.slice(0, 8)})에 연결된 예치금 거래 ${txs.length}건, 합계 ${f(txs.reduce((s, t) => s + t.amount, 0))}원`);
    }
  }
  checks.push(`E-2. 주문 ↔ 예치금 차감/환불 대조 — 당월 비직영 주문 ${n}건`);
}

// E-3. 승인 충전요청 ↔ 입금거래 대조 (당월)
{
  const depositTxs = depTx.filter(t => t.type === 'deposit');
  const used = new Set();
  const approved = depReq.filter(r => r.status === 'approved' && inMonthKST(r.reviewed_at || r.created_at));
  for (const r of approved) {
    const match = depositTxs.find(t =>
      !used.has(t.id) && t.store_id === r.store_id && t.amount === r.amount &&
      Math.abs(new Date(t.created_at) - new Date(r.reviewed_at || r.created_at)) < 1000 * 60 * 60 * 24);
    if (match) used.add(match.id);
    else issues.push(`[충전요청 미반영] ${storeName(r.store_id)} ${f(r.amount)}원 요청(${kst(r.created_at)}) 승인됐으나 일치하는 입금거래 없음`);
  }
  const orphanTx = monthDeposits.filter(t => !used.has(t.id));
  for (const t of orphanTx) {
    issues.push(`[요청없는 충전] ${storeName(t.store_id)} ${f(t.amount)}원 (${kst(t.created_at)}) — 승인된 충전요청과 매칭되지 않음. 관리자 직접 충전 여부 확인 필요. 비고: ${t.description || '(없음)'}`);
  }
  const pending = [...depReq, ...b2bDepReq].filter(r => r.status === 'pending');
  if (pending.length) {
    for (const r of pending) {
      const who = r.store_id ? storeName(r.store_id) : (b2bCustById.get(r.b2b_customer_id)?.name || 'B2B');
      issues.push(`[미처리 충전요청] ${who} ${f(r.amount)}원 (${kst(r.created_at)}) — 아직 승인/반려되지 않음`);
    }
  }
  checks.push(`E-3. 승인 충전요청 ↔ 입금거래 대조 — 당월 승인 ${approved.length}건 / 당월 충전 ${monthDeposits.length}건`);
}

// E-4. 주문금액 vs 품목합계 (당월)
{
  let n = 0;
  for (const o of orders) {
    if (!shipInMonth(o.ship_date)) continue;
    n++;
    const itemsSum = o.order_items.reduce((s, it) => s + it.subtotal, 0);
    if (o.total_amount !== itemsSum) {
      issues.push(`[주문금액불일치] ${o.order_number} [${o.status}] ${storeName(o.store_id)}: 주문금액 ${f(o.total_amount)} ≠ 품목합계 ${f(itemsSum)} (차이 ${f(o.total_amount - itemsSum)})`);
    }
  }
  for (const o of b2bOrders) {
    if (!shipInMonth(o.ship_date)) continue;
    n++;
    const itemsSum = o.b2b_order_items.reduce((s, it) => s + it.subtotal, 0);
    if (o.total_amount !== itemsSum) {
      issues.push(`[B2B주문금액불일치] ${o.order_number} [${o.status}]: 주문금액 ${f(o.total_amount)} ≠ 품목합계 ${f(itemsSum)}`);
    }
  }
  checks.push(`E-4. 주문금액 vs 품목합계 — 당월 출고 주문 ${n}건`);
}

// E-5. 품목 단가/부가세 정합성 (당월 출고)
{
  let n = 0;
  for (const o of orders) {
    if (!ACTIVE.has(o.status) || !shipInMonth(o.ship_date)) continue;
    for (const it of o.order_items) {
      n++;
      if (it.subtotal !== it.unit_price_with_tax * it.quantity) {
        issues.push(`[소계불일치] ${o.order_number}/${it.product_name}: 소계 ${f(it.subtotal)} ≠ 단가×수량 ${f(it.unit_price_with_tax * it.quantity)}`);
      }
      if (it.is_tax_free) {
        if (it.unit_price !== it.unit_price_with_tax) {
          issues.push(`[면세이상] ${o.order_number}/${it.product_name}: 면세인데 공급가 ${f(it.unit_price)} ≠ 세포함 ${f(it.unit_price_with_tax)}`);
        }
      } else {
        const tax = it.unit_price_with_tax - it.unit_price;
        if (tax === 0) issues.push(`[부가세0] ${o.order_number}/${it.product_name}: 과세인데 공급가 = 세포함가 ${f(it.unit_price)}`);
        else if (tax < 0) issues.push(`[부가세음수] ${o.order_number}/${it.product_name}`);
        else if (it.unit_price > 0) {
          const ratio = tax / it.unit_price;
          if (ratio < 0.08 || ratio > 0.12) issues.push(`[부가세율이상 ${(ratio * 100).toFixed(1)}%] ${o.order_number}/${it.product_name}`);
        }
      }
    }
  }
  checks.push(`E-5. 품목 단가·부가세 정합성 — 당월 출고 품목 ${n}줄`);
}

// E-6. B2B 예치금 원장
{
  const byCust = new Map();
  for (const t of b2bDepTx) {
    if (!byCust.has(t.b2b_customer_id)) byCust.set(t.b2b_customer_id, []);
    byCust.get(t.b2b_customer_id).push(t);
  }
  for (const [cid, txs] of byCust) {
    const cname = b2bCustById.get(cid)?.name || cid;
    txs.sort((a, b) => a.created_at.localeCompare(b.created_at));
    let prev = null;
    for (const t of txs) {
      if (prev !== null && prev + t.amount !== t.balance_after) {
        issues.push(`[B2B원장체인] ${cname} ${kst(t.created_at)} ${t.type}: 기대 ${f(prev + t.amount)} vs 기록 ${f(t.balance_after)}`);
      }
      prev = t.balance_after;
    }
    const cur = b2bCustById.get(cid)?.deposit_balance;
    if (prev !== null && cur !== undefined && prev !== cur) {
      issues.push(`[B2B잔액불일치] ${cname}: 원장 마지막 ${f(prev)}원 ≠ 현재 잔액 ${f(cur)}원`);
    }
  }
  checks.push(`E-6. B2B 예치금 원장 재계산 — 거래처 ${byCust.size}곳 / 거래 ${b2bDepTx.length}건 (전 기간)`);
}

// E-7. 잔액 스냅샷 + 음수/정산 누락 상태
const negatives = [];
{
  for (const s of stores.filter(s => !s.is_direct)) {
    if (s.deposit_balance < 0) { negatives.push(s); issues.push(`[음수잔액] ${s.short_name || s.name}: ${f(s.deposit_balance)}원`); }
  }
  const weird = orders.filter(o => !['confirmed', 'shipped', 'cancelled'].includes(o.status) && shipInMonth(o.ship_date));
  for (const o of weird) {
    issues.push(`[정산 미포함 상태] ${o.order_number} [${o.status}] ${storeName(o.store_id)} ${f(o.total_amount)}원 (출고일 ${o.ship_date}) — 출고일이 있는데 확정/출고 상태가 아니라 매출에 안 잡힘`);
  }
  const noShip = orders.filter(o => ACTIVE.has(o.status) && !o.ship_date && inMonthKST(o.created_at));
  for (const o of noShip) {
    issues.push(`[출고일 없음] ${o.order_number} [${o.status}] ${storeName(o.store_id)} ${f(o.total_amount)}원 (주문일 ${kstDate(o.created_at)}) — 출고일이 비어 매출 월 귀속이 안 됨`);
  }
  checks.push(`E-7. 잔액 스냅샷 · 정산 누락 상태 주문 점검`);
}

say('## E. 정합성 점검');
say('');
say('점검 항목:');
say('');
for (const c of checks) say(`- ${c}`);
say('');
if (issues.length === 0) {
  say('### ✅ 결과: 발견된 오류 없음');
  say('');
  say('예치금 원장 사슬, 주문 차감·환불, 충전요청 반영, 주문금액-품목합계, 단가·부가세, B2B 원장까지 **모두 일치**합니다.');
} else {
  say(`### ⚠️ 결과: 확인 필요 ${issues.length}건`);
  say('');
  issues.forEach((s, i) => say(`${i + 1}. ${s}`));
}
say('');

// 잔액 스냅샷
say('### 현재 예치금 잔액 (조회 시점)');
say('');
say('| 매장/거래처 | 현재 잔액(원) |');
say('|---|---:|');
for (const s of stores.filter(s => !s.is_direct).sort((a, b) => (a.short_name || a.name).localeCompare(b.short_name || b.name, 'ko'))) {
  say(`| ${s.short_name || s.name} | ${f(s.deposit_balance)}${s.deposit_balance < 0 ? ' ⚠️ 음수' : ''} |`);
}
for (const c of b2bCustomers.filter(c => c.is_prepaid)) say(`| [B2B] ${c.name} | ${f(c.deposit_balance)} |`);
say('');

// ================================================================
// 마감 판정
// ================================================================
say('## F. 마감 판정');
say('');
say('| 항목 | 값 |');
say('|---|---:|');
say(`| 매출 (직영 제외) | ${f(revenue)}원 |`);
say(`| 영업이익 | ${f(profit)}원 (${revenue > 0 ? (profit / revenue * 100).toFixed(1) : 0}%) |`);
say(`| 산방푸드 지급 (전용 매입원가) | ${f(exclusiveCogs)}원 |`);
say(`| 신화푸드 지급 (수수료+공급대금) | ${f(shinwaFee + generalSupply)}원 |`);
say(`| 예치금 충전 (통장 대사 대상) | ${f(chargeTotal)}원 |`);
say(`| 정합성 오류 | ${issues.length === 0 ? '**0건** ✅' : `**${issues.length}건** ⚠️`} |`);
say('');
say('---');
say('');
say('### 사장님 엑셀과 대조할 때 보는 숫자');
say('');
say(`1. **매출**: ${f(revenue)}원 — 직영점(상공회의소점) 출고분은 빠져 있습니다.`);
say(`2. **부가세**: 과세 공급가 ${f(tB)}원 / 부가세 ${f(tT)}원 / 면세 ${f(tF)}원`);
say(`3. **산방푸드 매입**: ${f(exclusiveCogs)}원 (출고기준. 입고기준 세금계산서와는 시점 차이가 날 수 있음)`);
say(`4. **신화푸드 지급**: ${f(shinwaFee + generalSupply)}원 (전용 수수료 ${f(shinwaFee)} + 범용 공급대금 ${f(generalSupply)})`);
say(`5. **예치금 입금**: ${f(chargeTotal)}원 — 통장 입금 합계와 맞아야 합니다.`);
say('');

// 저장
const outDir = join(projectRoot, '마감', arg);
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `정산검증_${arg}.md`);
writeFileSync(outPath, out.join('\n'), 'utf-8');

console.log('');
console.log(out.join('\n'));
console.log('');
console.log(`📄 저장 완료: 마감/${arg}/정산검증_${arg}.md`);
