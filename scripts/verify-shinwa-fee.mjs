// 신화푸드 정산 검증 — 사용자 엑셀 라인별 합계와 비교
// - 전용: 가맹판가 × region 물류수수료 (제주 12.5% / 육지 8.5%)
// - 범용: 가맹판가 × 97% 공급대금 (산방에프앤비 마진 3% 제외)
// 기간: 2026-04-01 ~ 2026-04-30 (출고일 기준)
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(resolve(__dirname, '..', '.env.local'), 'utf8');
const env = Object.fromEntries(
  envText.split('\n').filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } });

const START = '2026-04-01';
const END = '2026-04-30';
const FEE = { jeju: 0.125, seoul: 0.085 };  // 전용 물류수수료
const GENERAL_SUPPLY = 0.97;                 // 범용 공급대금

const { data: orders } = await supabase
  .from('orders')
  .select('order_number, ship_date, status, store_id, stores(short_name, name, region, is_direct), order_items(product_name, product_type, quantity, unit_price_with_tax, subtotal, is_tax_free)')
  .in('status', ['confirmed', 'shipped'])
  .gte('ship_date', START).lte('ship_date', END);

const { data: b2b } = await supabase
  .from('b2b_orders')
  .select('order_number, ship_date, status, b2b_customers(name), b2b_order_items(product_name, quantity, unit, unit_price_with_tax, subtotal)')
  .in('status', ['confirmed', 'shipped'])
  .gte('ship_date', START).lte('ship_date', END);

let lineSum = 0;
let bulkSum = 0;
const partyMap = new Map();

(orders || []).forEach((o) => {
  const region = o.stores?.region || 'jeju';
  const storeName = o.stores?.short_name || o.stores?.name || '?';
  const sid = `store:${o.store_id}`;
  let s = partyMap.get(sid);
  if (!s) { s = { name: storeName, region, exclusiveSales: 0, generalSales: 0 }; partyMap.set(sid, s); }
  o.order_items.forEach((it) => {
    let rate;
    if (it.product_type === 'exclusive') {
      rate = FEE[region];
      s.exclusiveSales += it.subtotal;
    } else {
      rate = GENERAL_SUPPLY;
      s.generalSales += it.subtotal;
    }
    lineSum += Math.round(it.subtotal * rate);
  });
});

(b2b || []).forEach((o) => {
  const customer = o.b2b_customers?.name || 'B2B';
  const sid = `b2b:${customer}`;
  let s = partyMap.get(sid);
  if (!s) { s = { name: customer, region: 'seoul', exclusiveSales: 0, generalSales: 0 }; partyMap.set(sid, s); }
  o.b2b_order_items.forEach((it) => {
    s.exclusiveSales += it.subtotal;
    lineSum += Math.round(it.subtotal * FEE.seoul);
  });
});

partyMap.forEach((s) => {
  const eFee = Math.round(s.exclusiveSales * FEE[s.region]);
  const gFee = Math.round(s.generalSales * GENERAL_SUPPLY);
  bulkSum += eFee + gFee;
});

const TARGET = 1508882;
console.log(`사용자 엑셀 합계 (목표):           ₩${TARGET.toLocaleString()}`);
console.log(`스크립트 - 라인별 round 후 합산:   ₩${lineSum.toLocaleString()}  ${lineSum === TARGET ? '✅ 일치' : `❌ 차이 ${(lineSum - TARGET).toLocaleString()}`}`);
console.log(`스크립트 - 매장합산 후 round (5섹션 방식): ₩${bulkSum.toLocaleString()}  ${bulkSum === TARGET ? '✅ 일치' : `차이 ${(bulkSum - TARGET).toLocaleString()}`}`);

console.log('\n=== 매장/거래처별 상세 ===');
Array.from(partyMap.values()).sort((a, b) => a.name.localeCompare(b.name, 'ko')).forEach((s) => {
  const eFee = Math.round(s.exclusiveSales * FEE[s.region]);
  const gFee = Math.round(s.generalSales * GENERAL_SUPPLY);
  console.log(`  ${s.name.padEnd(18)} ${s.region}  전용매출=${String(s.exclusiveSales).padStart(9)} → 수수료=${String(eFee).padStart(7)}  범용매출=${String(s.generalSales).padStart(7)} → 공급대금=${String(gFee).padStart(6)}  합계=${(eFee+gFee).toLocaleString()}`);
});
