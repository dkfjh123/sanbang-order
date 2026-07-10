// READ-ONLY — 5·6월 산방에프앤비 손익 + 매장별 예치금 입금(통장 대사용) + 예치금/출고 정합성 점검.
// SELECT만 수행. 데이터 변경 없음.
// 손익 로직은 정산 페이지(src/app/(dashboard)/settlement/page.tsx) 6섹션과 동일하게 재현.
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(join(__dirname, '..', '.env.local'), 'utf-8');
const env = Object.fromEntries(
  envText.split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  })
);
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const f = (n) => Math.round(n ?? 0).toLocaleString('ko-KR');
const kst = (iso) => new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16);
const kstDate = (iso) => new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 10);

// 페이지네이션 fetch (supabase 기본 1000행 제한 대응)
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

// ============ 데이터 로드 (전체 — 원장 재계산은 처음부터 끝까지 필요) ============
const stores = await fetchAll('stores', 'id, name, short_name, is_direct, region, deposit_balance');
const products = await fetchAll('products', 'id, name, product_type, pack_per_box, price_with_tax, sanbang_food_sale_price_with_tax, cost_price_with_tax');
const orders = await fetchAll('orders', 'id, order_number, store_id, status, total_amount, ship_date, created_at, order_items(product_id, product_name, product_type, quantity, unit, unit_price, unit_price_with_tax, is_tax_free, subtotal)', q => q.order('created_at'));
const depTx = await fetchAll('deposit_transactions', '*', q => q.order('created_at'));
const depReq = await fetchAll('deposit_requests', '*', q => q.order('created_at'));
const b2bCustomers = await fetchAll('b2b_customers', 'id, name, region, is_prepaid, deposit_balance');
const b2bOrders = await fetchAll('b2b_orders', 'id, order_number, b2b_customer_id, status, total_amount, ship_date, created_at, b2b_order_items(product_name, unit, quantity, pack_per_box, unit_price_with_tax, subtotal)', q => q.order('created_at'));
const b2bDepTx = await fetchAll('b2b_deposit_transactions', '*', q => q.order('created_at'));
const b2bDepReq = await fetchAll('b2b_deposit_requests', '*', q => q.order('created_at'));

const storeById = new Map(stores.map(s => [s.id, s]));
const storeName = (id) => { const s = storeById.get(id); return s ? (s.short_name || s.name) : `매장:${id?.slice(0, 8)}`; };
const productById = new Map(products.map(p => [p.id, p]));
const productByName = new Map(products.filter(p => p.product_type === 'exclusive').map(p => [p.name, p]));
const b2bCustById = new Map(b2bCustomers.map(c => [c.id, c]));

const SHINWA_FEE_RATE = { jeju: 0.125, seoul: 0.085 };
const GENERAL_SUPPLY_RATE = 0.97;

const MONTHS = [
  { label: '2026년 5월', start: '2026-05-01', end: '2026-05-31' },
  { label: '2026년 6월', start: '2026-06-01', end: '2026-06-30' },
];
const inMonthKST = (iso, m) => { const d = kstDate(iso); return d >= m.start && d <= m.end; };

// ================================================================
// PART A — 월간 손익 (정산 페이지 6섹션 로직 재현, 출고일 기준)
// ================================================================
console.log('████████████████████████████████████████████████████████████████');
console.log('  PART A. 산방에프앤비 월간 손익 (출고일 기준, 정산 로직과 동일)');
console.log('████████████████████████████████████████████████████████████████');

for (const m of MONTHS) {
  const mo = orders.filter(o => ['confirmed', 'shipped'].includes(o.status) && o.ship_date && o.ship_date >= m.start && o.ship_date <= m.end);
  const mb = b2bOrders.filter(o => ['confirmed', 'shipped'].includes(o.status) && o.ship_date && o.ship_date >= m.start && o.ship_date <= m.end);

  // 매장별 매출 (직영 제외 = 산방에프앤비 매출)
  const storeSales = new Map(); // sid -> {name, exclusive, general, total}
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
      if (!r) { r = { name: storeName(o.store_id), exclusive: 0, general: 0, total: 0 }; storeSales.set(o.store_id, r); }
      if (it.product_type === 'exclusive') r.exclusive += it.subtotal; else r.general += it.subtotal;
      r.total += it.subtotal;
    }
  }
  const b2bByCust = new Map();
  for (const o of mb) {
    const name = b2bCustById.get(o.b2b_customer_id)?.name || 'B2B';
    let r = b2bByCust.get(name);
    if (!r) { r = { total: 0 }; b2bByCust.set(name, r); }
    r.total += o.b2b_order_items.reduce((s, i) => s + i.subtotal, 0);
  }

  const storeRevenue = [...storeSales.values()].reduce((s, r) => s + r.total, 0);
  const b2bRevenue = [...b2bByCust.values()].reduce((s, r) => s + r.total, 0);
  const revenue = storeRevenue + b2bRevenue;

  // 전용상품 매출원가 (산방푸드 판매가 기준) — 직영 제외 + B2B 포함
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

  // 신화푸드 정산 (전용 수수료: 직영 포함 / 범용 공급대금 97%)
  const shinwa = new Map(); // key -> {feeRate, exclusiveFeeBase, generalSales}
  for (const o of mo) {
    const st = storeById.get(o.store_id);
    const region = st?.region || 'jeju';
    const key = `store:${o.store_id}`;
    let r = shinwa.get(key);
    if (!r) { r = { name: storeName(o.store_id), feeRate: SHINWA_FEE_RATE[region], exclusiveFeeBase: 0, generalSales: 0, isDirect: st?.is_direct || false }; shinwa.set(key, r); }
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
    if (!r) { r = { name: cust?.name || 'B2B', feeRate: SHINWA_FEE_RATE[region], exclusiveFeeBase: 0, generalSales: 0, isDirect: false }; shinwa.set(key, r); }
    for (const it of o.b2b_order_items) {
      const p = productByName.get(it.product_name);
      if (p) {
        const ppb = p.pack_per_box || 1;
        const boxPrice = p.price_with_tax;
        const packPrice = ppb > 1 ? Math.round(boxPrice / ppb) : boxPrice;
        r.exclusiveFeeBase += it.quantity * (it.unit === 'pack' ? packPrice : boxPrice);
      }
    }
  }
  let shinwaFee = 0, shinwaFeeDirect = 0, generalSupply = 0, generalSales = 0;
  shinwa.forEach(r => {
    const fee = Math.round(r.exclusiveFeeBase * r.feeRate);
    shinwaFee += fee;
    if (r.isDirect) shinwaFeeDirect += fee;
    generalSupply += Math.round(r.generalSales * GENERAL_SUPPLY_RATE);
    generalSales += r.generalSales;
  });

  const costs = exclusiveCogs + shinwaFee + generalSupply;
  const profit = revenue - costs;

  console.log(`\n══════════ ${m.label} 손익 ══════════`);
  console.log(`[매출]  (직영점 제외)`);
  const sortedStores = [...storeSales.values()].sort((a, b) => b.total - a.total);
  for (const r of sortedStores) console.log(`   ${r.name.padEnd(12)} ${f(r.total).padStart(12)}원  (전용 ${f(r.exclusive)} / 범용 ${f(r.general)})`);
  for (const [name, r] of b2bByCust) console.log(`   ${('B2B·' + name).padEnd(12)} ${f(r.total).padStart(12)}원`);
  console.log(`   ─ 매출 합계        ${f(revenue).padStart(12)}원  (가맹 ${f(storeRevenue)} + B2B ${f(b2bRevenue)})`);
  console.log(`[비용]`);
  console.log(`   전용상품 원가(산방푸드 공급대금, 출고분)   -${f(exclusiveCogs).padStart(12)}원`);
  console.log(`   신화푸드 전용 배송수수료                 -${f(shinwaFee).padStart(12)}원  (이 중 직영점 몫 ${f(shinwaFeeDirect)}원은 산방에프앤비 부담)`);
  console.log(`   신화푸드 범용 공급대금(매출의 97%)        -${f(generalSupply).padStart(12)}원  (범용매출 ${f(generalSales)})`);
  console.log(`   ─ 비용 합계        ${f(costs).padStart(12)}원`);
  console.log(`──────────────────────────────────────`);
  console.log(`   ★ 영업이익         ${f(profit).padStart(12)}원  (이익률 ${revenue > 0 ? (profit / revenue * 100).toFixed(1) : 0}%)`);
  console.log(`   (참고) 직영점 출고분: 전용 ${f(directExclusive)}원 / 범용 ${f(directGeneral)}원 — 내부거래, 매출 아님`);
  if (cogsMissing.length) console.log(`   ⚠️ 원가 매핑 누락: ${cogsMissing.join(', ')}`);

  // 정산에서 빠질 수 있는 상태의 주문 체크
  const other = orders.filter(o => !['confirmed', 'shipped', 'cancelled'].includes(o.status) && o.ship_date && o.ship_date >= m.start && o.ship_date <= m.end);
  if (other.length) {
    console.log(`   ⚠️ 정산에 안 잡히는 상태의 주문 ${other.length}건:`);
    for (const o of other) console.log(`      ${o.order_number} [${o.status}] ${storeName(o.store_id)} ${f(o.total_amount)}원 (출고일 ${o.ship_date})`);
  }
}

// ================================================================
// PART B — 매장별 예치금 입금 내역 (통장 대사용, 입금일 KST 기준)
// ================================================================
console.log('\n\n████████████████████████████████████████████████████████████████');
console.log('  PART B. 매장별 예치금 입금 내역 (통장 대사용 — 승인일 KST 기준)');
console.log('████████████████████████████████████████████████████████████████');

for (const m of MONTHS) {
  console.log(`\n══════════ ${m.label} 예치금 입금 (충전) ══════════`);
  const deposits = depTx.filter(t => t.type === 'deposit' && inMonthKST(t.created_at, m));
  const byStore = new Map();
  for (const t of deposits) {
    if (!byStore.has(t.store_id)) byStore.set(t.store_id, []);
    byStore.get(t.store_id).push(t);
  }
  let monthTotal = 0;
  const sorted = [...byStore.entries()].sort((a, b) => storeName(a[0]).localeCompare(storeName(b[0]), 'ko'));
  for (const [sid, txs] of sorted) {
    const sum = txs.reduce((s, t) => s + t.amount, 0);
    monthTotal += sum;
    console.log(`\n  ▶ ${storeName(sid)} — 합계 ${f(sum)}원 (${txs.length}건)`);
    for (const t of txs) console.log(`     ${kst(t.created_at)}  +${f(t.amount).padStart(11)}원  ${t.description || ''}`);
  }
  // B2B 예치금 입금 (돼봉 등)
  const b2bDeposits = b2bDepTx.filter(t => t.type === 'deposit' && inMonthKST(t.created_at, m));
  const b2bByC = new Map();
  for (const t of b2bDeposits) {
    if (!b2bByC.has(t.b2b_customer_id)) b2bByC.set(t.b2b_customer_id, []);
    b2bByC.get(t.b2b_customer_id).push(t);
  }
  let b2bTotal = 0;
  for (const [cid, txs] of b2bByC) {
    const sum = txs.reduce((s, t) => s + t.amount, 0);
    b2bTotal += sum;
    console.log(`\n  ▶ [B2B] ${b2bCustById.get(cid)?.name || cid} — 합계 ${f(sum)}원 (${txs.length}건)`);
    for (const t of txs) console.log(`     ${kst(t.created_at)}  +${f(t.amount).padStart(11)}원  ${t.description || ''}`);
  }
  console.log(`\n  ✔ ${m.label} 입금 총계: 가맹점 ${f(monthTotal)}원 + B2B ${f(b2bTotal)}원 = ${f(monthTotal + b2bTotal)}원`);
  console.log(`    → 이 금액·건수가 통장의 "${m.label} 가맹점/거래처 입금"과 일치해야 합니다.`);

  // 수동 조정(adjustment) — 통장 대사 시 참고해야 할 항목
  const adjs = depTx.filter(t => t.type === 'adjustment' && inMonthKST(t.created_at, m));
  if (adjs.length) {
    console.log(`\n  ⚠️ ${m.label} 예치금 수동조정(adjustment) ${adjs.length}건 — 입금이 아닌 잔액 보정, 통장과 무관한지 확인 필요:`);
    for (const t of adjs) console.log(`     ${kst(t.created_at)}  ${t.amount >= 0 ? '+' : ''}${f(t.amount)}원  ${storeName(t.store_id)}  ${t.description || ''}`);
  }
}

// ================================================================
// PART C — 정합성(오류) 점검
// ================================================================
console.log('\n\n████████████████████████████████████████████████████████████████');
console.log('  PART C. 예치금·출고 정합성 점검 (전 기간 원장 재계산)');
console.log('████████████████████████████████████████████████████████████████');

const issues = [];

// C-1. 매장별 예치금 원장 체인 재계산: balance_after 연쇄 + 현재 잔액 대조
console.log('\n── C-1. 예치금 원장 재계산 (거래 사슬 + 현재 잔액 대조) ──');
const txByStore = new Map();
for (const t of depTx) {
  if (!txByStore.has(t.store_id)) txByStore.set(t.store_id, []);
  txByStore.get(t.store_id).push(t);
}
for (const [sid, txs] of txByStore) {
  txs.sort((a, b) => a.created_at.localeCompare(b.created_at));
  let prev = null;
  for (const t of txs) {
    if (prev !== null) {
      const expected = prev + t.amount;
      if (expected !== t.balance_after) {
        issues.push(`[원장체인] ${storeName(sid)} ${kst(t.created_at)} ${t.type} ${f(t.amount)}원: 직전잔액 ${f(prev)} + 금액 = ${f(expected)} 이어야 하나 기록된 잔액은 ${f(t.balance_after)} (차이 ${f(t.balance_after - expected)}) — ${t.description || ''}`);
      }
    }
    prev = t.balance_after;
  }
  const cur = storeById.get(sid)?.deposit_balance;
  if (prev !== null && cur !== undefined && prev !== cur) {
    issues.push(`[잔액불일치] ${storeName(sid)}: 원장 마지막 잔액 ${f(prev)}원 ≠ 현재 stores.deposit_balance ${f(cur)}원 (차이 ${f(cur - prev)})`);
  }
}
console.log(`   매장 ${txByStore.size}곳 원장 ${depTx.length}건 재계산 완료`);

// C-2. 주문 ↔ 예치금 차감 대조 (직영 제외): 활성주문 합계 = -total, 취소주문 = 0
console.log('\n── C-2. 주문별 예치금 차감/환불 대조 (직영점 제외) ──');
const txByOrder = new Map();
for (const t of depTx) {
  if (!t.order_id) continue;
  if (!txByOrder.has(t.order_id)) txByOrder.set(t.order_id, []);
  txByOrder.get(t.order_id).push(t);
}
let checkedOrders = 0;
for (const o of orders) {
  const st = storeById.get(o.store_id);
  if (!st || st.is_direct) continue;
  checkedOrders++;
  const txs = txByOrder.get(o.id) || [];
  const sum = txs.reduce((s, t) => s + t.amount, 0);
  const expected = o.status === 'cancelled' ? 0 : -o.total_amount;
  if (sum !== expected) {
    issues.push(`[차감불일치] ${o.order_number} [${o.status}] ${storeName(o.store_id)} 주문액 ${f(o.total_amount)}원: 예치금 거래 합계 ${f(sum)}원 (기대값 ${f(expected)}원, 거래 ${txs.length}건, 주문일 ${kstDate(o.created_at)})`);
  }
  const deducts = txs.filter(t => t.type === 'order_deduct');
  if (o.status !== 'cancelled' && deducts.length > 1) {
    issues.push(`[중복차감의심] ${o.order_number} ${storeName(o.store_id)}: order_deduct ${deducts.length}건`);
  }
}
// 주문에 연결됐지만 주문이 없는 거래
for (const [oid, txs] of txByOrder) {
  if (!orders.find(o => o.id === oid)) {
    issues.push(`[고아거래] 존재하지 않는 주문(${oid.slice(0, 8)})에 연결된 예치금 거래 ${txs.length}건, 합계 ${f(txs.reduce((s, t) => s + t.amount, 0))}원`);
  }
}
console.log(`   비직영 주문 ${checkedOrders}건 대조 완료`);

// C-3. 충전요청(approved) ↔ 입금거래 대조
console.log('\n── C-3. 승인된 충전요청 ↔ 실제 입금거래 대조 ──');
const depositTxs = depTx.filter(t => t.type === 'deposit');
const usedTx = new Set();
for (const r of depReq.filter(r => r.status === 'approved')) {
  const match = depositTxs.find(t =>
    !usedTx.has(t.id) && t.store_id === r.store_id && t.amount === r.amount &&
    Math.abs(new Date(t.created_at) - new Date(r.reviewed_at || r.created_at)) < 1000 * 60 * 60 * 24
  );
  if (match) usedTx.add(match.id);
  else issues.push(`[충전요청 미반영] ${storeName(r.store_id)} ${f(r.amount)}원 요청(${kst(r.created_at)}) 승인됐으나 일치하는 입금거래 없음`);
}
const pendingReq = depReq.filter(r => r.status === 'pending');
if (pendingReq.length) {
  for (const r of pendingReq) console.log(`   ⏳ 승인 대기중 충전요청: ${storeName(r.store_id)} ${f(r.amount)}원 (${kst(r.created_at)})`);
}
console.log(`   승인된 충전요청 ${depReq.filter(r => r.status === 'approved').length}건 대조 완료`);

// C-4. 주문 total_amount vs 품목 합계 (5·6월 전체 상태)
console.log('\n── C-4. 주문금액 vs 품목합계 (5·6월, 모든 상태) ──');
let c4 = 0;
for (const o of orders) {
  const inRange = o.ship_date && o.ship_date >= '2026-05-01' && o.ship_date <= '2026-06-30';
  if (!inRange) continue;
  c4++;
  const itemsSum = o.order_items.reduce((s, it) => s + it.subtotal, 0);
  if (o.total_amount !== itemsSum) {
    issues.push(`[주문금액불일치] ${o.order_number} [${o.status}] ${storeName(o.store_id)}: total_amount ${f(o.total_amount)} ≠ 품목합계 ${f(itemsSum)}`);
  }
}
for (const o of b2bOrders) {
  const inRange = o.ship_date && o.ship_date >= '2026-05-01' && o.ship_date <= '2026-06-30';
  if (!inRange) continue;
  const itemsSum = o.b2b_order_items.reduce((s, it) => s + it.subtotal, 0);
  if (o.total_amount !== itemsSum) {
    issues.push(`[B2B주문금액불일치] ${o.order_number} [${o.status}]: total_amount ${f(o.total_amount)} ≠ 품목합계 ${f(itemsSum)}`);
  }
}
console.log(`   5·6월 주문 ${c4}건 + B2B 대조 완료`);

// C-5. 품목 단가/부가세 정합성 (5·6월 confirmed/shipped)
console.log('\n── C-5. 품목 부가세/단가 정합성 (5·6월 출고 주문) ──');
let c5 = 0;
for (const o of orders) {
  if (!['confirmed', 'shipped'].includes(o.status)) continue;
  if (!o.ship_date || o.ship_date < '2026-05-01' || o.ship_date > '2026-06-30') continue;
  for (const it of o.order_items) {
    c5++;
    if (it.subtotal !== it.unit_price_with_tax * it.quantity) {
      issues.push(`[소계불일치] ${o.order_number}/${it.product_name}: subtotal ${f(it.subtotal)} ≠ 단가×수량 ${f(it.unit_price_with_tax * it.quantity)}`);
    }
    if (it.is_tax_free) {
      if (it.unit_price !== it.unit_price_with_tax) {
        issues.push(`[면세이상] ${o.order_number}/${it.product_name}: 면세인데 공급가 ${f(it.unit_price)} ≠ 세포함 ${f(it.unit_price_with_tax)} (출고 ${o.ship_date})`);
      }
    } else {
      const tax = it.unit_price_with_tax - it.unit_price;
      if (tax === 0) issues.push(`[부가세0] ${o.order_number}/${it.product_name}: 과세인데 공급가=세포함가 ${f(it.unit_price)} (출고 ${o.ship_date})`);
      else if (tax < 0) issues.push(`[부가세음수] ${o.order_number}/${it.product_name}`);
      else if (it.unit_price > 0) {
        const ratio = tax / it.unit_price;
        if (ratio < 0.08 || ratio > 0.12) issues.push(`[부가세율이상 ${(ratio * 100).toFixed(1)}%] ${o.order_number}/${it.product_name} (출고 ${o.ship_date})`);
      }
    }
  }
}
console.log(`   품목 ${c5}줄 검증 완료`);

// C-6. B2B 예치금 원장 재계산 (돼봉 등 선입금 거래처)
console.log('\n── C-6. B2B 예치금 원장 재계산 ──');
const b2bTxByCust = new Map();
for (const t of b2bDepTx) {
  if (!b2bTxByCust.has(t.b2b_customer_id)) b2bTxByCust.set(t.b2b_customer_id, []);
  b2bTxByCust.get(t.b2b_customer_id).push(t);
}
for (const [cid, txs] of b2bTxByCust) {
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
// B2B 선입금 거래처 주문 ↔ 차감 대조
const b2bTxByOrder = new Map();
for (const t of b2bDepTx) {
  if (!t.b2b_order_id) continue;
  if (!b2bTxByOrder.has(t.b2b_order_id)) b2bTxByOrder.set(t.b2b_order_id, []);
  b2bTxByOrder.get(t.b2b_order_id).push(t);
}
for (const o of b2bOrders) {
  const cust = b2bCustById.get(o.b2b_customer_id);
  if (!cust?.is_prepaid) continue;
  // 선입금 전환(6/12) 이후 주문만
  if (kstDate(o.created_at) < '2026-06-12') continue;
  const txs = b2bTxByOrder.get(o.id) || [];
  const sum = txs.reduce((s, t) => s + t.amount, 0);
  const expected = o.status === 'cancelled' ? 0 : -o.total_amount;
  if (sum !== expected) {
    issues.push(`[B2B차감불일치] ${o.order_number} [${o.status}] ${cust.name} 주문액 ${f(o.total_amount)}원: 거래합계 ${f(sum)}원 (기대 ${f(expected)}원)`);
  }
}
console.log(`   B2B 거래처 ${b2bTxByCust.size}곳 원장 ${b2bDepTx.length}건 재계산 완료`);

// C-7. 현재 잔액 스냅샷 (음수 잔액 등)
console.log('\n── C-7. 현재 예치금 잔액 스냅샷 ──');
for (const s of stores.filter(s => !s.is_direct).sort((a, b) => (a.short_name || a.name).localeCompare(b.short_name || b.name, 'ko'))) {
  const flag = s.deposit_balance < 0 ? '  ⚠️ 음수!' : '';
  console.log(`   ${(s.short_name || s.name).padEnd(12)} ${f(s.deposit_balance).padStart(12)}원${flag}`);
  if (s.deposit_balance < 0) issues.push(`[음수잔액] ${s.short_name || s.name}: ${f(s.deposit_balance)}원`);
}
for (const c of b2bCustomers.filter(c => c.is_prepaid)) {
  console.log(`   [B2B] ${c.name.padEnd(10)} ${f(c.deposit_balance).padStart(12)}원`);
}

// ============ 결과 ============
console.log('\n\n════════════════════ 점검 결과 요약 ════════════════════');
if (issues.length === 0) {
  console.log('✅ 발견된 정합성 오류 없음 — 예치금 원장·주문 차감·잔액 모두 일치');
} else {
  console.log(`⚠️ 발견된 이슈 ${issues.length}건:\n`);
  issues.forEach((s, i) => console.log(`${String(i + 1).padStart(3)}. ${s}`));
}
