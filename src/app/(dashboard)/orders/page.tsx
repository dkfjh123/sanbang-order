'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Profile } from '@/types';

interface Order {
  id: string;
  order_number: string;
  store_id: string;
  status: string;
  total_amount: number;
  memo: string | null;
  delivery_date: string | null;
  created_at: string;
  stores: { short_name: string; name: string; region: string } | null;
}

interface OrderItem {
  id: string;
  product_id: string;
  product_name: string;
  product_type: string;
  quantity: number;
  unit_price_with_tax: number;
  subtotal: number;
}

interface OrderLog {
  id: string;
  action: string;
  description: string | null;
  changed_by_name: string | null;
  changed_by_role: string | null;
  created_at: string;
}

const statusLabel: Record<string, { text: string; color: string }> = {
  pending: { text: '대기', color: 'bg-yellow-100 text-yellow-700' },
  confirmed: { text: '확인', color: 'bg-blue-100 text-blue-700' },
  delivered: { text: '완료', color: 'bg-green-100 text-green-700' },
  cancelled: { text: '취소', color: 'bg-red-100 text-red-700' },
};

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [orderItems, setOrderItems] = useState<OrderItem[]>([]);
  const [orderLogs, setOrderLogs] = useState<OrderLog[]>([]);
  const [editMode, setEditMode] = useState(false);
  const [editItems, setEditItems] = useState<OrderItem[]>([]);
  const [editReason, setEditReason] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [saving, setSaving] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [viewMode, setViewMode] = useState<'list' | 'store'>('list');
  const supabase = createClient();

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data: prof } = await supabase.from('profiles').select('*').eq('id', user.id).single();
      if (prof) {
        setProfile(prof as Profile);
        if (prof.role === 'shinwa') setViewMode('store');
      }

      const { data } = await supabase
        .from('orders')
        .select('*, stores(short_name, name, region)')
        .order('created_at', { ascending: false });

      setOrders((data as Order[]) || []);
      setLoading(false);
    }
    load();
  }, []);

  const loadOrderDetail = async (order: Order) => {
    setSelectedOrder(order);
    setEditMode(false);
    setEditReason('');
    const { data: items } = await supabase.from('order_items').select('*').eq('order_id', order.id);
    setOrderItems((items as OrderItem[]) || []);
    setEditItems((items as OrderItem[]) || []);

    const { data: logs } = await supabase
      .from('order_logs')
      .select('*')
      .eq('order_id', order.id)
      .order('created_at', { ascending: false });
    setOrderLogs((logs as OrderLog[]) || []);
  };

  const refreshOrders = async () => {
    const { data } = await supabase
      .from('orders')
      .select('*, stores(short_name, name, region)')
      .order('created_at', { ascending: false });
    setOrders((data as Order[]) || []);
  };

  const updateStatus = async (orderId: string, newStatus: string) => {
    await supabase.from('orders').update({ status: newStatus }).eq('id', orderId);

    // 로그 기록
    await supabase.from('order_logs').insert({
      order_id: orderId,
      action: `상태 변경: ${statusLabel[newStatus]?.text}`,
      description: null,
      changed_by: (await supabase.auth.getUser()).data.user?.id,
      changed_by_name: profile?.name,
      changed_by_role: profile?.role,
    });

    await refreshOrders();
    if (selectedOrder?.id === orderId) {
      setSelectedOrder({ ...selectedOrder, status: newStatus });
      loadOrderDetail({ ...selectedOrder, status: newStatus });
    }
  };

  const handleCancelOrder = async (orderId: string) => {
    if (!confirm('이 주문을 취소하시겠습니까?')) return;
    setCancelling(true);
    const res = await fetch(`/api/orders/${orderId}`, { method: 'DELETE' });
    setCancelling(false);
    if (res.ok) {
      setSelectedOrder(null);
      refreshOrders();
    }
  };

  const updateEditQty = (itemId: string, qty: number) => {
    if (qty < 1) return;
    setEditItems((prev) => prev.map((item) =>
      item.id === itemId ? { ...item, quantity: qty, subtotal: item.unit_price_with_tax * qty } : item
    ));
  };

  const handleSaveEdit = async () => {
    if (!selectedOrder) return;
    if (profile?.role === 'shinwa' && !editReason.trim()) {
      alert('수정 사유를 입력해주세요.');
      return;
    }
    setSaving(true);

    const res = await fetch(`/api/orders/${selectedOrder.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: editItems.map((item) => ({
          product_id: item.product_id,
          product_name: item.product_name,
          product_type: item.product_type,
          quantity: item.quantity,
          unit_price: item.unit_price_with_tax,
          unit_price_with_tax: item.unit_price_with_tax,
          is_tax_free: false,
        })),
      }),
    });

    if (res.ok) {
      // 수정 로그 기록
      const oldItems = orderItems.map((i) => `${i.product_name}:${i.quantity}`).join(', ');
      const newItems = editItems.map((i) => `${i.product_name}:${i.quantity}`).join(', ');
      await supabase.from('order_logs').insert({
        order_id: selectedOrder.id,
        action: '수량 수정',
        description: `${editReason || '수량 변경'} | 변경전: ${oldItems} → 변경후: ${newItems}`,
        changed_by: (await supabase.auth.getUser()).data.user?.id,
        changed_by_name: profile?.name,
        changed_by_role: profile?.role,
      });

      setEditMode(false);
      setEditReason('');
      await refreshOrders();
      const newTotal = editItems.reduce((sum, item) => sum + item.unit_price_with_tax * item.quantity, 0);
      loadOrderDetail({ ...selectedOrder, total_amount: newTotal });
    } else {
      const data = await res.json();
      alert(data.error || '수정 실패');
    }
    setSaving(false);
  };

  // 필터링
  const filteredOrders = orders.filter((o) =>
    statusFilter === 'all' ? true : o.status === statusFilter
  );

  // 매장별 그룹핑
  const groupedByStore = new Map<string, Order[]>();
  filteredOrders.forEach((order) => {
    const storeName = order.stores?.short_name || order.stores?.name || '기타';
    const existing = groupedByStore.get(storeName) || [];
    existing.push(order);
    groupedByStore.set(storeName, existing);
  });

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="w-8 h-8 border-4 border-[#1B4332] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const roleLabel: Record<string, string> = { admin: '관리자', store: '가맹점', shinwa: '신화푸드' };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-gray-800">
          {profile?.role === 'shinwa' ? '배송/발주 관리' : '발주내역'}
        </h2>
        {/* 보기 모드 전환 */}
        <div className="flex gap-2">
          <button
            onClick={() => setViewMode('list')}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
              viewMode === 'list' ? 'bg-[#1B4332] text-white' : 'bg-gray-100 text-gray-600'
            }`}
          >
            목록
          </button>
          <button
            onClick={() => setViewMode('store')}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
              viewMode === 'store' ? 'bg-[#1B4332] text-white' : 'bg-gray-100 text-gray-600'
            }`}
          >
            매장별
          </button>
        </div>
      </div>

      {/* 상태 필터 */}
      <div className="flex gap-2 flex-wrap">
        {[
          ['all', '전체'],
          ['pending', '대기'],
          ['confirmed', '확인'],
          ['delivered', '완료'],
          ['cancelled', '취소'],
        ].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setStatusFilter(key)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
              statusFilter === key
                ? 'bg-[#1B4332] text-white'
                : 'bg-white text-gray-600 border border-gray-200'
            }`}
          >
            {label}
            {key !== 'all' && (
              <span className="ml-1 opacity-70">
                ({orders.filter((o) => o.status === key).length})
              </span>
            )}
          </button>
        ))}
      </div>

      {filteredOrders.length === 0 ? (
        <div className="bg-white rounded-xl p-12 text-center text-gray-400 shadow-sm border border-gray-100">
          해당하는 발주 내역이 없습니다.
        </div>
      ) : viewMode === 'list' ? (
        /* 목록 보기 */
        <div className="space-y-3">
          {filteredOrders.map((order) => (
            <OrderCard key={order.id} order={order} onClick={() => loadOrderDetail(order)} />
          ))}
        </div>
      ) : (
        /* 매장별 보기 */
        <div className="space-y-6">
          {Array.from(groupedByStore.entries()).map(([storeName, storeOrders]) => (
            <div key={storeName} className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
              <div className="px-5 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-gray-800">{storeName}</span>
                  <span className="text-sm text-gray-500">{storeOrders.length}건</span>
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                    storeOrders[0].stores?.region === 'seoul' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
                  }`}>
                    {storeOrders[0].stores?.region === 'seoul' ? '서울·내륙' : '제주'}
                  </span>
                </div>
                <span className="font-bold text-gray-800">
                  ₩{storeOrders.reduce((sum, o) => sum + o.total_amount, 0).toLocaleString()}
                </span>
              </div>
              <div className="divide-y divide-gray-100">
                {storeOrders.map((order) => (
                  <div
                    key={order.id}
                    onClick={() => loadOrderDetail(order)}
                    className="px-5 py-3 flex items-center justify-between cursor-pointer hover:bg-gray-50 transition"
                  >
                    <div className="flex items-center gap-3">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusLabel[order.status]?.color}`}>
                        {statusLabel[order.status]?.text}
                      </span>
                      <span className="text-sm text-gray-800">{order.order_number}</span>
                      <span className="text-xs text-gray-400">
                        {new Date(order.created_at).toLocaleDateString('ko-KR')}
                      </span>
                    </div>
                    <span className="font-semibold text-gray-800 text-sm">₩{order.total_amount.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 주문 상세 모달 */}
      {selectedOrder && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-gray-800">{selectedOrder.order_number}</h3>
              <button onClick={() => setSelectedOrder(null)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>

            <div className="space-y-3 mb-4">
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">가맹점</span>
                <span className="text-gray-800">{selectedOrder.stores?.short_name || selectedOrder.stores?.name}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">주문일시</span>
                <span className="text-gray-800">{new Date(selectedOrder.created_at).toLocaleString('ko-KR')}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">상태</span>
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusLabel[selectedOrder.status]?.color}`}>
                  {statusLabel[selectedOrder.status]?.text}
                </span>
              </div>
              {selectedOrder.memo && (
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">메모</span>
                  <span className="text-gray-800">{selectedOrder.memo}</span>
                </div>
              )}
            </div>

            {/* 수정/취소 버튼 (대기 상태, 관리자 또는 가맹점 본인) */}
            {selectedOrder.status === 'pending' && !editMode && (profile?.role === 'admin' || profile?.role === 'store') && (
              <div className="flex gap-2 mb-4">
                <button onClick={() => setEditMode(true)}
                  className="flex-1 py-2.5 bg-[#1B4332] text-white rounded-lg text-sm font-medium hover:bg-[#2D6A4F] transition">
                  수량 수정
                </button>
                <button onClick={() => handleCancelOrder(selectedOrder.id)} disabled={cancelling}
                  className="flex-1 py-2.5 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 transition disabled:opacity-50">
                  {cancelling ? '처리 중...' : '주문 취소'}
                </button>
              </div>
            )}

            {/* 신화푸드 수정 버튼 (대기/확인 상태에서 가능) */}
            {(selectedOrder.status === 'pending' || selectedOrder.status === 'confirmed') && !editMode && profile?.role === 'shinwa' && (
              <div className="mb-4">
                <button onClick={() => setEditMode(true)}
                  className="w-full py-2.5 bg-orange-500 text-white rounded-lg text-sm font-medium hover:bg-orange-600 transition">
                  수량 수정 (재고 조정)
                </button>
              </div>
            )}

            {/* 주문 상품 */}
            <div className="border-t border-gray-200 pt-3">
              <h4 className="font-medium text-gray-700 text-sm mb-2">주문 상품</h4>

              {editMode ? (
                <>
                  <div className="divide-y divide-gray-100">
                    {editItems.map((item) => (
                      <div key={item.id} className="py-3 flex items-center justify-between">
                        <span className="text-sm text-gray-800 flex-1">{item.product_name}</span>
                        <div className="flex items-center gap-2">
                          <button onClick={() => updateEditQty(item.id, item.quantity - 1)}
                            className="w-8 h-8 rounded border border-gray-300 flex items-center justify-center text-gray-600 hover:bg-gray-50">−</button>
                          <span className="w-8 text-center text-sm font-bold text-[#1B4332]">{item.quantity}</span>
                          <button onClick={() => updateEditQty(item.id, item.quantity + 1)}
                            className="w-8 h-8 rounded border border-[#1B4332] bg-[#1B4332] text-white flex items-center justify-center hover:bg-[#2D6A4F]">+</button>
                        </div>
                        <span className="font-medium text-gray-800 text-sm w-24 text-right">
                          ₩{(item.unit_price_with_tax * item.quantity).toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="flex justify-between pt-3 border-t border-gray-200 mt-2">
                    <span className="font-semibold text-gray-800">수정 합계</span>
                    <span className="font-bold text-lg text-[#1B4332]">
                      ₩{editItems.reduce((sum, item) => sum + item.unit_price_with_tax * item.quantity, 0).toLocaleString()}
                    </span>
                  </div>

                  {/* 수정 사유 (신화푸드 필수) */}
                  <div className="mt-3">
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      수정 사유 {profile?.role === 'shinwa' && <span className="text-red-500">*</span>}
                    </label>
                    <input
                      type="text"
                      value={editReason}
                      onChange={(e) => setEditReason(e.target.value)}
                      placeholder="예: 왕만두 재고 부족으로 수량 조정"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900"
                    />
                  </div>

                  <div className="flex gap-2 mt-3">
                    <button onClick={() => { setEditMode(false); setEditItems(orderItems); setEditReason(''); }}
                      className="flex-1 py-2 border border-gray-300 rounded-lg text-gray-600 text-sm hover:bg-gray-50">
                      취소
                    </button>
                    <button onClick={handleSaveEdit} disabled={saving}
                      className="flex-1 py-2 bg-[#1B4332] text-white rounded-lg text-sm font-medium hover:bg-[#2D6A4F] disabled:opacity-50">
                      {saving ? '저장 중...' : '수정 저장'}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="divide-y divide-gray-100">
                    {orderItems.map((item) => (
                      <div key={item.id} className="py-2 flex justify-between text-sm">
                        <div>
                          <span className="text-gray-800">{item.product_name}</span>
                          <span className="text-gray-400 ml-2">× {item.quantity}</span>
                        </div>
                        <span className="font-medium text-gray-800">₩{item.subtotal.toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                  <div className="flex justify-between pt-3 border-t border-gray-200 mt-2">
                    <span className="font-semibold text-gray-800">합계</span>
                    <span className="font-bold text-lg text-gray-800">₩{selectedOrder.total_amount.toLocaleString()}</span>
                  </div>
                </>
              )}
            </div>

            {/* 거래명세서 */}
            {!editMode && (
              <div className="mt-4 pt-4 border-t border-gray-200">
                <button
                  onClick={() => window.open(`/statement/${selectedOrder.id}`, '_blank')}
                  className="w-full py-2.5 border-2 border-[#1B4332] text-[#1B4332] rounded-lg text-sm font-bold hover:bg-[#1B4332] hover:text-white transition"
                >
                  거래명세서 출력
                </button>
              </div>
            )}

            {/* 상태 변경 */}
            {!editMode && selectedOrder.status !== 'cancelled' && selectedOrder.status !== 'delivered' && (
              <div className="mt-4 pt-4 border-t border-gray-200">
                <p className="text-sm text-gray-500 mb-2">상태 변경</p>
                <div className="flex flex-wrap gap-2">
                  {selectedOrder.status === 'pending' && (profile?.role === 'admin' || profile?.role === 'shinwa') && (
                    <button onClick={() => updateStatus(selectedOrder.id, 'confirmed')}
                      className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">
                      발주 확정
                    </button>
                  )}
                  {selectedOrder.status === 'confirmed' && (profile?.role === 'admin' || profile?.role === 'shinwa') && (
                    <button onClick={() => updateStatus(selectedOrder.id, 'delivered')}
                      className="flex-1 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700">
                      배송 완료
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* 변경 이력 */}
            {orderLogs.length > 0 && (
              <div className="mt-4 pt-4 border-t border-gray-200">
                <h4 className="font-medium text-gray-700 text-sm mb-2">변경 이력</h4>
                <div className="space-y-2 max-h-40 overflow-y-auto">
                  {orderLogs.map((log) => (
                    <div key={log.id} className="bg-gray-50 rounded-lg p-2.5 text-xs">
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-1.5">
                          <span className="font-semibold text-gray-700">{log.action}</span>
                          <span className={`px-1.5 py-0.5 rounded text-xs ${
                            log.changed_by_role === 'admin' ? 'bg-green-100 text-green-700'
                            : log.changed_by_role === 'shinwa' ? 'bg-orange-100 text-orange-700'
                            : 'bg-blue-100 text-blue-700'
                          }`}>
                            {log.changed_by_name} ({roleLabel[log.changed_by_role || ''] || log.changed_by_role})
                          </span>
                        </div>
                        <span className="text-gray-400">{new Date(log.created_at).toLocaleString('ko-KR')}</span>
                      </div>
                      {log.description && (
                        <p className="text-gray-500">{log.description}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function OrderCard({ order, onClick }: { order: Order; onClick: () => void }) {
  const st = statusLabel[order.status] || statusLabel.pending;
  const storeName = order.stores?.short_name || order.stores?.name || '';
  return (
    <div
      onClick={onClick}
      className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 cursor-pointer hover:border-[#2D6A4F] transition"
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-gray-800 text-sm">{order.order_number}</span>
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${st.color}`}>{st.text}</span>
        </div>
        <span className="font-bold text-gray-800">₩{order.total_amount.toLocaleString()}</span>
      </div>
      <div className="flex items-center justify-between text-sm text-gray-500">
        <span>{storeName}</span>
        <span>{new Date(order.created_at).toLocaleDateString('ko-KR')}</span>
      </div>
      {order.memo && <p className="mt-1 text-xs text-gray-400">메모: {order.memo}</p>}
    </div>
  );
}
