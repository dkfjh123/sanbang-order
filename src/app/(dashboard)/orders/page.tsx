'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { isPastDeadlineForShipDate } from '@/lib/delivery-schedule';
import type { Profile } from '@/types';

interface Order {
  id: string;
  order_number: string;
  store_id: string;
  status: string;
  total_amount: number;
  memo: string | null;
  delivery_date: string | null;
  ship_date: string | null;
  created_at: string;
  stores: {
    short_name: string;
    name: string;
    region: 'seoul' | 'jeju';
    delivery_days: number[] | null;
    allow_split_shipping: boolean;
    deadline_override_until: string | null;
  } | null;
}

interface OrderItem {
  id: string;
  product_id: string;
  product_name: string;
  product_type: string;
  quantity: number;
  unit_price: number;
  unit_price_with_tax: number;
  is_tax_free: boolean;
  subtotal: number;
  unit?: 'box' | 'pack';
  pack_per_box?: number;
  ship_date?: string | null;
}

interface Product {
  id: string;
  name: string;
  category: string;
  product_type: 'exclusive' | 'general';
  unit: string;
  spec: string | null;
  price: number;
  price_with_tax: number;
  is_tax_free: boolean;
  storage: string | null;
  pack_per_box: number;
  is_loose_pack_sellable: boolean;
}

const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];
function formatShipDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '미지정';
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return `${d.getMonth() + 1}/${d.getDate()}(${DAY_NAMES[d.getDay()]})`;
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
  confirmed: { text: '확정', color: 'bg-green-100 text-green-700' },
  shipped: { text: '출고완료', color: 'bg-blue-100 text-blue-700' },
  cancelled: { text: '취소', color: 'bg-red-100 text-red-700' },
};

const storageLabel: Record<string, string> = {
  frozen: '냉동',
  refrigerated: '냉장',
  room_temp: '상온',
};

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [orderItems, setOrderItems] = useState<OrderItem[]>([]);
  const [orderLogs, setOrderLogs] = useState<OrderLog[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [inventory, setInventory] = useState<Record<string, number>>({});
  const [loosePack, setLoosePack] = useState<Record<string, number>>({});
  const [allowedProductIds, setAllowedProductIds] = useState<Set<string> | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [editItems, setEditItems] = useState<OrderItem[]>([]);
  const [editReason, setEditReason] = useState('');
  const [editFilter, setEditFilter] = useState<'all' | 'exclusive' | 'general'>('all');
  const [editSearch, setEditSearch] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [saving, setSaving] = useState(false);
  // 처리 대기 건이 가장 먼저 눈에 띄도록 기본 필터를 '대기'로 설정
  const [statusFilter, setStatusFilter] = useState<string>('pending');
  const [viewMode, setViewMode] = useState<'list' | 'store'>('list');
  const supabase = useMemo(() => createClient(), []);

  const refreshInventory = useCallback(async () => {
    const { data: invData } = await supabase
      .from('inventory')
      .select('product_id, quantity, loose_pack_qty');
    const invMap: Record<string, number> = {};
    const looseMap: Record<string, number> = {};
    (invData || []).forEach((i: { product_id: string; quantity: number; loose_pack_qty: number }) => {
      invMap[i.product_id] = i.quantity;
      looseMap[i.product_id] = i.loose_pack_qty || 0;
    });
    setInventory(invMap);
    setLoosePack(looseMap);
  }, [supabase]);

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data: prof } = await supabase.from('profiles').select('*').eq('id', user.id).single();
      if (prof) {
        setProfile(prof as Profile);
        if (prof.role === 'shinwa') setViewMode('store');
      }

      const [{ data }, { data: prods }] = await Promise.all([
        supabase
          .from('orders')
          .select('*, stores(short_name, name, region, delivery_days, allow_split_shipping, deadline_override_until)')
          .order('created_at', { ascending: false }),
        supabase
          .from('products')
          .select('*')
          .eq('is_active', true)
          .order('sort_order'),
      ]);

      setOrders((data as Order[]) || []);
      setProducts((prods as Product[]) || []);
      await refreshInventory();
      setLoading(false);
    }
    load();
  }, [refreshInventory, supabase]);

  const loadOrderDetail = async (order: Order) => {
    setSelectedOrder(order);
    setEditMode(false);
    setEditReason('');
    setEditFilter('all');
    setEditSearch('');

    const [{ data: items }, { data: logs }, { data: allowedRows }] = await Promise.all([
      supabase.from('order_items').select('*').eq('order_id', order.id),
      supabase
        .from('order_logs')
        .select('*')
        .eq('order_id', order.id)
        .order('created_at', { ascending: false }),
      supabase
        .from('store_allowed_products')
        .select('product_id')
        .eq('store_id', order.store_id),
    ]);

    const nextItems = (items as OrderItem[]) || [];
    setOrderItems(nextItems);
    setEditItems(nextItems);
    setAllowedProductIds(
      allowedRows && allowedRows.length > 0
        ? new Set(allowedRows.map((row: { product_id: string }) => row.product_id))
        : null
    );
    setOrderLogs((logs as OrderLog[]) || []);
    await refreshInventory();
  };

  const refreshOrders = async () => {
    const { data } = await supabase
      .from('orders')
      .select('*, stores(short_name, name, region, delivery_days, allow_split_shipping, deadline_override_until)')
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
    } else {
      const { error } = await res.json().catch(() => ({ error: '취소 실패' }));
      alert(error || '취소 실패');
    }
  };

  const handleShipOrder = async (orderId: string) => {
    if (!confirm('이 주문을 출고 처리하시겠습니까?\n출고 후에는 상태를 되돌릴 수 없습니다.')) return;
    const res = await fetch(`/api/orders/${orderId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'ship' }),
    });
    if (res.ok) {
      await refreshOrders();
      if (selectedOrder?.id === orderId) {
        loadOrderDetail({ ...selectedOrder, status: 'shipped' });
      }
    } else {
      const { error } = await res.json().catch(() => ({ error: '출고 처리 실패' }));
      alert(error || '출고 처리 실패');
    }
  };

  const updateEditQty = (itemId: string, qty: number) => {
    if (qty < 1) return;
    setEditItems((prev) => prev.map((item) =>
      item.id === itemId ? { ...item, quantity: qty, subtotal: item.unit_price_with_tax * qty } : item
    ));
  };

  const removeEditItem = (itemId: string) => {
    setEditItems((prev) => prev.filter((item) => item.id !== itemId));
  };

  const getOriginalQty = (productId: string, unit: 'box' | 'pack') =>
    orderItems
      .filter((item) => item.product_id === productId && (item.unit || 'box') === unit)
      .reduce((sum, item) => sum + item.quantity, 0);

  const getEditQty = (productId: string, unit: 'box' | 'pack') =>
    editItems
      .filter((item) => item.product_id === productId && (item.unit || 'box') === unit)
      .reduce((sum, item) => sum + item.quantity, 0);

  const getEditableMaxQty = (product: Product, unit: 'box' | 'pack') => {
    const originalQty = getOriginalQty(product.id, unit);
    if (unit === 'box') {
      const stock = product.id in inventory
        ? inventory[product.id]
        : product.product_type === 'exclusive'
          ? 0
          : Infinity;
      return stock === Infinity ? Infinity : originalQty + stock;
    }
    const packPerBox = product.pack_per_box || 1;
    const availablePacks = (loosePack[product.id] || 0) + ((inventory[product.id] || 0) * packPerBox);
    return originalQty + availablePacks;
  };

  const makeEditItem = (product: Product, unit: 'box' | 'pack', quantity: number): OrderItem => {
    const packPerBox = product.pack_per_box || 1;
    const unitPrice = unit === 'pack' ? Math.round(product.price / packPerBox) : product.price;
    const unitPriceWithTax = unit === 'pack'
      ? Math.round(product.price_with_tax / packPerBox)
      : product.price_with_tax;
    return {
      id: `new-${product.id}-${unit}`,
      product_id: product.id,
      product_name: unit === 'pack' ? `${product.name} (낱팩)` : product.name,
      product_type: product.product_type,
      quantity,
      unit_price: unitPrice,
      unit_price_with_tax: unitPriceWithTax,
      is_tax_free: product.is_tax_free,
      subtotal: unitPriceWithTax * quantity,
      unit,
      pack_per_box: packPerBox,
      ship_date: selectedOrder?.ship_date || null,
    };
  };

  const addEditItem = (product: Product, unit: 'box' | 'pack') => {
    const currentQty = getEditQty(product.id, unit);
    const maxQty = getEditableMaxQty(product, unit);
    if (currentQty >= maxQty) return;

    setEditItems((prev) => {
      const existing = prev.find((item) => item.product_id === product.id && (item.unit || 'box') === unit);
      if (existing) {
        return prev.map((item) =>
          item.id === existing.id
            ? {
                ...item,
                quantity: item.quantity + 1,
                subtotal: item.unit_price_with_tax * (item.quantity + 1),
              }
            : item
        );
      }
      return [...prev, makeEditItem(product, unit, 1)];
    });
  };

  const handleSaveEdit = async () => {
    if (!selectedOrder) return;
    if (editItems.length === 0) {
      alert('상품을 1개 이상 선택해주세요.');
      return;
    }
    if (!editReason.trim()) {
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
          quantity: item.quantity,
          unit: item.unit || 'box',
        })),
      }),
    });

    if (res.ok) {
      // 수정 로그 기록
      const oldItems = orderItems.map((i) => `${i.product_name}:${i.quantity}`).join(', ');
      const newItems = editItems.map((i) => `${i.product_name}:${i.quantity}`).join(', ');
      await supabase.from('order_logs').insert({
        order_id: selectedOrder.id,
        action: '주문 수정',
        description: `${editReason || '주문 변경'} | 변경전: ${oldItems} → 변경후: ${newItems}`,
        changed_by: (await supabase.auth.getUser()).data.user?.id,
        changed_by_name: profile?.name,
        changed_by_role: profile?.role,
      });

      setEditMode(false);
      setEditReason('');
      await refreshOrders();
      await refreshInventory();
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

  const filteredEditProducts = products.filter((product) => {
    if (allowedProductIds && !allowedProductIds.has(product.id)) return false;
    if (editFilter !== 'all' && product.product_type !== editFilter) return false;
    if (editSearch && !product.name.toLowerCase().includes(editSearch.toLowerCase())) return false;
    return true;
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

      {/* 출고 지연 / 오늘 출고 알림 — 관리자 + 신화 전용 */}
      {(profile?.role === 'admin' || profile?.role === 'shinwa') && (() => {
        const now = new Date();
        const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        const delayedOrders = orders.filter(
          (o) => o.status === 'confirmed' && o.ship_date && o.ship_date < todayStr
        );
        const todayOrders = orders.filter(
          (o) => o.status === 'confirmed' && o.ship_date && o.ship_date === todayStr
        );
        if (delayedOrders.length === 0 && todayOrders.length === 0) return null;
        return (
          <div className="space-y-3">
            {delayedOrders.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold text-red-700">
                    출고 지연 ({delayedOrders.length}건)
                  </span>
                  <span className="text-[11px] text-red-600">출고일 지났는데 출고완료 처리 안 됨</span>
                </div>
                <div className="space-y-1">
                  {delayedOrders.map((o) => (
                    <button
                      key={o.id}
                      onClick={() => loadOrderDetail(o)}
                      className="w-full text-left flex items-center justify-between px-3 py-2 bg-white rounded-lg hover:bg-red-100 transition border border-red-100"
                    >
                      <span className="text-sm text-gray-800">
                        {o.order_number} · {o.stores?.short_name || o.stores?.name}
                      </span>
                      <span className="text-xs text-red-700 font-medium">{o.ship_date}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {todayOrders.length > 0 && (
              <div className="bg-gray-50 border border-gray-200 rounded-xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold text-gray-700">
                    오늘 출고 예정 ({todayOrders.length}건)
                  </span>
                </div>
                <div className="space-y-1">
                  {todayOrders.map((o) => (
                    <button
                      key={o.id}
                      onClick={() => loadOrderDetail(o)}
                      className="w-full text-left flex items-center justify-between px-3 py-2 bg-white rounded-lg hover:bg-gray-100 transition border border-gray-100"
                    >
                      <span className="text-sm text-gray-800">
                        {o.order_number} · {o.stores?.short_name || o.stores?.name}
                      </span>
                      <span className="text-xs text-gray-600">{o.ship_date}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* 상태 필터 */}
      <div className="flex gap-2 flex-wrap">
        {[
          ['all', '전체'],
          ['pending', '대기'],
          ['confirmed', '확정'],
          ['shipped', '출고완료'],
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
                  ₩{storeOrders.filter((o) => o.status !== 'cancelled').reduce((sum, o) => sum + o.total_amount, 0).toLocaleString()}
                </span>
              </div>
              <div className="divide-y divide-gray-100">
                {storeOrders.map((order) => {
                  const dateChosen = order.stores?.allow_split_shipping;
                  return (
                    <div
                      key={order.id}
                      onClick={() => loadOrderDetail(order)}
                      className="px-5 py-3 flex items-center justify-between cursor-pointer hover:bg-gray-50 transition gap-3"
                    >
                      <div className="flex items-center gap-3 flex-wrap min-w-0">
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusLabel[order.status]?.color}`}>
                          {statusLabel[order.status]?.text}
                        </span>
                        <span className="text-sm text-gray-800">{order.order_number}</span>
                        {order.ship_date && (
                          <span className={`px-3 py-1 rounded-lg text-sm font-bold border-2 ${
                            dateChosen
                              ? 'bg-purple-100 text-purple-800 border-purple-300'
                              : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                          }`}>
                            {dateChosen ? '📅 요청' : '🚚 출고'} {formatShipDate(order.ship_date)}
                          </span>
                        )}
                        <span className="text-xs text-gray-400">
                          주문 {new Date(order.created_at).toLocaleDateString('ko-KR')}
                        </span>
                      </div>
                      <span className="font-semibold text-gray-800 text-sm shrink-0">₩{order.total_amount.toLocaleString()}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 주문 상세 모달 */}
      {selectedOrder && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => { if (!editMode) setSelectedOrder(null); }}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-gray-800">{selectedOrder.order_number}</h3>
              <button onClick={() => setSelectedOrder(null)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>

            {/* 요청 배송일 배너 — 동일옥처럼 점주가 직접 선택하는 매장의 주문에만 */}
            {selectedOrder.stores?.allow_split_shipping && selectedOrder.ship_date && (
              <div className="mb-4 bg-purple-100 border-2 border-purple-400 rounded-xl px-4 py-3 flex items-center justify-between shadow-sm">
                <span className="text-sm font-bold text-purple-900">📅 점주 요청 배송일</span>
                <span className="text-xl font-extrabold text-purple-900">{formatShipDate(selectedOrder.ship_date)}</span>
              </div>
            )}

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
              {selectedOrder.ship_date && (
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">
                    {selectedOrder.stores?.allow_split_shipping ? '요청 배송일' : '출고 예정일'}
                  </span>
                  <span className={`font-bold ${selectedOrder.stores?.allow_split_shipping ? 'text-purple-700' : 'text-gray-800'}`}>
                    {formatShipDate(selectedOrder.ship_date)}
                  </span>
                </div>
              )}
              {selectedOrder.memo && (
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">메모</span>
                  <span className="text-gray-800">{selectedOrder.memo}</span>
                </div>
              )}
            </div>

            {/* 수정/취소 버튼 */}
            {(selectedOrder.status === 'pending' || selectedOrder.status === 'confirmed') && !editMode && (() => {
              const isAdmin = profile?.role === 'admin';
              const isStore = profile?.role === 'store';
              // 가맹점: pending + 마감 전에만 수정/취소 가능 (store 기반 마감 + override 반영)
              const s = selectedOrder.stores;
              const isPastDeadline = s
                ? isPastDeadlineForShipDate({
                    region: s.region,
                    delivery_days: s.delivery_days,
                    deadline_override_until: s.deadline_override_until,
                  }, selectedOrder.ship_date)
                : false;
              const canEdit =
                isAdmin ||
                (isStore && selectedOrder.status === 'pending' && !isPastDeadline);
              if (!canEdit) return null;
              return (
                <div className="flex gap-2 mb-4">
                  <button onClick={() => setEditMode(true)}
                    className="flex-1 py-2.5 bg-[#1B4332] text-white rounded-lg text-sm font-medium hover:bg-[#2D6A4F] transition">
                    주문 수정
                  </button>
                  <button onClick={() => handleCancelOrder(selectedOrder.id)} disabled={cancelling}
                    className="flex-1 py-2.5 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 transition disabled:opacity-50">
                    {cancelling ? '처리 중...' : '주문 취소'}
                  </button>
                </div>
              );
            })()}

            {/* 주문 상품 */}
            <div className="border-t border-gray-200 pt-3">
              <h4 className="font-medium text-gray-700 text-sm mb-2">주문 상품</h4>

              {editMode ? (
                <>
                  <div className="divide-y divide-gray-100">
                    {editItems.length === 0 ? (
                      <div className="py-6 text-center text-sm text-red-600 bg-red-50 rounded-lg">
                        상품을 1개 이상 추가해야 저장할 수 있습니다.
                      </div>
                    ) : editItems.map((item) => {
                      const unit = item.unit || 'box';
                      const product = products.find((p) => p.id === item.product_id);
                      const maxQty = product ? getEditableMaxQty(product, unit) : item.quantity;
                      const canIncrease = item.quantity < maxQty;
                      return (
                        <div key={item.id} className="py-3 flex items-center gap-3">
                          <div className="flex-1 min-w-0">
                            <span className="text-sm font-medium text-gray-800 block truncate">{item.product_name}</span>
                            <span className="text-xs text-gray-400">
                              {unit === 'pack' ? '낱팩' : '박스'} · ₩{item.unit_price_with_tax.toLocaleString()}
                              {maxQty !== Infinity && product && (
                                <> · 최대 {maxQty.toLocaleString()}</>
                              )}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              onClick={() => updateEditQty(item.id, item.quantity - 1)}
                              disabled={item.quantity <= 1}
                              className="w-8 h-8 rounded border border-gray-300 flex items-center justify-center text-gray-600 hover:bg-gray-50 disabled:opacity-30"
                            >
                              −
                            </button>
                            <span className="w-8 text-center text-sm font-bold text-[#1B4332]">{item.quantity}</span>
                            <button
                              onClick={() => updateEditQty(item.id, item.quantity + 1)}
                              disabled={!canIncrease}
                              className="w-8 h-8 rounded border border-[#1B4332] bg-[#1B4332] text-white flex items-center justify-center hover:bg-[#2D6A4F] disabled:opacity-30 disabled:cursor-not-allowed"
                            >
                              +
                            </button>
                            <button
                              onClick={() => removeEditItem(item.id)}
                              className="px-2 h-8 rounded border border-red-300 text-red-600 text-xs font-medium hover:bg-red-50"
                            >
                              삭제
                            </button>
                          </div>
                          <span className="font-medium text-gray-800 text-sm w-24 text-right shrink-0">
                            ₩{(item.unit_price_with_tax * item.quantity).toLocaleString()}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  <div className="mt-4 pt-4 border-t border-gray-200">
                    <div className="flex items-center justify-between gap-3">
                      <h4 className="font-medium text-gray-700 text-sm">상품 추가</h4>
                      {allowedProductIds && (
                        <span className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded px-2 py-1">
                          이 가맹점 주문 가능 상품만 표시
                        </span>
                      )}
                    </div>
                    <div className="mt-2 flex flex-col sm:flex-row gap-2">
                      <div className="flex gap-2">
                        {([['all', '전체'], ['exclusive', '전용'], ['general', '범용']] as const).map(([key, label]) => (
                          <button
                            key={key}
                            onClick={() => setEditFilter(key)}
                            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                              editFilter === key
                                ? 'bg-[#1B4332] text-white'
                                : 'bg-white text-gray-600 border border-gray-200'
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <input
                        type="text"
                        value={editSearch}
                        onChange={(e) => setEditSearch(e.target.value)}
                        placeholder="상품 검색..."
                        className="flex-1 px-3 py-1.5 border border-gray-300 rounded-lg text-sm text-gray-900"
                      />
                    </div>

                    <div className="mt-3 border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-72 overflow-y-auto">
                      {filteredEditProducts.length === 0 ? (
                        <div className="p-5 text-center text-sm text-gray-400">추가할 수 있는 상품이 없습니다.</div>
                      ) : filteredEditProducts.map((product) => {
                        const boxQty = getEditQty(product.id, 'box');
                        const packQty = getEditQty(product.id, 'pack');
                        const maxBoxQty = getEditableMaxQty(product, 'box');
                        const maxPackQty = getEditableMaxQty(product, 'pack');
                        const canAddBox = boxQty < maxBoxQty;
                        const canAddPack = product.is_loose_pack_sellable && packQty < maxPackQty;
                        return (
                          <div key={product.id} className="p-3 flex items-center gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1">
                                <span className={`px-2 py-0.5 rounded text-xs font-semibold ${
                                  product.product_type === 'exclusive'
                                    ? 'bg-orange-100 text-orange-700'
                                    : 'bg-blue-100 text-blue-700'
                                }`}>
                                  {product.product_type === 'exclusive' ? '전용' : '범용'}
                                </span>
                                <span className="text-xs text-gray-400">
                                  {storageLabel[product.storage || ''] || ''}{product.spec ? ` · ${product.spec}` : ''}
                                </span>
                              </div>
                              <p className="font-medium text-sm text-gray-800 truncate">{product.name}</p>
                              <p className="text-xs text-gray-500">
                                ₩{product.price_with_tax.toLocaleString()} / {product.unit}
                                {product.is_tax_free && <span className="ml-1 text-green-600">(면세)</span>}
                              </p>
                            </div>
                            <div className="flex flex-col sm:flex-row gap-2 shrink-0">
                              <button
                                onClick={() => addEditItem(product, 'box')}
                                disabled={!canAddBox}
                                className="px-3 py-1.5 bg-[#1B4332] text-white rounded-lg text-xs font-medium hover:bg-[#2D6A4F] disabled:opacity-30 disabled:cursor-not-allowed"
                              >
                                박스 추가
                              </button>
                              {product.is_loose_pack_sellable && (
                                <button
                                  onClick={() => addEditItem(product, 'pack')}
                                  disabled={!canAddPack}
                                  className="px-3 py-1.5 bg-amber-600 text-white rounded-lg text-xs font-medium hover:bg-amber-700 disabled:opacity-30 disabled:cursor-not-allowed"
                                >
                                  낱팩 추가
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
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
                      수정 사유 <span className="text-red-500">*</span>
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

            {/* 상태 변경 — 관리자 + 신화푸드 */}
            {!editMode && (profile?.role === 'admin' || profile?.role === 'shinwa') && (
              <>
                {selectedOrder.status === 'pending' && (
                  <div className="mt-4 pt-4 border-t border-gray-200">
                    <p className="text-sm text-gray-500 mb-2">상태 변경</p>
                    <button onClick={() => updateStatus(selectedOrder.id, 'confirmed')}
                      className="w-full py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">
                      발주 확정
                    </button>
                  </div>
                )}
                {selectedOrder.status === 'confirmed' && (
                  <div className="mt-4 pt-4 border-t border-gray-200">
                    <p className="text-sm text-gray-500 mb-2">상태 변경</p>
                    <div className="flex gap-2">
                      <button onClick={() => handleShipOrder(selectedOrder.id)}
                        className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">
                        출고 처리
                      </button>
                      <button onClick={() => {
                        if (!confirm('발주 확정을 취소하시겠습니까?\n상태가 대기로 되돌아갑니다.')) return;
                        updateStatus(selectedOrder.id, 'pending');
                      }}
                        className="flex-1 py-2 bg-orange-500 text-white rounded-lg text-sm font-medium hover:bg-orange-600">
                        확정 취소
                      </button>
                    </div>
                  </div>
                )}
              </>
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
  const dateChosen = order.stores?.allow_split_shipping;
  return (
    <div
      onClick={onClick}
      className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 cursor-pointer hover:border-[#2D6A4F] transition"
    >
      <div className="flex items-center justify-between mb-2 gap-2">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <span className="font-semibold text-gray-800 text-sm">{order.order_number}</span>
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${st.color}`}>{st.text}</span>
          {order.ship_date && (
            <span className={`px-3 py-1 rounded-lg text-sm font-bold border-2 ${
              dateChosen
                ? 'bg-purple-100 text-purple-800 border-purple-300'
                : 'bg-emerald-50 text-emerald-700 border-emerald-200'
            }`}>
              {dateChosen ? '📅 요청 배송일' : '🚚 출고'} {formatShipDate(order.ship_date)}
            </span>
          )}
        </div>
        <span className="font-bold text-gray-800 shrink-0">₩{order.total_amount.toLocaleString()}</span>
      </div>
      <div className="flex items-center justify-between text-sm text-gray-500">
        <span>{storeName}</span>
        <span>{new Date(order.created_at).toLocaleDateString('ko-KR')}</span>
      </div>
      {order.memo && <p className="mt-1 text-xs text-gray-400">메모: {order.memo}</p>}
    </div>
  );
}
