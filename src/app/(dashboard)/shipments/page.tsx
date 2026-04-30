'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';

interface ShipmentRow {
  ship_date: string;
  order_number: string;
  channel: 'store' | 'b2b';
  party_name: string;        // 가맹점명 또는 B2B 거래처명
  is_direct: boolean;        // store 채널에서만 의미
  product_type: 'exclusive' | 'general';
  product_name: string;
  quantity: number;
  unit: 'box' | 'pack';
  unit_price_with_tax: number;
  subtotal: number;
  status: 'confirmed' | 'shipped';
  is_tax_free: boolean;
}

interface OrderRow {
  order_number: string;
  ship_date: string | null;
  status: string;
  stores: { name: string; short_name: string | null; is_direct: boolean } | null;
  order_items: {
    product_name: string;
    product_type: 'exclusive' | 'general';
    quantity: number;
    unit: 'box' | 'pack' | null;
    unit_price_with_tax: number;
    subtotal: number;
    is_tax_free: boolean;
  }[];
}

interface B2bOrderRow {
  order_number: string;
  ship_date: string | null;
  status: string;
  b2b_customers: { name: string } | null;
  b2b_order_items: {
    product_name: string;
    unit: 'box' | 'pack';
    quantity: number;
    unit_price_with_tax: number;
    subtotal: number;
    is_tax_free: boolean;
  }[];
}

function monthRange(year: number, month: number) {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const endY = month === 12 ? year + 1 : year;
  const endM = month === 12 ? 1 : month + 1;
  const e = new Date(`${endY}-${String(endM).padStart(2, '0')}-01T00:00:00Z`);
  e.setUTCDate(e.getUTCDate() - 1);
  return { start, end: e.toISOString().slice(0, 10) };
}

export default function ShipmentsPage() {
  const today = new Date();
  const initial = monthRange(today.getFullYear(), today.getMonth() + 1);

  const [startDate, setStartDate] = useState(initial.start);
  const [endDate, setEndDate] = useState(initial.end);
  const [rows, setRows] = useState<ShipmentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const supabase = createClient();

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

    // 가맹점(orders) + B2B(b2b_orders) 동시 조회
    const [storeRes, b2bRes] = await Promise.all([
      supabase
        .from('orders')
        .select('order_number, ship_date, status, stores(name, short_name, is_direct), order_items(product_name, product_type, quantity, unit, unit_price_with_tax, subtotal, is_tax_free)')
        .in('status', ['confirmed', 'shipped'])
        .gte('ship_date', startDate)
        .lte('ship_date', endDate),
      supabase
        .from('b2b_orders')
        .select('order_number, ship_date, status, b2b_customers(name), b2b_order_items(product_name, unit, quantity, unit_price_with_tax, subtotal, is_tax_free)')
        .in('status', ['confirmed', 'shipped'])
        .gte('ship_date', startDate)
        .lte('ship_date', endDate),
    ]);

    if (storeRes.error) {
      setError(storeRes.error.message);
      setRows([]);
      setLoading(false);
      return;
    }
    if (b2bRes.error) {
      setError(b2bRes.error.message);
      setRows([]);
      setLoading(false);
      return;
    }

    const flat: ShipmentRow[] = [];

    // 가맹점 출고
    (storeRes.data as unknown as OrderRow[] || []).forEach((o) => {
      const storeName = o.stores?.short_name || o.stores?.name || '알 수 없음';
      const isDirect = o.stores?.is_direct || false;
      o.order_items.forEach((it) => {
        flat.push({
          ship_date: o.ship_date || '',
          order_number: o.order_number,
          channel: 'store',
          party_name: storeName,
          is_direct: isDirect,
          product_type: it.product_type,
          product_name: it.product_name,
          quantity: it.quantity,
          unit: (it.unit as 'box' | 'pack') || 'box',
          unit_price_with_tax: it.unit_price_with_tax,
          subtotal: it.subtotal,
          status: o.status as 'confirmed' | 'shipped',
          is_tax_free: it.is_tax_free,
        });
      });
    });

    // B2B 출고 (B2B는 모두 전용상품)
    (b2bRes.data as unknown as B2bOrderRow[] || []).forEach((o) => {
      const customerName = o.b2b_customers?.name || 'B2B 거래처';
      o.b2b_order_items.forEach((it) => {
        flat.push({
          ship_date: o.ship_date || '',
          order_number: o.order_number,
          channel: 'b2b',
          party_name: customerName,
          is_direct: false,
          product_type: 'exclusive',
          product_name: it.product_name,
          quantity: it.quantity,
          unit: it.unit,
          unit_price_with_tax: it.unit_price_with_tax,
          subtotal: it.subtotal,
          status: o.status as 'confirmed' | 'shipped',
          is_tax_free: it.is_tax_free,
        });
      });
    });

    // 출고일 → 주문번호 순 정렬
    flat.sort((a, b) => {
      if (a.ship_date !== b.ship_date) return a.ship_date.localeCompare(b.ship_date);
      return a.order_number.localeCompare(b.order_number);
    });

    setRows(flat);
    setLoading(false);
  }

  const totalQty = rows.reduce((s, r) => s + r.quantity, 0);
  const totalAmount = rows.reduce((s, r) => s + r.subtotal, 0);
  const shippedCount = new Set(rows.filter((r) => r.status === 'shipped').map((r) => r.order_number)).size;
  const confirmedCount = new Set(rows.filter((r) => r.status === 'confirmed').map((r) => r.order_number)).size;
  const storeAmount = rows.filter((r) => r.channel === 'store').reduce((s, r) => s + r.subtotal, 0);
  const b2bAmount = rows.filter((r) => r.channel === 'b2b').reduce((s, r) => s + r.subtotal, 0);

  function downloadExcel() {
    if (rows.length === 0) {
      alert('다운로드할 데이터가 없습니다. 먼저 조회해주세요.');
      return;
    }
    const header = [
      '출고일', '주문번호', '채널', '거래처/가맹점', '직영여부', '상품구분', '상품명',
      '수량', '단위', '단가(세포함)', '금액', '면세여부', '상태',
    ];
    const data = rows.map((r) => [
      r.ship_date,
      r.order_number,
      r.channel === 'b2b' ? 'B2B' : '가맹점',
      r.party_name,
      r.channel === 'store' && r.is_direct ? '직영' : '',
      r.product_type === 'exclusive' ? '전용' : '범용',
      r.product_name,
      String(r.quantity),
      r.unit === 'pack' ? '팩' : '박스',
      String(r.unit_price_with_tax),
      String(r.subtotal),
      r.is_tax_free ? '면세' : '과세',
      r.status === 'shipped' ? '출고완료' : '확정',
    ]);
    const csv = '﻿' + [header, ...data]
      .map((row) => row.map((cell) => {
        const s = String(cell);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `출고내역_${startDate}_${endDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-gray-800">출고내역</h2>
        <button
          onClick={downloadExcel}
          disabled={rows.length === 0}
          className="px-4 py-2 bg-[#1B4332] text-white rounded-lg text-sm font-medium hover:bg-[#2D6A4F] transition disabled:bg-gray-300 disabled:cursor-not-allowed"
        >
          엑셀 다운로드
        </button>
      </div>

      {/* 기간 선택 + 조회 */}
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

      {/* 결과 요약 */}
      {searched && !loading && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 flex flex-wrap gap-4 text-sm">
          <div>
            <span className="text-gray-500">기간:</span>{' '}
            <span className="font-semibold text-gray-800">{startDate} ~ {endDate}</span>
          </div>
          <div>
            <span className="text-gray-500">주문 건수:</span>{' '}
            <span className="font-semibold text-gray-800">
              {shippedCount + confirmedCount}건
            </span>{' '}
            <span className="text-xs text-gray-400">
              (출고완료 {shippedCount} · 확정 {confirmedCount})
            </span>
          </div>
          <div>
            <span className="text-gray-500">아이템 수:</span>{' '}
            <span className="font-semibold text-gray-800">{rows.length}건</span>
          </div>
          <div>
            <span className="text-gray-500">총 수량:</span>{' '}
            <span className="font-semibold text-gray-800">{totalQty.toLocaleString()}</span>
          </div>
          <div className="ml-auto text-right">
            <div>
              <span className="text-gray-500">총 금액:</span>{' '}
              <span className="font-bold text-[#1B4332] text-base">
                ₩{totalAmount.toLocaleString()}
              </span>
            </div>
            <div className="text-xs text-gray-500 mt-0.5">
              가맹점 ₩{storeAmount.toLocaleString()} · B2B ₩{b2bAmount.toLocaleString()}
            </div>
          </div>
        </div>
      )}

      {/* 결과 표 */}
      {searched && !loading && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[900px]">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-3 py-3 text-left font-medium text-gray-500">출고일</th>
                  <th className="px-3 py-3 text-left font-medium text-gray-500">주문번호</th>
                  <th className="px-3 py-3 text-left font-medium text-gray-500">구분</th>
                  <th className="px-3 py-3 text-left font-medium text-gray-500">거래처/가맹점</th>
                  <th className="px-3 py-3 text-left font-medium text-gray-500">상품</th>
                  <th className="px-3 py-3 text-right font-medium text-gray-500">수량</th>
                  <th className="px-3 py-3 text-right font-medium text-gray-500">단가</th>
                  <th className="px-3 py-3 text-right font-medium text-gray-500">금액</th>
                  <th className="px-3 py-3 text-center font-medium text-gray-500">상태</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((r, idx) => (
                  <tr key={idx} className="hover:bg-gray-50">
                    <td className="px-3 py-2 text-gray-700 whitespace-nowrap">{r.ship_date}</td>
                    <td className="px-3 py-2 text-gray-600 whitespace-nowrap text-xs">{r.order_number}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                        r.channel === 'b2b' ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-700'
                      }`}>
                        {r.channel === 'b2b' ? 'B2B' : '가맹점'}
                      </span>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className="text-gray-800">{r.party_name}</span>
                      {r.channel === 'store' && r.is_direct && (
                        <span className="ml-1 px-1.5 py-0.5 rounded text-[10px] bg-blue-100 text-blue-700">직영</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`mr-1.5 px-1.5 py-0.5 rounded text-[10px] ${
                        r.product_type === 'exclusive' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'
                      }`}>
                        {r.product_type === 'exclusive' ? '전용' : '범용'}
                      </span>
                      <span className="text-gray-800">{r.product_name}</span>
                    </td>
                    <td className="px-3 py-2 text-right text-gray-700 whitespace-nowrap">
                      {r.quantity.toLocaleString()} {r.unit === 'pack' ? '팩' : '박스'}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-600 whitespace-nowrap">
                      ₩{r.unit_price_with_tax.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold text-gray-800 whitespace-nowrap">
                      ₩{r.subtotal.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-center whitespace-nowrap">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                        r.status === 'shipped' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-800'
                      }`}>
                        {r.status === 'shipped' ? '출고완료' : '확정'}
                      </span>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-4 py-12 text-center text-gray-400">
                      해당 기간에 출고 내역이 없습니다.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!searched && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 text-center text-gray-400 text-sm">
          기간을 선택하고 <strong className="text-gray-600">조회</strong> 버튼을 눌러주세요.
        </div>
      )}
    </div>
  );
}
