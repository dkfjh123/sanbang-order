'use client';

import { useEffect, useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import {
  getStoreDeliverySchedule,
  getUpcomingDeliveryDates,
  toLocalISODate,
  type DeliveryInfo,
} from '@/lib/delivery-schedule';
import type { Store, Profile } from '@/types';

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

interface CartItem {
  product: Product;
  quantity: number;
  unit: 'box' | 'pack';
  unit_price: number;
  unit_price_with_tax: number;
}

const DEFAULT_MIN_ORDER_AMOUNT = 150000;

const storageLabel: Record<string, string> = {
  frozen: '냉동',
  refrigerated: '냉장',
  room_temp: '상온',
};

const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];
function formatDateLabel(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return `${d.getMonth() + 1}/${d.getDate()}(${DAY_NAMES[d.getDay()]})`;
}

export default function NewOrderPage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [store, setStore] = useState<Store | null>(null);
  const [stores, setStores] = useState<Store[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [filter, setFilter] = useState<'all' | 'exclusive' | 'general'>('all');
  const [search, setSearch] = useState('');
  const [memo, setMemo] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string; amount: number; deliveryInfo?: DeliveryInfo; chosenShipDate?: string } | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [deliveryInfo, setDeliveryInfo] = useState<DeliveryInfo | null>(null);
  const [jejuPalletBoxes, setJejuPalletBoxes] = useState<number>(0);
  const [inventory, setInventory] = useState<Record<string, number>>({});
  const [loosePack, setLoosePack] = useState<Record<string, number>>({});
  // 동일옥: 주문 전체의 배송일을 점주가 선택
  const [chosenShipDate, setChosenShipDate] = useState<string>('');
  // 매장 화이트리스트: null이면 전체 발주 가능, Set이면 해당 상품 ID만 발주 가능
  const [allowedProductIds, setAllowedProductIds] = useState<Set<string> | null>(null);
  const JEJU_PALLET_MIN = 55;
  const supabase = createClient();

  const allowChooseShipDate = !!store?.allow_split_shipping;
  const minOrderAmount = store?.min_order_amount ?? DEFAULT_MIN_ORDER_AMOUNT;

  // 이 매장의 가능 배송일 (동일옥용 드롭다운 옵션) — 가장 가까운 3개 노출
  const upcomingDates: string[] = store
    ? getUpcomingDeliveryDates(
        {
          region: store.region,
          delivery_days: store.delivery_days,
          deadline_override_until: store.deadline_override_until,
        },
        3
      ).map((d) => toLocalISODate(d))
    : [];

  const updateDeliveryInfo = useCallback(() => {
    if (store) {
      setDeliveryInfo(
        getStoreDeliverySchedule({
          region: store.region,
          delivery_days: store.delivery_days,
          deadline_override_until: store.deadline_override_until,
        })
      );
    } else {
      setDeliveryInfo(null);
    }
  }, [store]);

  // 배송 스케줄 실시간 업데이트 (1분마다)
  useEffect(() => {
    updateDeliveryInfo();
    const timer = setInterval(updateDeliveryInfo, 60000);
    return () => clearInterval(timer);
  }, [updateDeliveryInfo]);

  // 매장 변경 시 화이트리스트 로드
  useEffect(() => {
    let cancelled = false;
    async function loadAllowed() {
      if (!store) {
        setAllowedProductIds(null);
        return;
      }
      const { data } = await supabase
        .from('store_allowed_products')
        .select('product_id')
        .eq('store_id', store.id);
      if (cancelled) return;
      if (!data || data.length === 0) {
        setAllowedProductIds(null);
      } else {
        setAllowedProductIds(new Set(data.map((r: { product_id: string }) => r.product_id)));
      }
    }
    loadAllowed();
    return () => {
      cancelled = true;
    };
  }, [store?.id, supabase]);

  useEffect(() => {
    async function loadJejuPallet() {
      const now = new Date();
      const day = now.getDay();
      const diffToMon = (day === 0 ? -6 : 1) - day;
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() + diffToMon);
      weekStart.setHours(0, 0, 0, 0);

      const { data: jejuStores } = await supabase
        .from('stores')
        .select('id')
        .eq('region', 'jeju');

      if (!jejuStores || jejuStores.length === 0) return;

      const jejuStoreIds = jejuStores.map((s: { id: string }) => s.id);

      const { data: jejuOrders } = await supabase
        .from('orders')
        .select('id, store_id, order_items(product_type, quantity)')
        .in('store_id', jejuStoreIds)
        .in('status', ['pending', 'confirmed'])
        .gte('created_at', weekStart.toISOString());

      let totalBoxes = 0;
      (jejuOrders || []).forEach((order: { order_items: { product_type: string; quantity: number }[] }) => {
        order.order_items.forEach((item) => {
          if (item.product_type === 'exclusive') {
            totalBoxes += item.quantity;
          }
        });
      });
      setJejuPalletBoxes(totalBoxes);
    }

    async function load() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data: prof } = await supabase.from('profiles').select('*').eq('id', user.id).single();
      if (!prof) return;
      setProfile(prof as Profile);

      const { data: prods } = await supabase
        .from('products')
        .select('*')
        .eq('is_active', true)
        .order('sort_order');
      setProducts((prods as Product[]) || []);

      const { data: invData } = await supabase
        .from('inventory')
        .select('product_id, quantity, loose_pack_qty');
      if (invData) {
        const invMap: Record<string, number> = {};
        const looseMap: Record<string, number> = {};
        invData.forEach((i: { product_id: string; quantity: number; loose_pack_qty: number }) => {
          invMap[i.product_id] = i.quantity;
          looseMap[i.product_id] = i.loose_pack_qty || 0;
        });
        setInventory(invMap);
        setLoosePack(looseMap);
      }

      if (prof.role === 'admin') {
        const { data: storeList } = await supabase.from('stores').select('*').order('created_at');
        setStores((storeList as Store[]) || []);
      } else if (prof.store_id) {
        const { data: s } = await supabase.from('stores').select('*').eq('id', prof.store_id).single();
        if (s) {
          setStore(s as Store);
          setSelectedStoreId(s.id);
        }
      }

      await loadJejuPallet();
      setLoading(false);
    }
    load();
  }, []);

  // 관리자가 가맹점 선택 시 — store 상태 동기화 + 장바구니/배송일 초기화
  const [lastSelectedStoreIdForCart, setLastSelectedStoreIdForCart] = useState('');
  if (selectedStoreId && selectedStoreId !== lastSelectedStoreIdForCart && stores.length > 0) {
    const s = stores.find((st) => st.id === selectedStoreId) || null;
    setStore(s);
    setCart([]);
    setChosenShipDate('');
    setLastSelectedStoreIdForCart(selectedStoreId);
  }

  // 동일옥: 가능 배송일이 로드되면 기본값으로 가장 빠른 날짜 세팅
  if (allowChooseShipDate && !chosenShipDate && upcomingDates.length > 0) {
    setChosenShipDate(upcomingDates[0]);
  }
  // 비분할 매장: chosenShipDate 값 사용 안함
  if (!allowChooseShipDate && chosenShipDate !== '') {
    setChosenShipDate('');
  }

  const filteredProducts = products.filter((p) => {
    if (allowedProductIds && !allowedProductIds.has(p.id)) return false;
    const matchType = filter === 'all' || p.product_type === filter;
    const matchSearch = !search || p.name.toLowerCase().includes(search.toLowerCase());
    return matchType && matchSearch;
  });

  const updateCart = (product: Product, unit: 'box' | 'pack', qty: number) => {
    setCart((prev) => {
      const existing = prev.find((c) => c.product.id === product.id && c.unit === unit);
      if (qty <= 0) return prev.filter((c) => !(c.product.id === product.id && c.unit === unit));
      const unit_price = unit === 'box' ? product.price : Math.round(product.price / (product.pack_per_box || 1));
      const unit_price_with_tax = unit === 'box'
        ? product.price_with_tax
        : Math.round(product.price_with_tax / (product.pack_per_box || 1));
      if (existing) {
        return prev.map((c) =>
          c.product.id === product.id && c.unit === unit ? { ...c, quantity: qty } : c
        );
      }
      return [...prev, { product, unit, quantity: qty, unit_price, unit_price_with_tax }];
    });
  };

  const getQty = (productId: string, unit: 'box' | 'pack' = 'box') =>
    cart.find((c) => c.product.id === productId && c.unit === unit)?.quantity || 0;
  const getStock = (productId: string): number | null => {
    if (productId in inventory) return inventory[productId];
    const product = products.find((p) => p.id === productId);
    if (product?.product_type === 'exclusive') return 0;
    return null;
  };
  const isOutOfStock = (productId: string): boolean => {
    const stock = getStock(productId);
    return stock !== null && stock <= 0;
  };
  const getLoosePack = (productId: string) => loosePack[productId] || 0;
  const getPackPrice = (product: Product) => Math.round(product.price_with_tax / (product.pack_per_box || 1));

  const totalAmount = cart.reduce((sum, item) => sum + item.unit_price_with_tax * item.quantity, 0);

  const handleSubmit = async () => {
    if (!selectedStoreId) {
      setResult({ success: false, message: '가맹점을 선택해주세요.', amount: 0 });
      return;
    }
    if (cart.length === 0) {
      setResult({ success: false, message: '상품을 선택해주세요.', amount: 0 });
      return;
    }
    if (totalAmount < minOrderAmount) {
      setResult({ success: false, message: `최소발주금액은 ₩${minOrderAmount.toLocaleString()}입니다.`, amount: 0 });
      return;
    }
    if (allowChooseShipDate && !chosenShipDate) {
      setResult({ success: false, message: '배송일을 선택해주세요.', amount: 0 });
      return;
    }

    setSubmitting(true);
    setResult(null);

    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        store_id: selectedStoreId,
        memo,
        // 동일옥은 점주가 선택한 날짜, 나머지는 서버에서 자동 결정
        ship_date: allowChooseShipDate ? chosenShipDate : null,
        items: cart.map((item) => ({
          product_id: item.product.id,
          product_name: item.unit === 'pack' ? `${item.product.name} (낱팩)` : item.product.name,
          product_type: item.product.product_type,
          quantity: item.quantity,
          unit_price: item.unit_price,
          unit_price_with_tax: item.unit_price_with_tax,
          is_tax_free: item.product.is_tax_free,
          unit: item.unit,
          pack_per_box: item.product.pack_per_box || 1,
        })),
      }),
    });

    const data = await res.json();
    setSubmitting(false);

    if (res.ok) {
      const orderedAmount = totalAmount;
      const submittedShipDate = chosenShipDate;
      setCart([]);
      setMemo('');
      setCartOpen(false);
      // 다음 주문을 위해 선택된 날짜는 유지 (동일옥이 연속 주문할 때 편의)
      if (store && !store.is_direct) {
        setStore({ ...store, deposit_balance: store.deposit_balance - orderedAmount });
      }
      const { data: invData } = await supabase
        .from('inventory')
        .select('product_id, quantity, loose_pack_qty');
      if (invData) {
        const invMap: Record<string, number> = {};
        const looseMap: Record<string, number> = {};
        invData.forEach((i: { product_id: string; quantity: number; loose_pack_qty: number }) => {
          invMap[i.product_id] = i.quantity;
          looseMap[i.product_id] = i.loose_pack_qty || 0;
        });
        setInventory(invMap);
        setLoosePack(looseMap);
      }
      setResult({
        success: true,
        message: data.order_number,
        amount: orderedAmount,
        deliveryInfo: deliveryInfo || undefined,
        chosenShipDate: allowChooseShipDate ? submittedShipDate : undefined,
      });
    } else {
      setResult({ success: false, message: data.error, amount: 0 });
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="w-8 h-8 border-4 border-[#1B4332] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const submitDisabled =
    submitting ||
    totalAmount < minOrderAmount ||
    (allowChooseShipDate && !chosenShipDate) ||
    (!store?.is_direct && !!store && store.deposit_balance < totalAmount);

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-gray-800">발주하기</h2>

      {/* 가맹점 선택 (관리자만) */}
      {profile?.role === 'admin' && (
        <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
          <label className="block text-sm font-medium text-gray-700 mb-2">발주 가맹점 선택</label>
          <select
            value={selectedStoreId}
            onChange={(e) => setSelectedStoreId(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
          >
            <option value="">가맹점을 선택하세요</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.short_name || s.name} {s.is_direct ? '(직영)' : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* 예치금 잔액 */}
      {store && (
        <div className={`rounded-xl p-4 shadow-sm border ${
          store.is_direct ? 'bg-blue-50 border-blue-100' : 'bg-white border-gray-100'
        }`}>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600">
              {store.short_name || store.name} — {store.is_direct ? '후불정산 (직영점)' : '예치금 잔액'}
            </span>
            {!store.is_direct && (
              <span className={`text-lg font-bold ${
                store.deposit_balance < totalAmount ? 'text-red-600' : 'text-gray-800'
              }`}>
                ₩{store.deposit_balance.toLocaleString()}
              </span>
            )}
          </div>
        </div>
      )}

      {/* 배송일 선택 매장 안내 (동일옥) */}
      {store && allowChooseShipDate && (
        <div className="rounded-xl p-4 shadow-sm border border-purple-200 bg-purple-50">
          <div className="flex items-start gap-2">
            <span className="text-xl">📅</span>
            <div className="flex-1 text-sm text-purple-900">
              <p className="font-bold">배송일을 선택해서 주문할 수 있는 매장입니다</p>
              <p className="mt-1 text-xs leading-relaxed">
                상품을 장바구니에 담고 <b>이 주문의 배송일을 화·수·금 중 하나로 선택</b>해 주세요.
                여러 날짜로 받고 싶으시면 <b>발주를 두 번 이상 나눠서</b> 진행하시면 됩니다.
                <br />(예: 1차 발주는 화요일 배송, 2차 발주는 금요일 배송)
              </p>
            </div>
          </div>
        </div>
      )}

      {/* 배송 스케줄 안내 — 크고 잘 보이게 */}
      {store && deliveryInfo && (
        <div className={`rounded-xl shadow-sm border-2 overflow-hidden ${
          deliveryInfo.isPastDeadline
            ? 'bg-red-50 border-red-300'
            : deliveryInfo.isOverrideActive
              ? 'bg-purple-50 border-purple-300'
              : deliveryInfo.remainingMs < 3600000
                ? 'bg-amber-50 border-amber-300'
                : 'bg-emerald-50 border-emerald-300'
        }`}>
          <div className={`px-5 py-3 text-base font-bold flex items-center justify-between ${
            deliveryInfo.isPastDeadline
              ? 'bg-red-100 text-red-800'
              : deliveryInfo.isOverrideActive
                ? 'bg-purple-100 text-purple-800'
                : deliveryInfo.remainingMs < 3600000
                  ? 'bg-amber-100 text-amber-800'
                  : 'bg-emerald-100 text-emerald-800'
          }`}>
            <span>{store.region === 'jeju' ? '제주 배송 스케줄' : '서울·내륙 배송 스케줄'}</span>
            {deliveryInfo.isOverrideActive && (
              <span className="text-sm font-bold">⏳ 관리자 마감 연장 중</span>
            )}
          </div>

          <div className="px-5 py-2 text-center text-sm text-gray-600 border-b border-white/50">
            {deliveryInfo.scheduleDescription}
          </div>

          <div className="px-5 py-5">
            {deliveryInfo.isPastDeadline ? (
              <div className="text-center py-2">
                <p className="text-red-700 font-bold text-xl">이번 주 발주 마감이 지났습니다</p>
                <p className="text-red-600 text-base mt-2">
                  다음 마감: <b>{deliveryInfo.deadlineLabel}</b>
                </p>
                <p className="text-red-600 text-base mt-1">
                  {store.region === 'jeju'
                    ? `${deliveryInfo.shipLabel} 상차 → ${deliveryInfo.arrivalLabel} 도착`
                    : `${deliveryInfo.shipLabel} 출고`
                  }
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="bg-white/70 rounded-lg py-3 px-2">
                  <p className="text-xs text-gray-500 mb-1 font-medium">발주 마감</p>
                  <p className="font-bold text-gray-800 text-lg leading-tight">{deliveryInfo.deadlineLabel}</p>
                </div>
                <div className="bg-white/70 rounded-lg py-3 px-2">
                  <p className="text-xs text-gray-500 mb-1 font-medium">{store.region === 'jeju' ? '상차일' : '출고일'}</p>
                  <p className="font-bold text-gray-800 text-lg leading-tight">{deliveryInfo.shipLabel}</p>
                </div>
                <div className="bg-white/70 rounded-lg py-3 px-2">
                  <p className="text-xs text-gray-500 mb-1 font-medium">{store.region === 'jeju' ? '도착 예정' : '배송일'}</p>
                  <p className="font-bold text-gray-800 text-lg leading-tight">{deliveryInfo.arrivalLabel}</p>
                </div>
              </div>
            )}

            {!deliveryInfo.isPastDeadline && (
              <div className={`mt-4 text-center py-3 rounded-lg ${
                deliveryInfo.isOverrideActive
                  ? 'bg-purple-200'
                  : deliveryInfo.remainingMs < 3600000
                    ? 'bg-amber-200'
                    : 'bg-emerald-200'
              }`}>
                <span className="text-sm text-gray-700">마감까지 </span>
                <span className={`font-bold text-xl ${
                  deliveryInfo.isOverrideActive
                    ? 'text-purple-800'
                    : deliveryInfo.remainingMs < 3600000 ? 'text-amber-800' : 'text-emerald-800'
                }`}>
                  {deliveryInfo.remainingLabel}
                </span>
                <span className="text-sm text-gray-700"> 남음</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 제주 파레트 현황 (관리자/신화만) */}
      {(profile?.role === 'admin' || profile?.role === 'shinwa') && (
        <div className={`rounded-xl p-4 shadow-sm border ${
          jejuPalletBoxes >= JEJU_PALLET_MIN
            ? 'bg-green-50 border-green-200'
            : 'bg-orange-50 border-orange-200'
        }`}>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-bold text-gray-800">이번 주 제주 발주 현황</p>
              <p className="text-lg font-bold mt-1">
                <span className={jejuPalletBoxes >= JEJU_PALLET_MIN ? 'text-green-700' : 'text-orange-700'}>
                  {jejuPalletBoxes}
                </span>
                <span className="text-gray-500 text-sm font-normal"> / {JEJU_PALLET_MIN}박스 (1파레트)</span>
              </p>
            </div>
            <div className="text-right">
              <p className="text-2xl font-bold">
                {jejuPalletBoxes >= JEJU_PALLET_MIN
                  ? <span className="text-green-600">달성</span>
                  : <span className="text-orange-600">{JEJU_PALLET_MIN - jejuPalletBoxes}박스 부족</span>
                }
              </p>
            </div>
          </div>
          <div className="mt-3 h-3 bg-gray-200 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${jejuPalletBoxes >= JEJU_PALLET_MIN ? 'bg-green-500' : 'bg-orange-500'}`}
              style={{ width: `${Math.min(100, (jejuPalletBoxes / JEJU_PALLET_MIN) * 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* 매장 화이트리스트 안내 */}
      {store && allowedProductIds && (
        <div className="rounded-xl p-4 shadow-sm border border-amber-200 bg-amber-50 text-amber-900 text-sm">
          <p className="font-bold">이 매장은 주문 가능 상품이 제한되어 있습니다.</p>
          <p className="mt-1 text-xs">
            아래 목록에 표시된 상품({allowedProductIds.size}종)만 발주할 수 있어요.
          </p>
        </div>
      )}

      {/* 상품 필터 + 검색 */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex gap-2">
          {([['all', '전체'], ['exclusive', '전용'], ['general', '범용']] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                filter === key
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
          placeholder="상품 검색..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 px-3 py-1.5 border border-gray-300 rounded-lg text-sm text-gray-900"
        />
      </div>

      {!selectedStoreId && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 text-yellow-800 text-center font-medium">
          가맹점을 먼저 선택해주세요.
        </div>
      )}

      {/* 상품 목록 */}
      <div className={`bg-white rounded-xl shadow-sm border border-gray-100 divide-y divide-gray-100 ${!selectedStoreId ? 'opacity-50 pointer-events-none' : ''}`}>
        {filteredProducts.map((product) => {
          const qty = getQty(product.id, 'box');
          const packQty = getQty(product.id, 'pack');
          const stock = getStock(product.id);
          const outOfStock = isOutOfStock(product.id);
          const maxQty = stock !== null ? stock : Infinity;
          const loose = getLoosePack(product.id);
          const showLooseRow = product.is_loose_pack_sellable && loose > 0;
          const packPrice = getPackPrice(product);
          return (
            <div key={product.id} className={`p-5 sm:p-6 ${outOfStock && !showLooseRow ? 'opacity-50' : ''}`}>
              <div className="flex items-center gap-5">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`px-2.5 py-1 rounded text-sm font-semibold ${
                      product.product_type === 'exclusive'
                        ? 'bg-orange-100 text-orange-700'
                        : 'bg-blue-100 text-blue-700'
                    }`}>
                      {product.product_type === 'exclusive' ? '전용' : '범용'}
                    </span>
                    <span className="text-base text-gray-400">
                      {storageLabel[product.storage || ''] || ''} · {product.spec}
                    </span>
                    {stock !== null && profile?.role !== 'store' && (
                      <span className={`text-sm font-medium ${outOfStock ? 'text-red-500' : stock <= 5 ? 'text-orange-500' : 'text-gray-400'}`}>
                        재고 {stock}
                      </span>
                    )}
                  </div>
                  <h3 className="font-bold text-gray-800 text-lg">{product.name}</h3>
                  <p className="text-lg text-gray-600 mt-1">
                    ₩{product.price_with_tax.toLocaleString()} / {product.unit}
                    {product.is_tax_free && <span className="ml-1 text-base text-green-600">(면세)</span>}
                  </p>
                  {outOfStock && <p className="text-red-500 font-bold text-sm mt-1">품절</p>}
                  {!outOfStock && stock !== null && qty >= stock && qty > 0 && profile?.role !== 'store' && (
                    <p className="text-orange-500 font-medium text-sm mt-1">최대 주문 가능 수량: {stock}개</p>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => updateCart(product, 'box', qty - 1)}
                    disabled={qty === 0 || outOfStock}
                    className="w-12 h-12 rounded-lg border border-gray-300 flex items-center justify-center text-xl text-gray-600 hover:bg-gray-50 disabled:opacity-30"
                  >
                    −
                  </button>
                  <span className={`w-12 text-center text-xl font-bold ${qty > 0 ? 'text-[#1B4332]' : 'text-gray-300'}`}>
                    {qty}
                  </span>
                  <button
                    onClick={() => updateCart(product, 'box', qty + 1)}
                    disabled={outOfStock || qty >= maxQty}
                    className="w-12 h-12 rounded-lg border border-[#1B4332] bg-[#1B4332] text-white text-xl flex items-center justify-center hover:bg-[#2D6A4F] disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    +
                  </button>
                </div>
              </div>

              {/* 낱팩 옵션 행 */}
              {showLooseRow && (
                <div className="mt-3 pt-3 border-t border-dashed border-amber-200 flex items-center gap-5 bg-amber-50/50 -mx-2 px-4 py-3 rounded-lg">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="px-2 py-0.5 bg-amber-100 text-amber-800 rounded text-xs font-semibold">낱팩</span>
                      <span className="text-sm text-amber-700 font-medium">{loose}팩 남음</span>
                    </div>
                    <p className="text-base text-gray-700 mt-1">
                      ₩{packPrice.toLocaleString()} / 팩
                      <span className="text-xs text-gray-400 ml-1">({product.pack_per_box}팩 = 1박스)</span>
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => updateCart(product, 'pack', packQty - 1)}
                      disabled={packQty === 0}
                      className="w-10 h-10 rounded-lg border border-gray-300 flex items-center justify-center text-lg text-gray-600 hover:bg-gray-50 disabled:opacity-30"
                    >
                      −
                    </button>
                    <span className={`w-10 text-center text-lg font-bold ${packQty > 0 ? 'text-amber-700' : 'text-gray-300'}`}>
                      {packQty}
                    </span>
                    <button
                      onClick={() => updateCart(product, 'pack', packQty + 1)}
                      disabled={packQty >= loose}
                      className="w-10 h-10 rounded-lg border border-amber-600 bg-amber-600 text-white text-lg flex items-center justify-center hover:bg-amber-700 disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      +
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 결과 모달 */}
      {result && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setResult(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-8 text-center" onClick={(e) => e.stopPropagation()}>
            {result.success ? (
              <>
                <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <span className="text-3xl">✅</span>
                </div>
                <h3 className="text-xl font-bold text-gray-800 mb-2">발주 완료!</h3>
                <p className="text-gray-600 mb-1">주문번호</p>
                <p className="text-lg font-bold text-[#1B4332] mb-3">{result.message}</p>
                <p className="text-gray-500 text-sm mb-2">결제금액: ₩{result.amount.toLocaleString()}</p>
                {result.chosenShipDate ? (
                  <div className="bg-purple-50 rounded-lg px-4 py-3 mb-4 text-sm">
                    <span className="text-gray-500 text-xs">요청 배송일</span>
                    <p className="font-bold text-purple-800 text-base">{formatDateLabel(result.chosenShipDate)}</p>
                  </div>
                ) : result.deliveryInfo && (
                  <div className="bg-emerald-50 rounded-lg px-4 py-3 mb-4 text-sm">
                    <div className="grid grid-cols-2 gap-2 text-left">
                      <div>
                        <span className="text-gray-500 text-xs">{store?.region === 'jeju' ? '상차일' : '출고일'}</span>
                        <p className="font-semibold text-gray-800">{result.deliveryInfo.shipLabel}</p>
                      </div>
                      <div>
                        <span className="text-gray-500 text-xs">{store?.region === 'jeju' ? '도착 예정' : '배송일'}</span>
                        <p className="font-semibold text-gray-800">{result.deliveryInfo.arrivalLabel}</p>
                      </div>
                    </div>
                  </div>
                )}
                <div className="flex gap-3">
                  <button
                    onClick={() => setResult(null)}
                    className="flex-1 py-3 border border-gray-300 rounded-xl text-gray-600 font-medium hover:bg-gray-50 transition"
                  >
                    계속 발주
                  </button>
                  <a
                    href="/orders"
                    className="flex-1 py-3 bg-[#1B4332] text-white rounded-xl font-medium hover:bg-[#2D6A4F] transition text-center"
                  >
                    발주내역 보기
                  </a>
                </div>
              </>
            ) : (
              <>
                {result.message.includes('재고') ? (
                  <div className="w-16 h-16 bg-orange-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <span className="text-3xl">📦</span>
                  </div>
                ) : result.message.includes('예치금') ? (
                  <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <span className="text-3xl">💰</span>
                  </div>
                ) : (
                  <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <span className="text-3xl">⚠️</span>
                  </div>
                )}
                <h3 className="text-xl font-bold text-gray-800 mb-2">
                  {result.message.includes('재고') ? '재고 부족' : result.message.includes('예치금') ? '예치금 부족' : '발주 실패'}
                </h3>
                <div className={`rounded-lg px-4 py-3 mb-6 text-left text-sm ${
                  result.message.includes('재고') ? 'bg-orange-50 text-orange-800' :
                  result.message.includes('예치금') ? 'bg-red-50 text-red-700' :
                  'bg-gray-50 text-gray-700'
                }`}>
                  <p>{result.message}</p>
                  {result.message.includes('예치금') && (
                    <p className="mt-2 text-xs font-medium">관리자에게 예치금 충전을 요청해주세요.</p>
                  )}
                  {result.message.includes('재고') && (
                    <p className="mt-2 text-xs font-medium">해당 상품의 수량을 줄이거나, 관리자에게 문의해주세요.</p>
                  )}
                </div>
                <button
                  onClick={() => setResult(null)}
                  className="w-full py-3 bg-[#1B4332] text-white rounded-xl font-medium hover:bg-[#2D6A4F] transition"
                >
                  확인
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* 하단 여백 (고정 바에 가리지 않게) */}
      {cart.length > 0 && <div className="h-20" />}

      {/* 하단 고정 바 */}
      {cart.length > 0 && (
        <>
          {/* 펼쳐지는 상세 패널 */}
          {cartOpen && (
            <div className="fixed inset-0 z-40" onClick={() => setCartOpen(false)}>
              <div className="absolute inset-0 bg-black/40" />
              <div
                className="absolute bottom-16 left-0 right-0 lg:left-64 bg-white border-t border-gray-200 shadow-2xl rounded-t-2xl max-h-[70vh] overflow-y-auto"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="font-bold text-gray-800 text-lg">주문 요약 ({cart.length}건)</h3>
                    <button onClick={() => setCart([])} className="text-sm text-red-500 hover:text-red-700">
                      전체 삭제
                    </button>
                  </div>

                  {/* 동일옥: 배송일 선택 안내 (실제 버튼은 하단 고정 바에 있음) */}
                  {allowChooseShipDate && (
                    <div className="bg-purple-50 border border-purple-200 rounded-lg p-3 text-sm text-purple-900">
                      <p>
                        📅 <b>이 주문의 배송일</b>은 하단에서 선택할 수 있습니다.
                        {chosenShipDate && (
                          <> 현재 선택: <b className="text-purple-700">{formatDateLabel(chosenShipDate)}</b></>
                        )}
                      </p>
                      <p className="text-xs text-purple-800 mt-1 leading-relaxed">
                        다른 날짜에 받고 싶은 품목은 이 발주 제출 후 <b>다시 발주하기</b>에서 별도 주문해 주세요.
                      </p>
                    </div>
                  )}

                  <div className="divide-y divide-gray-100">
                    {cart.map((item) => (
                      <div key={`${item.product.id}|${item.unit}`} className="py-3 flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <span className="text-sm font-medium text-gray-800 block truncate">
                            {item.product.name}
                            {item.unit === 'pack' && (
                              <span className="ml-1 text-xs text-amber-700 font-semibold">· 낱팩</span>
                            )}
                          </span>
                          <span className="text-xs text-gray-400">
                            ₩{item.unit_price_with_tax.toLocaleString()} / {item.unit === 'pack' ? '팩' : item.product.unit}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button onClick={() => updateCart(item.product, item.unit, item.quantity - 1)}
                            className="w-8 h-8 rounded border border-gray-300 flex items-center justify-center text-gray-600 hover:bg-gray-50">−</button>
                          <span className="w-8 text-center text-sm font-bold text-[#1B4332]">{item.quantity}</span>
                          <button onClick={() => updateCart(item.product, item.unit, item.quantity + 1)}
                            className="w-8 h-8 rounded border border-[#1B4332] bg-[#1B4332] text-white flex items-center justify-center hover:bg-[#2D6A4F]">+</button>
                          <button onClick={() => updateCart(item.product, item.unit, 0)}
                            className="w-8 h-8 rounded border border-red-300 text-red-500 flex items-center justify-center hover:bg-red-50 ml-1">✕</button>
                        </div>
                        <span className="font-medium text-gray-800 text-sm w-24 text-right shrink-0">
                          ₩{(item.unit_price_with_tax * item.quantity).toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>

                  <div>
                    <label className="block text-sm text-gray-600 mb-1">메모 (선택)</label>
                    <input
                      type="text"
                      value={memo}
                      onChange={(e) => setMemo(e.target.value)}
                      placeholder="요청사항을 입력하세요"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900"
                    />
                  </div>

                  {!store?.is_direct && store && store.deposit_balance < totalAmount && (
                    <p className="text-red-600 text-sm font-medium">예치금이 부족합니다. 관리자에게 문의하세요.</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* 고정 하단 바 */}
          <div className="fixed bottom-0 left-0 right-0 lg:left-64 z-50 bg-white border-t border-gray-200 shadow-[0_-4px_20px_rgba(0,0,0,0.1)]">
            {/* 동일옥: 배송일 선택 행 — 눈에 띄게 상단에 배치 */}
            {allowChooseShipDate && (
              <div className="border-b-2 border-purple-200 bg-purple-50 px-5 py-3">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-sm font-bold text-purple-900 shrink-0">
                    📅 배송일 <span className="text-red-600">*</span>
                  </span>
                  {upcomingDates.length === 0 ? (
                    <span className="text-sm text-red-600 font-medium">선택 가능한 배송일이 없습니다.</span>
                  ) : (
                    <div className="flex gap-2 flex-wrap">
                      {upcomingDates.map((d) => {
                        const selected = d === chosenShipDate;
                        return (
                          <button
                            key={d}
                            onClick={() => setChosenShipDate(d)}
                            className={`px-4 py-2 text-base font-bold border-2 rounded-lg transition shadow-sm ${
                              selected
                                ? 'bg-purple-600 text-white border-purple-600 shadow-md scale-105'
                                : 'bg-white border-purple-300 text-purple-700 hover:bg-purple-100'
                            }`}
                          >
                            {formatDateLabel(d)}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="flex items-center justify-between px-5 py-3">
              <button
                onClick={() => setCartOpen(!cartOpen)}
                className="flex items-center gap-3"
              >
                <span className="bg-[#1B4332] text-white w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold">
                  {cart.reduce((sum, item) => sum + item.quantity, 0)}
                </span>
                <div className="text-left">
                  <p className="text-lg font-bold text-gray-800">₩{totalAmount.toLocaleString()}</p>
                  <p className="text-xs text-gray-400">
                    {cartOpen ? '닫기' : '상세보기'}
                  </p>
                </div>
              </button>
              <button
                onClick={handleSubmit}
                disabled={submitDisabled}
                className="px-8 py-3 bg-[#1B4332] text-white rounded-xl font-bold text-lg hover:bg-[#2D6A4F] transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting
                  ? '처리 중...'
                  : totalAmount < minOrderAmount
                    ? `₩${minOrderAmount.toLocaleString()} 이상`
                    : allowChooseShipDate && !chosenShipDate
                      ? '배송일 선택 필요'
                      : !store?.is_direct && !!store && store.deposit_balance < totalAmount
                        ? `예치금 부족 (₩${(totalAmount - store.deposit_balance).toLocaleString()} 이상 충전 필요)`
                        : '발주하기'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
