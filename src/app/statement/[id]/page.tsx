'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useParams } from 'next/navigation';

interface OrderData {
  id: string;
  order_number: string;
  created_at: string;
  total_amount: number;
  memo: string | null;
  ship_date: string | null;
  stores: {
    name: string;
    short_name: string;
    owner_name: string;
    address: string;
    contact_name: string;
    contact_phone: string;
    allow_split_shipping: boolean;
  };
  order_items: {
    product_name: string;
    product_type: string;
    quantity: number;
    unit_price_with_tax: number;
    subtotal: number;
    ship_date: string | null;
  }[];
}

const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];
function formatShipDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '미지정';
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return `${d.getMonth() + 1}/${d.getDate()}(${DAY_NAMES[d.getDay()]})`;
}

export default function StatementPage() {
  const params = useParams();
  const id = params.id as string;
  const [order, setOrder] = useState<OrderData | null>(null);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from('orders')
        .select('*, stores(name, short_name, owner_name, address, contact_name, contact_phone, allow_split_shipping), order_items(*)')
        .eq('id', id)
        .single();

      if (data) setOrder(data as OrderData);
      setLoading(false);
    }
    load();
  }, [id]);

  if (loading) {
    return <div className="p-12 text-center text-gray-500 text-lg">불러오는 중...</div>;
  }

  if (!order) {
    return <div className="p-12 text-center text-red-500 text-lg">주문을 찾을 수 없습니다.</div>;
  }

  const orderDate = new Date(order.created_at);
  const dateStr = `${orderDate.getFullYear()}년 ${orderDate.getMonth() + 1}월 ${orderDate.getDate()}일`;
  const totalQty = order.order_items.reduce((sum, i) => sum + i.quantity, 0);
  // 점주가 직접 배송일을 선택하는 매장이면 요청 배송일을 명세서 상단에 표기
  const requestedShipLabel = order.stores.allow_split_shipping && order.ship_date
    ? formatShipDate(order.ship_date)
    : null;

  return (
    <>
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { margin: 0; padding: 0; }
          @page { size: A4; margin: 12mm; }
        }
      `}</style>

      {/* 인쇄 버튼 */}
      <div className="no-print fixed top-4 right-4 flex gap-2 z-50">
        <button
          onClick={() => window.print()}
          className="px-6 py-3 bg-[#1B4332] text-white rounded-lg font-bold text-lg hover:bg-[#2D6A4F] transition shadow-lg"
        >
          인쇄 / PDF 저장
        </button>
        <button
          onClick={() => window.close()}
          className="px-4 py-3 bg-gray-500 text-white rounded-lg font-medium hover:bg-gray-600 transition shadow-lg"
        >
          닫기
        </button>
      </div>

      <div className="max-w-[800px] mx-auto p-6 bg-white min-h-screen">
        {/* 헤더 */}
        <div className="border-b-4 border-black pb-4 mb-6">
          <h1 className="text-center text-3xl font-bold tracking-[0.3em]">거래명세서</h1>
          <p className="text-center text-sm text-gray-500 mt-2">{dateStr}</p>
        </div>

        {/* 주문 정보 + 배송처 */}
        <div className="grid grid-cols-2 gap-6 mb-6">
          <div>
            <h2 className="text-sm font-bold text-gray-500 mb-2 border-b border-gray-300 pb-1">주문 정보</h2>
            <table className="w-full text-sm">
              <tbody>
                <tr>
                  <td className="py-1.5 text-gray-500 w-20">주문번호</td>
                  <td className="py-1.5 font-bold">{order.order_number}</td>
                </tr>
                <tr>
                  <td className="py-1.5 text-gray-500">주문일</td>
                  <td className="py-1.5">{dateStr}</td>
                </tr>
                <tr>
                  <td className="py-1.5 text-gray-500">총수량</td>
                  <td className="py-1.5">{totalQty}박스</td>
                </tr>
                <tr>
                  <td className="py-1.5 text-gray-500">합계금액</td>
                  <td className="py-1.5 font-bold text-lg">₩{order.total_amount.toLocaleString()}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div>
            <h2 className="text-sm font-bold text-gray-500 mb-2 border-b border-gray-300 pb-1">배송처</h2>
            <table className="w-full text-sm">
              <tbody>
                <tr>
                  <td className="py-1.5 text-gray-500 w-16">매장명</td>
                  <td className="py-1.5 font-bold">{order.stores.short_name || order.stores.name}</td>
                </tr>
                <tr>
                  <td className="py-1.5 text-gray-500">대표자</td>
                  <td className="py-1.5">{order.stores.owner_name}</td>
                </tr>
                <tr>
                  <td className="py-1.5 text-gray-500">담당자</td>
                  <td className="py-1.5">{order.stores.contact_name} {order.stores.contact_phone}</td>
                </tr>
                <tr>
                  <td className="py-1.5 text-gray-500">주소</td>
                  <td className="py-1.5 text-xs leading-relaxed">{order.stores.address}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* 요청 배송일 배너 (동일옥처럼 매장이 배송일 선택한 경우만) */}
        {requestedShipLabel && (
          <div className="mb-4 border-2 border-purple-300 bg-purple-50 rounded px-4 py-2 flex items-center justify-between">
            <span className="text-sm font-bold text-purple-900">📅 요청 배송일</span>
            <span className="text-base font-bold text-purple-800">{requestedShipLabel}</span>
          </div>
        )}

        {/* 품목 테이블 */}
        <table className="w-full border-collapse text-sm mb-6">
          <thead>
            <tr className="border-t-2 border-b-2 border-black">
              <th className="py-2.5 text-left w-10">#</th>
              <th className="py-2.5 text-left">품명</th>
              <th className="py-2.5 text-center w-16">구분</th>
              <th className="py-2.5 text-center w-16">수량</th>
              <th className="py-2.5 text-right w-24">단가</th>
              <th className="py-2.5 text-right w-28">금액</th>
            </tr>
          </thead>
          <tbody>
            {order.order_items.map((item, idx) => (
              <tr key={idx} className="border-b border-gray-200">
                <td className="py-2.5 text-gray-400">{idx + 1}</td>
                <td className="py-2.5 font-medium">{item.product_name}</td>
                <td className="py-2.5 text-center text-xs text-gray-500">
                  {item.product_type === 'exclusive' ? '전용' : '범용'}
                </td>
                <td className="py-2.5 text-center font-medium">{item.quantity}</td>
                <td className="py-2.5 text-right">₩{item.unit_price_with_tax.toLocaleString()}</td>
                <td className="py-2.5 text-right font-medium">₩{item.subtotal.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-black font-bold">
              <td colSpan={3} className="py-3 text-right">합계</td>
              <td className="py-3 text-center">{totalQty}</td>
              <td className="py-3"></td>
              <td className="py-3 text-right text-lg">₩{order.total_amount.toLocaleString()}</td>
            </tr>
          </tfoot>
        </table>

        {/* 메모 */}
        {order.memo && (
          <div className="mb-6 p-3 bg-gray-50 rounded border border-gray-200">
            <span className="text-sm text-gray-500">메모: </span>
            <span className="text-sm">{order.memo}</span>
          </div>
        )}

        {/* 하단 */}
        <div className="border-t-2 border-black pt-6 mt-8 flex justify-between items-end">
          <div className="text-sm text-gray-500 space-y-1">
            <p>산방에프앤비 : contact@jejusanbang.com / 010-4011-5348</p>
            <p>신화푸드주식회사 : shfd03263@naver.com / 010-5657-8506</p>
          </div>
          <div className="text-right text-sm text-gray-400">
            <p>{dateStr} 발행</p>
          </div>
        </div>
      </div>
    </>
  );
}
