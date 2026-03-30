'use client';

import { useEffect, useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { getDeliverySchedule, type DeliveryInfo } from '@/lib/delivery-schedule';
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
}

interface CartItem {
  product: Product;
  quantity: number;
}

const storageLabel: Record<string, string> = {
  frozen: '냉동',
  refrigerated: '냉장',
  room_temp: '상온',
};

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
  const [result, setResult] = useState<{ success: boolean; message: string; amount: number; deliveryInfo?: DeliveryInfo } | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [deliveryInfo, setDeliveryInfo] = useState<DeliveryInfo | null>(null);
  const [jejuPalletBoxes, setJejuPalletBoxes] = useState<number>(0);
  const [inventory, setInventory] = useState<Record<string, number>>({});
  const JEJU_PALLET_MIN = 55;
  const supabase = createClient();

  const updateDeliveryInfo = useCallback(() => {
    if (store) {
      setDeliveryInfo(getDeliverySchedule(store.region));
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

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data: prof } = await supabase.from('profiles').select('*').eq('id', user.id).single();
      if (!prof) return;
      setProfile(prof as Profile);

      // 상품 로드
      const { data: prods } = await supabase
        .from('products')
        .select('*')
        .eq('is_active', true)
        .order('sort_order');
      setProducts((prods as Product[]) || []);

      // 재고 정보 로드
      const { data: invData } = await supabase
        .from('inventory')
        .select('product_id, quantity');
      if (invData) {
        const invMap: Record<string, number> = {};
        invData.forEach((i: { product_id: string; quantity: number }) => {
          invMap[i.product_id] = i.quantity;
        });
        setInventory(invMap);
      }

      if (prof.role === 'admin') {
        // 관리자: 가맹점 선택 가능
        const { data: storeList } = await supabase.from('stores').select('*').order('created_at');
        setStores((storeList as Store[]) || []);
      } else if (prof.store_id) {
        // 가맹점: 자기 매장만
        const { data: s } = await supabase.from('stores').select('*').eq('id', prof.store_id).single();
        if (s) {
          setStore(s as Store);
          setSelectedStoreId(s.id);
        }
      }

      // 제주 파레트 현황 조회
      await loadJejuPallet();

      setLoading(false);
    }
    load();
  }, []);

  async function loadJejuPallet() {
    // 이번 주 수요일 마감 기준 제주 주문의 전용상품 박스 합산
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

  // 관리자가 가맹점 선택 시
  useEffect(() => {
    if (selectedStoreId && stores.length > 0) {
      const s = stores.find((st) => st.id === selectedStoreId);
      setStore(s || null);
    }
  }, [selectedStoreId, stores]);

  const filteredProducts = products.filter((p) => {
    const matchType = filter === 'all' || p.product_type === filter;
    const matchSearch = !search || p.name.toLowerCase().includes(search.toLowerCase());
    return matchType && matchSearch;
  });

  const updateCart = (product: Product, qty: number) => {
    setCart((prev) => {
      const existing = prev.find((c) => c.product.id === product.id);
      if (qty <= 0) return prev.filter((c) => c.product.id !== product.id);
      if (existing) return prev.map((c) => c.product.id === product.id ? { ...c, quantity: qty } : c);
      return [...prev, { product, quantity: qty }];
    });
  };

  const getQty = (productId: string) => cart.find((c) => c.product.id === productId)?.quantity || 0;
  const getStock = (productId: string): number | null => {
    return productId in inventory ? inventory[productId] : null;
  };
  const isOutOfStock = (productId: string): boolean => {
    const stock = getStock(productId);
    return stock !== null && stock <= 0;
  };

  const totalAmount = cart.reduce((sum, item) => sum + item.product.price_with_tax * item.quantity, 0);

  const MIN_ORDER_AMOUNT = 150000;

  const handleSubmit = async () => {
    if (!selectedStoreId) {
      setResult({ success: false, message: '가맹점을 선택해주세요.', amount: 0 });
      return;
    }
    if (cart.length === 0) {
      setResult({ success: false, message: '상품을 선택해주세요.', amount: 0 });
      return;
    }
    if (totalAmount < MIN_ORDER_AMOUNT) {
      setResult({ success: false, message: `최소발주금액은 ₩${MIN_ORDER_AMOUNT.toLocaleString()}입니다.`, amount: 0 });
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
        items: cart.map((item) => ({
          product_id: item.product.id,
          product_name: item.product.name,
          product_type: item.product.product_type,
          quantity: item.quantity,
          unit_price: item.product.price,
          unit_price_with_tax: item.product.price_with_tax,
          is_tax_free: item.product.is_tax_free,
        })),
      }),
    });

    const data = await res.json();
    setSubmitting(false);

    if (res.ok) {
      const orderedAmount = totalAmount;
      setCart([]);
      setMemo('');
      setCartOpen(false);
      // 예치금 갱신
      if (store && !store.is_direct) {
        setStore({ ...store, deposit_balance: store.deposit_balance - orderedAmount });
      }
      // 재고 갱신
      const { data: invData } = await supabase
        .from('inventory')
        .select('product_id, quantity');
      if (invData) {
        const invMap: Record<string, number> = {};
        invData.forEach((i: { product_id: string; quantity: number }) => {
          invMap[i.product_id] = i.quantity;
        });
        setInventory(invMap);
      }
      setResult({ success: true, message: data.order_number, amount: orderedAmount, deliveryInfo: deliveryInfo || undefined });
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

      {/* 배송 스케줄 안내 */}
      {store && deliveryInfo && (
        <div className={`rounded-xl shadow-sm border overflow-hidden ${
          deliveryInfo.isPastDeadline
            ? 'bg-red-50 border-red-200'
            : deliveryInfo.remainingMs < 3600000
              ? 'bg-amber-50 border-amber-200'
              : 'bg-emerald-50 border-emerald-200'
        }`}>
          <div className={`px-4 py-2.5 text-sm font-semibold flex items-center gap-2 ${
            deliveryInfo.isPastDeadline
              ? 'bg-red-100 text-red-800'
              : deliveryInfo.remainingMs < 3600000
                ? 'bg-amber-100 text-amber-800'
                : 'bg-emerald-100 text-emerald-800'
          }`}>
            <span>{store.region === 'jeju' ? '🏝️ 제주 배송' : '🚚 서울·내륙 배송'}</span>
            <span className="font-normal text-xs opacity-75">— {deliveryInfo.scheduleDescription}</span>
          </div>

          <div className="px-4 py-3">
            {deliveryInfo.isPastDeadline ? (
              <div className="text-center py-1">
                <p className="text-red-700 font-bold text-base">이번 주 발주 마감이 지났습니다</p>
                <p className="text-red-600 text-sm mt-1">
                  다음 마감: {deliveryInfo.deadlineLabel}
                  {store.region === 'jeju'
                    ? ` → ${deliveryInfo.shipLabel} 상차 → ${deliveryInfo.arrivalLabel} 도착`
                    : ` → ${deliveryInfo.shipLabel} 출고`
                  }
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-3 text-center">
                <div>
                  <p className="text-xs text-gray-500 mb-0.5">발주 마감</p>
                  <p className="font-bold text-gray-800 text-sm">{deliveryInfo.deadlineLabel}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500 mb-0.5">{store.region === 'jeju' ? '상차일' : '출고일'}</p>
                  <p className="font-bold text-gray-800 text-sm">{deliveryInfo.shipLabel}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500 mb-0.5">{store.region === 'jeju' ? '도착 예정' : '배송일'}</p>
                  <p className="font-bold text-gray-800 text-sm">{deliveryInfo.arrivalLabel}</p>
                </div>
              </div>
            )}

            {!deliveryInfo.isPastDeadline && (
              <div className={`mt-3 text-center py-2 rounded-lg ${
                deliveryInfo.remainingMs < 3600000
                  ? 'bg-amber-100'
                  : 'bg-emerald-100'
              }`}>
                <span className="text-xs text-gray-500">마감까지 </span>
                <span className={`font-bold text-base ${
                  deliveryInfo.remainingMs < 3600000 ? 'text-amber-700' : 'text-emerald-700'
                }`}>
                  {deliveryInfo.remainingLabel}
                </span>
                <span className="text-xs text-gray-500"> 남음</span>
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
          {/* 프로그레스 바 */}
          <div className="mt-3 h-3 bg-gray-200 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${jejuPalletBoxes >= JEJU_PALLET_MIN ? 'bg-green-500' : 'bg-orange-500'}`}
              style={{ width: `${Math.min(100, (jejuPalletBoxes / JEJU_PALLET_MIN) * 100)}%` }}
            />
          </div>
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

      {/* 가맹점 미선택 안내 */}
      {!selectedStoreId && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 text-yellow-800 text-center font-medium">
          가맹점을 먼저 선택해주세요.
        </div>
      )}

      {/* 상품 목록 */}
      <div className={`bg-white rounded-xl shadow-sm border border-gray-100 divide-y divide-gray-100 ${!selectedStoreId ? 'opacity-50 pointer-events-none' : ''}`}>
        {filteredProducts.map((product) => {
          const qty = getQty(product.id);
          const stock = getStock(product.id);
          const outOfStock = isOutOfStock(product.id);
          const maxQty = stock !== null ? stock : Infinity;
          return (
            <div key={product.id} className={`p-5 sm:p-6 flex items-center gap-5 ${outOfStock ? 'opacity-50' : ''}`}>
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
                  onClick={() => updateCart(product, qty - 1)}
                  disabled={qty === 0 || outOfStock}
                  className="w-12 h-12 rounded-lg border border-gray-300 flex items-center justify-center text-xl text-gray-600 hover:bg-gray-50 disabled:opacity-30"
                >
                  −
                </button>
                <span className={`w-12 text-center text-xl font-bold ${qty > 0 ? 'text-[#1B4332]' : 'text-gray-300'}`}>
                  {qty}
                </span>
                <button
                  onClick={() => updateCart(product, qty + 1)}
                  disabled={outOfStock || qty >= maxQty}
                  className="w-12 h-12 rounded-lg border border-[#1B4332] bg-[#1B4332] text-white text-xl flex items-center justify-center hover:bg-[#2D6A4F] disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  +
                </button>
              </div>
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
                {result.deliveryInfo && (
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
                className="absolute bottom-16 left-0 right-0 lg:left-64 bg-white border-t border-gray-200 shadow-2xl rounded-t-2xl max-h-[60vh] overflow-y-auto"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="font-bold text-gray-800 text-lg">주문 요약 ({cart.length}건)</h3>
                    <button onClick={() => setCart([])} className="text-sm text-red-500 hover:text-red-700">
                      전체 삭제
                    </button>
                  </div>

                  <div className="divide-y divide-gray-100">
                    {cart.map((item) => (
                      <div key={item.product.id} className="py-3 flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <span className="text-sm font-medium text-gray-800 block truncate">{item.product.name}</span>
                          <span className="text-xs text-gray-400">₩{item.product.price_with_tax.toLocaleString()} / {item.product.unit}</span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button onClick={() => updateCart(item.product, item.quantity - 1)}
                            className="w-8 h-8 rounded border border-gray-300 flex items-center justify-center text-gray-600 hover:bg-gray-50">−</button>
                          <span className="w-8 text-center text-sm font-bold text-[#1B4332]">{item.quantity}</span>
                          <button onClick={() => updateCart(item.product, item.quantity + 1)}
                            className="w-8 h-8 rounded border border-[#1B4332] bg-[#1B4332] text-white flex items-center justify-center hover:bg-[#2D6A4F]">+</button>
                          <button onClick={() => updateCart(item.product, 0)}
                            className="w-8 h-8 rounded border border-red-300 text-red-500 flex items-center justify-center hover:bg-red-50 ml-1">✕</button>
                        </div>
                        <span className="font-medium text-gray-800 text-sm w-24 text-right shrink-0">
                          ₩{(item.product.price_with_tax * item.quantity).toLocaleString()}
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
                  <p className="text-xs text-gray-400">{cartOpen ? '닫기' : '상세보기'}</p>
                </div>
              </button>
              <button
                onClick={handleSubmit}
                disabled={submitting || totalAmount < MIN_ORDER_AMOUNT || (!store?.is_direct && !!store && store.deposit_balance < totalAmount)}
                className="px-8 py-3 bg-[#1B4332] text-white rounded-xl font-bold text-lg hover:bg-[#2D6A4F] transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting
                  ? '처리 중...'
                  : totalAmount < MIN_ORDER_AMOUNT
                    ? `₩${MIN_ORDER_AMOUNT.toLocaleString()} 이상`
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
