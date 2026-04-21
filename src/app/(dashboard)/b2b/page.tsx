'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import type { B2bCustomer, B2bOrder, B2bOrderStatus } from '@/types';

const statusLabel: Record<B2bOrderStatus, string> = {
  pending: '대기',
  confirmed: '확정',
  shipped: '출고',
  cancelled: '취소',
};

const statusColor: Record<B2bOrderStatus, string> = {
  pending: 'bg-yellow-100 text-yellow-700',
  confirmed: 'bg-blue-100 text-blue-700',
  shipped: 'bg-green-100 text-green-700',
  cancelled: 'bg-gray-100 text-gray-500',
};

export default function B2bOrdersPage() {
  const [orders, setOrders] = useState<B2bOrder[]>([]);
  const [customers, setCustomers] = useState<B2bCustomer[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<B2bOrderStatus | 'all'>('all');
  const [customerFilter, setCustomerFilter] = useState<string>('all');
  const supabase = createClient();

  useEffect(() => { load(); }, []);

  async function load() {
    const [ordersRes, customersRes] = await Promise.all([
      supabase
        .from('b2b_orders')
        .select('*, b2b_customers(name)')
        .order('order_date', { ascending: false })
        .order('created_at', { ascending: false }),
      supabase.from('b2b_customers').select('*').order('name'),
    ]);
    setOrders((ordersRes.data as B2bOrder[]) || []);
    setCustomers((customersRes.data as B2bCustomer[]) || []);
    setLoading(false);
  }

  const filtered = useMemo(() => {
    return orders.filter((o) => {
      if (statusFilter !== 'all' && o.status !== statusFilter) return false;
      if (customerFilter !== 'all' && o.b2b_customer_id !== customerFilter) return false;
      return true;
    });
  }, [orders, statusFilter, customerFilter]);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-xl font-bold text-gray-800">B2B 발주</h2>
        <div className="flex gap-2">
          <Link
            href="/b2b/customers"
            className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 transition"
          >
            거래처 관리
          </Link>
          <Link
            href="/b2b/new"
            className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary-light transition"
          >
            + 발주 등록
          </Link>
        </div>
      </div>

      {/* 필터 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 flex flex-wrap gap-3">
        <div className="flex gap-1">
          {(['all', 'pending', 'shipped', 'cancelled'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 rounded-lg text-sm transition ${
                statusFilter === s
                  ? 'bg-primary text-white'
                  : 'bg-gray-50 text-gray-600 hover:bg-gray-100'
              }`}
            >
              {s === 'all' ? '전체' : statusLabel[s]}
            </button>
          ))}
        </div>
        <select
          value={customerFilter}
          onChange={(e) => setCustomerFilter(e.target.value)}
          className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm text-gray-700"
        >
          <option value="all">전체 거래처</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      {/* 목록 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        {filtered.length === 0 ? (
          <div className="text-center py-12 text-gray-400">조건에 맞는 발주가 없습니다.</div>
        ) : (
          <>
            {/* 모바일 카드 */}
            <div className="lg:hidden divide-y divide-gray-100">
              {filtered.map((o) => (
                <Link key={o.id} href={`/b2b/${o.id}`} className="block p-4 hover:bg-gray-50 transition">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-medium text-gray-800">{o.order_number}</span>
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusColor[o.status]}`}>
                      {statusLabel[o.status]}
                    </span>
                  </div>
                  <p className="text-sm text-gray-500">
                    {o.b2b_customers?.name} · {o.order_date}
                    {o.ship_date ? ` → 출고 ${o.ship_date}` : ''}
                  </p>
                  <p className="text-sm font-semibold text-gray-800 mt-1">
                    ₩{o.total_amount.toLocaleString()}
                  </p>
                </Link>
              ))}
            </div>

            {/* 데스크톱 테이블 */}
            <div className="hidden lg:block overflow-x-auto">
              <table className="w-full text-sm min-w-[800px]">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">주문번호</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">거래처</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">주문일</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">출고일</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">상태</th>
                    <th className="px-4 py-3 text-right font-medium text-gray-500">합계(세포함)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filtered.map((o) => (
                    <tr key={o.id} className="hover:bg-gray-50 transition cursor-pointer" onClick={() => { window.location.href = `/b2b/${o.id}`; }}>
                      <td className="px-4 py-3 font-medium text-gray-800">{o.order_number}</td>
                      <td className="px-4 py-3 text-gray-600">{o.b2b_customers?.name}</td>
                      <td className="px-4 py-3 text-gray-500">{o.order_date}</td>
                      <td className="px-4 py-3 text-gray-500">{o.ship_date || '-'}</td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusColor[o.status]}`}>
                          {statusLabel[o.status]}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-gray-800">
                        ₩{o.total_amount.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
