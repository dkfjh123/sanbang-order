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

export default function B2bNewOrderPage() {
  const router = useRouter();
  const supabase = createClient();

  const [customers, setCustomers] = useState<B2bCustomer[]>([]);
  const [products, setProducts] = useState<B2bProduct[]>([]);
  const [inventory, setInventory] = useState<Record<string, InvRow>>({});
  const [loading, setLoading] = useState(true);

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
      const [customersRes, productsRes, invRes] = await Promise.all([
        supabase.from('b2b_customers').select('*').eq('is_active', true).order('name'),
        supabase
          .from('products')
          .select('id, name, product_type, pack_per_box, b2b_price, b2b_price_with_tax, is_b2b_eligible, is_tax_free')
          .eq('is_b2b_eligible', true)
          .order('name'),
        supabase.from('inventory').select('product_id, quantity, loose_pack_qty'),
      ]);

      const cs = (customersRes.data as B2bCustomer[]) || [];
      setCustomers(cs);
      if (cs.length === 1) setCustomerId(cs[0].id); // 아워홈만 있으면 자동 선택

      setProducts((productsRes.data as B2bProduct[]) || []);
      const invMap: Record<string, InvRow> = {};
      ((invRes.data as InvRow[]) || []).forEach((r) => { invMap[r.product_id] = r; });
      setInventory(invMap);
      setLoading(false);
    })();
  }, []);

  const totals = useMemo(() => {
    const withTax = cart.reduce((s, i) => s + i.unit_price_with_tax * i.quantity, 0);
    const exTax = cart.reduce((s, i) => s + i.unit_price * i.quantity, 0);
    return { withTax, exTax, tax: withTax - exTax };
  }, [cart]);

  function addOrUpdate(p: B2bProduct, unit: B2bUnit, qty: number) {
    if (qty <= 0) return;
    setCart((prev) => {
      const idx = prev.findIndex((i) => i.product_id === p.id && i.unit === unit);
      // 단위별 단가: 박스가 = b2b_price / 팩가 = b2b_price / pack_per_box
      const unit_price = unit === 'box'
        ? p.b2b_price
        : Math.round(p.b2b_price / p.pack_per_box);
      const unit_price_with_tax = unit === 'box'
        ? p.b2b_price_with_tax
        : Math.round(p.b2b_price_with_tax / p.pack_per_box);
      const next = [...prev];
      if (idx >= 0) {
        next[idx] = { ...next[idx], quantity: next[idx].quantity + qty };
      } else {
        next.push({
          product_id: p.id,
          product_name: p.name,
          unit,
          quantity: qty,
          pack_per_box: p.pack_per_box,
          unit_price,
          unit_price_with_tax,
          is_tax_free: p.is_tax_free,
        });
      }
      return next;
    });
  }

  function updateQty(i: number, qty: number) {
    setCart((prev) => prev.map((it, idx) => idx === i ? { ...it, quantity: Math.max(1, qty) } : it));
  }

  function removeItem(i: number) {
    setCart((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function submit() {
    setError('');
    if (!customerId) { setError('거래처를 선택하세요.'); return; }
    if (cart.length === 0) { setError('발주 항목을 1개 이상 추가하세요.'); return; }
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
      setError(data.error || '발주 등록 실패');
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
        <Link href="/b2b" className="text-sm text-primary hover:underline">← 발주 목록으로</Link>
        <h2 className="text-xl font-bold text-gray-800 mt-1">B2B 발주 등록</h2>
        <p className="text-sm text-gray-500 mt-1">이메일로 받은 발주를 수동 입력합니다. 등록 시점에는 재고가 차감되지 않으며, 상세에서 <b>출고 처리</b>를 눌러야 차감됩니다.</p>
      </div>

      {/* 주문 정보 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">거래처 *</label>
            <select
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 text-sm"
            >
              <option value="">선택하세요</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">주문일 *</label>
            <input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)}
                   className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 text-sm" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">출고 예정일 (선택)</label>
            <input type="date" value={shipDate} onChange={(e) => setShipDate(e.target.value)}
                   className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 text-sm" />
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">메모</label>
          <textarea value={memo} onChange={(e) => setMemo(e.target.value)} rows={2}
                    placeholder="이메일 참조번호, 특이사항 등"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 text-sm" />
        </div>
      </div>

      {/* 상품 추가 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
        <h3 className="font-semibold text-gray-800 mb-3">B2B 상품 추가</h3>
        {products.length === 0 ? (
          <p className="text-sm text-gray-400">B2B 대상으로 지정된 상품이 없습니다.</p>
        ) : (
          <div className="space-y-3">
            {products.map((p) => (
              <ProductRow
                key={p.id}
                product={p}
                inv={inventory[p.id]}
                onAdd={(unit, qty) => addOrUpdate(p, unit, qty)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 카트 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
        <h3 className="font-semibold text-gray-800 mb-3">선택 항목 ({cart.length})</h3>
        {cart.length === 0 ? (
          <p className="text-sm text-gray-400">위에서 상품을 추가하세요.</p>
        ) : (
          <div className="space-y-2">
            {cart.map((it, i) => (
              <div key={i} className="flex items-center gap-3 py-2 border-b border-gray-50 last:border-0">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-gray-800 truncate">{it.product_name}</p>
                  <p className="text-xs text-gray-500">
                    {it.unit === 'box' ? '박스' : '팩'} · ₩{it.unit_price_with_tax.toLocaleString()}/{it.unit === 'box' ? '박스' : '팩'}
                  </p>
                </div>
                <input
                  type="number"
                  min={1}
                  value={it.quantity}
                  onChange={(e) => updateQty(i, parseInt(e.target.value) || 1)}
                  className="w-20 px-2 py-1 border border-gray-300 rounded text-sm text-right"
                />
                <span className="w-28 text-right font-semibold text-gray-800">
                  ₩{(it.unit_price_with_tax * it.quantity).toLocaleString()}
                </span>
                <button onClick={() => removeItem(i)} className="text-red-500 hover:text-red-700 text-sm">삭제</button>
              </div>
            ))}
          </div>
        )}

        {cart.length > 0 && (
          <div className="mt-4 pt-4 border-t border-gray-200 space-y-1 text-sm">
            <div className="flex justify-between text-gray-500">
              <span>공급가(세전)</span><span>₩{totals.exTax.toLocaleString()}</span>
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

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg text-sm">{error}</div>
      )}

      {/* 하단 고정 바 */}
      <div className="fixed bottom-0 left-0 lg:left-64 right-0 bg-white border-t border-gray-200 p-3 flex items-center gap-3">
        <div className="flex-1 text-right">
          <span className="text-sm text-gray-500">합계 </span>
          <span className="text-lg font-bold text-gray-800">₩{totals.withTax.toLocaleString()}</span>
        </div>
        <button
          onClick={submit}
          disabled={submitting || cart.length === 0}
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
  onAdd,
}: {
  product: B2bProduct;
  inv: InvRow | undefined;
  onAdd: (unit: B2bUnit, qty: number) => void;
}) {
  const [unit, setUnit] = useState<B2bUnit>('box');
  const [qty, setQty] = useState(1);
  const boxPrice = product.b2b_price_with_tax;
  const packPrice = Math.round(product.b2b_price_with_tax / product.pack_per_box);
  const curBox = inv?.quantity ?? 0;
  const curLoose = inv?.loose_pack_qty ?? 0;
  const availablePacks = curBox * product.pack_per_box + curLoose;

  return (
    <div className="flex flex-wrap items-center gap-3 py-2 border-b border-gray-50 last:border-0">
      <div className="flex-1 min-w-[180px]">
        <p className="font-medium text-gray-800">{product.name}</p>
        <p className="text-xs text-gray-500">
          입수 {product.pack_per_box}팩/박스 · 박스 ₩{boxPrice.toLocaleString()} / 팩 ₩{packPrice.toLocaleString()}
        </p>
        <p className="text-xs text-gray-400">
          현재 재고: 박스 <b>{curBox}</b> · 낱팩 <b>{curLoose}</b> (총 {availablePacks}팩)
        </p>
      </div>
      <div className="flex items-center gap-2">
        <select value={unit} onChange={(e) => setUnit(e.target.value as B2bUnit)}
                className="px-2 py-1 border border-gray-300 rounded text-sm">
          <option value="box">박스</option>
          <option value="pack">팩</option>
        </select>
        <input
          type="number"
          min={1}
          value={qty}
          onChange={(e) => setQty(parseInt(e.target.value) || 1)}
          className="w-20 px-2 py-1 border border-gray-300 rounded text-sm text-right"
        />
        <button
          onClick={() => { onAdd(unit, qty); setQty(1); }}
          className="px-3 py-1 bg-primary text-white rounded text-sm hover:bg-primary-light transition"
        >
          추가
        </button>
      </div>
    </div>
  );
}
