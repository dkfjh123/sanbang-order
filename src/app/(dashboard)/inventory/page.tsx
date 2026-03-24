'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

interface InventoryItem {
  id: string;
  product_id: string;
  quantity: number;
  products: {
    name: string;
    spec: string | null;
    unit: string;
    storage: string | null;
    cost_price_with_tax: number;
    price_with_tax: number;
  };
}

interface InventoryTx {
  id: string;
  product_id: string;
  type: string;
  quantity: number;
  description: string | null;
  created_at: string;
}

const storageLabel: Record<string, string> = {
  frozen: '냉동',
  refrigerated: '냉장',
  room_temp: '상온',
};

export default function InventoryPage() {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [transactions, setTransactions] = useState<InventoryTx[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState('');
  const [txType, setTxType] = useState<'inbound' | 'outbound' | 'adjustment'>('inbound');
  const [txQty, setTxQty] = useState('');
  const [txDesc, setTxDesc] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [txFilter, setTxFilter] = useState('');
  const supabase = createClient();

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    const { data: inv } = await supabase
      .from('inventory')
      .select('*, products(name, spec, unit, storage, cost_price_with_tax, price_with_tax)')
      .order('product_id');
    setItems((inv as InventoryItem[]) || []);

    const { data: txs } = await supabase
      .from('inventory_transactions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);
    setTransactions((txs as InventoryTx[]) || []);

    setLoading(false);
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');

    const qty = Number(txQty);
    if (!selectedProduct || qty <= 0) {
      setError('상품과 수량을 입력해주세요.');
      setSaving(false);
      return;
    }

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    // 현재 재고 조회
    const item = items.find((i) => i.product_id === selectedProduct);
    if (!item) { setError('상품을 찾을 수 없습니다.'); setSaving(false); return; }

    const change = txType === 'outbound' ? -qty : qty;
    const newQty = item.quantity + change;

    if (newQty < 0) {
      setError('재고가 부족합니다.');
      setSaving(false);
      return;
    }

    // 재고 업데이트
    const { error: updateErr } = await supabase
      .from('inventory')
      .update({ quantity: newQty })
      .eq('product_id', selectedProduct);

    if (updateErr) { setError(updateErr.message); setSaving(false); return; }

    // 이력 기록
    await supabase.from('inventory_transactions').insert({
      product_id: selectedProduct,
      type: txType,
      quantity: change,
      description: txDesc || `${txType === 'inbound' ? '입고' : txType === 'outbound' ? '출고' : '조정'}`,
      created_by: user.id,
    });

    setSaving(false);
    setShowModal(false);
    setTxQty('');
    setTxDesc('');
    loadData();
  };

  const getProductName = (productId: string) => {
    const item = items.find((i) => i.product_id === productId);
    return item?.products?.name || productId;
  };

  const filteredTx = txFilter
    ? transactions.filter((tx) => tx.product_id === txFilter)
    : transactions;

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="w-8 h-8 border-4 border-[#1B4332] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-gray-800">재고 관리</h2>
        <button
          onClick={() => setShowModal(true)}
          className="px-4 py-2 bg-[#1B4332] text-white rounded-lg text-sm font-medium hover:bg-[#2D6A4F] transition"
        >
          + 입/출고 등록
        </button>
      </div>

      {/* 재고 현황 카드 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {items.map((item) => {
          const isLow = item.quantity <= 3;
          return (
            <div
              key={item.id}
              className={`rounded-xl p-4 shadow-sm border ${
                isLow ? 'bg-red-50 border-red-200' : 'bg-white border-gray-100'
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-gray-400">
                  {storageLabel[item.products?.storage || ''] || ''} · {item.products?.spec}
                </span>
                {isLow && (
                  <span className="px-2 py-0.5 bg-red-100 text-red-700 rounded text-xs font-semibold">부족</span>
                )}
              </div>
              <h3 className="font-bold text-gray-800">{item.products?.name}</h3>
              <div className="mt-3 flex items-end justify-between">
                <div>
                  <p className="text-3xl font-bold text-gray-800">{item.quantity}</p>
                  <p className="text-xs text-gray-400">{item.products?.unit}</p>
                </div>
                <button
                  onClick={() => { setSelectedProduct(item.product_id); setTxFilter(item.product_id); }}
                  className="text-xs text-[#2D6A4F] hover:underline"
                >
                  이력 보기
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* 입출고 이력 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
          <h3 className="font-semibold text-gray-700 text-sm">입출고 이력</h3>
          <div className="flex items-center gap-2">
            <select
              value={txFilter}
              onChange={(e) => setTxFilter(e.target.value)}
              className="text-sm px-2 py-1 border border-gray-300 rounded-lg text-gray-700"
            >
              <option value="">전체 상품</option>
              {items.map((item) => (
                <option key={item.product_id} value={item.product_id}>
                  {item.products?.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        {filteredTx.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">이력이 없습니다.</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {filteredTx.map((tx) => {
              const isIn = tx.quantity > 0;
              return (
                <div key={tx.id} className="px-4 py-3 flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className={`text-sm font-medium ${isIn ? 'text-green-600' : 'text-red-600'}`}>
                        {tx.type === 'inbound' ? '입고' : tx.type === 'outbound' ? '출고' : '조정'}
                      </span>
                      <span className="text-sm text-gray-700">{getProductName(tx.product_id)}</span>
                    </div>
                    {tx.description && <p className="text-xs text-gray-400 mt-0.5">{tx.description}</p>}
                  </div>
                  <div className="text-right">
                    <p className={`font-bold ${isIn ? 'text-green-600' : 'text-red-600'}`}>
                      {isIn ? '+' : ''}{tx.quantity}
                    </p>
                    <p className="text-xs text-gray-400">
                      {new Date(tx.created_at).toLocaleDateString('ko-KR')}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 입/출고 등록 모달 */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-gray-800">입/출고 등록</h3>
              <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">구분</label>
                <div className="flex gap-2">
                  {([['inbound', '입고'], ['outbound', '출고'], ['adjustment', '조정']] as const).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setTxType(key)}
                      className={`flex-1 py-2 rounded-lg text-sm font-medium transition ${
                        txType === key
                          ? key === 'outbound' ? 'bg-red-600 text-white' : 'bg-[#1B4332] text-white'
                          : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">상품</label>
                <select
                  value={selectedProduct}
                  onChange={(e) => setSelectedProduct(e.target.value)}
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
                >
                  <option value="">선택하세요</option>
                  {items.map((item) => (
                    <option key={item.product_id} value={item.product_id}>
                      {item.products?.name} (현재: {item.quantity}{item.products?.unit})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">수량</label>
                <input
                  type="number"
                  value={txQty}
                  onChange={(e) => setTxQty(e.target.value)}
                  required
                  min="1"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">설명</label>
                <input
                  type="text"
                  value={txDesc}
                  onChange={(e) => setTxDesc(e.target.value)}
                  placeholder="예: 한만두식품 3월 입고"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
                />
              </div>

              {error && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg text-sm">{error}</div>
              )}

              <div className="flex gap-3">
                <button type="button" onClick={() => setShowModal(false)}
                  className="flex-1 py-2 border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50 transition">
                  취소
                </button>
                <button type="submit" disabled={saving}
                  className="flex-1 py-2 bg-[#1B4332] text-white rounded-lg font-medium hover:bg-[#2D6A4F] transition disabled:opacity-50">
                  {saving ? '처리 중...' : '등록'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
