'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import type { B2bCustomer, B2bProduct, B2bUnit } from '@/types';

type InvRow = { product_id: string; quantity: number; loose_pack_qty: number };

type CartItem = {
  product_id: string;
  product_name: string;
  unit: B2bUnit;
  quantity: number;
  pack_per_box: number;
  unit_price: number;
  unit_price_with_tax: number;
  is_tax_free: boolean;
};

function hasValidB2bPrice(product: B2bProduct) {
  return product.pack_per_box > 0 && product.b2b_price > 0 && product.b2b_price_with_tax > 0;
}

export default function B2bNewOrderPage() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  const [customers, setCustomers] = useState<B2bCustomer[]>([]);
  const [products, setProducts] = useState<B2bProduct[]>([]);
  const [inventory, setInventory] = useState<Record<string, InvRow>>({});
  const [role, setRole] = useState<'admin' | 'b2b' | null>(null);
  const [loading, setLoading] = useState(true);
  const [productsLoading, setProductsLoading] = useState(false);

  const today = new Date().toISOString().slice(0, 10);
  const [customerId, setCustomerId] = useState('');
  const [orderDate, setOrderDate] = useState(today);
  const [shipDate, setShipDate] = useState('');
  const [memo, setMemo] = useState('');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      let nextRole: 'admin' | 'b2b' | null = null;
      if (user) {
        const { data: prof } = await supabase.from('profiles').select('role').eq('id', user.id).single();
        nextRole = (prof?.role === 'admin' || prof?.role === 'b2b') ? prof.role : null;
      }
      setRole(nextRole);

      // b2b 역할은 RLS 가 자기 거래처 행만 반환. inventory 는 admin 만 조회(거래처에 재고 비노출).
      const [customersRes, invRes] = await Promise.all([
        supabase.from('b2b_customers').select('*').eq('is_active', true).order('name'),
        nextRole === 'admin'
          ? supabase.from('inventory').select('product_id, quantity, loose_pack_qty')
          : Promise.resolve({ data: [] as InvRow[] }),
      ]);

      const nextCustomers = (customersRes.data as B2bCustomer[]) || [];
      setCustomers(nextCustomers);
      if (nextCustomers.length === 1) setCustomerId(nextCustomers[0].id);

      const invMap: Record<string, InvRow> = {};
      ((invRes.data as InvRow[]) || []).forEach((row) => {
        invMap[row.product_id] = row;
      });
      setInventory(invMap);
      setLoading(false);
    })();
  }, [supabase]);

  useEffect(() => {
    if (!customerId) {
      return;
    }

    (async () => {
      setProductsLoading(true);
      setError('');

      // 서버 API — 거래처 단가표 + 상품 안전 필드만 (원가 비노출, b2b/admin 공용)
      const res = await fetch(`/api/b2b/products?customer_id=${customerId}`);
      const data = await res.json();

      if (!res.ok) {
        setProducts([]);
        setError(data.error || 'B2B 단가표를 불러오지 못했습니다.');
        setProductsLoading(false);
        return;
      }

      setProducts((data as B2bProduct[]) || []);
      setProductsLoading(false);
    })();
  }, [customerId]);

  const selectedCustomer = customers.find((customer) => customer.id === customerId);

  function handleCustomerChange(nextCustomerId: string) {
    setCustomerId(nextCustomerId);
    setProducts([]);
    setCart([]);
    setError('');
  }

  const totals = useMemo(() => {
    const withTax = cart.reduce((sum, item) => sum + item.unit_price_with_tax * item.quantity, 0);
    const exTax = cart.reduce((sum, item) => sum + item.unit_price * item.quantity, 0);
    return { withTax, exTax, tax: withTax - exTax };
  }, [cart]);

  function addOrUpdate(product: B2bProduct, unit: B2bUnit, qty: number) {
    if (qty <= 0) return;
    if (!product.available_units.includes(unit)) {
      setError(`${product.name}: ${unit === 'box' ? '박스' : '팩'} 단위는 이 거래처에 열려 있지 않습니다.`);
      return;
    }
    if (!hasValidB2bPrice(product)) {
      setError(`${product.name}: B2B 단가를 먼저 설정해주세요.`);
      return;
    }

    setError('');
    setCart((prev) => {
      const idx = prev.findIndex((item) => item.product_id === product.id && item.unit === unit);
      const unitPrice = unit === 'box'
        ? product.b2b_price
        : Math.round(product.b2b_price / product.pack_per_box);
      const unitPriceWithTax = unit === 'box'
        ? product.b2b_price_with_tax
        : Math.round(product.b2b_price_with_tax / product.pack_per_box);

      const next = [...prev];
      if (idx >= 0) {
        next[idx] = { ...next[idx], quantity: next[idx].quantity + qty };
      } else {
        next.push({
          product_id: product.id,
          product_name: product.name,
          unit,
          quantity: qty,
          pack_per_box: product.pack_per_box,
          unit_price: unitPrice,
          unit_price_with_tax: unitPriceWithTax,
          is_tax_free: product.is_tax_free,
        });
      }
      return next;
    });
  }

  function updateQty(index: number, qty: number) {
    setCart((prev) => prev.map((item, i) => (
      i === index ? { ...item, quantity: Math.max(1, qty) } : item
    )));
  }

  function removeItem(index: number) {
    setCart((prev) => prev.filter((_, i) => i !== index));
  }

  async function submit() {
    setError('');
    if (!customerId) {
      setError('거래처를 선택하세요.');
      return;
    }
    if (cart.length === 0) {
      setError('발주 항목을 1개 이상 추가하세요.');
      return;
    }

    setSubmitting(true);
    const res = await fetch('/api/b2b/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        b2b_customer_id: customerId,
        order_date: orderDate,
        ship_date: shipDate || null,
        memo: memo || null,
        items: cart,
      }),
    });
    const data = await res.json();
    setSubmitting(false);

    if (!res.ok) {
      setError(data.error || '발주 등록에 실패했습니다.');
      return;
    }

    router.push(`/b2b/${data.order_id}`);
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-24">
      <div>
        <Link href="/b2b" className="text-sm text-primary hover:underline">{role === 'b2b' ? '발주 내역으로' : 'B2B 발주 목록으로'}</Link>
        <h2 className="text-xl font-bold text-gray-800 mt-1">{role === 'b2b' ? '발주 등록' : 'B2B 발주 등록'}</h2>
        <p className="text-sm text-gray-500 mt-1">
          {role === 'b2b' ? (
            <>등록과 동시에 예치금에서 차감됩니다. 출고 전(대기) 상태에서는 취소할 수 있고, 취소하면 자동 환불됩니다.</>
          ) : (
            <>거래처별 B2B 단가표 기준으로 발주를 입력합니다. 등록 시점에는 재고가 차감되지 않으며,
            상세에서 <b>출고 처리</b>를 눌러야 차감됩니다.</>
          )}
        </p>
      </div>

      {/* 선입금 거래처: 잔액 · 최소주문 안내 */}
      {selectedCustomer?.is_prepaid && (
        <div className="bg-gradient-to-r from-[#1B4332] to-[#2D6A4F] rounded-xl p-4 text-white shadow-sm flex items-center justify-between flex-wrap gap-2">
          <div>
            <p className="text-xs opacity-80">{selectedCustomer.name} 예치금 잔액</p>
            <p className="text-xl font-bold">₩{selectedCustomer.deposit_balance.toLocaleString()}</p>
          </div>
          {selectedCustomer.min_order_amount > 0 && (
            <p className="text-xs opacity-80">최소 발주금액 ₩{selectedCustomer.min_order_amount.toLocaleString()}</p>
          )}
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">거래처 *</label>
            {role === 'b2b' ? (
              <div className="w-full px-3 py-2 border border-gray-200 bg-gray-50 rounded-lg text-gray-800 text-sm font-medium">
                {selectedCustomer?.name || '거래처 정보를 불러오는 중'}
              </div>
            ) : (
              <select
                value={customerId}
                onChange={(e) => handleCustomerChange(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 text-sm"
              >
                <option value="">선택하세요</option>
                {customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>{customer.name}</option>
                ))}
              </select>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">주문일 *</label>
            <input
              type="date"
              value={orderDate}
              onChange={(e) => setOrderDate(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">출고 예정일</label>
            <input
              type="date"
              value={shipDate}
              onChange={(e) => setShipDate(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 text-sm"
            />
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">메모</label>
          <textarea
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            rows={2}
            placeholder="이메일 참조번호, 특이사항 등"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 text-sm"
          />
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-gray-800">B2B 상품 추가</h3>
          {selectedCustomer && (
            <span className="text-xs text-gray-500">{selectedCustomer.name} 단가표</span>
          )}
        </div>
        {!customerId ? (
          <p className="text-sm text-gray-400">거래처를 먼저 선택하세요.</p>
        ) : productsLoading ? (
          <p className="text-sm text-gray-400">단가표를 불러오는 중입니다.</p>
        ) : products.length === 0 ? (
          <p className="text-sm text-gray-400">이 거래처에 등록된 B2B 상품이 없습니다.</p>
        ) : (
          <div className="space-y-3">
            {products.map((product) => (
              <ProductRow
                key={product.id}
                product={product}
                inv={inventory[product.id]}
                showStock={role === 'admin'}
                onAdd={(unit, qty) => addOrUpdate(product, unit, qty)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
        <h3 className="font-semibold text-gray-800 mb-3">선택 항목 ({cart.length})</h3>
        {cart.length === 0 ? (
          <p className="text-sm text-gray-400">위에서 상품을 추가하세요.</p>
        ) : (
          <div className="space-y-2">
            {cart.map((item, index) => (
              <div key={index} className="flex items-center gap-3 py-2 border-b border-gray-50 last:border-0">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-gray-800 truncate">{item.product_name}</p>
                  <p className="text-xs text-gray-500">
                    {item.unit === 'box' ? '박스' : '팩'} · ₩{item.unit_price_with_tax.toLocaleString()}/{item.unit === 'box' ? '박스' : '팩'}
                  </p>
                </div>
                <input
                  type="number"
                  min={1}
                  value={item.quantity}
                  onChange={(e) => updateQty(index, parseInt(e.target.value, 10) || 1)}
                  className="w-20 px-2 py-1 border border-gray-300 rounded text-sm text-right"
                />
                <span className="w-28 text-right font-semibold text-gray-800">
                  ₩{(item.unit_price_with_tax * item.quantity).toLocaleString()}
                </span>
                <button onClick={() => removeItem(index)} className="text-red-500 hover:text-red-700 text-sm">삭제</button>
              </div>
            ))}
          </div>
        )}

        {cart.length > 0 && (
          <div className="mt-4 pt-4 border-t border-gray-200 space-y-1 text-sm">
            <div className="flex justify-between text-gray-500">
              <span>공급가액(세전)</span><span>₩{totals.exTax.toLocaleString()}</span>
            </div>
            <div className="flex justify-between text-gray-500">
              <span>부가세</span><span>₩{totals.tax.toLocaleString()}</span>
            </div>
            <div className="flex justify-between text-base font-bold text-gray-800">
              <span>합계(세포함)</span><span>₩{totals.withTax.toLocaleString()}</span>
            </div>
          </div>
        )}
      </div>

      {/* 선입금 가드 안내 (서버에서도 동일 검증) */}
      {cart.length > 0 && selectedCustomer && selectedCustomer.min_order_amount > 0
        && totals.withTax < selectedCustomer.min_order_amount && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 px-3 py-2 rounded-lg text-sm">
          최소 발주금액은 ₩{selectedCustomer.min_order_amount.toLocaleString()}입니다.
          (현재 ₩{totals.withTax.toLocaleString()} — ₩{(selectedCustomer.min_order_amount - totals.withTax).toLocaleString()} 부족)
        </div>
      )}
      {cart.length > 0 && selectedCustomer?.is_prepaid && totals.withTax > selectedCustomer.deposit_balance && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg text-sm">
          예치금이 부족합니다. 잔액 ₩{selectedCustomer.deposit_balance.toLocaleString()} / 필요 ₩{totals.withTax.toLocaleString()}
          {role === 'b2b' && <> — <Link href="/deposits" className="underline font-medium">충전하러 가기</Link></>}
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg text-sm">{error}</div>
      )}

      <div className="fixed bottom-0 left-0 lg:left-64 right-0 bg-white border-t border-gray-200 p-3 flex items-center gap-3">
        <div className="flex-1 text-right">
          <span className="text-sm text-gray-500">합계 </span>
          <span className="text-lg font-bold text-gray-800">₩{totals.withTax.toLocaleString()}</span>
        </div>
        <button
          onClick={submit}
          disabled={
            submitting
            || cart.length === 0
            || (!!selectedCustomer && selectedCustomer.min_order_amount > 0 && totals.withTax < selectedCustomer.min_order_amount)
            || (!!selectedCustomer?.is_prepaid && totals.withTax > selectedCustomer.deposit_balance)
          }
          className="px-6 py-2 bg-primary text-white rounded-lg font-medium hover:bg-primary-light transition disabled:opacity-50"
        >
          {submitting ? '등록 중...' : '발주 등록'}
        </button>
      </div>
    </div>
  );
}

function ProductRow({
  product,
  inv,
  showStock,
  onAdd,
}: {
  product: B2bProduct;
  inv: InvRow | undefined;
  showStock: boolean;
  onAdd: (unit: B2bUnit, qty: number) => void;
}) {
  const [selectedUnit, setSelectedUnit] = useState<B2bUnit>(product.available_units[0] || 'box');
  const [qty, setQty] = useState(1);

  const canAdd = hasValidB2bPrice(product);
  const unit = product.available_units.includes(selectedUnit)
    ? selectedUnit
    : product.available_units[0] || 'box';
  const boxPrice = product.b2b_price_with_tax;
  const packPrice = product.pack_per_box > 0
    ? Math.round(product.b2b_price_with_tax / product.pack_per_box)
    : 0;
  const curBox = inv?.quantity ?? 0;
  const curLoose = inv?.loose_pack_qty ?? 0;
  const availablePacks = curBox * Math.max(product.pack_per_box, 1) + curLoose;

  return (
    <div className="flex flex-wrap items-center gap-3 py-2 border-b border-gray-50 last:border-0">
      <div className="flex-1 min-w-[180px]">
        <p className="font-medium text-gray-800">{product.name}</p>
        {canAdd ? (
          <p className="text-xs text-gray-500">
            입수 {product.pack_per_box}팩/박스 · 박스 ₩{boxPrice.toLocaleString()}
            {product.available_units.includes('pack') && ` / 팩 ₩${packPrice.toLocaleString()}`}
          </p>
        ) : (
          <p className="text-xs text-amber-600">B2B 단가 미설정</p>
        )}
        {showStock && (
          <p className="text-xs text-gray-400">
            현재 재고: 박스 <b>{curBox}</b> · 낱팩 <b>{curLoose}</b> (총 {availablePacks}팩)
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <select
          value={unit}
          onChange={(e) => setSelectedUnit(e.target.value as B2bUnit)}
          disabled={product.available_units.length === 1}
          className="px-2 py-1 border border-gray-300 rounded text-sm disabled:bg-gray-50 disabled:text-gray-500"
        >
          {product.available_units.map((availableUnit) => (
            <option key={availableUnit} value={availableUnit}>
              {availableUnit === 'box' ? '박스' : '팩'}
            </option>
          ))}
        </select>
        <input
          type="number"
          min={1}
          value={qty}
          onChange={(e) => setQty(parseInt(e.target.value, 10) || 1)}
          className="w-20 px-2 py-1 border border-gray-300 rounded text-sm text-right"
        />
        <button
          onClick={() => { onAdd(unit, qty); setQty(1); }}
          disabled={!canAdd}
          className="px-3 py-1 bg-primary text-white rounded text-sm hover:bg-primary-light transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          추가
        </button>
      </div>
    </div>
  );
}
