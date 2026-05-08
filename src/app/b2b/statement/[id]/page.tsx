'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

type B2bStatementOrder = {
  id: string;
  order_number: string;
  order_date: string;
  ship_date: string | null;
  total_amount: number;
  total_amount_ex_tax: number;
  memo: string | null;
  b2b_customers: {
    name: string;
    business_number: string | null;
    contact_name: string | null;
    contact_phone: string | null;
    address: string | null;
  } | null;
  b2b_order_items: {
    product_name: string;
    unit: 'box' | 'pack';
    quantity: number;
    pack_per_box: number;
    unit_price_with_tax: number;
    subtotal: number;
  }[];
};

function formatDate(dateStr: string | null | undefined) {
  if (!dateStr) return '-';
  const date = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dateStr;
  return `${date.getFullYear()}년 ${date.getMonth() + 1}월 ${date.getDate()}일`;
}

export default function B2bStatementPage() {
  const params = useParams();
  const id = params.id as string;
  const supabase = useMemo(() => createClient(), []);

  const [order, setOrder] = useState<B2bStatementOrder | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from('b2b_orders')
        .select(`
          id,
          order_number,
          order_date,
          ship_date,
          total_amount,
          total_amount_ex_tax,
          memo,
          b2b_customers(name, business_number, contact_name, contact_phone, address),
          b2b_order_items(product_name, unit, quantity, pack_per_box, unit_price_with_tax, subtotal)
        `)
        .eq('id', id)
        .single();

      setOrder((data as unknown as B2bStatementOrder) || null);
      setLoading(false);
    }

    load();
  }, [id, supabase]);

  if (loading) {
    return <div className="p-12 text-center text-gray-500 text-lg">불러오는 중...</div>;
  }

  if (!order) {
    return <div className="p-12 text-center text-red-500 text-lg">B2B 발주를 찾을 수 없습니다.</div>;
  }

  const totalQty = order.b2b_order_items.reduce((sum, item) => sum + item.quantity, 0);
  const tax = order.total_amount - order.total_amount_ex_tax;

  return (
    <>
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { margin: 0; padding: 0; }
          @page { size: A4; margin: 12mm; }
        }
      `}</style>

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
        <div className="border-b-4 border-black pb-4 mb-6">
          <h1 className="text-center text-3xl font-bold tracking-[0.3em]">거래명세서</h1>
          <p className="text-center text-sm text-gray-500 mt-2">B2B 발주 · {formatDate(order.order_date)}</p>
        </div>

        <div className="grid grid-cols-2 gap-6 mb-6">
          <div>
            <h2 className="text-sm font-bold text-gray-500 mb-2 border-b border-gray-300 pb-1">발주 정보</h2>
            <table className="w-full text-sm">
              <tbody>
                <tr>
                  <td className="py-1.5 text-gray-500 w-24">발주번호</td>
                  <td className="py-1.5 font-bold">{order.order_number}</td>
                </tr>
                <tr>
                  <td className="py-1.5 text-gray-500">주문일</td>
                  <td className="py-1.5">{formatDate(order.order_date)}</td>
                </tr>
                <tr>
                  <td className="py-1.5 text-gray-500">출고일</td>
                  <td className="py-1.5">{formatDate(order.ship_date)}</td>
                </tr>
                <tr>
                  <td className="py-1.5 text-gray-500">합계금액</td>
                  <td className="py-1.5 font-bold text-lg">₩{order.total_amount.toLocaleString()}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div>
            <h2 className="text-sm font-bold text-gray-500 mb-2 border-b border-gray-300 pb-1">거래처</h2>
            <table className="w-full text-sm">
              <tbody>
                <tr>
                  <td className="py-1.5 text-gray-500 w-24">거래처명</td>
                  <td className="py-1.5 font-bold">{order.b2b_customers?.name || '-'}</td>
                </tr>
                <tr>
                  <td className="py-1.5 text-gray-500">사업자번호</td>
                  <td className="py-1.5">{order.b2b_customers?.business_number || '-'}</td>
                </tr>
                <tr>
                  <td className="py-1.5 text-gray-500">담당자</td>
                  <td className="py-1.5">
                    {order.b2b_customers?.contact_name || '-'} {order.b2b_customers?.contact_phone || ''}
                  </td>
                </tr>
                <tr>
                  <td className="py-1.5 text-gray-500">주소</td>
                  <td className="py-1.5 text-xs leading-relaxed">{order.b2b_customers?.address || '-'}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <table className="w-full border-collapse text-sm mb-6">
          <thead>
            <tr className="border-t-2 border-b-2 border-black">
              <th className="py-2.5 text-left w-10">#</th>
              <th className="py-2.5 text-left">품명</th>
              <th className="py-2.5 text-center w-20">단위</th>
              <th className="py-2.5 text-center w-16">수량</th>
              <th className="py-2.5 text-right w-28">단가</th>
              <th className="py-2.5 text-right w-32">금액</th>
            </tr>
          </thead>
          <tbody>
            {order.b2b_order_items.map((item, idx) => (
              <tr key={idx} className="border-b border-gray-200">
                <td className="py-2.5 text-gray-400">{idx + 1}</td>
                <td className="py-2.5 font-medium">{item.product_name}</td>
                <td className="py-2.5 text-center text-xs text-gray-500">
                  {item.unit === 'box' ? `박스(${item.pack_per_box}팩)` : '팩'}
                </td>
                <td className="py-2.5 text-center font-medium">{item.quantity}</td>
                <td className="py-2.5 text-right">₩{item.unit_price_with_tax.toLocaleString()}</td>
                <td className="py-2.5 text-right font-medium">₩{item.subtotal.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-black">
              <td colSpan={3} className="py-2.5 text-right text-gray-500">수량 합계</td>
              <td className="py-2.5 text-center font-bold">{totalQty}</td>
              <td className="py-2.5 text-right text-gray-500">공급가액</td>
              <td className="py-2.5 text-right">₩{order.total_amount_ex_tax.toLocaleString()}</td>
            </tr>
            <tr>
              <td colSpan={5} className="py-2.5 text-right text-gray-500">부가세</td>
              <td className="py-2.5 text-right">₩{tax.toLocaleString()}</td>
            </tr>
            <tr className="font-bold">
              <td colSpan={5} className="py-3 text-right">합계</td>
              <td className="py-3 text-right text-lg">₩{order.total_amount.toLocaleString()}</td>
            </tr>
          </tfoot>
        </table>

        {order.memo && (
          <div className="mb-6 p-3 bg-gray-50 rounded border border-gray-200">
            <span className="text-sm text-gray-500">메모: </span>
            <span className="text-sm">{order.memo}</span>
          </div>
        )}

        <div className="border-t-2 border-black pt-6 mt-8 flex justify-between items-end">
          <div className="text-sm text-gray-500 space-y-1">
            <p>산방에프앤비 : contact@jejusanbang.com / 010-4011-5348</p>
            <p>신화푸드주식회사 : shfd03263@naver.com / 010-5657-8506</p>
          </div>
          <div className="text-right text-sm text-gray-400">
            <p>{formatDate(order.order_date)} 발행</p>
          </div>
        </div>
      </div>
    </>
  );
}
