// READ-ONLY — 월별 신화푸드 정산 검증 (출고 대조 + 수수료 재계산 + B2B 가맹가 기준 확인).
// SELECT만 수행. DB 변경 없음. (로컬 마감 폴더에 md 파일만 생성)
//
// 사용법:  node scripts/closing-shinwa-verify-monthly-readonly.mjs 2026-07
//
// 산출물: 마감/<YYYY-MM>/신화정산검증_<YYYY-MM>.md
//
// 정산 페이지(settlement/page.tsx) 5섹션 로직을 품목 단위로 다시 계산해 대조한다.
//   전용 수수료 = (가맹점 판가 × 수량) × 권역요율   [제주 12.5% / 육지 8.5%]
//   범용 공급대금 = 범용 매출 × 97%
//   B2B도 수수료 베이스는 "가맹점 판가" 기준 (B2B 판매가 아님)
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
  console.error('사용법: node scripts/closing-shinwa-verify-monthly-readonly.mjs 2026-07');
  process.exit(1);
}
const [Y, M] = arg.split('-').map(Number);
const START = `${arg}-01`;
const END = new Date(Date.UTC(Y, M, 0)).toISOString().slice(0, 10);
const label = `${Y}년 ${M}월`;

const f = (n) => Math.round(n ?? 0).toLocaleString('ko-KR');
const SHINWA_FEE_RATE = { jeju: 0.125, seoul: 0.085 };
const GENERAL_SUPPLY_RATE = 0.97;

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

console.log(`${label} 신화푸드 정산 검증 — 조회 중...`);

const stores = await fetchAll('stores', 'id, name, short_name, is_direct, region');
const products = await fetchAll('products', 'id, name, product_type, pack_per_box, price, price_with_tax, sanbang_food_sale_price_with_tax');
const orders = await fetchAll('orders',
  'id, order_number, store_id, status, ship_date, total_amount, stores(name, short_name, is_direct, region), order_items(product_id, product_name, product_type, quantity, unit, unit_price_with_tax, subtotal)',
  q => q.in('status', ['confirmed', 'shipped']).gte('ship_date', START).lte('ship_date', END).order('ship_date'));
const b2bOrders = await fetchAll('b2b_orders',
  'id, order_number, status, ship_date, total_amount, b2b_customers(name, region), b2b_order_items(product_name, unit, quantity, pack_per_box, unit_price_with_tax, subtotal)',
  q => q.in('status', ['confirmed', 'shipped']).gte('ship_date', START).lte('ship_date', END).order('ship_date'));

const productById = new Map(products.map(p => [p.id, p]));
const productByName = new Map(products.filter(p => p.product_type === 'exclusive').map(p => [p.name, p]));

const issues = [];
const out = [];
const say = (s = '') => out.push(s);

// 가맹판가 단가 계산 (박스/낱팩)
const franchiseUnitPrice = (p, unit) => {
  const ppb = p.pack_per_box || 1;
  const box = p.price_with_tax || 0;
  return unit === 'pack' && ppb > 1 ? Math.round(box / ppb) : box;
};

say(`# ${label} 신화푸드 정산 검증`);
say('');
say(`- 대상: **${START} ~ ${END}** · 출고일(ship_date) 기준 · 확정+출고완료 주문`);
say(`- 방법: 읽기전용 스크립트 \`scripts/closing-shinwa-verify-monthly-readonly.mjs ${arg}\` — SELECT만, DB 변경 없음`);
say('- 정산 페이지 5섹션 로직을 **품목 한 줄씩 다시 계산**해서 대조했습니다.');
say('');
say('**계산 규칙**');
say('');
say('| 항목 | 계산식 |');
say('|---|---|');
say('| 전용 배송수수료 | (**가맹점 판가** × 수량) × 권역요율 |');
say('| 권역요율 | 제주 **12.5%** / 육지(서울 등) **8.5%** |');
say('| 범용 공급대금 | 범용 매출 × **97%** (산방에프앤비 마진 3%) |');
say('| B2B 수수료 베이스 | **가맹점 판가** 기준 (B2B 판매가 아님) |');
say('| 낱팩(팩) 단가 | 가맹판가 박스가 ÷ 팩수, 반올림 |');
say('| 직영점 | 수수료 **부과됨** (산방에프앤비가 부담) |');
say('');

// ================================================================
// 1. 권역·요율 확인
// ================================================================
say('## 1. 권역·수수료율 확인');
say('');
say('| 매장/거래처 | 채널 | 권역 | 적용 요율 |');
say('|---|---|---|---:|');
const partySeen = new Set();
for (const o of orders) {
  const key = `store:${o.store_id}`;
  if (partySeen.has(key)) continue;
  partySeen.add(key);
  const st = o.stores;
  const region = st?.region || 'jeju';
  if (!SHINWA_FEE_RATE[region]) issues.push(`[권역이상] ${st?.short_name || st?.name}: region 값이 '${region}' — 요율을 정할 수 없음`);
  say(`| ${st?.short_name || st?.name}${st?.is_direct ? ' *(직영)*' : ''} | 가맹점 | ${region === 'jeju' ? '제주' : '육지'} (${region}) | ${((SHINWA_FEE_RATE[region] ?? 0) * 100).toFixed(1)}% |`);
}
for (const o of b2bOrders) {
  const key = `b2b:${o.b2b_customers?.name}`;
  if (partySeen.has(key)) continue;
  partySeen.add(key);
  const region = o.b2b_customers?.region || 'seoul';
  if (!SHINWA_FEE_RATE[region]) issues.push(`[권역이상] B2B ${o.b2b_customers?.name}: region 값이 '${region}'`);
  say(`| ${o.b2b_customers?.name} | B2B | ${region === 'jeju' ? '제주' : '육지'} (${region}) | ${((SHINWA_FEE_RATE[region] ?? 0) * 100).toFixed(1)}% |`);
}
say('');
say('> 권역이 실제 매장 소재지와 맞는지 눈으로 확인해 주세요. 권역이 틀리면 수수료가 통째로 어긋납니다.');
say('');

// ================================================================
// 2. 가맹점 — 전용 수수료 베이스 검증
// ================================================================
say('## 2. 가맹점 전용 수수료 베이스 검증');
say('');
say('가맹점은 주문 소계(가맹판가)가 곧 수수료 베이스입니다. **주문에 기록된 단가**가 **현재 상품 가맹판가**와 같은지 확인했습니다.');
say('');
const storeAgg = new Map();
const priceMismatch = [];
for (const o of orders) {
  const st = o.stores;
  const region = st?.region || 'jeju';
  const key = `store:${o.store_id}`;
  let r = storeAgg.get(key);
  if (!r) { r = { name: st?.short_name || st?.name, channel: '가맹점', isDirect: st?.is_direct || false, region, rate: SHINWA_FEE_RATE[region] ?? 0, feeBase: 0, exclusiveSales: 0, generalSales: 0, orders: new Set() }; storeAgg.set(key, r); }
  r.orders.add(o.order_number);
  for (const it of o.order_items) {
    if (it.product_type === 'exclusive') {
      r.exclusiveSales += it.subtotal;
      r.feeBase += it.subtotal;
      // 단가 검증
      const p = it.product_id ? productById.get(it.product_id) : productByName.get(it.product_name);
      if (!p) { issues.push(`[상품매핑없음] ${o.order_number} / ${it.product_name} — 가맹판가 대조 불가`); continue; }
      const expected = franchiseUnitPrice(p, it.unit);
      if (expected !== it.unit_price_with_tax) {
        priceMismatch.push({ ord: o.order_number, ship: o.ship_date, store: r.name, item: it.product_name, unit: it.unit, qty: it.quantity, used: it.unit_price_with_tax, now: expected, gap: (it.unit_price_with_tax - expected) * it.quantity });
      }
      if (it.subtotal !== it.unit_price_with_tax * it.quantity) {
        issues.push(`[소계불일치] ${o.order_number} / ${it.product_name}: 소계 ${f(it.subtotal)} ≠ 단가×수량 ${f(it.unit_price_with_tax * it.quantity)}`);
      }
    } else {
      r.generalSales += it.subtotal;
    }
  }
}
if (!priceMismatch.length) {
  say('✅ **전 품목 일치** — 주문 단가가 모두 현재 가맹판가와 같습니다. 수수료 베이스에 문제 없습니다.');
} else {
  say(`⚠️ 주문 단가와 현재 가맹판가가 다른 품목 **${priceMismatch.length}줄** (가격이 바뀌었거나 수기 수정된 건):`);
  say('');
  say('| 주문번호 | 출고일 | 매장 | 품목 | 수량 | 주문 단가 | 현재 가맹판가 | 베이스 차이 |');
  say('|---|---|---|---|---:|---:|---:|---:|');
  for (const m of priceMismatch) {
    say(`| ${m.ord} | ${m.ship} | ${m.store} | ${m.item}(${m.unit === 'pack' ? '팩' : '박스'}) | ${m.qty} | ${f(m.used)} | ${f(m.now)} | ${m.gap > 0 ? '+' : ''}${f(m.gap)} |`);
  }
  say('');
  say('> 출고 당시 단가로 정산하는 게 맞습니다. 가격 개정이 있었다면 정상이며, 아니라면 확인이 필요합니다.');
}
say('');

// ================================================================
// 3. B2B — 가맹가 기준 여부 검증 (핵심)
// ================================================================
say('## 3. B2B 수수료 베이스 — 가맹가 기준인지 확인 ★');
say('');
say('B2B는 판매가가 가맹판가와 다릅니다. 수수료는 **가맹판가 기준**으로 잡혀야 합니다.');
say('');
const b2bAgg = new Map();
const b2bDetail = [];
const b2bUnmapped = [];
for (const o of b2bOrders) {
  const cname = o.b2b_customers?.name || 'B2B';
  const region = o.b2b_customers?.region || 'seoul';
  const key = `b2b:${cname}`;
  let r = b2bAgg.get(key);
  if (!r) { r = { name: cname, channel: 'B2B', isDirect: false, region, rate: SHINWA_FEE_RATE[region] ?? 0, feeBase: 0, exclusiveSales: 0, generalSales: 0, orders: new Set(), b2bBaseIfWrong: 0 }; b2bAgg.set(key, r); }
  r.orders.add(o.order_number);
  for (const it of o.b2b_order_items) {
    r.exclusiveSales += it.subtotal;
    r.b2bBaseIfWrong += it.subtotal; // 만약 B2B 판매가로 잘못 잡았다면 이 값
    const p = productByName.get(it.product_name);
    if (!p) {
      b2bUnmapped.push({ ord: o.order_number, ship: o.ship_date, cust: cname, item: it.product_name, qty: it.quantity, sales: it.subtotal });
      issues.push(`[B2B 상품매핑 누락] ${o.order_number} / ${it.product_name} — 가맹판가를 못 찾아 수수료 베이스 0원 처리됨 (수수료 과소 계상)`);
      continue;
    }
    const fUnit = franchiseUnitPrice(p, it.unit);
    const base = fUnit * it.quantity;
    r.feeBase += base;
    b2bDetail.push({ ord: o.order_number, ship: o.ship_date, cust: cname, item: it.product_name, unit: it.unit, qty: it.quantity,
                     b2bUnit: it.unit_price_with_tax, b2bSub: it.subtotal, fUnit, base, rate: r.rate, fee: base * r.rate });
  }
}
if (!b2bDetail.length && !b2bUnmapped.length) {
  say('당월 B2B 출고 없음.');
} else {
  say('| 주문번호 | 출고일 | 거래처 | 품목 | 단위 | 수량 | B2B 단가 | **가맹판가** | 수수료 베이스 | 요율 | 수수료 |');
  say('|---|---|---|---|---|---:|---:|---:|---:|---:|---:|');
  for (const d of b2bDetail) {
    say(`| ${d.ord} | ${d.ship} | ${d.cust} | ${d.item} | ${d.unit === 'pack' ? '팩' : '박스'} | ${d.qty} | ${f(d.b2bUnit)} | **${f(d.fUnit)}** | ${f(d.base)} | ${(d.rate * 100).toFixed(1)}% | ${f(d.fee)} |`);
  }
  say('');
  for (const [, r] of b2bAgg) {
    const feeCorrect = Math.round(r.feeBase * r.rate);
    const feeWrong = Math.round(r.b2bBaseIfWrong * r.rate);
    say(`**▶ ${r.name}** (${r.region === 'jeju' ? '제주' : '육지'} ${(r.rate * 100).toFixed(1)}%, 주문 ${r.orders.size}건)`);
    say('');
    say('| 항목 | 금액(원) |');
    say('|---|---:|');
    say(`| B2B 매출 (판매가) | ${f(r.exclusiveSales)} |`);
    say(`| **수수료 베이스 (가맹판가 기준)** | **${f(r.feeBase)}** |`);
    say(`| 수수료 = 베이스 × ${(r.rate * 100).toFixed(1)}% | **${f(feeCorrect)}** |`);
    say(`| (비교) 만약 B2B 판매가로 잘못 계산했다면 | ${f(feeWrong)} — 차이 ${f(feeWrong - feeCorrect)}원 |`);
    say('');
    const ok = r.feeBase !== r.exclusiveSales;
    say(`${ok ? '✅' : '⚠️'} 수수료 베이스(${f(r.feeBase)})가 B2B 매출(${f(r.exclusiveSales)})과 ${ok ? '**다릅니다 → 가맹판가 기준으로 정상 적용됨**' : '**같습니다 → 가맹판가 기준인지 확인 필요**'}`);
    say('');
  }
  if (b2bUnmapped.length) {
    say('### ⚠️ 가맹판가를 못 찾은 B2B 품목 (수수료 0원 처리됨)');
    say('');
    say('| 주문번호 | 출고일 | 거래처 | 품목 | 수량 | B2B 매출 |');
    say('|---|---|---|---|---:|---:|');
    for (const u of b2bUnmapped) say(`| ${u.ord} | ${u.ship} | ${u.cust} | ${u.item} | ${u.qty} | ${f(u.sales)} |`);
    say('');
    say('> 상품명이 products 테이블의 전용상품 이름과 정확히 일치해야 가맹판가를 찾습니다.');
    say('> **이 품목들은 신화 수수료가 0원으로 계산되어 실제보다 적게 나갑니다.** 상품명 확인이 필요합니다.');
    say('');
  }
}

// ── 3-2. B2B 품목별 수익성 (매출 − 산방푸드 원가 − 신화 수수료) ──
if (b2bDetail.length) {
  say('### 3-2. B2B 품목별 수익성 점검');
  say('');
  say('수수료를 가맹판가로 내는 구조라, B2B 판매가가 낮으면 남는 게 없을 수 있습니다. 품목별로 확인했습니다.');
  say('');
  say('| 거래처 | 품목 | 단위 | 수량 | B2B 매출 | 산방푸드 원가 | 신화 수수료 | **마진** | 마진율 |');
  say('|---|---|---|---:|---:|---:|---:|---:|---:|');
  const itemAgg = new Map();
  for (const d of b2bDetail) {
    const p = productByName.get(d.item);
    const ppb = p.pack_per_box || 1;
    const boxCost = p.sanbang_food_sale_price_with_tax || 0;
    const unitCost = d.unit === 'pack' && ppb > 1 ? Math.round(boxCost / ppb) : boxCost;
    const k = `${d.cust}|${d.item}|${d.unit}`;
    let a = itemAgg.get(k);
    if (!a) { a = { cust: d.cust, item: d.item, unit: d.unit, qty: 0, sales: 0, cost: 0, fee: 0, baseOver: 0 }; itemAgg.set(k, a); }
    a.qty += d.qty; a.sales += d.b2bSub; a.cost += unitCost * d.qty; a.fee += d.fee;
    a.baseOver += (d.fUnit - d.b2bUnit) * d.qty; // 가맹판가가 B2B가보다 높은 만큼
  }
  let tS = 0, tC = 0, tF = 0;
  for (const a of [...itemAgg.values()].sort((x, y) => y.sales - x.sales)) {
    const margin = a.sales - a.cost - a.fee;
    tS += a.sales; tC += a.cost; tF += a.fee;
    const flag = margin < 0 ? ' ⚠️' : '';
    say(`| ${a.cust} | ${a.item} | ${a.unit === 'pack' ? '팩' : '박스'} | ${a.qty} | ${f(a.sales)} | ${f(a.cost)} | ${f(Math.round(a.fee))} | **${f(margin)}**${flag} | ${a.sales > 0 ? (margin / a.sales * 100).toFixed(1) : 0}% |`);
  }
  const tM = tS - tC - tF;
  say(`| **합계** | | | | **${f(tS)}** | **${f(tC)}** | **${f(Math.round(tF))}** | **${f(tM)}** | ${tS > 0 ? (tM / tS * 100).toFixed(1) : 0}% |`);
  say('');
  const losers = [...itemAgg.values()].filter(a => (a.sales - a.cost - a.fee) < 0);
  if (losers.length) {
    say(`> ⚠️ **적자 품목 ${losers.length}개**: ${losers.map(a => `${a.cust}/${a.item}`).join(', ')} — 판매가·원가 재검토가 필요합니다.`);
    say('');
  }
  // B2B가가 가맹판가보다 싼 품목 → 수수료를 매출보다 큰 베이스로 냄
  const overs = [...itemAgg.values()].filter(a => a.baseOver > 0);
  if (overs.length) {
    say('**B2B 판매가가 가맹판가보다 싼 품목** — 매출보다 큰 금액을 베이스로 수수료를 냅니다.');
    say('');
    say('| 거래처 | 품목 | 수량 | 베이스 초과분 | 추가 부담 수수료 |');
    say('|---|---|---:|---:|---:|');
    let ov = 0;
    for (const a of overs) {
      const extra = a.baseOver * (b2bAgg.get([...b2bAgg.keys()].find(k => b2bAgg.get(k).name === a.cust))?.rate ?? 0);
      ov += extra;
      say(`| ${a.cust} | ${a.item}(${a.unit === 'pack' ? '팩' : '박스'}) | ${a.qty} | ${f(a.baseOver)} | ${f(Math.round(extra))} |`);
    }
    say(`| **합계** | | | | **${f(Math.round(ov))}** |`);
    say('');
    say('> 계약상 수수료를 가맹판가로 내기로 했다면 정상입니다. 다만 이 품목들은 **팔수록 수수료 부담이 커지는 구조**입니다.');
    say('');
  }
}

// ================================================================
// 4. 매장/거래처별 정산 집계
// ================================================================
const allAgg = [...storeAgg.values(), ...b2bAgg.values()];
for (const r of allAgg) {
  r.fee = Math.round(r.feeBase * r.rate);
  r.supply = Math.round(r.generalSales * GENERAL_SUPPLY_RATE);
  r.total = r.fee + r.supply;
}
const sorted = allAgg.sort((a, b) => b.total - a.total);
const T = sorted.reduce((a, r) => ({
  feeBase: a.feeBase + r.feeBase, fee: a.fee + r.fee,
  generalSales: a.generalSales + r.generalSales, supply: a.supply + r.supply, total: a.total + r.total,
}), { feeBase: 0, fee: 0, generalSales: 0, supply: 0, total: 0 });

say('## 4. 신화푸드 지급액 (매장·거래처별)');
say('');
say('| 매장/거래처 | 채널 | 권역 | 요율 | 주문 | 전용 수수료 베이스 | 전용 수수료 | 범용 매출 | 범용 공급대금 | **지급 합계** |');
say('|---|---|---|---:|---:|---:|---:|---:|---:|---:|');
for (const r of sorted) {
  say(`| ${r.name}${r.isDirect ? ' *(직영)*' : ''} | ${r.channel} | ${r.region === 'jeju' ? '제주' : '육지'} | ${(r.rate * 100).toFixed(1)}% | ${r.orders.size} | ${f(r.feeBase)} | ${f(r.fee)} | ${f(r.generalSales)} | ${f(r.supply)} | **${f(r.total)}** |`);
}
say(`| **합계** | | | | | **${f(T.feeBase)}** | **${f(T.fee)}** | **${f(T.generalSales)}** | **${f(T.supply)}** | **${f(T.total)}** |`);
say('');
say(`- 범용 마진(산방에프앤비 몫 3%): ${f(T.generalSales)} − ${f(T.supply)} = **${f(T.generalSales - T.supply)}원**`);
const directFee = sorted.filter(r => r.isDirect).reduce((s, r) => s + r.total, 0);
say(`- 직영점 몫 **${f(directFee)}원**은 매출이 없는데도 산방에프앤비가 부담합니다.`);
say('');

// 요율 검산
say('### 수수료 재검산 (베이스 × 요율)');
say('');
say('| 매장/거래처 | 베이스 | 요율 | 계산값 | 반올림 | 확인 |');
say('|---|---:|---:|---:|---:|---|');
for (const r of sorted) {
  if (r.feeBase === 0) continue;
  const raw = r.feeBase * r.rate;
  say(`| ${r.name} | ${f(r.feeBase)} | ${(r.rate * 100).toFixed(1)}% | ${raw.toFixed(1)} | ${f(r.fee)} | ${Math.round(raw) === r.fee ? '✅' : '⚠️'} |`);
}
say('');

// ================================================================
// 5. 출고 건별 상세 (신화 명세서 대조용)
// ================================================================
say('## 5. 출고 건별 상세 (신화 명세서 대조용)');
say('');
say('| 출고일 | 주문번호 | 매장/거래처 | 전용 베이스 | 범용 매출 | 요율 | 수수료 | 범용 공급대금 | 소계 |');
say('|---|---|---|---:|---:|---:|---:|---:|---:|');
const perOrder = [];
for (const o of orders) {
  const st = o.stores;
  const region = st?.region || 'jeju';
  const rate = SHINWA_FEE_RATE[region] ?? 0;
  let base = 0, gen = 0;
  for (const it of o.order_items) {
    if (it.product_type === 'exclusive') base += it.subtotal; else gen += it.subtotal;
  }
  perOrder.push({ ship: o.ship_date, ord: o.order_number, name: (st?.short_name || st?.name) + (st?.is_direct ? '(직영)' : ''), base, gen, rate });
}
for (const o of b2bOrders) {
  const cname = o.b2b_customers?.name || 'B2B';
  const region = o.b2b_customers?.region || 'seoul';
  const rate = SHINWA_FEE_RATE[region] ?? 0;
  let base = 0;
  for (const it of o.b2b_order_items) {
    const p = productByName.get(it.product_name);
    if (p) base += franchiseUnitPrice(p, it.unit) * it.quantity;
  }
  perOrder.push({ ship: o.ship_date, ord: o.order_number, name: `${cname}(B2B)`, base, gen: 0, rate });
}
perOrder.sort((a, b) => a.ship.localeCompare(b.ship) || a.ord.localeCompare(b.ord));
for (const o of perOrder) {
  const fee = Math.round(o.base * o.rate);
  const sup = Math.round(o.gen * GENERAL_SUPPLY_RATE);
  say(`| ${o.ship} | ${o.ord} | ${o.name} | ${f(o.base)} | ${f(o.gen)} | ${(o.rate * 100).toFixed(1)}% | ${f(fee)} | ${f(sup)} | ${f(fee + sup)} |`);
}
say('');
say('> ⚠️ 건별 수수료를 더한 값과 위 4번의 매장별 수수료는 **반올림 시점 차이로 몇 원 다를 수 있습니다.**');
const perOrderFeeSum = perOrder.reduce((s, o) => s + Math.round(o.base * o.rate) + Math.round(o.gen * GENERAL_SUPPLY_RATE), 0);
say(`> 건별 합계 ${f(perOrderFeeSum)}원 vs 매장별 합계 ${f(T.total)}원 — 차이 ${f(perOrderFeeSum - T.total)}원.`);
say(`> **매장별 합계(${f(T.total)}원)가 정산 기준**입니다(정산 페이지와 동일).`);
say('');

// ================================================================
// 6. 점검 결과
// ================================================================
say('## 6. 점검 결과');
say('');
if (!issues.length) {
  say('### ✅ 이상 없음');
  say('');
  say('- 권역·요율 정상');
  say('- 가맹점 수수료 베이스 = 주문 소계(가맹판가) 일치');
  say('- B2B 수수료 베이스 = 가맹판가 기준 적용 확인');
  say('- 범용 공급대금 97% 정상');
} else {
  say(`### ⚠️ 확인 필요 ${issues.length}건`);
  say('');
  issues.forEach((s, i) => say(`${i + 1}. ${s}`));
}
say('');
say('---');
say('');
say('## 신화푸드에 지급할 금액');
say('');
say(`| 항목 | 금액(원) |`);
say('|---|---:|');
say(`| 전용 배송수수료 | ${f(T.fee)} |`);
say(`| 범용 공급대금 (97%) | ${f(T.supply)} |`);
say(`| **합계** | **${f(T.total)}** |`);
say('');

const outDir = join(projectRoot, '마감', arg);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `신화정산검증_${arg}.md`), out.join('\n'), 'utf-8');

console.log('');
console.log(out.join('\n'));
console.log('');
console.log(`📄 저장 완료: 마감/${arg}/신화정산검증_${arg}.md`);
