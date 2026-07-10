// READ-ONLY — 6월 출고기준 전 매장 정산 및 세금계산서 발행 정보 조회 스크립트. SELECT만 수행.
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

const f = (n) => (n ?? 0).toLocaleString();

// 1. 6월 출고 기준 주문 및 세부 항목 조회
const { data: orders, error } = await supabase
  .from('orders')
  .select('id, order_number, store_id, status, total_amount, ship_date, stores(name, short_name, is_direct, owner_name, business_number, email), order_items(product_name, quantity, unit_price, unit_price_with_tax, is_tax_free, subtotal)')
  .in('status', ['confirmed', 'shipped'])
  .gte('ship_date', '2026-06-01')
  .lte('ship_date', '2026-06-30')
  .order('ship_date');

if (error) {
  console.error('Error fetching orders:', error);
  process.exit(1);
}

const storeNames = new Set();
const problems = [];   // {store, order, item, type, detail}
let itemCount = 0;

// 정산 및 세금계산서 발행 대장 매핑
const map = new Map();

for (const o of orders) {
  const store = o.stores?.short_name || o.stores?.name || `store:${o.store_id}`;
  storeNames.add(store);

  // 1) 주문 레벨 정합성 체크: total_amount vs 항목합
  const itemsSum = o.order_items.reduce((s, it) => s + it.subtotal, 0);
  if (o.total_amount !== itemsSum) {
    problems.push({ store, order: o.order_number, item: '-', type: 'total_amount≠항목합', detail: `${o.total_amount} vs ${itemsSum}` });
  }

  // 직영이 아닐 경우만 세금계산서 발행 대상에 합산
  const isDirect = o.stores?.is_direct || false;
  
  if (!isDirect) {
    let r = map.get(store);
    if (!r) {
      r = {
        name: store,
        owner: o.stores?.owner_name || '미등록',
        bizNum: o.stores?.business_number || '미등록',
        email: o.stores?.email || '미등록',
        supply: 0,
        taxSys: 0,
        taxFree: 0,
        total: 0
      };
      map.set(store, r);
    }

    for (const it of o.order_items) {
      itemCount++;
      // subtotal 정합성 검증
      const expSub = it.unit_price_with_tax * it.quantity;
      if (it.subtotal !== expSub) {
        problems.push({ store, order: o.order_number, item: it.product_name, type: 'subtotal불일치', detail: `저장 ${it.subtotal} vs 계산 ${expSub}` });
      }

      if (it.is_tax_free) {
        r.taxFree += it.subtotal;
        // 면세인데 공급가≠세포함가 → 세금이 끼어있음
        if (it.unit_price !== it.unit_price_with_tax) {
          problems.push({ store, order: o.order_number, item: it.product_name, type: '면세인데 공급가≠세포함가', detail: `공급가 ${it.unit_price} / 세포함 ${it.unit_price_with_tax}` });
        }
      } else {
        r.supply += it.unit_price * it.quantity;
        r.taxSys += (it.unit_price_with_tax - it.unit_price) * it.quantity;
        
        // 과세 품목 단가 정합성 체크
        const tax = it.unit_price_with_tax - it.unit_price;
        if (tax === 0) {
          problems.push({ store, order: o.order_number, item: it.product_name, type: '⚠️과세인데 부가세0 (공급가=세포함가)', detail: `공급가=세포함가=${it.unit_price}` });
        } else if (tax < 0) {
          problems.push({ store, order: o.order_number, item: it.product_name, type: '⚠️부가세 음수', detail: `공급가 ${it.unit_price} > 세포함 ${it.unit_price_with_tax}` });
        } else if (it.unit_price > 0) {
          const ratio = tax / it.unit_price;
          if (ratio < 0.08 || ratio > 0.12) {
            problems.push({ store, order: o.order_number, item: it.product_name, type: `부가세율 이상(${(ratio * 100).toFixed(1)}%)`, detail: `공급가 ${it.unit_price} / 세포함 ${it.unit_price_with_tax}` });
          }
        }
      }
    }
  } else {
    // 직영점도 정합성 체크는 동일하게 진행
    for (const it of o.order_items) {
      itemCount++;
      const expSub = it.unit_price_with_tax * it.quantity;
      if (it.subtotal !== expSub) {
        problems.push({ store, order: o.order_number, item: it.product_name, type: '직영 subtotal불일치', detail: `저장 ${it.subtotal} vs 계산 ${expSub}` });
      }
      if (it.is_tax_free && it.unit_price !== it.unit_price_with_tax) {
        problems.push({ store, order: o.order_number, item: it.product_name, type: '직영 면세인데 공급가≠세포함가', detail: `공급가 ${it.unit_price} / 세포함 ${it.unit_price_with_tax}` });
      } else if (!it.is_tax_free) {
        const tax = it.unit_price_with_tax - it.unit_price;
        if (tax === 0) {
          problems.push({ store, order: o.order_number, item: it.product_name, type: '⚠️직영 과세인데 부가세0 (공급가=세포함가)', detail: `공급가=세포함가=${it.unit_price}` });
        }
      }
    }
  }
}

console.log(`=== 6월(출고기준) 데이터 검증 ===`);
console.log(`주문 ${orders.length}건 / 가맹점 품목 ${itemCount}줄 / 전체 매장 ${storeNames.size}곳\n`);

if (problems.length === 0) {
  console.log('✅ 데이터 정합성 검증 결과: 이상 없음 (모든 매장 정상)');
} else {
  console.log(`⚠️ 데이터 이슈 감지 (${problems.length}건):`);
  const byStore = {};
  for (const p of problems) (byStore[p.store] ||= []).push(p);
  for (const [store, ps] of Object.entries(byStore)) {
    console.log(`\n[${store}] ${ps.length}건의 이슈`);
    for (const p of ps) console.log(`   - ${p.order} / ${p.item}: ${p.type} (${p.detail})`);
  }
}

console.log('\n========================================================================================');
console.log('                               6월 세금계산서 발행용 매출 집계표                               ');
console.log('========================================================================================');
console.log(
  '가맹점'.padEnd(14) +
  '대표자'.padEnd(7) +
  '사업자번호'.padEnd(15) +
  '과세 공급가액'.padStart(14) +
  '부가세(홈택스)'.padStart(14) +
  '면세 공급가액'.padStart(14) +
  '합계금액'.padStart(14)
);
console.log('-'.repeat(100));

const rows = [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
let T = { supply: 0, taxHometax: 0, taxSys: 0, taxFree: 0, total: 0 };

for (const r of rows) {
  const hometax = Math.floor(r.supply * 0.1); // 홈택스 계산 방식: 과세공급가액의 10% 원단위 절사
  const total = r.supply + hometax + r.taxFree;
  
  T.supply += r.supply;
  T.taxHometax += hometax;
  T.taxSys += r.taxSys;
  T.taxFree += r.taxFree;
  T.total += total;

  console.log(
    r.name.padEnd(12) +
    r.owner.padEnd(7) +
    r.bizNum.padEnd(15) +
    f(r.supply).padStart(15) +
    f(hometax).padStart(15) +
    f(r.taxFree).padStart(15) +
    f(total).padStart(15)
  );
}

console.log('-'.repeat(100));
console.log(
  '합계'.padEnd(18) +
  ''.padEnd(15) +
  f(T.supply).padStart(15) +
  f(T.taxHometax).padStart(15) +
  f(T.taxFree).padStart(15) +
  f(T.total).padStart(15)
);
console.log('========================================================================================');
console.log('* 부가세(홈택스) = 과세 공급가액 × 10% 원단위 절사');
console.log('* 합계금액 = 과세 공급가액 + 부가세(홈택스) + 면세 공급가액');
console.log('* 직영점(대한상공회의소점)은 발행 대상에서 제외되었습니다.');

// 이메일 리스트 출력
console.log('\n[가맹점 세금계산서 수신 이메일]');
for (const r of rows) {
  console.log(`  - ${r.name}: ${r.email}`);
}
