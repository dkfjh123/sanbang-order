'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';

interface OrderWithItems {
  id: string;
  order_number: string;
  store_id: string;
  status: string;
  total_amount: number;
  created_at: string;
  stores: { name: string; short_name: string; is_direct: boolean; region: 'seoul' | 'jeju' } | null;
  order_items: {
    product_id: string | null;
    product_name: string;
    product_type: string;
    quantity: number;
    unit?: 'box' | 'pack' | null;
    unit_price: number;
    unit_price_with_tax: number;
    subtotal: number;
    is_tax_free: boolean;
  }[];
}

// 입고내역 — 전용상품만, 발주/B2B 취소 복구는 제외 (정산 대상은 산방푸드가 보낸 순수 입고만)
interface InboundTx {
  id: string;
  product_id: string;
  quantity: number;
  description: string | null;
  created_at: string;
}

// B2B 발주 — 신화푸드 정산 5섹션에 포함 (아워홈 = 육지)
interface B2bOrderRow {
  id: string;
  order_number: string;
  status: string;
  ship_date: string | null;
  b2b_customers: { name: string } | null;
  b2b_order_items: {
    product_name: string;
    quantity: number;
    unit: 'box' | 'pack';
    unit_price_with_tax: number;
    subtotal: number;
  }[];
}

interface ExclusiveProduct {
  id: string;
  name: string;
  sort_order: number;
  pack_per_box: number;          // 낱팩 발주 단가 분기 (4섹션)
  sanbang_food_sale_price_with_tax: number;
  cost_price_with_tax: number;   // 제조사 → 산방푸드 매입가 (3섹션)
}

// 전용상품 → 제조사 매핑 (3섹션 제조사별 마감 집계용)
// 신규 전용상품 추가 시 여기도 매핑 추가 필요
const MANUFACTURER: Record<string, string> = {
  '왕만두': '한만두식품',
  '아삭한김치왕만두70': '한만두식품',
  '고기국수육수': '윤트리스팟',
  '육수간장': '다담푸드',
  '비빔전용장': '다담푸드',
  '양념장': '다담푸드',
  '생밀면': '다선',
};
const MANUFACTURER_ORDER = ['한만두식품', '윤트리스팟', '다담푸드', '다선'];

// 5섹션 — 신화푸드 정산 비율
//   - 전용상품 배송수수료: 가맹점 판가(부가세포함) × region별 수수료율
//   - 범용상품 공급대금: 매출 × 97% (산방에프앤비 마진 3%)
const SHINWA_FEE_RATE = { jeju: 0.125, seoul: 0.085 } as const; // 전용 배송수수료
const GENERAL_SUPPLY_RATE = 0.97;                                 // 범용 공급대금 (산방에프앤비 마진 3%)

// 입금 흐름 + 계산서 발행 라벨 (섹션 헤더에 표시)
function FlowChips({ payment, invoice }: { payment: string; invoice: string }) {
  return (
    <div className="flex items-center gap-2 mt-2 text-xs flex-wrap">
      <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
        <span className="font-semibold">입금</span>
        <span>{payment}</span>
      </span>
      <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-blue-50 text-blue-700 border border-blue-200">
        <span className="font-semibold">계산서</span>
        <span>{invoice}</span>
      </span>
    </div>
  );
}

// 해당 월의 [1일, 말일] 반환 (YYYY-MM-DD) — timezone-safe (UTC 산술)
function monthRange(year: number, month: number) {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const endY = month === 12 ? year + 1 : year;
  const endM = month === 12 ? 1 : month + 1;
  const e = new Date(`${endY}-${String(endM).padStart(2, '0')}-01T00:00:00Z`);
  e.setUTCDate(e.getUTCDate() - 1);
  return { start, end: e.toISOString().slice(0, 10) };
}

export default function SettlementPage() {
  const today = new Date();
  const initial = monthRange(today.getFullYear(), today.getMonth() + 1);
  const [startDate, setStartDate] = useState(initial.start);
  const [endDate, setEndDate] = useState(initial.end);
  const [orders, setOrders] = useState<OrderWithItems[]>([]);
  const [b2bOrders, setB2bOrders] = useState<B2bOrderRow[]>([]);
  const [inbounds, setInbounds] = useState<InboundTx[]>([]);
  const [exclusiveProducts, setExclusiveProducts] = useState<ExclusiveProduct[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supabase = createClient();

  // 기간 빠른 선택 — 이번달 / 지난달
  const setThisMonth = () => {
    const d = new Date();
    const r = monthRange(d.getFullYear(), d.getMonth() + 1);
    setStartDate(r.start);
    setEndDate(r.end);
  };
  const setLastMonth = () => {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - 1);
    const r = monthRange(d.getFullYear(), d.getMonth() + 1);
    setStartDate(r.start);
    setEndDate(r.end);
  };

  async function search() {
    if (!startDate || !endDate) {
      setError('시작일과 종료일을 모두 입력해주세요.');
      return;
    }
    if (startDate > endDate) {
      setError('시작일이 종료일보다 늦을 수 없습니다.');
      return;
    }
    setLoading(true);
    setError(null);
    setSearched(true);

    // 출고기준: ship_date가 [startDate, endDate] 범위에 속하고, 확정(confirmed) 또는 출고완료(shipped)인 주문
    // - shipped: 신화푸드가 실제 출고처리 완료
    // - confirmed: 출고예정 (신화가 출고처리 누락해도 정산에 잡혀야 안전)
    const { data: orderData } = await supabase
      .from('orders')
      .select('*, stores(name, short_name, is_direct, region), order_items(*)')
      .in('status', ['confirmed', 'shipped'])
      .gte('ship_date', startDate)
      .lte('ship_date', endDate)
      .order('ship_date');

    setOrders((orderData as OrderWithItems[]) || []);

    // B2B 출고 — 신화푸드 정산 5섹션 대상 (아워홈 = 육지 8.5%)
    const { data: b2bData } = await supabase
      .from('b2b_orders')
      .select('id, order_number, status, ship_date, b2b_customers(name), b2b_order_items(product_name, quantity, unit, unit_price_with_tax, subtotal)')
      .in('status', ['confirmed', 'shipped'])
      .gte('ship_date', startDate)
      .lte('ship_date', endDate);
    setB2bOrders((b2bData as unknown as B2bOrderRow[]) || []);

    // 전용상품 + 산방푸드 판매가 (2섹션) + 매입가 (3섹션) + pack_per_box (4섹션 낱팩 분기)
    const { data: prodData } = await supabase
      .from('products')
      .select('id, name, sort_order, pack_per_box, sanbang_food_sale_price_with_tax, cost_price_with_tax')
      .eq('product_type', 'exclusive')
      .order('sort_order', { ascending: true });
    const exclusiveList = (prodData as ExclusiveProduct[]) || [];
    setExclusiveProducts(exclusiveList);

    // 입고내역 (전용상품만, 기간 내, 취소 복구는 제외)
    // - created_at 기준 KR 자정 (timezone-safe)
    // - description에 "복구" 포함된 건 제외 (발주/B2B 취소 복구)
    const exclusiveIds = exclusiveList.map((p) => p.id);
    const dt = new Date(`${endDate}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() + 1);
    const inboundEndDate = dt.toISOString().slice(0, 10);
    const inboundStartKR = `${startDate}T00:00:00+09:00`;
    const inboundEndKR = `${inboundEndDate}T00:00:00+09:00`;

    const { data: inboundData } = await supabase
      .from('inventory_transactions')
      .select('id, product_id, quantity, description, created_at')
      .eq('type', 'inbound')
      .in('product_id', exclusiveIds.length > 0 ? exclusiveIds : ['00000000-0000-0000-0000-000000000000'])
      .gte('created_at', inboundStartKR)
      .lt('created_at', inboundEndKR)
      .order('created_at', { ascending: true });

    const filteredInbound = ((inboundData as InboundTx[]) || []).filter(
      (tx) => !(tx.description || '').includes('복구'),
    );
    setInbounds(filteredInbound);

    setLoading(false);
  }

  // 출고 상태 카운트 — 월마감 시 신화푸드가 '출고 처리'를 빠뜨린 건이 있는지 확인
  const shippedCount = orders.filter((o) => o.status === 'shipped').length;
  const pendingShipCount = orders.filter((o) => o.status === 'confirmed').length;

  // 가맹점 매출 (계산서 발행 대상) — 직영점 제외, 과세/면세 분리
  type StoreSalesRow = {
    store_id: string;
    name: string;
    taxableSupply: number;   // 과세 공급가 (세전)
    taxableTax: number;      // 부가세
    taxableTotal: number;    // 과세 합계 (공급가 + 부가세)
    taxFreeTotal: number;    // 면세 합계
    total: number;           // 총 매출
  };
  const storeSalesMap = new Map<string, StoreSalesRow>();

  orders.forEach((order) => {
    if (order.stores?.is_direct) return; // 직영점 제외 (내부거래라 계산서 발행 X)
    const sid = order.store_id;
    let row = storeSalesMap.get(sid);
    if (!row) {
      row = {
        store_id: sid,
        name: order.stores?.short_name || order.stores?.name || '알 수 없음',
        taxableSupply: 0,
        taxableTax: 0,
        taxableTotal: 0,
        taxFreeTotal: 0,
        total: 0,
      };
      storeSalesMap.set(sid, row);
    }
    order.order_items.forEach((item) => {
      const supply = item.unit_price * item.quantity;
      const tax = (item.unit_price_with_tax - item.unit_price) * item.quantity;
      if (item.is_tax_free) {
        row!.taxFreeTotal += item.subtotal;
      } else {
        row!.taxableSupply += supply;
        row!.taxableTax += tax;
        row!.taxableTotal += item.subtotal;
      }
      row!.total += item.subtotal;
    });
  });

  const storeSalesRows = Array.from(storeSalesMap.values())
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'));

  const storeSalesTotal = storeSalesRows.reduce(
    (acc, r) => ({
      taxableSupply: acc.taxableSupply + r.taxableSupply,
      taxableTax: acc.taxableTax + r.taxableTax,
      taxableTotal: acc.taxableTotal + r.taxableTotal,
      taxFreeTotal: acc.taxFreeTotal + r.taxFreeTotal,
      total: acc.total + r.total,
    }),
    { taxableSupply: 0, taxableTax: 0, taxableTotal: 0, taxFreeTotal: 0, total: 0 },
  );

  // 입고내역 — 2섹션(산방푸드 정산) + 3섹션(제조사 매입금액)
  type InboundRow = {
    product_id: string;
    name: string;
    sortOrder: number;
    manufacturer: string;
    quantity: number;          // 입고 수량 (박스)
    unitPrice: number;         // 산방푸드 판매가 (세포함) — 2섹션 단가
    amount: number;            // 산방푸드 정산 합계
    unitCostPrice: number;     // 제조사 매입가 (세포함) — 3섹션 단가
    costAmount: number;        // 제조사 매입금액 합계
    txCount: number;           // 입고 건수
  };
  const productMap = new Map(exclusiveProducts.map((p) => [p.id, p]));
  const inboundMap = new Map<string, InboundRow>();
  inbounds.forEach((tx) => {
    const p = productMap.get(tx.product_id);
    if (!p) return;
    let row = inboundMap.get(tx.product_id);
    if (!row) {
      row = {
        product_id: tx.product_id,
        name: p.name,
        sortOrder: p.sort_order,
        manufacturer: MANUFACTURER[p.name] || '미지정',
        quantity: 0,
        unitPrice: p.sanbang_food_sale_price_with_tax,
        amount: 0,
        unitCostPrice: p.cost_price_with_tax,
        costAmount: 0,
        txCount: 0,
      };
      inboundMap.set(tx.product_id, row);
    }
    row.quantity += tx.quantity;
    row.amount += tx.quantity * row.unitPrice;
    row.costAmount += tx.quantity * row.unitCostPrice;
    row.txCount += 1;
  });
  // 정렬: 제조사 우선 (MANUFACTURER_ORDER) → 상품 sort_order
  const inboundRows = Array.from(inboundMap.values()).sort((a, b) => {
    const ma = MANUFACTURER_ORDER.indexOf(a.manufacturer);
    const mb = MANUFACTURER_ORDER.indexOf(b.manufacturer);
    const maOrder = ma === -1 ? 999 : ma;
    const mbOrder = mb === -1 ? 999 : mb;
    if (maOrder !== mbOrder) return maOrder - mbOrder;
    return a.sortOrder - b.sortOrder;
  });
  const inboundTotal = inboundRows.reduce(
    (acc, r) => ({
      quantity: acc.quantity + r.quantity,
      amount: acc.amount + r.amount,
      costAmount: acc.costAmount + r.costAmount,
    }),
    { quantity: 0, amount: 0, costAmount: 0 },
  );

  // 제조사별 매입금액 집계 (3섹션 하단 표시용)
  const manufacturerMap = new Map<string, { quantity: number; costAmount: number; productCount: number }>();
  inboundRows.forEach((r) => {
    let g = manufacturerMap.get(r.manufacturer);
    if (!g) { g = { quantity: 0, costAmount: 0, productCount: 0 }; manufacturerMap.set(r.manufacturer, g); }
    g.quantity += r.quantity;
    g.costAmount += r.costAmount;
    g.productCount += 1;
  });
  const manufacturerRows = Array.from(manufacturerMap.entries())
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => {
      const ai = MANUFACTURER_ORDER.indexOf(a.name);
      const bi = MANUFACTURER_ORDER.indexOf(b.name);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });

  // 4섹션 — 직영점 후불 (산방푸드 → 상공회의소점)
  // 출고기준 (ship_date 범위 내), 직영점만, 전용상품만, 산방푸드_판매가 단가
  // 낱팩 발주 시 단가 = 박스가 / pack_per_box (round)
  type DirectRow = {
    product_id: string;
    name: string;
    sortOrder: number;
    qtyBox: number;        // 박스 발주 수량
    qtyPack: number;       // 낱팩 발주 수량
    boxPrice: number;      // 박스 단가
    packPrice: number;     // 낱팩 단가 (박스가 / pack_per_box)
    amount: number;        // 합계 (박스+낱팩)
  };
  const directMap = new Map<string, DirectRow>();
  orders.forEach((order) => {
    if (!order.stores?.is_direct) return;        // 직영점만
    order.order_items.forEach((item) => {
      if (item.product_type !== 'exclusive') return; // 전용상품만 (범용은 별도 채널)
      if (!item.product_id) return;
      const p = productMap.get(item.product_id);
      if (!p) return;
      const ppb = p.pack_per_box || 1;
      const boxPrice = p.sanbang_food_sale_price_with_tax;
      const packPrice = ppb > 1 ? Math.round(boxPrice / ppb) : boxPrice;

      let row = directMap.get(item.product_id);
      if (!row) {
        row = {
          product_id: item.product_id,
          name: item.product_name,
          sortOrder: p.sort_order,
          qtyBox: 0,
          qtyPack: 0,
          boxPrice,
          packPrice,
          amount: 0,
        };
        directMap.set(item.product_id, row);
      }
      if (item.unit === 'pack') {
        row.qtyPack += item.quantity;
        row.amount += item.quantity * packPrice;
      } else {
        row.qtyBox += item.quantity;
        row.amount += item.quantity * boxPrice;
      }
    });
  });
  const directRows = Array.from(directMap.values()).sort((a, b) => a.sortOrder - b.sortOrder);
  const directTotal = directRows.reduce(
    (acc, r) => ({
      qtyBox: acc.qtyBox + r.qtyBox,
      qtyPack: acc.qtyPack + r.qtyPack,
      amount: acc.amount + r.amount,
    }),
    { qtyBox: 0, qtyPack: 0, amount: 0 },
  );

  // 5섹션 — 신화푸드 정산 (매장/거래처별)
  //   전용 수수료: 모든 매장 + B2B (직영 상공회의소점도 신화 물류수수료 대상, 단가는 가맹판가 기준)
  //   범용 공급대금: 모든 매장 (B2B는 전용만이라 범용 없음)
  type ShinwaRow = {
    party_id: string;
    name: string;
    channel: 'store' | 'b2b';
    region: 'seoul' | 'jeju';
    is_direct: boolean;
    feeRate: number;          // 전용 수수료율
    exclusiveSales: number;   // 전용 매출 (가맹판가 또는 B2B 매출 기준)
    exclusiveFee: number;     // 전용 수수료
    generalSales: number;     // 범용 매출 (orders만)
    generalSupply: number;    // 범용 공급대금
    storeTotal: number;       // 매장/거래처 합계 (신화에 보낼 금액)
  };
  const shinwaMap = new Map<string, ShinwaRow>();

  // (1) 가맹점 + 직영점 — orders 기준 (가맹판가 = item.subtotal)
  orders.forEach((order) => {
    const isDirect = order.stores?.is_direct || false;
    const region = (order.stores?.region as 'seoul' | 'jeju') || 'jeju';
    const sid = `store:${order.store_id}`;
    let row = shinwaMap.get(sid);
    if (!row) {
      row = {
        party_id: sid,
        name: order.stores?.short_name || order.stores?.name || '알 수 없음',
        channel: 'store',
        region,
        is_direct: isDirect,
        feeRate: SHINWA_FEE_RATE[region],
        exclusiveSales: 0,
        exclusiveFee: 0,
        generalSales: 0,
        generalSupply: 0,
        storeTotal: 0,
      };
      shinwaMap.set(sid, row);
    }
    order.order_items.forEach((item) => {
      if (item.product_type === 'exclusive') {
        // 직영 포함 모든 매장 — 가맹판가 기준 신화 수수료
        row!.exclusiveSales += item.subtotal;
      } else {
        row!.generalSales += item.subtotal;
      }
    });
  });

  // (2) B2B — b2b_orders 기준 (아워홈 = 육지 8.5%, 모두 전용상품)
  b2bOrders.forEach((order) => {
    const customerName = order.b2b_customers?.name || 'B2B 거래처';
    // 같은 거래처는 통합 (거래처명을 키로)
    const key = `b2b:${customerName}`;
    let row = shinwaMap.get(key);
    if (!row) {
      row = {
        party_id: key,
        name: customerName,
        channel: 'b2b',
        region: 'seoul', // 아워홈 = 육지 (향후 거래처별 region 필요 시 확장)
        is_direct: false,
        feeRate: SHINWA_FEE_RATE.seoul,
        exclusiveSales: 0,
        exclusiveFee: 0,
        generalSales: 0,
        generalSupply: 0,
        storeTotal: 0,
      };
      shinwaMap.set(key, row);
    }
    order.b2b_order_items.forEach((item) => {
      // B2B는 모두 전용상품으로 간주 (b2b 매출 기준)
      row!.exclusiveSales += item.subtotal;
    });
  });

  // 합계 계산 (round)
  shinwaMap.forEach((r) => {
    r.exclusiveFee = Math.round(r.exclusiveSales * r.feeRate);
    r.generalSupply = Math.round(r.generalSales * GENERAL_SUPPLY_RATE);
    r.storeTotal = r.exclusiveFee + r.generalSupply;
  });
  const shinwaRows = Array.from(shinwaMap.values())
    .filter((r) => r.exclusiveSales > 0 || r.generalSales > 0)
    .sort((a, b) => {
      // 채널(store 먼저) → 권역(제주 먼저) → 매장명
      if (a.channel !== b.channel) return a.channel === 'store' ? -1 : 1;
      if (a.region !== b.region) return a.region === 'jeju' ? -1 : 1;
      return a.name.localeCompare(b.name, 'ko');
    });
  const shinwaTotal = shinwaRows.reduce(
    (acc, r) => ({
      exclusiveSales: acc.exclusiveSales + r.exclusiveSales,
      exclusiveFee: acc.exclusiveFee + r.exclusiveFee,
      generalSales: acc.generalSales + r.generalSales,
      generalSupply: acc.generalSupply + r.generalSupply,
      storeTotal: acc.storeTotal + r.storeTotal,
    }),
    { exclusiveSales: 0, exclusiveFee: 0, generalSales: 0, generalSupply: 0, storeTotal: 0 },
  );
  const sanbangGeneralMargin = shinwaTotal.generalSales - shinwaTotal.generalSupply; // = generalSales × 3%

  // 6섹션 — 산방에프앤비 월간 손익 (출고기준 P&L + 현금흐름 참고)
  //   매출  : 가맹점(직영 제외) + B2B
  //   원가  : 출고분 × 산방푸드 판매가 + 신화 전용 수수료 + 신화 범용 공급대금(97%)
  //   직영(상공회의소점) 정책:
  //     - 매출/매입 0 (산방에프앤비를 거치지 않음)
  //     - 단, 5섹션 직영분 신화 수수료는 산방에프앤비 부담 → 비용으로 잡힘
  //   B2B는 product_id가 없어서 product_name 매핑으로 산방푸드 판매가 조회
  const productByName = new Map(exclusiveProducts.map((p) => [p.name, p]));

  // 출고기준 매출원가 — 전용상품
  let exclusiveCogs = 0;
  orders.forEach((order) => {
    if (order.stores?.is_direct) return; // 직영 제외 (매출 0이므로 원가도 0)
    order.order_items.forEach((item) => {
      if (item.product_type !== 'exclusive') return;
      if (!item.product_id) return;
      const p = productMap.get(item.product_id);
      if (!p) return;
      const ppb = p.pack_per_box || 1;
      const boxPrice = p.sanbang_food_sale_price_with_tax;
      const packPrice = ppb > 1 ? Math.round(boxPrice / ppb) : boxPrice;
      exclusiveCogs += item.quantity * (item.unit === 'pack' ? packPrice : boxPrice);
    });
  });
  b2bOrders.forEach((order) => {
    order.b2b_order_items.forEach((item) => {
      const p = productByName.get(item.product_name);
      if (!p) return;
      const ppb = p.pack_per_box || 1;
      const boxPrice = p.sanbang_food_sale_price_with_tax;
      const packPrice = ppb > 1 ? Math.round(boxPrice / ppb) : boxPrice;
      exclusiveCogs += item.quantity * (item.unit === 'pack' ? packPrice : boxPrice);
    });
  });

  // 매출 — 가맹점(직영 제외) + B2B
  const storeRevenue = storeSalesTotal.total; // 1섹션은 이미 직영 제외
  const b2bRevenue = b2bOrders.reduce(
    (sum, o) => sum + o.b2b_order_items.reduce((s, i) => s + i.subtotal, 0),
    0,
  );
  const pnlRevenue = storeRevenue + b2bRevenue;

  // 비용
  const pnlShinwaExclusiveFee = shinwaTotal.exclusiveFee;   // 직영 포함 (산방에프앤비가 부담)
  const pnlGeneralSupply = shinwaTotal.generalSupply;       // 범용 97%
  const pnlCosts = exclusiveCogs + pnlShinwaExclusiveFee + pnlGeneralSupply;

  // 영업이익
  const pnlOperatingProfit = pnlRevenue - pnlCosts;
  const pnlMargin = pnlRevenue > 0 ? (pnlOperatingProfit / pnlRevenue) * 100 : 0;

  // 현금흐름 (참고)
  //   직영 후불(4섹션)은 산방푸드 ↔ 직영 직접 결제라 산방에프앤비 통장과 무관
  const cashIn = storeSalesTotal.total + b2bRevenue;        // 가맹+B2B 입금 (예치금/B2B)
  const cashOutSanbang = inboundTotal.amount;               // 산방푸드 지급 (입고기준)
  const cashOutShinwa = shinwaTotal.storeTotal;             // 신화 지급
  const cashFlow = cashIn - cashOutSanbang - cashOutShinwa;

  // 엑셀 다운로드 — 1섹션 가맹점 매출 표 기반
  const downloadExcel = () => {
    const header = ['가맹점', '과세 공급가', '부가세', '과세 합계', '면세 합계', '총 매출'];
    const body = storeSalesRows.map((r) => [
      r.name,
      String(r.taxableSupply),
      String(r.taxableTax),
      String(r.taxableTotal),
      String(r.taxFreeTotal),
      String(r.total),
    ]);
    const totalRow = [
      '합계',
      String(storeSalesTotal.taxableSupply),
      String(storeSalesTotal.taxableTax),
      String(storeSalesTotal.taxableTotal),
      String(storeSalesTotal.taxFreeTotal),
      String(storeSalesTotal.total),
    ];
    const rows: (string[])[] = [header, ...body, totalRow];

    const csvContent = '\uFEFF' + rows
      .map((r) => r.map((c) => /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c).join(','))
      .join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `가맹점매출_${startDate}_${endDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // 2섹션 다운로드 — 입고 정산 (산방에프앤비 → 산방푸드)
  const downloadInboundExcel = () => {
    const header = ['상품', '입고 수량(박스)', '입고 건수', '단가(산방푸드 판매가)', '합계'];
    const body = inboundRows.map((r) => [
      r.name,
      String(r.quantity),
      String(r.txCount),
      String(r.unitPrice),
      String(r.amount),
    ]);
    const totalRow = ['합계', String(inboundTotal.quantity), '', '', String(inboundTotal.amount)];
    const rows: string[][] = [header, ...body, totalRow];

    const csv = '﻿' + rows
      .map((r) => r.map((c) => /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `입고정산_${startDate}_${endDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // 3섹션 다운로드 — 매입금액 (산방푸드 → 제조사) + 제조사별 합계
  const downloadCostExcel = () => {
    const header = ['제조사', '상품', '입고 수량(박스)', '입고 건수', '단가(제조사 매입가)', '합계'];
    const body = inboundRows.map((r) => [
      r.manufacturer,
      r.name,
      String(r.quantity),
      String(r.txCount),
      String(r.unitCostPrice),
      String(r.costAmount),
    ]);
    const totalRow = ['전체 합계', '', String(inboundTotal.quantity), '', '', String(inboundTotal.costAmount)];

    // 제조사별 합계 섹션
    const blank = ['', '', '', '', '', ''];
    const mHeader = ['제조사별 합계', '', '품목 수', '입고 수량(박스)', '', '합계'];
    const mBody = manufacturerRows.map((m) => [
      m.name, '', String(m.productCount), String(m.quantity), '', String(m.costAmount),
    ]);

    const rows: string[][] = [header, ...body, totalRow, blank, mHeader, ...mBody];

    const csv = '﻿' + rows
      .map((r) => r.map((c) => /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `매입금액_${startDate}_${endDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // 4섹션 다운로드 — 직영점 후불 (산방푸드 → 상공회의소점)
  const downloadDirectExcel = () => {
    const header = ['상품', '박스 수량', '낱팩 수량', '박스 단가', '낱팩 단가', '합계'];
    const body = directRows.map((r) => [
      r.name,
      String(r.qtyBox),
      String(r.qtyPack),
      String(r.boxPrice),
      r.qtyPack > 0 ? String(r.packPrice) : '',
      String(r.amount),
    ]);
    const totalRow = [
      '합계',
      String(directTotal.qtyBox),
      String(directTotal.qtyPack),
      '',
      '',
      String(directTotal.amount),
    ];
    const rows: string[][] = [header, ...body, totalRow];

    const csv = '﻿' + rows
      .map((r) => r.map((c) => /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `직영점후불_${startDate}_${endDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // 5섹션 다운로드 — 신화푸드 정산
  const downloadShinwaExcel = () => {
    const header = [
      '매장/거래처', '채널', '권역', '수수료율',
      '전용 매출', '전용 수수료',
      '범용 매출', '범용 공급대금(97%)',
      '신화 정산 합계',
    ];
    const body = shinwaRows.map((r) => [
      r.name,
      r.channel === 'b2b' ? 'B2B' : (r.is_direct ? '직영' : '가맹점'),
      r.region === 'jeju' ? '제주' : '육지',
      `${(r.feeRate * 100).toFixed(1)}%`,
      String(r.exclusiveSales),
      String(r.exclusiveFee),
      String(r.generalSales),
      String(r.generalSupply),
      String(r.storeTotal),
    ]);
    const totalRow = [
      '합계', '', '', '',
      String(shinwaTotal.exclusiveSales),
      String(shinwaTotal.exclusiveFee),
      String(shinwaTotal.generalSales),
      String(shinwaTotal.generalSupply),
      String(shinwaTotal.storeTotal),
    ];
    const blank = ['', '', '', '', '', '', '', '', ''];
    const marginRow = ['산방에프앤비 범용 마진(3%)', '', '', '', '', '', '', '', String(sanbangGeneralMargin)];
    const rows: string[][] = [header, ...body, totalRow, blank, marginRow];

    const csv = '﻿' + rows
      .map((r) => r.map((c) => /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `신화푸드정산_${startDate}_${endDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-gray-800">정산 관리</h2>

      {/* 기간 선택 — 출고일(ship_date) 기준 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 flex items-center flex-wrap gap-3">
        <span className="text-sm font-medium text-gray-700">출고일 기간</span>
        <input
          type="date"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-gray-900 text-sm"
        />
        <span className="text-gray-400">~</span>
        <input
          type="date"
          value={endDate}
          onChange={(e) => setEndDate(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-gray-900 text-sm"
        />
        <div className="flex gap-1 ml-1">
          <button
            onClick={setThisMonth}
            className="px-3 py-1.5 border border-gray-300 rounded-lg text-xs text-gray-700 hover:bg-gray-50"
          >
            이번달
          </button>
          <button
            onClick={setLastMonth}
            className="px-3 py-1.5 border border-gray-300 rounded-lg text-xs text-gray-700 hover:bg-gray-50"
          >
            지난달
          </button>
        </div>
        <button
          onClick={search}
          disabled={loading}
          className="ml-auto px-5 py-2 bg-[#1B4332] text-white rounded-lg text-sm font-bold hover:bg-[#2D6A4F] transition disabled:bg-gray-300"
        >
          {loading ? '조회 중...' : '조회'}
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">
          {error}
        </div>
      )}

      {loading && (
        <div className="flex justify-center py-12">
          <div className="w-8 h-8 border-4 border-[#1B4332] border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {!loading && !searched && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 text-center text-gray-400 text-sm">
          기간을 선택하고 <strong className="text-gray-600">조회</strong> 버튼을 눌러주세요.
        </div>
      )}

      {!loading && searched && (<>

      {/* 1. 가맹점 매출 — 계산서 발행 대상 */}
      <section className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <header className="px-5 py-4 border-b border-gray-200 flex items-baseline justify-between flex-wrap gap-3">
          <div>
            <h3 className="font-bold text-gray-900">1. 가맹점 매출</h3>
            <p className="text-xs text-gray-500 mt-1">
              산방에프앤비 → 가맹점 · 계산서 발행 대상 · 직영점 제외
            </p>
            <FlowChips
              payment="가맹점 → 산방에프앤비 (예치금에서 차감)"
              invoice="산방에프앤비 → 가맹점 (전용+범용 합산)"
            />
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-500">
              {startDate} ~ {endDate} · 출고완료 {shippedCount} · 출고예정 {pendingShipCount}
            </span>
            <button
              onClick={downloadExcel}
              disabled={storeSalesRows.length === 0}
              className="px-3 py-1.5 bg-[#1B4332] text-white rounded-lg text-xs font-medium hover:bg-[#2D6A4F] transition disabled:bg-gray-300 disabled:cursor-not-allowed"
            >
              엑셀
            </button>
          </div>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[760px]">
            <thead className="bg-gray-50 border-b border-gray-200 text-gray-600">
              <tr>
                <th className="px-4 py-3 text-left font-medium">가맹점</th>
                <th className="px-4 py-3 text-right font-medium">과세 공급가</th>
                <th className="px-4 py-3 text-right font-medium">부가세</th>
                <th className="px-4 py-3 text-right font-medium">과세 합계</th>
                <th className="px-4 py-3 text-right font-medium">면세 합계</th>
                <th className="px-4 py-3 text-right font-medium text-gray-800">총 매출</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 text-gray-700">
              {storeSalesRows.map((r) => (
                <tr key={r.store_id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-800">{r.name}</td>
                  <td className="px-4 py-3 text-right">₩{r.taxableSupply.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">₩{r.taxableTax.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">₩{r.taxableTotal.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">
                    {r.taxFreeTotal > 0 ? `₩${r.taxFreeTotal.toLocaleString()}` : '-'}
                  </td>
                  <td className="px-4 py-3 text-right font-bold text-gray-900">
                    ₩{r.total.toLocaleString()}
                  </td>
                </tr>
              ))}
              {storeSalesRows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-gray-400">
                    해당 기간 가맹점 매출이 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
            {storeSalesRows.length > 0 && (
              <tfoot className="bg-gray-50 border-t-2 border-gray-300 text-gray-800 font-semibold">
                <tr>
                  <td className="px-4 py-3">합계</td>
                  <td className="px-4 py-3 text-right">₩{storeSalesTotal.taxableSupply.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">₩{storeSalesTotal.taxableTax.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">₩{storeSalesTotal.taxableTotal.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">
                    {storeSalesTotal.taxFreeTotal > 0 ? `₩${storeSalesTotal.taxFreeTotal.toLocaleString()}` : '-'}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-900">₩{storeSalesTotal.total.toLocaleString()}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </section>

      {/* 2. 산방에프앤비 → 산방푸드 (입고 정산) */}
      <section className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <header className="px-5 py-4 border-b border-gray-200 flex items-baseline justify-between flex-wrap gap-3">
          <div>
            <h3 className="font-bold text-gray-900">2. 산방에프앤비 → 산방푸드 (입고 정산)</h3>
            <p className="text-xs text-gray-500 mt-1">
              기간 내 산방푸드가 보낸 입고분 × 산방푸드 판매가 · 발주/B2B 취소 복구는 제외
            </p>
            <FlowChips
              payment="산방에프앤비 → 산방푸드 (전용상품 공급대금)"
              invoice="산방푸드 → 산방에프앤비"
            />
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-500">
              {startDate} ~ {endDate} · 입고 {inbounds.length}건
            </span>
            <button
              onClick={downloadInboundExcel}
              disabled={inboundRows.length === 0}
              className="px-3 py-1.5 bg-[#1B4332] text-white rounded-lg text-xs font-medium hover:bg-[#2D6A4F] transition disabled:bg-gray-300 disabled:cursor-not-allowed"
            >
              엑셀
            </button>
          </div>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[640px]">
            <thead className="bg-gray-50 border-b border-gray-200 text-gray-600">
              <tr>
                <th className="px-4 py-3 text-left font-medium">상품</th>
                <th className="px-4 py-3 text-right font-medium">입고 수량</th>
                <th className="px-4 py-3 text-right font-medium">단가 (산방푸드 판매가)</th>
                <th className="px-4 py-3 text-right font-medium text-gray-800">합계</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 text-gray-700">
              {inboundRows.map((r) => (
                <tr key={r.product_id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-800">{r.name}</td>
                  <td className="px-4 py-3 text-right">
                    {r.quantity.toLocaleString()} 박스
                    <span className="text-xs text-gray-400 ml-1">({r.txCount}건)</span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {r.unitPrice > 0 ? `₩${r.unitPrice.toLocaleString()}` : (
                      <span className="text-amber-600 text-xs">단가 미입력</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-bold text-gray-900">
                    ₩{r.amount.toLocaleString()}
                  </td>
                </tr>
              ))}
              {inboundRows.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-12 text-center text-gray-400">
                    해당 기간 입고 내역이 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
            {inboundRows.length > 0 && (
              <tfoot className="bg-gray-50 border-t-2 border-gray-300 text-gray-800 font-semibold">
                <tr>
                  <td className="px-4 py-3">합계</td>
                  <td className="px-4 py-3 text-right">{inboundTotal.quantity.toLocaleString()} 박스</td>
                  <td className="px-4 py-3 text-right text-gray-400">-</td>
                  <td className="px-4 py-3 text-right text-gray-900">₩{inboundTotal.amount.toLocaleString()}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </section>

      {/* 3. 산방푸드 → 제조사 (매입금액) */}
      <section className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <header className="px-5 py-4 border-b border-gray-200 flex items-baseline justify-between flex-wrap gap-3">
          <div>
            <h3 className="font-bold text-gray-900">3. 산방푸드 → 제조사 (매입금액)</h3>
            <p className="text-xs text-gray-500 mt-1">
              기간 내 입고분 × 제조사 매입가 · 산방푸드가 제조사에 결제할 금액
            </p>
            <FlowChips
              payment="산방푸드 → 제조사 (제조사별 합계 기준)"
              invoice="제조사 → 산방푸드 (원자재 매입)"
            />
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-500">
              {startDate} ~ {endDate} · 입고 {inbounds.length}건
            </span>
            <button
              onClick={downloadCostExcel}
              disabled={inboundRows.length === 0}
              className="px-3 py-1.5 bg-[#1B4332] text-white rounded-lg text-xs font-medium hover:bg-[#2D6A4F] transition disabled:bg-gray-300 disabled:cursor-not-allowed"
            >
              엑셀
            </button>
          </div>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[720px]">
            <thead className="bg-gray-50 border-b border-gray-200 text-gray-600">
              <tr>
                <th className="px-4 py-3 text-left font-medium">제조사</th>
                <th className="px-4 py-3 text-left font-medium">상품</th>
                <th className="px-4 py-3 text-right font-medium">입고 수량</th>
                <th className="px-4 py-3 text-right font-medium">단가 (매입가)</th>
                <th className="px-4 py-3 text-right font-medium text-gray-800">합계</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 text-gray-700">
              {inboundRows.map((r, idx) => {
                const prev = inboundRows[idx - 1];
                const showManufacturer = !prev || prev.manufacturer !== r.manufacturer;
                return (
                  <tr key={r.product_id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-700 align-top">
                      {showManufacturer && (
                        <span className="text-sm font-medium">{r.manufacturer}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-medium text-gray-800">{r.name}</td>
                    <td className="px-4 py-3 text-right">
                      {r.quantity.toLocaleString()} 박스
                      <span className="text-xs text-gray-400 ml-1">({r.txCount}건)</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {r.unitCostPrice > 0 ? `₩${r.unitCostPrice.toLocaleString()}` : (
                        <span className="text-amber-600 text-xs">단가 미입력</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-bold text-gray-900">
                      ₩{r.costAmount.toLocaleString()}
                    </td>
                  </tr>
                );
              })}
              {inboundRows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-gray-400">
                    해당 기간 입고 내역이 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
            {inboundRows.length > 0 && (
              <tfoot className="bg-gray-50 border-t-2 border-gray-300 text-gray-800 font-semibold">
                <tr>
                  <td className="px-4 py-3" colSpan={2}>합계</td>
                  <td className="px-4 py-3 text-right">{inboundTotal.quantity.toLocaleString()} 박스</td>
                  <td className="px-4 py-3 text-right text-gray-400">-</td>
                  <td className="px-4 py-3 text-right text-gray-900">₩{inboundTotal.costAmount.toLocaleString()}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        {/* 제조사별 마감 합계 */}
        {manufacturerRows.length > 0 && (
          <div className="border-t border-gray-200 bg-gray-50 px-5 py-4">
            <h4 className="text-xs font-semibold text-gray-600 mb-3">제조사별 마감 합계</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {manufacturerRows.map((m) => (
                <div key={m.name} className="bg-white border border-gray-200 rounded-lg px-4 py-3">
                  <p className="text-xs text-gray-500 mb-1">{m.name}</p>
                  <p className="text-base font-bold text-gray-900">₩{m.costAmount.toLocaleString()}</p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {m.productCount}품목 · {m.quantity.toLocaleString()}박스
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* 4. 산방푸드 → 상공회의소점 (직영 후불) */}
      <section className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <header className="px-5 py-4 border-b border-gray-200 flex items-baseline justify-between flex-wrap gap-3">
          <div>
            <h3 className="font-bold text-gray-900">4. 산방푸드 → 상공회의소점 (직영 후불)</h3>
            <p className="text-xs text-gray-500 mt-1">
              기간 내 상공회의소점 출고분 × 산방푸드 판매가 · 같은 법인이라 산방푸드와 직접 거래 (전용상품만)
            </p>
            <FlowChips
              payment="상공회의소점 → 산방푸드 (월마감 후 후불)"
              invoice="산방푸드 → 상공회의소점"
            />
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-500">
              {startDate} ~ {endDate} · 출고기준
            </span>
            <button
              onClick={downloadDirectExcel}
              disabled={directRows.length === 0}
              className="px-3 py-1.5 bg-[#1B4332] text-white rounded-lg text-xs font-medium hover:bg-[#2D6A4F] transition disabled:bg-gray-300 disabled:cursor-not-allowed"
            >
              엑셀
            </button>
          </div>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[680px]">
            <thead className="bg-gray-50 border-b border-gray-200 text-gray-600">
              <tr>
                <th className="px-4 py-3 text-left font-medium">상품</th>
                <th className="px-4 py-3 text-right font-medium">출고 수량</th>
                <th className="px-4 py-3 text-right font-medium">단가 (산방푸드 판매가)</th>
                <th className="px-4 py-3 text-right font-medium text-gray-800">합계</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 text-gray-700">
              {directRows.map((r) => (
                <tr key={r.product_id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-800">{r.name}</td>
                  <td className="px-4 py-3 text-right">
                    {r.qtyBox > 0 && <span>{r.qtyBox.toLocaleString()} 박스</span>}
                    {r.qtyBox > 0 && r.qtyPack > 0 && <span className="text-gray-400 mx-1">·</span>}
                    {r.qtyPack > 0 && <span>{r.qtyPack.toLocaleString()} 팩</span>}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {r.boxPrice > 0 ? (
                      <>
                        ₩{r.boxPrice.toLocaleString()}
                        {r.qtyPack > 0 && (
                          <div className="text-xs text-gray-400">팩 ₩{r.packPrice.toLocaleString()}</div>
                        )}
                      </>
                    ) : (
                      <span className="text-amber-600 text-xs">단가 미입력</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-bold text-gray-900">
                    ₩{r.amount.toLocaleString()}
                  </td>
                </tr>
              ))}
              {directRows.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-12 text-center text-gray-400">
                    해당 기간 상공회의소점 출고 내역이 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
            {directRows.length > 0 && (
              <tfoot className="bg-gray-50 border-t-2 border-gray-300 text-gray-800 font-semibold">
                <tr>
                  <td className="px-4 py-3">합계</td>
                  <td className="px-4 py-3 text-right">
                    {directTotal.qtyBox > 0 && <span>{directTotal.qtyBox.toLocaleString()} 박스</span>}
                    {directTotal.qtyBox > 0 && directTotal.qtyPack > 0 && <span className="text-gray-400 mx-1">·</span>}
                    {directTotal.qtyPack > 0 && <span>{directTotal.qtyPack.toLocaleString()} 팩</span>}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-400">-</td>
                  <td className="px-4 py-3 text-right text-gray-900">₩{directTotal.amount.toLocaleString()}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </section>

      {/* 5. 산방에프앤비 → 신화푸드 (정산) */}
      <section className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <header className="px-5 py-4 border-b border-gray-200 flex items-baseline justify-between flex-wrap gap-3">
          <div>
            <h3 className="font-bold text-gray-900">5. 산방에프앤비 → 신화푸드 (정산)</h3>
            <p className="text-xs text-gray-500 mt-1">
              전용 배송수수료 (제주 12.5% / 육지 8.5%) + 범용 공급대금 (97%) · 직영·B2B 모두 포함, 가맹판가 기준
            </p>
            <FlowChips
              payment="산방에프앤비 → 신화푸드 (전용 수수료 + 범용 공급대금)"
              invoice="신화푸드 → 산방에프앤비"
            />
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-500">
              {startDate} ~ {endDate} · 출고기준
            </span>
            <button
              onClick={downloadShinwaExcel}
              disabled={shinwaRows.length === 0}
              className="px-3 py-1.5 bg-[#1B4332] text-white rounded-lg text-xs font-medium hover:bg-[#2D6A4F] transition disabled:bg-gray-300 disabled:cursor-not-allowed"
            >
              엑셀
            </button>
          </div>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[920px]">
            <thead className="bg-gray-50 border-b border-gray-200 text-gray-600">
              <tr>
                <th className="px-3 py-3 text-left font-medium">매장/거래처</th>
                <th className="px-3 py-3 text-left font-medium">권역</th>
                <th className="px-3 py-3 text-right font-medium">전용 매출</th>
                <th className="px-3 py-3 text-right font-medium">전용 수수료</th>
                <th className="px-3 py-3 text-right font-medium">범용 매출</th>
                <th className="px-3 py-3 text-right font-medium">범용 공급대금<span className="text-xs text-gray-400 font-normal"> (97%)</span></th>
                <th className="px-3 py-3 text-right font-medium text-gray-800">합계</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 text-gray-700">
              {shinwaRows.map((r) => (
                <tr key={r.party_id} className="hover:bg-gray-50">
                  <td className="px-3 py-3 font-medium text-gray-800">
                    {r.name}
                    {r.is_direct && (
                      <span className="ml-1 px-1.5 py-0.5 rounded text-[10px] bg-blue-100 text-blue-700">직영</span>
                    )}
                    {r.channel === 'b2b' && (
                      <span className="ml-1 px-1.5 py-0.5 rounded text-[10px] bg-purple-100 text-purple-700">B2B</span>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <span className="text-gray-700">{r.region === 'jeju' ? '제주' : '육지'}</span>
                    <span className="text-xs text-gray-400 ml-1">({(r.feeRate * 100).toFixed(1)}%)</span>
                  </td>
                  <td className="px-3 py-3 text-right">
                    {r.exclusiveSales > 0 ? `₩${r.exclusiveSales.toLocaleString()}` : <span className="text-gray-300">-</span>}
                  </td>
                  <td className="px-3 py-3 text-right">
                    {r.exclusiveFee > 0 ? `₩${r.exclusiveFee.toLocaleString()}` : <span className="text-gray-300">-</span>}
                  </td>
                  <td className="px-3 py-3 text-right">
                    {r.generalSales > 0 ? `₩${r.generalSales.toLocaleString()}` : <span className="text-gray-300">-</span>}
                  </td>
                  <td className="px-3 py-3 text-right">
                    {r.generalSupply > 0 ? `₩${r.generalSupply.toLocaleString()}` : <span className="text-gray-300">-</span>}
                  </td>
                  <td className="px-3 py-3 text-right font-bold text-gray-900">₩{r.storeTotal.toLocaleString()}</td>
                </tr>
              ))}
              {shinwaRows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-gray-400">
                    해당 기간 신화푸드 정산 대상이 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
            {shinwaRows.length > 0 && (
              <tfoot className="bg-gray-50 border-t-2 border-gray-300 text-gray-800 font-semibold">
                <tr>
                  <td className="px-3 py-3" colSpan={2}>합계</td>
                  <td className="px-3 py-3 text-right">₩{shinwaTotal.exclusiveSales.toLocaleString()}</td>
                  <td className="px-3 py-3 text-right">₩{shinwaTotal.exclusiveFee.toLocaleString()}</td>
                  <td className="px-3 py-3 text-right">₩{shinwaTotal.generalSales.toLocaleString()}</td>
                  <td className="px-3 py-3 text-right">₩{shinwaTotal.generalSupply.toLocaleString()}</td>
                  <td className="px-3 py-3 text-right text-gray-900">₩{shinwaTotal.storeTotal.toLocaleString()}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        {/* 킥포인트: 신화푸드에 보낼 총액 */}
        {shinwaRows.length > 0 && (
          <div className="border-t border-gray-200 bg-[#1B4332]/5 px-5 py-4">
            <div className="flex items-baseline justify-between flex-wrap gap-3">
              <div>
                <p className="text-xs text-gray-600 mb-1">신화푸드에 보낼 총액</p>
                <p className="text-sm text-gray-700">
                  전용 수수료 <strong className="text-gray-900">₩{shinwaTotal.exclusiveFee.toLocaleString()}</strong>
                  <span className="text-gray-400 mx-2">＋</span>
                  범용 공급대금 <strong className="text-gray-900">₩{shinwaTotal.generalSupply.toLocaleString()}</strong>
                  <span className="text-gray-400 mx-2">＝</span>
                </p>
              </div>
              <div className="text-right">
                <p className="text-2xl font-bold text-[#1B4332]">
                  ₩{shinwaTotal.storeTotal.toLocaleString()}
                </p>
              </div>
            </div>
            <div className="mt-3 pt-3 border-t border-[#1B4332]/10 text-xs text-gray-500 flex flex-wrap gap-x-6 gap-y-1">
              <span>전용 매출 ₩{shinwaTotal.exclusiveSales.toLocaleString()} (제주 12.5% / 육지 8.5% 적용)</span>
              <span>범용 매출 ₩{shinwaTotal.generalSales.toLocaleString()} × 97%</span>
              <span>참고: 산방에프앤비 범용 마진(3%) ₩{sanbangGeneralMargin.toLocaleString()}</span>
            </div>
          </div>
        )}
      </section>

      {/* 6. 산방에프앤비 월간 손익 — 출고기준 P&L + 현금흐름 */}
      <section className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <header className="px-5 py-4 border-b border-gray-200 flex items-baseline justify-between flex-wrap gap-3">
          <div>
            <h3 className="font-bold text-gray-900">6. 산방에프앤비 월간 손익</h3>
            <p className="text-xs text-gray-500 mt-1">
              출고기준 영업이익 + 현금흐름 참고 · 직영(상공회의소점)은 매출/매입에서 제외 (단, 직영분 신화 수수료는 산방에프앤비 부담으로 비용에 포함)
            </p>
          </div>
          <span className="text-xs text-gray-500">{startDate} ~ {endDate}</span>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-0 lg:divide-x divide-gray-200">
          {/* 좌: 영업이익 (P&L) */}
          <div className="p-5">
            <h4 className="text-xs font-semibold text-gray-600 mb-3">영업이익 (출고기준)</h4>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between text-gray-700">
                <dt>가맹점 매출 <span className="text-xs text-gray-400">(직영 제외)</span></dt>
                <dd className="font-medium">₩{storeRevenue.toLocaleString()}</dd>
              </div>
              <div className="flex justify-between text-gray-700">
                <dt>B2B 매출</dt>
                <dd className="font-medium">₩{b2bRevenue.toLocaleString()}</dd>
              </div>
              <div className="flex justify-between border-t border-gray-200 pt-2 text-gray-900 font-semibold">
                <dt>총 매출</dt>
                <dd>₩{pnlRevenue.toLocaleString()}</dd>
              </div>

              <div className="flex justify-between text-gray-700 pt-3">
                <dt>전용 매입원가 <span className="text-xs text-gray-400">(산방푸드 판매가)</span></dt>
                <dd className="font-medium text-rose-600">-₩{exclusiveCogs.toLocaleString()}</dd>
              </div>
              <div className="flex justify-between text-gray-700">
                <dt>신화 전용 배송수수료 <span className="text-xs text-gray-400">(직영 포함)</span></dt>
                <dd className="font-medium text-rose-600">-₩{pnlShinwaExclusiveFee.toLocaleString()}</dd>
              </div>
              <div className="flex justify-between text-gray-700">
                <dt>신화 범용 공급대금 <span className="text-xs text-gray-400">(97%)</span></dt>
                <dd className="font-medium text-rose-600">-₩{pnlGeneralSupply.toLocaleString()}</dd>
              </div>
              <div className="flex justify-between border-t border-gray-200 pt-2 text-gray-900 font-semibold">
                <dt>총 비용</dt>
                <dd className="text-rose-600">-₩{pnlCosts.toLocaleString()}</dd>
              </div>

              <div className="flex justify-between border-t-2 border-gray-300 pt-3 mt-2 items-baseline">
                <dt className="font-bold text-gray-900">영업이익</dt>
                <dd className="text-right">
                  <span className={`text-2xl font-bold ${pnlOperatingProfit >= 0 ? 'text-[#1B4332]' : 'text-rose-700'}`}>
                    ₩{pnlOperatingProfit.toLocaleString()}
                  </span>
                  <span className="ml-2 text-xs text-gray-500">({pnlMargin.toFixed(1)}%)</span>
                </dd>
              </div>
            </dl>
          </div>

          {/* 우: 현금흐름 */}
          <div className="p-5 bg-gray-50/50">
            <h4 className="text-xs font-semibold text-gray-600 mb-3">현금흐름 (참고)</h4>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between text-gray-700">
                <dt>가맹점 + B2B 입금 <span className="text-xs text-gray-400">(예치금 충전 등)</span></dt>
                <dd className="font-medium text-emerald-700">+₩{cashIn.toLocaleString()}</dd>
              </div>
              <div className="flex justify-between text-gray-700">
                <dt>산방푸드 지급 <span className="text-xs text-gray-400">(2섹션, 입고기준)</span></dt>
                <dd className="font-medium text-rose-600">-₩{cashOutSanbang.toLocaleString()}</dd>
              </div>
              <div className="flex justify-between text-gray-700">
                <dt>신화푸드 지급 <span className="text-xs text-gray-400">(5섹션 합계)</span></dt>
                <dd className="font-medium text-rose-600">-₩{cashOutShinwa.toLocaleString()}</dd>
              </div>
              <div className="flex justify-between border-t-2 border-gray-300 pt-3 mt-2 items-baseline">
                <dt className="font-bold text-gray-900">이달 현금 변동</dt>
                <dd className="text-right">
                  <span className={`text-2xl font-bold ${cashFlow >= 0 ? 'text-[#1B4332]' : 'text-rose-700'}`}>
                    {cashFlow >= 0 ? '+' : ''}₩{cashFlow.toLocaleString()}
                  </span>
                </dd>
              </div>
            </dl>
            <p className="text-[11px] text-gray-400 mt-3 leading-relaxed">
              현금흐름은 입고시점/지급시점 기준이라 출고기준 영업이익과 다를 수 있음.
              산방푸드 입고가 많은 달은 현금이 더 빠지지만 재고로 남아있어 손익에는 반영 안 됨.
              직영점 후불(4섹션)은 산방푸드 ↔ 직영 직접 결제라 산방에프앤비 통장과 무관.
            </p>
          </div>
        </div>
      </section>

      </>)}
    </div>
  );
}
