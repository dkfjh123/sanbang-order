'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Store, Profile, DepositRequest } from '@/types';

interface DepositTransaction {
  id: string;
  store_id: string;
  type: string;
  amount: number;
  balance_after: number;
  description: string | null;
  created_at: string;
}

const typeLabel: Record<string, { text: string; color: string }> = {
  deposit: { text: '입금', color: 'text-green-600' },
  withdrawal: { text: '출금', color: 'text-red-600' },
  order_deduct: { text: '발주차감', color: 'text-red-600' },
  order_refund: { text: '발주환불', color: 'text-green-600' },
  adjustment: { text: '조정', color: 'text-blue-600' },
};

export default function DepositsPage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [stores, setStores] = useState<Store[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState('');
  const [transactions, setTransactions] = useState<DepositTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdjustModal, setShowAdjustModal] = useState(false);
  const [showRequestModal, setShowRequestModal] = useState(false);
  const [myRequests, setMyRequests] = useState<DepositRequest[]>([]);
  const supabase = createClient();

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data: prof } = await supabase.from('profiles').select('*').eq('id', user.id).single();
      if (!prof) return;
      setProfile(prof as Profile);

      if (prof.role === 'admin') {
        const { data: storeList } = await supabase.from('stores').select('*').eq('is_direct', false).order('created_at');
        setStores((storeList as Store[]) || []);
      } else if (prof.store_id) {
        const { data: s } = await supabase.from('stores').select('*').eq('id', prof.store_id).single();
        if (s) {
          setStores([s as Store]);
          setSelectedStoreId(s.id);
        }
      }

      // 가맹점: 내 입금 요청 내역
      if (prof.role === 'store') {
        loadMyRequests();
      }

      setLoading(false);
    }
    load();
  }, []);

  async function loadMyRequests() {
    const res = await fetch('/api/deposit-requests');
    if (res.ok) {
      const data = await res.json();
      setMyRequests(data);
    }
  }

  useEffect(() => {
    if (selectedStoreId) loadTransactions();
  }, [selectedStoreId]);

  async function loadTransactions() {
    const { data } = await supabase
      .from('deposit_transactions')
      .select('*')
      .eq('store_id', selectedStoreId)
      .order('created_at', { ascending: false })
      .limit(50);
    setTransactions((data as DepositTransaction[]) || []);
  }

  const selectedStore = stores.find((s) => s.id === selectedStoreId);

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
        <h2 className="text-xl font-bold text-gray-800">예치금 관리</h2>
        <div className="flex gap-2">
          {profile?.role === 'admin' && selectedStore && (
            <button
              onClick={() => setShowAdjustModal(true)}
              className="px-4 py-2 bg-[#1B4332] text-white rounded-lg text-sm font-medium hover:bg-[#2D6A4F] transition"
            >
              예치금 조정
            </button>
          )}
        </div>
      </div>

      {/* 가맹점: 예치금 충전 안내 플로우 */}
      {profile?.role === 'store' && (
        <div className="bg-gradient-to-br from-green-50 to-emerald-50 border border-green-200 rounded-xl p-5">
          <p className="text-sm font-bold text-green-800 mb-4">예치금 충전 방법</p>
          <div className="flex items-start gap-0">
            {/* Step 1 */}
            <div className="flex-1 text-center">
              <div className="w-10 h-10 rounded-full bg-[#1B4332] text-white flex items-center justify-center mx-auto text-lg font-bold">1</div>
              <p className="text-xs font-semibold text-gray-700 mt-2">계좌로 입금</p>
              <p className="text-[11px] text-gray-500 mt-0.5 leading-tight">아래 계좌로<br />금액 이체</p>
            </div>
            <div className="pt-5 text-gray-300 text-lg">&#10132;</div>
            {/* Step 2 */}
            <div className="flex-1 text-center">
              <div className="w-10 h-10 rounded-full bg-[#1B4332] text-white flex items-center justify-center mx-auto text-lg font-bold">2</div>
              <p className="text-xs font-semibold text-gray-700 mt-2">입금 확인 요청</p>
              <p className="text-[11px] text-gray-500 mt-0.5 leading-tight">아래 버튼으로<br />금액 알림</p>
            </div>
            <div className="pt-5 text-gray-300 text-lg">&#10132;</div>
            {/* Step 3 */}
            <div className="flex-1 text-center">
              <div className="w-10 h-10 rounded-full bg-[#1B4332] text-white flex items-center justify-center mx-auto text-lg font-bold">3</div>
              <p className="text-xs font-semibold text-gray-700 mt-2">관리자 승인</p>
              <p className="text-[11px] text-gray-500 mt-0.5 leading-tight">확인 후<br />예치금 반영</p>
            </div>
          </div>
          <div className="mt-4 bg-white/70 rounded-lg p-3 border border-green-100">
            <p className="text-xs text-gray-500 font-medium mb-1">입금 계좌</p>
            <p className="text-base font-bold text-gray-800">하나은행 776-910015-28704</p>
            <p className="text-xs text-gray-500">예금주: 산방에프앤비 주식회사</p>
          </div>
          <button
            onClick={() => setShowRequestModal(true)}
            className="w-full mt-4 py-3 bg-[#1B4332] text-white rounded-lg font-semibold text-sm hover:bg-[#2D6A4F] transition flex items-center justify-center gap-2"
          >
            <span className="text-base">&#9989;</span> 입금했어요 — 확인 요청하기
          </button>
        </div>
      )}

      {/* 관리자: 입금 계좌 안내 */}
      {profile?.role === 'admin' && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4">
          <p className="text-sm font-semibold text-yellow-800 mb-1">예치금 입금 계좌</p>
          <p className="text-lg font-bold text-gray-800">하나은행 776-910015-28704</p>
          <p className="text-sm text-gray-600">예금주: 산방에프앤비 주식회사</p>
        </div>
      )}

      {/* 가맹점 선택 (관리자만) */}
      {profile?.role === 'admin' && (
        <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
          <label className="block text-sm font-medium text-gray-700 mb-2">가맹점 선택</label>
          <select
            value={selectedStoreId}
            onChange={(e) => setSelectedStoreId(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
          >
            <option value="">선택하세요</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>{s.short_name || s.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* 잔액 표시 */}
      {selectedStore && (
        <div className="bg-gradient-to-r from-[#1B4332] to-[#2D6A4F] rounded-xl p-6 text-white shadow-sm">
          <p className="text-sm opacity-80">{selectedStore.short_name || selectedStore.name} 예치금 잔액</p>
          <p className="text-3xl font-bold mt-1">₩{selectedStore.deposit_balance.toLocaleString()}</p>
        </div>
      )}

      {/* 거래 내역 */}
      {selectedStoreId && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200">
            <h3 className="font-semibold text-gray-700 text-sm">거래 내역</h3>
          </div>
          {transactions.length === 0 ? (
            <div className="p-8 text-center text-gray-400 text-sm">거래 내역이 없습니다.</div>
          ) : (
            <div className="divide-y divide-gray-100">
              {transactions.map((tx) => {
                const tl = typeLabel[tx.type] || { text: tx.type, color: 'text-gray-600' };
                return (
                  <div key={tx.id} className="px-4 py-3 flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className={`text-sm font-medium ${tl.color}`}>{tl.text}</span>
                        <span className="text-xs text-gray-400">
                          {new Date(tx.created_at).toLocaleString('ko-KR')}
                        </span>
                      </div>
                      {tx.description && (
                        <p className="text-xs text-gray-500 mt-0.5">{tx.description}</p>
                      )}
                    </div>
                    <div className="text-right">
                      <p className={`font-semibold ${tx.amount >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {tx.amount >= 0 ? '+' : ''}₩{tx.amount.toLocaleString()}
                      </p>
                      <p className="text-xs text-gray-400">잔액 ₩{tx.balance_after.toLocaleString()}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 가맹점: 내 입금 요청 내역 */}
      {profile?.role === 'store' && myRequests.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200">
            <h3 className="font-semibold text-gray-700 text-sm">입금 확인 요청 내역</h3>
          </div>
          <div className="divide-y divide-gray-100">
            {myRequests.map((req) => {
              const statusStyle = {
                pending: { text: '대기중', color: 'text-yellow-700 bg-yellow-50' },
                approved: { text: '승인', color: 'text-green-700 bg-green-50' },
                rejected: { text: '반려', color: 'text-red-700 bg-red-50' },
              }[req.status];
              return (
                <div key={req.id} className="px-4 py-3 flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${statusStyle.color}`}>
                        {statusStyle.text}
                      </span>
                      <span className="text-sm font-semibold text-gray-800">
                        ₩{req.amount.toLocaleString()}
                      </span>
                      <span className="text-xs text-gray-400">
                        {new Date(req.created_at).toLocaleString('ko-KR')}
                      </span>
                    </div>
                    {req.description && (
                      <p className="text-xs text-gray-500 mt-0.5">{req.description}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 입금 요청 모달 (가맹점) */}
      {showRequestModal && profile?.store_id && (
        <DepositRequestModal
          onClose={() => setShowRequestModal(false)}
          onSaved={() => {
            setShowRequestModal(false);
            loadMyRequests();
          }}
        />
      )}

      {/* 예치금 조정 모달 */}
      {showAdjustModal && selectedStore && (
        <AdjustModal
          store={selectedStore}
          onClose={() => setShowAdjustModal(false)}
          onSaved={() => {
            setShowAdjustModal(false);
            loadTransactions();
            // 잔액 갱신
            supabase.from('stores').select('deposit_balance').eq('id', selectedStoreId).single()
              .then(({ data }: { data: { deposit_balance: number } | null }) => {
                if (data) {
                  setStores((prev) =>
                    prev.map((s) => s.id === selectedStoreId ? { ...s, deposit_balance: data.deposit_balance } : s)
                  );
                }
              });
          }}
        />
      )}
    </div>
  );
}

function AdjustModal({
  store,
  onClose,
  onSaved,
}: {
  store: Store;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [type, setType] = useState<'deposit' | 'withdrawal' | 'adjustment'>('deposit');
  const [amount, setAmount] = useState('');
  const [displayAmount, setDisplayAmount] = useState('');
  const [description, setDescription] = useState('');

  const formatNumber = (val: string) => {
    const num = val.replace(/[^0-9]/g, '');
    return num ? Number(num).toLocaleString() : '';
  };

  const numberToKorean = (num: number): string => {
    if (num === 0) return '';
    const units = ['', '만', '억', '조'];
    const parts: string[] = [];
    let remaining = num;
    let unitIdx = 0;
    while (remaining > 0) {
      const chunk = remaining % 10000;
      if (chunk > 0) {
        const chunkStr = chunk.toLocaleString();
        parts.unshift(`${chunkStr}${units[unitIdx]}`);
      }
      remaining = Math.floor(remaining / 10000);
      unitIdx++;
    }
    return parts.join(' ') + '원';
  };

  const handleAmountChange = (val: string) => {
    const raw = val.replace(/[^0-9]/g, '');
    setAmount(raw);
    setDisplayAmount(formatNumber(raw));
  };
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    const numAmount = Number(amount);
    if (numAmount <= 0) {
      setError('금액을 입력해주세요.');
      setLoading(false);
      return;
    }

    const res = await fetch('/api/deposits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        store_id: store.id,
        type,
        amount: type === 'withdrawal' ? -numAmount : numAmount,
        description: description || `${type === 'deposit' ? '입금' : type === 'withdrawal' ? '출금' : '조정'}`,
      }),
    });

    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(data.error);
      return;
    }

    onSaved();
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-gray-800">예치금 조정</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>

        <p className="text-sm text-gray-500 mb-4">
          {store.short_name || store.name} — 현재 잔액: ₩{store.deposit_balance.toLocaleString()}
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">구분</label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as typeof type)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
            >
              <option value="deposit">입금</option>
              <option value="withdrawal">출금</option>
              <option value="adjustment">조정</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">금액 (원)</label>
            <input
              type="text"
              inputMode="numeric"
              value={displayAmount}
              onChange={(e) => handleAmountChange(e.target.value)}
              required
              placeholder="0"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 text-lg font-semibold"
            />
            {amount && Number(amount) > 0 && (
              <p className="mt-1 text-sm text-gray-400">{numberToKorean(Number(amount))}</p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">설명</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="예: 3월 예치금 입금"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
            />
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg text-sm">{error}</div>
          )}

          <div className="flex gap-3">
            <button type="button" onClick={onClose}
              className="flex-1 py-2 border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50 transition">
              취소
            </button>
            <button type="submit" disabled={loading}
              className="flex-1 py-2 bg-[#1B4332] text-white rounded-lg font-medium hover:bg-[#2D6A4F] transition disabled:opacity-50">
              {loading ? '처리 중...' : '확인'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function DepositRequestModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [displayAmount, setDisplayAmount] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const formatNumber = (val: string) => {
    const num = val.replace(/[^0-9]/g, '');
    return num ? Number(num).toLocaleString() : '';
  };

  const numberToKorean = (num: number): string => {
    if (num === 0) return '';
    const units = ['', '만', '억', '조'];
    const parts: string[] = [];
    let remaining = num;
    let unitIdx = 0;
    while (remaining > 0) {
      const chunk = remaining % 10000;
      if (chunk > 0) {
        const chunkStr = chunk.toLocaleString();
        parts.unshift(`${chunkStr}${units[unitIdx]}`);
      }
      remaining = Math.floor(remaining / 10000);
      unitIdx++;
    }
    return parts.join(' ') + '원';
  };

  const handleAmountChange = (val: string) => {
    const raw = val.replace(/[^0-9]/g, '');
    setAmount(raw);
    setDisplayAmount(formatNumber(raw));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    const numAmount = Number(amount);
    if (numAmount <= 0) {
      setError('금액을 입력해주세요.');
      setLoading(false);
      return;
    }

    const res = await fetch('/api/deposit-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: numAmount,
        description: description || `예치금 입금`,
      }),
    });

    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(data.error);
      return;
    }

    setSuccess(true);
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        {success ? (
          <div className="text-center py-6">
            <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
              <span className="text-3xl">&#9989;</span>
            </div>
            <h3 className="text-xl font-bold text-gray-800 mb-2">요청되었습니다!</h3>
            <p className="text-sm text-gray-500 mb-1">
              입금 확인 후 관리자가 승인하면
            </p>
            <p className="text-sm text-gray-500 mb-6">
              예치금에 자동으로 반영됩니다.
            </p>
            <button
              onClick={() => { onSaved(); }}
              className="w-full py-3 bg-[#1B4332] text-white rounded-lg font-semibold hover:bg-[#2D6A4F] transition"
            >
              확인
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-gray-800">입금 확인 요청</h3>
              <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>

            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 mb-4">
              <p className="text-xs text-yellow-800 font-medium">아래 계좌로 입금 후 요청해주세요</p>
              <p className="text-sm font-bold text-gray-800 mt-1">하나은행 776-910015-28704</p>
              <p className="text-xs text-gray-600">예금주: 산방에프앤비 주식회사</p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">입금 금액 (원)</label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={displayAmount}
                  onChange={(e) => handleAmountChange(e.target.value)}
                  required
                  placeholder="0"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 text-lg font-semibold"
                />
                {amount && Number(amount) > 0 && (
                  <p className="mt-1 text-sm text-gray-400">{numberToKorean(Number(amount))}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">입금일자 메모 <span className="text-red-500">*</span></label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  required
                  placeholder="예: 3/24입금"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
                />
                <p className="text-xs text-gray-400 mt-1">입금한 날짜를 적어주세요. 관리자가 계좌 확인 시 참고합니다.</p>
              </div>

              {error && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg text-sm">{error}</div>
              )}

              <div className="flex gap-3">
                <button type="button" onClick={onClose}
                  className="flex-1 py-2 border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50 transition">
                  취소
                </button>
                <button type="submit" disabled={loading}
                  className="flex-1 py-2 bg-[#1B4332] text-white rounded-lg font-medium hover:bg-[#2D6A4F] transition disabled:opacity-50">
                  {loading ? '요청 중...' : '확인 요청하기'}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
