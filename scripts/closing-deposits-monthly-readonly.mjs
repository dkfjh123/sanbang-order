// READ-ONLY — 월별 예치금 충전(입금) 내역 마감 정리.
// SELECT만 수행. DB 데이터 변경 없음. (로컬 마감 폴더에 md/csv 파일만 생성)
//
// 사용법:  node scripts/closing-deposits-monthly-readonly.mjs 2026-07
//
// 산출물: 마감/<YYYY-MM>/예치금_충전내역_<YYYY-MM>.md
//         마감/<YYYY-MM>/예치금_충전내역_<YYYY-MM>.csv
//         마감/<YYYY-MM>/예치금_잔액변동_<YYYY-MM>.csv
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

// ── 대상 월 ──
const arg = process.argv[2];
if (!arg || !/^\d{4}-\d{2}$/.test(arg)) {
  console.error('사용법: node scripts/closing-deposits-monthly-readonly.mjs 2026-07');
  process.exit(1);
}
const [Y, M] = arg.split('-').map(Number);
const monthStart = `${arg}-01`;
const monthEnd = new Date(Date.UTC(Y, M, 0)).toISOString().slice(0, 10); // 해당 월 말일
const label = `${Y}년 ${M}월`;

const f = (n) => Math.round(n ?? 0).toLocaleString('ko-KR');
const kst = (iso) => new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16);
const kstDate = (iso) => new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 10);
const inMonth = (iso) => { const d = kstDate(iso); return d >= monthStart && d <= monthEnd; };
const beforeMonth = (iso) => kstDate(iso) < monthStart;
const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

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

// ── 데이터 로드 ──
const stores = await fetchAll('stores', 'id, name, short_name, is_direct, region, deposit_balance');
const depTx = await fetchAll('deposit_transactions', '*', q => q.order('created_at'));
const depReq = await fetchAll('deposit_requests', '*, stores(name, short_name)', q => q.order('created_at'));
const b2bCustomers = await fetchAll('b2b_customers', 'id, name, region, is_prepaid, deposit_balance');
const b2bDepTx = await fetchAll('b2b_deposit_transactions', '*', q => q.order('created_at'));
const b2bDepReq = await fetchAll('b2b_deposit_requests', '*', q => q.order('created_at'));

const storeById = new Map(stores.map(s => [s.id, s]));
const storeName = (id) => { const s = storeById.get(id); return s ? (s.short_name || s.name) : `매장:${String(id).slice(0, 8)}`; };
const b2bById = new Map(b2bCustomers.map(c => [c.id, c]));
const b2bName = (id) => b2bById.get(id)?.name || `거래처:${String(id).slice(0, 8)}`;

const out = [];
const say = (s = '') => { out.push(s); console.log(s); };

say(`# ${label} 예치금 충전내역 (마감 정리)`);
say('');
say(`- 대상 기간: **${monthStart} ~ ${monthEnd}** (KST 기준)`);
say(`- 산출 기준: \`deposit_transactions.type='deposit'\` (= 관리자가 입금 확인·승인한 시점)`);
say(`- 이 문서는 읽기전용 스크립트 \`scripts/closing-deposits-monthly-readonly.mjs\` 실행 결과입니다. DB 변경 없음.`);
say('');

// ================================================================
// 1. 가맹점 예치금 충전 내역
// ================================================================
const deposits = depTx.filter(t => t.type === 'deposit' && inMonth(t.created_at));
const byStore = new Map();
for (const t of deposits) {
  if (!byStore.has(t.store_id)) byStore.set(t.store_id, []);
  byStore.get(t.store_id).push(t);
}
const storeSorted = [...byStore.entries()].sort((a, b) => storeName(a[0]).localeCompare(storeName(b[0]), 'ko'));

let storeTotal = 0;
say('## 1. 가맹점 예치금 충전 (매장별)');
say('');
say('| 매장 | 건수 | 충전 합계(원) |');
say('|---|---:|---:|');
for (const [sid, txs] of storeSorted) {
  const sum = txs.reduce((s, t) => s + t.amount, 0);
  storeTotal += sum;
  say(`| ${storeName(sid)} | ${txs.length} | ${f(sum)} |`);
}
say(`| **가맹점 합계** | **${deposits.length}** | **${f(storeTotal)}** |`);
say('');

say('### 매장별 상세');
say('');
for (const [sid, txs] of storeSorted) {
  const sum = txs.reduce((s, t) => s + t.amount, 0);
  say(`**▶ ${storeName(sid)}** — ${txs.length}건 / ${f(sum)}원`);
  say('');
  say('| 승인일시(KST) | 금액(원) | 승인 후 잔액(원) | 비고 |');
  say('|---|---:|---:|---|');
  for (const t of txs) {
    say(`| ${kst(t.created_at)} | ${f(t.amount)} | ${f(t.balance_after)} | ${t.description || ''} |`);
  }
  say('');
}

// ================================================================
// 2. B2B 거래처 예치금 충전 내역
// ================================================================
const b2bDeposits = b2bDepTx.filter(t => t.type === 'deposit' && inMonth(t.created_at));
const byCust = new Map();
for (const t of b2bDeposits) {
  if (!byCust.has(t.b2b_customer_id)) byCust.set(t.b2b_customer_id, []);
  byCust.get(t.b2b_customer_id).push(t);
}
let b2bTotal = 0;
say('## 2. B2B 거래처 예치금 충전');
say('');
if (byCust.size === 0) {
  say(`${label} B2B 예치금 충전 없음.`);
  say('');
} else {
  say('| 거래처 | 승인일시(KST) | 금액(원) | 승인 후 잔액(원) | 비고 |');
  say('|---|---|---:|---:|---|');
  for (const [cid, txs] of byCust) {
    for (const t of txs) {
      b2bTotal += t.amount;
      say(`| ${b2bName(cid)} | ${kst(t.created_at)} | ${f(t.amount)} | ${f(t.balance_after)} | ${t.description || ''} |`);
    }
  }
  say(`| **B2B 합계** |  | **${f(b2bTotal)}** |  | ${b2bDeposits.length}건 |`);
  say('');
}

// ================================================================
// 3. 월 총계 + 일자별 집계 (통장 대사용)
// ================================================================
say('## 3. 통장 대사용 요약');
say('');
say(`- 가맹점 충전: **${f(storeTotal)}원** (${deposits.length}건)`);
say(`- B2B 충전: **${f(b2bTotal)}원** (${b2bDeposits.length}건)`);
say(`- **${label} 예치금 입금 총계: ${f(storeTotal + b2bTotal)}원 (${deposits.length + b2bDeposits.length}건)**`);
say('');
say('### 일자별 입금 집계');
say('');
const byDay = new Map();
for (const t of [...deposits, ...b2bDeposits]) {
  const d = kstDate(t.created_at);
  if (!byDay.has(d)) byDay.set(d, { cnt: 0, sum: 0 });
  const r = byDay.get(d); r.cnt++; r.sum += t.amount;
}
say('| 일자 | 건수 | 금액(원) |');
say('|---|---:|---:|');
for (const [d, r] of [...byDay.entries()].sort()) say(`| ${d} | ${r.cnt} | ${f(r.sum)} |`);
say(`| **합계** | **${deposits.length + b2bDeposits.length}** | **${f(storeTotal + b2bTotal)}** |`);
say('');

// ================================================================
// 4. 충전 외 예치금 변동 (조정·출금·환불) — 통장과 무관한 항목 구분
// ================================================================
say('## 4. 충전 외 예치금 변동 (통장 입금 아님 — 대사 총계에서 제외)');
say('');
const others = depTx.filter(t => t.type !== 'deposit' && inMonth(t.created_at));
const b2bOthers = b2bDepTx.filter(t => t.type !== 'deposit' && inMonth(t.created_at));
const otherAll = [
  ...others.map(t => ({ ...t, who: storeName(t.store_id) })),
  ...b2bOthers.map(t => ({ ...t, who: `[B2B] ${b2bName(t.b2b_customer_id)}` })),
].sort((a, b) => a.created_at.localeCompare(b.created_at));

// 4-1. 발주 차감/환불 — 자동 처리분이라 건수·합계만
const autoTx = otherAll.filter(t => t.type === 'order_deduct' || t.type === 'order_refund');
const deduct = autoTx.filter(t => t.type === 'order_deduct');
const refund = autoTx.filter(t => t.type === 'order_refund');
say('### 4-1. 발주 차감·환불 (시스템 자동, 요약)');
say('');
say('| 유형 | 건수 | 금액(원) |');
say('|---|---:|---:|');
say(`| 발주 차감(order_deduct) | ${deduct.length} | ${f(deduct.reduce((s, t) => s + t.amount, 0))} |`);
say(`| 발주 취소 환불(order_refund) | ${refund.length} | ${f(refund.reduce((s, t) => s + t.amount, 0))} |`);
say('');
say('> 발주 건별 상세는 정산/발주내역 페이지에서 확인. 여기서는 예치금 잔액 대사용 합계만 표기합니다.');
say('');

// 4-2. 수동 조정/출금 — 사람이 개입한 항목이라 전건 표기
const manualTx = otherAll.filter(t => t.type === 'adjustment' || t.type === 'withdrawal');
say('### 4-2. 수동 조정·출금 (전건 — 확인 필요)');
say('');
if (manualTx.length === 0) {
  say('해당 없음.');
} else {
  say('| 일시(KST) | 대상 | 유형 | 금액(원) | 사유 |');
  say('|---|---|---|---:|---|');
  for (const t of manualTx) {
    say(`| ${kst(t.created_at)} | ${t.who} | ${t.type} | ${t.amount >= 0 ? '+' : ''}${f(t.amount)} | ${t.description || ''} |`);
  }
  say('');
  const manualByWho = new Map();
  for (const t of manualTx) manualByWho.set(t.who, (manualByWho.get(t.who) || 0) + t.amount);
  say('**대상별 조정 순액**: ' + [...manualByWho.entries()].map(([w, v]) => `${w} ${v >= 0 ? '+' : ''}${f(v)}원`).join(' / '));
  say('');
  say(`> ⚠️ 수동 조정 ${manualTx.length}건, 순액 ${f(manualTx.reduce((s, t) => s + t.amount, 0))}원. 통장 입금이 아니므로 대사 총계에서 제외하되, 사유가 타당한지 확인하세요.`);
}
say('');

// 4-3. 그 외 유형 (예상 밖 타입 방어)
const knownTypes = new Set(['deposit', 'order_deduct', 'order_refund', 'adjustment', 'withdrawal']);
const unknownTx = otherAll.filter(t => !knownTypes.has(t.type));
if (unknownTx.length) {
  say('### 4-3. ⚠️ 분류되지 않은 거래 유형');
  say('');
  say('| 일시(KST) | 대상 | 유형 | 금액(원) | 비고 |');
  say('|---|---|---|---:|---|');
  for (const t of unknownTx) say(`| ${kst(t.created_at)} | ${t.who} | ${t.type} | ${f(t.amount)} | ${t.description || ''} |`);
  say('');
}

// ================================================================
// 5. 충전요청(deposit_requests) 처리 현황 대조
// ================================================================
say('## 5. 충전요청 처리 현황 (요청 기준)');
say('');
const reqs = depReq.filter(r => inMonth(r.created_at));
const b2bReqs = b2bDepReq.filter(r => inMonth(r.created_at));
const reqStat = { approved: [], pending: [], rejected: [] };
for (const r of [...reqs, ...b2bReqs]) (reqStat[r.status] || (reqStat[r.status] = [])).push(r);

say('| 상태 | 건수 | 금액(원) |');
say('|---|---:|---:|');
for (const [st, arr] of Object.entries(reqStat)) {
  say(`| ${st} | ${arr.length} | ${f(arr.reduce((s, r) => s + r.amount, 0))} |`);
}
say('');
if (reqStat.pending?.length) {
  say('### ⚠️ 미처리(pending) 요청');
  say('');
  say('| 요청일시(KST) | 대상 | 금액(원) | 비고 |');
  say('|---|---|---:|---|');
  for (const r of reqStat.pending) {
    const who = r.store_id ? storeName(r.store_id) : `[B2B] ${b2bName(r.b2b_customer_id)}`;
    say(`| ${kst(r.created_at)} | ${who} | ${f(r.amount)} | ${r.description || ''} |`);
  }
  say('');
}
if (reqStat.rejected?.length) {
  say('### 반려(rejected) 요청');
  say('');
  say('| 요청일시(KST) | 대상 | 금액(원) | 비고 |');
  say('|---|---|---:|---|');
  for (const r of reqStat.rejected) {
    const who = r.store_id ? storeName(r.store_id) : `[B2B] ${b2bName(r.b2b_customer_id)}`;
    say(`| ${kst(r.created_at)} | ${who} | ${f(r.amount)} | ${r.description || ''} |`);
  }
  say('');
}

// 승인건수 ↔ 충전 트랜잭션 건수 대조
const approvedInMonth = [...depReq, ...b2bDepReq].filter(r => r.status === 'approved' && r.reviewed_at && inMonth(r.reviewed_at));
const approvedSum = approvedInMonth.reduce((s, r) => s + r.amount, 0);
say(`- 당월 **승인 처리**된 요청: ${approvedInMonth.length}건 / ${f(approvedSum)}원`);
say(`- 당월 **충전 트랜잭션**: ${deposits.length + b2bDeposits.length}건 / ${f(storeTotal + b2bTotal)}원`);
if (approvedInMonth.length !== deposits.length + b2bDeposits.length || approvedSum !== storeTotal + b2bTotal) {
  say(`- ⚠️ **차이 있음** → 관리자가 요청 없이 직접 충전했거나(수동 입력), 승인일과 트랜잭션일이 월을 넘긴 건이 있습니다. 아래 6번 확인.`);
} else {
  say(`- ✅ 일치`);
}
say('');

// ================================================================
// 5-2. 월경계 점검 — 비고에 적힌 실제 입금일과 승인일의 월이 다른 건
// ================================================================
say('### 월경계 점검 (승인일 ≠ 점주가 적은 입금일)');
say('');
const crossMonth = [];
for (const t of [...deposits.map(t => ({ ...t, who: storeName(t.store_id) })), ...b2bDeposits.map(t => ({ ...t, who: `[B2B] ${b2bName(t.b2b_customer_id)}` }))]) {
  const m = String(t.description || '').match(/(\d{1,2})\s*[/.\-월]\s*(\d{1,2})/);
  if (!m) continue;
  const noteMonth = Number(m[1]);
  const noteDay = Number(m[2]);
  if (noteMonth < 1 || noteMonth > 12 || noteDay < 1 || noteDay > 31) continue;
  if (noteMonth !== M) crossMonth.push({ ...t, noteMonth, noteDay });
}
if (crossMonth.length === 0) {
  say('해당 없음 — 모든 충전건의 비고 날짜가 당월입니다.');
} else {
  say('| 승인일시(KST) | 대상 | 금액(원) | 비고(점주 기재) | 판단 |');
  say('|---|---|---:|---|---|');
  for (const t of crossMonth) {
    const dir = t.noteMonth < M ? '전월 입금 → 당월 승인' : '차월 표기(오기 의심)';
    say(`| ${kst(t.created_at)} | ${t.who} | ${f(t.amount)} | ${t.description} | ${dir} |`);
  }
  say('');
  say(`> ⚠️ 위 ${crossMonth.length}건은 시스템 승인일과 점주가 적은 실제 입금일의 **월이 다릅니다**. 통장 대사 시 통장에는 다른 달에 찍혀 있을 수 있으니 확인하세요. (합계 ${f(crossMonth.reduce((s, t) => s + t.amount, 0))}원)`);
}
say('');

// ================================================================
// 6. 매장별 잔액 변동 (기초 → 기말)
// ================================================================
say('## 6. 매장별 예치금 잔액 변동');
say('');
say('| 매장 | 기초잔액(원) | 충전(원) | 사용/차감(원) | 기타조정(원) | 기말잔액(원) |');
say('|---|---:|---:|---:|---:|---:|');

const balRows = [];
const allTargets = [
  ...stores.map(s => ({ kind: 'store', id: s.id, name: s.short_name || s.name })),
  ...b2bCustomers.filter(c => c.is_prepaid).map(c => ({ kind: 'b2b', id: c.id, name: `[B2B] ${c.name}` })),
];
let tOpen = 0, tCharge = 0, tUse = 0, tAdj = 0, tClose = 0;
for (const tgt of allTargets) {
  const txs = (tgt.kind === 'store' ? depTx.filter(t => t.store_id === tgt.id) : b2bDepTx.filter(t => t.b2b_customer_id === tgt.id));
  const before = txs.filter(t => beforeMonth(t.created_at));
  const inM = txs.filter(t => inMonth(t.created_at));
  if (before.length === 0 && inM.length === 0) continue;
  const open = before.length ? before[before.length - 1].balance_after : 0;
  const charge = inM.filter(t => t.type === 'deposit').reduce((s, t) => s + t.amount, 0);
  const use = inM.filter(t => t.amount < 0 && t.type !== 'adjustment' && t.type !== 'withdrawal').reduce((s, t) => s + t.amount, 0);
  const adj = inM.filter(t => t.type === 'adjustment' || t.type === 'withdrawal').reduce((s, t) => s + t.amount, 0);
  const refund = inM.filter(t => t.amount > 0 && t.type !== 'deposit' && t.type !== 'adjustment').reduce((s, t) => s + t.amount, 0);
  const close = inM.length ? inM[inM.length - 1].balance_after : open;
  tOpen += open; tCharge += charge; tUse += use + refund; tAdj += adj; tClose += close;
  say(`| ${tgt.name} | ${f(open)} | ${f(charge)} | ${f(use + refund)} | ${f(adj)} | ${f(close)} |`);
  balRows.push([tgt.name, open, charge, use + refund, adj, close]);
}
say(`| **합계** | **${f(tOpen)}** | **${f(tCharge)}** | **${f(tUse)}** | **${f(tAdj)}** | **${f(tClose)}** |`);
say('');
say('> 기초잔액 = 당월 이전 마지막 거래의 balance_after / 기말잔액 = 당월 마지막 거래의 balance_after (당월 거래 없으면 기초와 동일)');
say('');

// ================================================================
// 파일 저장
// ================================================================
const outDir = join(projectRoot, '마감', arg);
mkdirSync(outDir, { recursive: true });

writeFileSync(join(outDir, `예치금_충전내역_${arg}.md`), out.join('\n'), 'utf-8');

const csvLines = ['구분,대상,승인일시(KST),금액,승인후잔액,비고'];
for (const t of deposits) {
  csvLines.push([`가맹점`, storeName(t.store_id), kst(t.created_at), t.amount, t.balance_after, t.description || ''].map(csvCell).join(','));
}
for (const t of b2bDeposits) {
  csvLines.push([`B2B`, b2bName(t.b2b_customer_id), kst(t.created_at), t.amount, t.balance_after, t.description || ''].map(csvCell).join(','));
}
writeFileSync(join(outDir, `예치금_충전내역_${arg}.csv`), '﻿' + csvLines.join('\r\n'), 'utf-8');

const balCsv = ['대상,기초잔액,충전,사용차감,기타조정,기말잔액'];
for (const r of balRows) balCsv.push(r.map(csvCell).join(','));
writeFileSync(join(outDir, `예치금_잔액변동_${arg}.csv`), '﻿' + balCsv.join('\r\n'), 'utf-8');

console.log('');
console.log(`📄 저장 완료: 마감/${arg}/`);
console.log(`   - 예치금_충전내역_${arg}.md`);
console.log(`   - 예치금_충전내역_${arg}.csv`);
console.log(`   - 예치금_잔액변동_${arg}.csv`);
