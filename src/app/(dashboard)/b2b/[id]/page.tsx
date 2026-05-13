'use client';

import { useCallback, useEffect, useMemo, useState, use } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import type { B2bOrder, B2bOrderItem, B2bOrderStatus } from '@/types';

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

type OrderLog = {
  id: string;
  action: string;
  description: string | null;
  changed_by_name: string | null;
  changed_by_role: string | null;
  created_at: string;
};

export default function B2bOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  const [order, setOrder] = useState<B2bOrder | null>(null);
  const [items, setItems] = useState<B2bOrderItem[]>([]);
  const [logs, setLogs] = useState<OrderLog[]>([]);
  const [role, setRole] = useState<'admin' | 'shinwa' | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const [oRes, iRes, lRes] = await Promise.all([
      supabase.from('b2b_orders').select('*, b2b_customers(name)').eq('id', id).single(),
      supabase.from('b2b_order_items').select('*').eq('order_id', id).order('created_at'),
      supabase.from('b2b_order_logs').select('*').eq('order_id', id).order('created_at'),
    ]);
    setOrder((oRes.data as B2bOrder) || null);
    setItems((iRes.data as B2bOrderItem[]) || []);
    setLogs((lRes.data as OrderLog[]) || []);
    setLoading(false);
  }, [id, supabase]);

  useEffect(() => {
    let cancelled = false;

    async function loadInitial() {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: prof } = await supabase.from('profiles').select('role').eq('id', user.id).single();
        if (!cancelled) {
          const r = (prof?.role === 'shinwa' || prof?.role === 'admin') ? prof.role as 'admin' | 'shinwa' : null;
          setRole(r);
        }
      }
      const [oRes, iRes, lRes] = await Promise.all([
        supabase.from('b2b_orders').select('*, b2b_customers(name)').eq('id', id).single(),
        supabase.from('b2b_order_items').select('*').eq('order_id', id).order('created_at'),
        supabase.from('b2b_order_logs').select('*').eq('order_id', id).order('created_at'),
      ]);
      if (cancelled) return;
      setOrder((oRes.data as B2bOrder) || null);
      setItems((iRes.data as B2bOrderItem[]) || []);
      setLogs((lRes.data as OrderLog[]) || []);
      setLoading(false);
    }

    loadInitial();
    return () => { cancelled = true; };
  }, [id, supabase]);

  async function doAction(action: 'ship' | 'cancel') {
    const confirmMsg = action === 'ship'
      ? '출고 처리하시겠어요? 재고가 차감됩니다.'
      : '이 발주를 취소하시겠어요?' + (order?.status === 'shipped' ? ' (재고 복구됨)' : '');
    if (!confirm(confirmMsg)) return;

    setBusy(true); setError('');
    const res = await fetch(`/api/b2b/orders/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) { setError(data.error || '처리 실패'); return; }
    await load();
  }

  async function doDelete() {
    if (!confirm('이 대기 발주를 완전히 삭제하시겠어요?')) return;
    setBusy(true); setError('');
    const res = await fetch(`/api/b2b/orders/${id}`, { method: 'DELETE' });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) { setError(data.error || '삭제 실패'); return; }
    router.push('/b2b');
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!order) {
    return (
      <div className="text-center py-12 text-gray-400">
        발주를 찾을 수 없습니다. <Link href="/b2b" className="text-primary underline">목록</Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <Link href="/b2b" className="text-sm text-primary hover:underline">← 발주 목록으로</Link>
        <div className="flex items-center gap-2 mt-1">
          <h2 className="text-xl font-bold text-gray-800">{order.order_number}</h2>
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusColor[order.status]}`}>
            {statusLabel[order.status]}
          </span>
        </div>
        <button
          onClick={() => window.open(`/b2b/statement/${order.id}`, '_blank')}
          className="mt-3 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 transition"
        >
          거래명세서 출력
        </button>
      </div>

      {/* 주문 정보 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-gray-500">거래처</p>
            <p className="font-medium text-gray-800">{order.b2b_customers?.name}</p>
          </div>
          <div>
            <p className="text-gray-500">주문일</p>
            <p className="font-medium text-gray-800">{order.order_date}</p>
          </div>
          <div>
            <p className="text-gray-500">출고일</p>
            <p className="font-medium text-gray-800">{order.ship_date || '-'}</p>
          </div>
          <div>
            <p className="text-gray-500">합계(세포함)</p>
            <p className="font-semibold text-gray-800">₩{order.total_amount.toLocaleString()}</p>
          </div>
        </div>
        {order.memo && (
          <div className="mt-3 pt-3 border-t border-gray-100 text-sm">
            <p className="text-gray-500 mb-1">메모</p>
            <p className="text-gray-700 whitespace-pre-wrap">{order.memo}</p>
          </div>
        )}
      </div>

      {/* 품목 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100">
          <h3 className="font-semibold text-gray-800">품목 ({items.length})</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="px-4 py-2 text-left font-medium text-gray-500">상품</th>
                <th className="px-4 py-2 text-left font-medium text-gray-500">단위</th>
                <th className="px-4 py-2 text-right font-medium text-gray-500">수량</th>
                <th className="px-4 py-2 text-right font-medium text-gray-500">단가(세포함)</th>
                <th className="px-4 py-2 text-right font-medium text-gray-500">합계(세포함)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map((it) => (
                <tr key={it.id}>
                  <td className="px-4 py-2 text-gray-800">{it.product_name}</td>
                  <td className="px-4 py-2 text-gray-600">
                    {it.unit === 'box' ? `박스 (${it.pack_per_box}팩)` : '팩'}
                  </td>
                  <td className="px-4 py-2 text-right text-gray-800">{it.quantity}</td>
                  <td className="px-4 py-2 text-right text-gray-600">₩{it.unit_price_with_tax.toLocaleString()}</td>
                  <td className="px-4 py-2 text-right font-semibold text-gray-800">₩{it.subtotal.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-gray-50 border-t border-gray-200">
              <tr>
                <td colSpan={4} className="px-4 py-2 text-right text-gray-500">세전 합계</td>
                <td className="px-4 py-2 text-right text-gray-700">₩{order.total_amount_ex_tax.toLocaleString()}</td>
              </tr>
              <tr>
                <td colSpan={4} className="px-4 py-2 text-right text-gray-500">부가세</td>
                <td className="px-4 py-2 text-right text-gray-700">₩{(order.total_amount - order.total_amount_ex_tax).toLocaleString()}</td>
              </tr>
              <tr>
                <td colSpan={4} className="px-4 py-2 text-right font-bold text-gray-800">세포함 합계</td>
                <td className="px-4 py-2 text-right font-bold text-gray-800">₩{order.total_amount.toLocaleString()}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* 액션 버튼 — shinwa 는 출고만, admin 은 전체 */}
      {order.status !== 'cancelled' && (
        <div className="flex flex-wrap gap-2">
          {order.status === 'pending' && (
            <>
              <button
                onClick={() => doAction('ship')}
                disabled={busy}
                className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary-light transition disabled:opacity-50"
              >
                출고 처리 (재고 차감)
              </button>
              {role === 'admin' && (
                <button
                  onClick={doDelete}
                  disabled={busy}
                  className="px-4 py-2 border border-red-300 text-red-600 rounded-lg text-sm font-medium hover:bg-red-50 transition disabled:opacity-50"
                >
                  삭제
                </button>
              )}
            </>
          )}
          {order.status === 'shipped' && role === 'admin' && (
            <button
              onClick={() => doAction('cancel')}
              disabled={busy}
              className="px-4 py-2 border border-red-300 text-red-600 rounded-lg text-sm font-medium hover:bg-red-50 transition disabled:opacity-50"
            >
              취소 (재고 복구)
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg text-sm">{error}</div>
      )}

      {/* 변경 이력 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100">
          <h3 className="font-semibold text-gray-800">변경 이력</h3>
        </div>
        {logs.length === 0 ? (
          <div className="p-4 text-sm text-gray-400">이력이 없습니다.</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {logs.map((l) => (
              <div key={l.id} className="px-4 py-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-gray-700">{l.action}</span>
                  <span className="text-xs text-gray-400">{new Date(l.created_at).toLocaleString('ko-KR')}</span>
                </div>
                {l.description && <p className="text-gray-600 mt-1">{l.description}</p>}
                {l.changed_by_name && (
                  <p className="text-xs text-gray-400 mt-1">{l.changed_by_name} ({l.changed_by_role})</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
