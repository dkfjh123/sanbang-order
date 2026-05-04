'use client';

import { useEffect, useState, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import PasswordConfirmModal from '@/components/PasswordConfirmModal';

interface InventoryItem {
  id: string;
  product_id: string;
  quantity: number;
  loose_pack_qty: number;
  products: {
    name: string;
    spec: string | null;
    unit: string;
    storage: string | null;
    product_type: string;
    cost_price_with_tax: number;
    price_with_tax: number;
    sanbang_food_sale_price_with_tax: number;
    pack_per_box: number;
    is_loose_pack_sellable: boolean;
  };
}

interface InventoryTx {
  id: string;
  product_id: string;
  type: string;
  quantity: number;
  unit: 'box' | 'pack';
  description: string | null;
  created_at: string;
}

const storageLabel: Record<string, string> = {
  frozen: '냉동',
  refrigerated: '냉장',
  room_temp: '상온',
};

// 해당 월의 [1일, 말일] 반환 (YYYY-MM-DD) — timezone-safe (UTC 산술)
function monthRange(year: number, month: number) {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const endY = month === 12 ? year + 1 : year;
  const endM = month === 12 ? 1 : month + 1;
  const e = new Date(`${endY}-${String(endM).padStart(2, '0')}-01T00:00:00Z`);
  e.setUTCDate(e.getUTCDate() - 1);
  return { start, end: e.toISOString().slice(0, 10) };
}

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
  // 입출고 이력 기간/타입 필터
  const _initRange = monthRange(new Date().getFullYear(), new Date().getMonth() + 1);
  const [txStartDate, setTxStartDate] = useState(_initRange.start);
  const [txEndDate, setTxEndDate] = useState(_initRange.end);
  const [txTypeFilter, setTxTypeFilter] = useState<'all' | 'inbound' | 'outbound'>('all');
  const [txLoading, setTxLoading] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [userRole, setUserRole] = useState<string>('');
  const [pendingToggle, setPendingToggle] = useState<{ productId: string; next: boolean } | null>(null);
  const [showTogglePasswordModal, setShowTogglePasswordModal] = useState(false);
  const txSectionRef = useRef<HTMLDivElement>(null);
  const supabase = createClient();

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }: { data: { user: { id: string } | null } }) => {
      if (user) {
        supabase.from('profiles').select('role').eq('id', user.id).single()
          .then(({ data }: { data: { role: string } | null }) => { if (data) setUserRole(data.role); });
      }
    });
    loadData();
    loadTransactions(_initRange.start, _initRange.end);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadData() {
    // 기존 inventory 레코드 로드
    const { data: inv } = await supabase
      .from('inventory')
      .select('*, products(name, spec, unit, storage, product_type, cost_price_with_tax, price_with_tax, sanbang_food_sale_price_with_tax, pack_per_box, is_loose_pack_sellable)')
      .order('product_id');
    const existingItems = (inv as InventoryItem[]) || [];
    const existingProductIds = new Set(existingItems.map((i) => i.product_id));

    // 전용상품 중 inventory 레코드가 없는 상품도 표시 (재고 0)
    const { data: exclusiveProducts } = await supabase
      .from('products')
      .select('id, name, spec, unit, storage, product_type, cost_price_with_tax, price_with_tax, sanbang_food_sale_price_with_tax, pack_per_box, is_loose_pack_sellable')
      .eq('product_type', 'exclusive')
      .eq('is_active', true);

    const missingItems: InventoryItem[] = (exclusiveProducts || [])
      .filter((p: { id: string }) => !existingProductIds.has(p.id))
      .map((p: { id: string; name: string; spec: string | null; unit: string; storage: string | null; product_type: string; cost_price_with_tax: number; price_with_tax: number; sanbang_food_sale_price_with_tax: number; pack_per_box: number; is_loose_pack_sellable: boolean }) => ({
        id: `virtual-${p.id}`,
        product_id: p.id,
        quantity: 0,
        loose_pack_qty: 0,
        products: {
          name: p.name,
          spec: p.spec,
          unit: p.unit,
          storage: p.storage,
          product_type: p.product_type,
          cost_price_with_tax: p.cost_price_with_tax,
          price_with_tax: p.price_with_tax,
          sanbang_food_sale_price_with_tax: p.sanbang_food_sale_price_with_tax,
          pack_per_box: p.pack_per_box,
          is_loose_pack_sellable: p.is_loose_pack_sellable,
        },
      }));

    setItems([...existingItems, ...missingItems]);
    setLoading(false);
  }

  // 입출고 이력 조회 (기간 기준 KR 자정, 타입은 client-side 필터)
  async function loadTransactions(start: string, end: string) {
    setTxLoading(true);
    // KR 자정 기준 [start, end+1) — UTC 산술로 다음날 계산하고 +09:00 timezone 명시
    const dt = new Date(`${end}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() + 1);
    const endNextDate = dt.toISOString().slice(0, 10);
    const startKR = `${start}T00:00:00+09:00`;
    const endNextKR = `${endNextDate}T00:00:00+09:00`;

    const { data: txs } = await supabase
      .from('inventory_transactions')
      .select('*')
      .gte('created_at', startKR)
      .lt('created_at', endNextKR)
      .order('created_at', { ascending: false });
    setTransactions((txs as InventoryTx[]) || []);
    setTxLoading(false);
  }

  const handleTxSearch = () => {
    if (!txStartDate || !txEndDate) return;
    if (txStartDate > txEndDate) return;
    loadTransactions(txStartDate, txEndDate);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const qty = Number(txQty);
    if (!selectedProduct || qty <= 0) {
      setError('상품과 수량을 입력해주세요.');
      return;
    }

    const item = items.find((i) => i.product_id === selectedProduct);

    // 신화: 전용상품 수정 차단
    if (userRole === 'shinwa' && item?.products?.product_type === 'exclusive') {
      setError('전용상품은 관리자만 수정할 수 있습니다.');
      return;
    }

    // 전용상품이면 비밀번호 확인 필요 (어드민)
    if (item?.products?.product_type === 'exclusive') {
      setShowPasswordModal(true);
      return;
    }

    await doSave();
  };

  const doSave = async () => {
    setSaving(true);
    setError('');

    const qty = Number(txQty);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const item = items.find((i) => i.product_id === selectedProduct);
    if (!item) { setError('상품을 찾을 수 없습니다.'); setSaving(false); return; }

    const change = txType === 'outbound' ? -qty : qty;
    const newQty = item.quantity + change;

    if (newQty < 0) {
      setError('재고가 부족합니다.');
      setSaving(false);
      return;
    }

    // 재고 레코드가 없으면 생성 (virtual 아이템)
    const isVirtual = item.id.startsWith('virtual-');
    if (isVirtual) {
      const { error: insertErr } = await supabase
        .from('inventory')
        .insert({ product_id: selectedProduct, quantity: newQty });
      if (insertErr) { setError(insertErr.message); setSaving(false); return; }
    } else {
      const { error: updateErr } = await supabase
        .from('inventory')
        .update({ quantity: newQty })
        .eq('product_id', selectedProduct);
      if (updateErr) { setError(updateErr.message); setSaving(false); return; }
    }

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
    setShowPasswordModal(false);
    setTxQty('');
    setTxDesc('');
    loadData();
    loadTransactions(txStartDate, txEndDate);
  };

  const getProductName = (productId: string) => {
    const item = items.find((i) => i.product_id === productId);
    return item?.products?.name || productId;
  };

  const requestToggleLoosePack = (productId: string, next: boolean) => {
    const item = items.find((i) => i.product_id === productId);
    if (!item) return;
    setPendingToggle({ productId, next });
    // 전용상품은 비밀번호 재확인, 범용은 바로 반영
    if (item.products.product_type === 'exclusive') {
      setShowTogglePasswordModal(true);
    } else {
      applyLoosePackToggle(productId, next);
    }
  };

  const applyLoosePackToggle = async (productId: string, next: boolean) => {
    const { error: updErr } = await supabase
      .from('products')
      .update({ is_loose_pack_sellable: next })
      .eq('id', productId);
    setShowTogglePasswordModal(false);
    setPendingToggle(null);
    if (updErr) {
      alert(`낱팩 판매 설정 변경 실패: ${updErr.message}`);
      return;
    }
    // 낙관적 갱신
    setItems((prev) => prev.map((i) =>
      i.product_id === productId
        ? { ...i, products: { ...i.products, is_loose_pack_sellable: next } }
        : i
    ));
  };

  const filteredTx = transactions.filter((tx) => {
    if (txFilter && tx.product_id !== txFilter) return false;
    if (txTypeFilter !== 'all' && tx.type !== txTypeFilter) return false;
    return true;
  });

  // 재고 금액 = 산방푸드 판매가(=산방에프앤비 매입가) 기준
  // 박스: quantity × sanbang_food_sale_price_with_tax
  // 낱팩: loose_pack_qty × (sanbang_food_sale_price_with_tax / pack_per_box)
  // (정산 4섹션 직영 후불 단가 로직과 동일)
  const itemValue = (item: InventoryItem) => {
    const sfsp = item.products?.sanbang_food_sale_price_with_tax || 0;
    if (sfsp === 0) return { boxValue: 0, looseValue: 0, total: 0, packPrice: 0 };
    const ppb = item.products?.pack_per_box || 1;
    const packPrice = ppb > 1 ? Math.round(sfsp / ppb) : sfsp;
    const boxValue = item.quantity * sfsp;
    const looseValue = (item.loose_pack_qty || 0) * packPrice;
    return { boxValue, looseValue, total: boxValue + looseValue, packPrice };
  };
  const totalInventoryValue = items.reduce((acc, i) => acc + itemValue(i).total, 0);

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
        {(userRole === 'admin' || userRole === 'shinwa') && (
          <button
            onClick={() => setShowModal(true)}
            className="px-4 py-2 bg-[#1B4332] text-white rounded-lg text-sm font-medium hover:bg-[#2D6A4F] transition"
          >
            {userRole === 'shinwa' ? '+ 범용상품 입/출고' : '+ 입/출고 등록'}
          </button>
        )}
      </div>

      {/* 총 재고 가치 — 산방푸드 판매가(=산방에프앤비 매입가) 기준 */}
      {userRole === 'admin' && totalInventoryValue > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 px-5 py-4 flex items-baseline justify-between flex-wrap gap-2">
          <div>
            <p className="text-xs text-gray-500">총 재고 가치</p>
            <p className="text-[11px] text-gray-400 mt-0.5">산방푸드 판매가 기준 (산방에프앤비 매입가 = 상공회의소점 매입가)</p>
          </div>
          <p className="text-2xl font-bold text-[#1B4332]">₩{totalInventoryValue.toLocaleString()}</p>
        </div>
      )}

      {/* 재고 현황 카드 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {items.map((item) => {
          const isLow = item.quantity <= 3;
          const ppb = item.products?.pack_per_box || 1;
          const hasLoose = (item.loose_pack_qty || 0) > 0;
          const canTogglePack = userRole === 'admin' && ppb > 1;
          const value = itemValue(item);
          const showValue = userRole === 'admin' && value.total > 0;
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
                  onClick={() => {
                    setSelectedProduct(item.product_id);
                    setTxFilter(item.product_id);
                    setTimeout(() => txSectionRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
                  }}
                  className="text-xs text-[#2D6A4F] hover:underline"
                >
                  이력 보기
                </button>
              </div>

              {/* 재고 가치 — 산방푸드 판매가 기준 */}
              {showValue && (
                <div className="mt-3 pt-3 border-t border-gray-100">
                  <div className="flex items-baseline justify-between">
                    <span className="text-xs text-gray-500">재고 가치</span>
                    <span className="text-base font-bold text-gray-800">₩{value.total.toLocaleString()}</span>
                  </div>
                  <div className="text-[11px] text-gray-400 mt-0.5 flex items-center justify-between">
                    <span>박스 ₩{item.products.sanbang_food_sale_price_with_tax.toLocaleString()}</span>
                    {value.looseValue > 0 && (
                      <span>낱팩 ₩{value.packPrice.toLocaleString()}</span>
                    )}
                  </div>
                </div>
              )}

              {/* 낱팩 / 가맹점 판매 토글 (박스 입수 > 1 인 상품만) */}
              {ppb > 1 && (
                <div className="mt-3 pt-3 border-t border-gray-100 space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-gray-500">낱팩</span>
                    <span className={`font-bold ${hasLoose ? 'text-amber-600' : 'text-gray-400'}`}>
                      {item.loose_pack_qty || 0}팩
                      <span className="text-xs text-gray-400 font-normal"> / {ppb}팩당 1박스</span>
                    </span>
                  </div>
                  {canTogglePack && (
                    <label className="flex items-center justify-between text-xs cursor-pointer select-none">
                      <span className="text-gray-500">가맹점 낱팩 판매</span>
                      <button
                        type="button"
                        onClick={() => requestToggleLoosePack(item.product_id, !item.products.is_loose_pack_sellable)}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${
                          item.products.is_loose_pack_sellable ? 'bg-[#1B4332]' : 'bg-gray-300'
                        }`}
                      >
                        <span
                          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${
                            item.products.is_loose_pack_sellable ? 'translate-x-5' : 'translate-x-1'
                          }`}
                        />
                      </button>
                    </label>
                  )}
                  {!canTogglePack && item.products.is_loose_pack_sellable && (
                    <p className="text-xs text-emerald-600">가맹점 낱팩 판매 ON</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 낱팩 판매 토글 — 전용상품 비밀번호 확인 */}
      {showTogglePasswordModal && pendingToggle && (
        <PasswordConfirmModal
          title="비밀번호 확인"
          message="전용상품의 낱팩 판매 설정 변경은 비밀번호 확인이 필요합니다."
          onConfirm={() => applyLoosePackToggle(pendingToggle.productId, pendingToggle.next)}
          onCancel={() => { setShowTogglePasswordModal(false); setPendingToggle(null); }}
        />
      )}

      {/* 입출고 이력 */}
      <div ref={txSectionRef} className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h3 className="font-semibold text-gray-700 text-sm">입출고 이력</h3>
            <span className="text-xs text-gray-500">{filteredTx.length}건</span>
          </div>
          {/* 기간 + 조회 */}
          <div className="flex items-center flex-wrap gap-2">
            <input
              type="date"
              value={txStartDate}
              onChange={(e) => setTxStartDate(e.target.value)}
              className="text-sm px-2 py-1.5 border border-gray-300 rounded-lg text-gray-700"
            />
            <span className="text-gray-400 text-xs">~</span>
            <input
              type="date"
              value={txEndDate}
              onChange={(e) => setTxEndDate(e.target.value)}
              className="text-sm px-2 py-1.5 border border-gray-300 rounded-lg text-gray-700"
            />
            <button
              onClick={() => {
                const d = new Date();
                const r = monthRange(d.getFullYear(), d.getMonth() + 1);
                setTxStartDate(r.start);
                setTxEndDate(r.end);
                loadTransactions(r.start, r.end);
              }}
              className="px-2 py-1.5 border border-gray-300 rounded-lg text-xs text-gray-700 hover:bg-gray-50"
            >이번달</button>
            <button
              onClick={() => {
                const d = new Date();
                d.setDate(1);
                d.setMonth(d.getMonth() - 1);
                const r = monthRange(d.getFullYear(), d.getMonth() + 1);
                setTxStartDate(r.start);
                setTxEndDate(r.end);
                loadTransactions(r.start, r.end);
              }}
              className="px-2 py-1.5 border border-gray-300 rounded-lg text-xs text-gray-700 hover:bg-gray-50"
            >지난달</button>
            <button
              onClick={handleTxSearch}
              disabled={txLoading}
              className="ml-auto px-4 py-1.5 bg-[#1B4332] text-white rounded-lg text-xs font-medium hover:bg-[#2D6A4F] disabled:bg-gray-300"
            >
              {txLoading ? '조회 중...' : '조회'}
            </button>
          </div>
          {/* 타입 토글 + 상품 필터 */}
          <div className="flex items-center flex-wrap gap-2">
            <div className="inline-flex border border-gray-300 rounded-lg overflow-hidden">
              {([['all', '전체'], ['inbound', '입고'], ['outbound', '출고']] as const).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setTxTypeFilter(key)}
                  className={`px-3 py-1.5 text-xs font-medium border-l first:border-l-0 border-gray-300 transition ${
                    txTypeFilter === key
                      ? 'bg-[#1B4332] text-white'
                      : 'bg-white text-gray-700 hover:bg-gray-50'
                  }`}
                >{label}</button>
              ))}
            </div>
            <select
              value={txFilter}
              onChange={(e) => setTxFilter(e.target.value)}
              className="text-sm px-2 py-1.5 border border-gray-300 rounded-lg text-gray-700"
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
        {txLoading ? (
          <div className="p-8 text-center text-gray-400 text-sm">조회 중...</div>
        ) : filteredTx.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">이력이 없습니다.</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {filteredTx.map((tx) => {
              const isB2B = (tx.description || '').includes('B2B');
              // type 기준으로 부호 결정 (DB에 B2B 출고가 양수로 저장되는 정합성 이슈 회피)
              const absQty = Math.abs(tx.quantity);
              const sign =
                tx.type === 'inbound' ? '+'
                : tx.type === 'outbound' ? '-'
                : (tx.quantity > 0 ? '+' : tx.quantity < 0 ? '-' : '');
              const unitLabel = tx.unit === 'pack' ? '팩' : '박스';
              const typeLabel = tx.type === 'inbound' ? '입고' : tx.type === 'outbound' ? '출고' : '조정';
              const typeBadgeClass =
                tx.type === 'inbound' ? 'bg-emerald-50 text-emerald-700'
                : tx.type === 'outbound' ? 'bg-rose-50 text-rose-700'
                : 'bg-gray-100 text-gray-600';
              return (
                <div key={tx.id} className="px-4 py-3 flex items-center justify-between hover:bg-gray-50">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${typeBadgeClass}`}>
                        {typeLabel}
                      </span>
                      <span className="text-sm font-medium text-gray-800">{getProductName(tx.product_id)}</span>
                      {isB2B && (
                        <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-700">
                          B2B
                        </span>
                      )}
                    </div>
                    {tx.description && <p className="text-xs text-gray-400 mt-0.5">{tx.description}</p>}
                  </div>
                  <div className="text-right whitespace-nowrap">
                    <p className="font-semibold text-gray-800">
                      {sign}{absQty} {unitLabel}
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
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setShowModal(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
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
                  {items
                    .filter((item) => userRole !== 'shinwa' || item.products?.product_type === 'general')
                    .map((item) => (
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

            {showPasswordModal && (
              <PasswordConfirmModal
                title="비밀번호 확인"
                message="전용상품 재고 변경은 비밀번호 확인이 필요합니다."
                onConfirm={() => { setShowPasswordModal(false); doSave(); }}
                onCancel={() => setShowPasswordModal(false)}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
