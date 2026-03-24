'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

interface OrderWithItems {
  id: string;
  order_number: string;
  store_id: string;
  status: string;
  total_amount: number;
  created_at: string;
  stores: { name: string; short_name: string; is_direct: boolean } | null;
  order_items: {
    product_name: string;
    product_type: string;
    quantity: number;
    unit_price: number;
    unit_price_with_tax: number;
    subtotal: number;
    is_tax_free: boolean;
  }[];
}

interface ProductCost {
  id: string;
  name: string;
  cost_price: number;
  cost_price_with_tax: number;
  price: number;
  price_with_tax: number;
}

export default function SettlementPage() {
  const [year, setYear] = useState(new Date().getFullYear());
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [orders, setOrders] = useState<OrderWithItems[]>([]);
  const [products, setProducts] = useState<ProductCost[]>([]);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  useEffect(() => {
    loadData();
  }, [year, month]);

  async function loadData() {
    setLoading(true);

    // 해당 월의 배송완료/확정 주문 조회 (출고일 = created_at 기준, 추후 delivery_date로 변경 가능)
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDate = month === 12
      ? `${year + 1}-01-01`
      : `${year}-${String(month + 1).padStart(2, '0')}-01`;

    const { data: orderData } = await supabase
      .from('orders')
      .select('*, stores(name, short_name, is_direct), order_items(*)')
      .in('status', ['confirmed', 'shipping', 'delivered'])
      .gte('created_at', startDate)
      .lt('created_at', endDate)
      .order('created_at');

    setOrders((orderData as OrderWithItems[]) || []);

    // 상품 원가 정보
    const { data: prodData } = await supabase
      .from('products')
      .select('id, name, cost_price, cost_price_with_tax, price, price_with_tax')
      .eq('product_type', 'exclusive');

    setProducts((prodData as ProductCost[]) || []);
    setLoading(false);
  }

  // 계산
  const storeOrders = new Map<string, { name: string; is_direct: boolean; exclusive: number; general: number; total: number }>();

  let totalExclusive = 0; // 전용 판매액 (가맹점 기준)
  let totalGeneral = 0; // 범용 판매액
  let totalExclusiveDirect = 0; // 직영점 전용
  let totalGeneralDirect = 0; // 직영점 범용
  let totalCostPrice = 0; // 산방푸드시스템즈 공급대금

  orders.forEach((order) => {
    const storeName = order.stores?.short_name || order.stores?.name || '알 수 없음';
    const isDirect = order.stores?.is_direct || false;

    let excl = 0;
    let gen = 0;

    order.order_items.forEach((item) => {
      if (item.product_type === 'exclusive') {
        excl += item.subtotal;
      } else {
        gen += item.subtotal;
      }
    });

    if (isDirect) {
      totalExclusiveDirect += excl;
      totalGeneralDirect += gen;
    } else {
      totalExclusive += excl;
      totalGeneral += gen;
    }

    const existing = storeOrders.get(order.store_id) || { name: storeName, is_direct: isDirect, exclusive: 0, general: 0, total: 0 };
    existing.exclusive += excl;
    existing.general += gen;
    existing.total += excl + gen;
    storeOrders.set(order.store_id, existing);
  });

  // 산방푸드시스템즈 공급대금 계산 (전용상품 매입가 기준)
  orders.forEach((order) => {
    order.order_items.forEach((item) => {
      if (item.product_type === 'exclusive') {
        // cost_price_with_tax 기준으로 계산
        const prod = products.find((p) => p.name === item.product_name);
        if (prod) {
          totalCostPrice += prod.cost_price_with_tax * item.quantity;
        }
      }
    });
  });

  const deliveryFee = Math.round((totalExclusive + totalExclusiveDirect) * 0.10); // 전용 판매가의 10%
  const generalSupply = Math.round((totalGeneral + totalGeneralDirect) * 0.97); // 범용 판매가의 97%
  const directTotal = totalExclusiveDirect + totalGeneralDirect; // 직영점 후불 정산

  const totalIncome = totalExclusive + totalGeneral; // 가맹점에서 받은 돈 (예치금)
  const totalExpense = totalCostPrice + deliveryFee + generalSupply + directTotal;
  const profit = totalIncome - totalExpense + directTotal; // 직영점 매출은 수입에 안 잡히므로 보정

  // 엑셀 다운로드
  const downloadExcel = () => {
    const rows: string[][] = [
      ['주문번호', '주문일', '가맹점', '직영/가맹', '상품구분', '상품명', '수량', '단가(세포함)', '금액'],
    ];

    orders.forEach((order) => {
      const storeName = order.stores?.short_name || order.stores?.name || '';
      const storeType = order.stores?.is_direct ? '직영' : '가맹';
      order.order_items.forEach((item) => {
        rows.push([
          order.order_number,
          new Date(order.created_at).toLocaleDateString('ko-KR'),
          storeName,
          storeType,
          item.product_type === 'exclusive' ? '전용' : '범용',
          item.product_name,
          String(item.quantity),
          String(item.unit_price_with_tax),
          String(item.subtotal),
        ]);
      });
    });

    const csvContent = '\uFEFF' + rows.map((r) => r.join(',')).join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `정산_${year}년${month}월.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="w-8 h-8 border-4 border-[#1B4332] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-gray-800">정산 관리</h2>
        <button
          onClick={downloadExcel}
          className="px-4 py-2 bg-[#1B4332] text-white rounded-lg text-sm font-medium hover:bg-[#2D6A4F] transition"
        >
          엑셀 다운로드
        </button>
      </div>

      {/* 월 선택 */}
      <div className="flex gap-3">
        <select
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
          className="px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
        >
          {[2025, 2026, 2027].map((y) => (
            <option key={y} value={y}>{y}년</option>
          ))}
        </select>
        <select
          value={month}
          onChange={(e) => setMonth(Number(e.target.value))}
          className="px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
        >
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
            <option key={m} value={m}>{m}월</option>
          ))}
        </select>
      </div>

      {/* 정산 요약 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 space-y-6">
        <h3 className="font-bold text-lg text-gray-800">
          {year}년 {month}월 정산 요약
        </h3>

        {/* 받은 돈 */}
        <div>
          <h4 className="font-semibold text-green-700 mb-2">받은 돈 (가맹점 예치금)</h4>
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-600">+ 전용상품 매출 (가맹점)</span>
              <span className="font-medium text-gray-800">₩{totalExclusive.toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">+ 범용상품 매출 (가맹점)</span>
              <span className="font-medium text-gray-800">₩{totalGeneral.toLocaleString()}</span>
            </div>
            <div className="flex justify-between pt-1 border-t border-gray-100 font-semibold">
              <span className="text-green-700">소계</span>
              <span className="text-green-700">₩{totalIncome.toLocaleString()}</span>
            </div>
          </div>
        </div>

        {/* 직영점 (후불) */}
        {directTotal > 0 && (
          <div>
            <h4 className="font-semibold text-blue-700 mb-2">직영점 발주 (후불 정산)</h4>
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-600">전용상품</span>
                <span className="font-medium text-gray-800">₩{totalExclusiveDirect.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">범용상품</span>
                <span className="font-medium text-gray-800">₩{totalGeneralDirect.toLocaleString()}</span>
              </div>
              <div className="flex justify-between pt-1 border-t border-gray-100 font-semibold">
                <span className="text-blue-700">소계 (신화푸드에 별도 입금)</span>
                <span className="text-blue-700">₩{directTotal.toLocaleString()}</span>
              </div>
            </div>
          </div>
        )}

        {/* 줘야 할 돈 */}
        <div>
          <h4 className="font-semibold text-red-700 mb-2">줘야 할 돈</h4>
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-600">- 산방푸드시스템즈 (전용상품 공급대금)</span>
              <span className="font-medium text-red-600">₩{totalCostPrice.toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">- 신화푸드 (전용 배송수수료 10%)</span>
              <span className="font-medium text-red-600">₩{deliveryFee.toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">- 신화푸드 (범용상품 공급대금 97%)</span>
              <span className="font-medium text-red-600">₩{generalSupply.toLocaleString()}</span>
            </div>
            {directTotal > 0 && (
              <div className="flex justify-between">
                <span className="text-gray-600">- 신화푸드 (직영점 후불 정산)</span>
                <span className="font-medium text-red-600">₩{directTotal.toLocaleString()}</span>
              </div>
            )}
            <div className="flex justify-between pt-1 border-t border-gray-100 font-semibold">
              <span className="text-red-700">소계</span>
              <span className="text-red-700">₩{totalExpense.toLocaleString()}</span>
            </div>
          </div>
        </div>

        {/* 순이익 */}
        <div className="pt-4 border-t-2 border-gray-300">
          <div className="flex justify-between items-center">
            <span className="text-lg font-bold text-gray-800">월 순이익</span>
            <span className={`text-2xl font-bold ${profit >= 0 ? 'text-green-700' : 'text-red-700'}`}>
              ₩{profit.toLocaleString()}
            </span>
          </div>
        </div>
      </div>

      {/* 계산서 체크리스트 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 space-y-4">
        <h3 className="font-bold text-lg text-gray-800">계산서 체크리스트</h3>

        <div>
          <h4 className="font-semibold text-sm text-gray-600 mb-2">📤 발행해야 할 계산서 (매출)</h4>
          <div className="space-y-2">
            {Array.from(storeOrders.entries())
              .filter(([, v]) => !v.is_direct)
              .map(([storeId, data]) => (
                <div key={storeId} className="flex justify-between text-sm bg-green-50 rounded-lg p-3">
                  <span className="text-gray-700">산방에프앤비 → <strong>{data.name}</strong></span>
                  <span className="font-semibold text-gray-800">₩{data.total.toLocaleString()}</span>
                </div>
              ))}
            {Array.from(storeOrders.entries()).filter(([, v]) => !v.is_direct).length === 0 && (
              <p className="text-sm text-gray-400">해당 월 발행할 계산서가 없습니다.</p>
            )}
          </div>
        </div>

        <div>
          <h4 className="font-semibold text-sm text-gray-600 mb-2">📥 받아야 할 계산서 (매입/비용)</h4>
          <div className="space-y-2">
            {totalCostPrice > 0 && (
              <div className="flex justify-between text-sm bg-red-50 rounded-lg p-3">
                <span className="text-gray-700">산방푸드시스템즈 → 산방에프앤비 <span className="text-gray-400">(전용상품 공급)</span></span>
                <span className="font-semibold text-gray-800">₩{totalCostPrice.toLocaleString()}</span>
              </div>
            )}
            {deliveryFee > 0 && (
              <div className="flex justify-between text-sm bg-red-50 rounded-lg p-3">
                <span className="text-gray-700">신화푸드 → 산방에프앤비 <span className="text-gray-400">(배송수수료)</span></span>
                <span className="font-semibold text-gray-800">₩{deliveryFee.toLocaleString()}</span>
              </div>
            )}
            {generalSupply > 0 && (
              <div className="flex justify-between text-sm bg-red-50 rounded-lg p-3">
                <span className="text-gray-700">신화푸드 → 산방에프앤비 <span className="text-gray-400">(범용상품 공급)</span></span>
                <span className="font-semibold text-gray-800">₩{generalSupply.toLocaleString()}</span>
              </div>
            )}
          </div>
        </div>

        {directTotal > 0 && (
          <div>
            <h4 className="font-semibold text-sm text-gray-600 mb-2">💰 직영점 후불 정산</h4>
            <div className="bg-blue-50 rounded-lg p-3 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-700">산방에프앤비 → 신화푸드 <span className="text-gray-400">(직영점 발주분)</span></span>
                <span className="font-semibold text-gray-800">₩{directTotal.toLocaleString()}</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 가맹점별 상세 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h3 className="font-bold text-lg text-gray-800 mb-4">가맹점별 발주 내역</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">가맹점</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">구분</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">전용상품</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">범용상품</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">합계</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {Array.from(storeOrders.entries()).map(([storeId, data]) => (
                <tr key={storeId} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-800">{data.name}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                      data.is_direct ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
                    }`}>
                      {data.is_direct ? '직영' : '가맹'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-gray-600">₩{data.exclusive.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right text-gray-600">₩{data.general.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right font-semibold text-gray-800">₩{data.total.toLocaleString()}</td>
                </tr>
              ))}
              {storeOrders.size === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-gray-400">해당 월 발주 내역이 없습니다.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
