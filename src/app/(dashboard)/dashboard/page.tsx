'use client';

import { useEffect, useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { getDeliverySchedule, type DeliveryInfo } from '@/lib/delivery-schedule';
import type { Profile, DepositRequest } from '@/types';

interface DepositTransaction {
  id: string;
  store_id: string;
  type: string;
  amount: number;
  balance_after: number;
  description: string | null;
  created_at: string;
  stores?: { short_name: string | null; name: string };
}

interface OrderSummary {
  id: string;
  order_number: string;
  total_amount: number;
  status: string;
  created_at: string;
  stores: { short_name: string | null; name: string };
}

interface StoreSummary {
  id: string;
  name: string;
  short_name: string;
  region: string;
  is_direct: boolean;
  deposit_balance: number;
}

const typeLabel: Record<string, { text: string; color: string }> = {
  deposit: { text: '입금', color: 'text-green-600 bg-green-50' },
  withdrawal: { text: '출금', color: 'text-red-600 bg-red-50' },
  order_deduct: { text: '발주차감', color: 'text-red-600 bg-red-50' },
  order_refund: { text: '발주환불', color: 'text-green-600 bg-green-50' },
  adjustment: { text: '조정', color: 'text-blue-600 bg-blue-50' },
};

const statusLabel: Record<string, { text: string; color: string }> = {
  pending: { text: '대기', color: 'text-yellow-700 bg-yellow-100' },
  confirmed: { text: '확정', color: 'text-green-700 bg-green-100' },
  cancelled: { text: '취소', color: 'text-red-700 bg-red-100' },
};

export default function DashboardPage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [storeName, setStoreName] = useState('');
  const [storeCount, setStoreCount] = useState(0);
  const [depositBalance, setDepositBalance] = useState<number | null>(null);
  const [depositTransactions, setDepositTransactions] = useState<DepositTransaction[]>([]);
  const [pendingRequests, setPendingRequests] = useState<DepositRequest[]>([]);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [notices, setNotices] = useState<{ id: string; title: string; is_pinned: boolean; created_at: string }[]>([]);
  const [storeRegion, setStoreRegion] = useState<'seoul' | 'jeju' | null>(null);
  const [deliveryInfo, setDeliveryInfo] = useState<DeliveryInfo | null>(null);
  const [jejuPalletBoxes, setJejuPalletBoxes] = useState<number>(0);
  const [todayOrders, setTodayOrders] = useState(0);
  const [pendingDelivery, setPendingDelivery] = useState(0);
  const [monthlyOrders, setMonthlyOrders] = useState(0);

  // 아코디언 상태
  const [expandedCard, setExpandedCard] = useState<string | null>(null);
  const [storeList, setStoreList] = useState<StoreSummary[]>([]);
  const [todayOrderList, setTodayOrderList] = useState<OrderSummary[]>([]);
  const [pendingOrderList, setPendingOrderList] = useState<OrderSummary[]>([]);
  const [monthlyOrderList, setMonthlyOrderList] = useState<OrderSummary[]>([]);

  const JEJU_PALLET_MIN = 55;
  const supabase = createClient();

  const toggleCard = (cardId: string) => {
    setExpandedCard((prev) => (prev === cardId ? null : cardId));
  };

  const updateDeliveryInfo = useCallback(() => {
    if (storeRegion) {
      setDeliveryInfo(getDeliverySchedule(storeRegion));
    }
  }, [storeRegion]);

  useEffect(() => {
    updateDeliveryInfo();
    const timer = setInterval(updateDeliveryInfo, 60000);
    return () => clearInterval(timer);
  }, [updateDeliveryInfo]);

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data: prof } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .single();

      if (!prof) return;
      setProfile(prof as Profile);

      if (prof.store_id) {
        const { data: store } = await supabase
          .from('stores')
          .select('name, deposit_balance, region')
          .eq('id', prof.store_id)
          .single();
        if (store) {
          setStoreName(store.name);
          setDepositBalance(store.deposit_balance);
          setStoreRegion(store.region as 'seoul' | 'jeju');
        }

        // 가맹점: 본인 매장 최근 충전 내역
        const { data: txData } = await supabase
          .from('deposit_transactions')
          .select('*')
          .eq('store_id', prof.store_id)
          .order('created_at', { ascending: false })
          .limit(5);
        setDepositTransactions((txData as DepositTransaction[]) || []);
      }

      if (prof.role === 'admin') {
        // 가맹점 수 + 목록
        const { data: stores } = await supabase
          .from('stores')
          .select('id, name, short_name, region, is_direct, deposit_balance')
          .order('name');
        setStoreList((stores as StoreSummary[]) || []);
        setStoreCount(stores?.length || 0);

        // 오늘 발주 건수 + 목록
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const { data: todayData } = await supabase
          .from('orders')
          .select('id, order_number, total_amount, status, created_at, stores(short_name, name)')
          .gte('created_at', todayStart.toISOString())
          .neq('status', 'cancelled')
          .order('created_at', { ascending: false })
          .limit(5);
        setTodayOrderList((todayData as OrderSummary[]) || []);
        setTodayOrders(todayData?.length || 0);

        // 오늘 발주 정확한 카운트 (5건 넘을 수 있으므로)
        const { count: todayCount } = await supabase
          .from('orders')
          .select('*', { count: 'exact', head: true })
          .gte('created_at', todayStart.toISOString())
          .neq('status', 'cancelled');
        setTodayOrders(todayCount || 0);

        // 배송 대기 건수 + 목록
        const { data: pendingData } = await supabase
          .from('orders')
          .select('id, order_number, total_amount, status, created_at, stores(short_name, name)')
          .in('status', ['pending', 'confirmed'])
          .order('created_at', { ascending: false })
          .limit(5);
        setPendingOrderList((pendingData as OrderSummary[]) || []);

        const { count: pendingCount } = await supabase
          .from('orders')
          .select('*', { count: 'exact', head: true })
          .in('status', ['pending', 'confirmed']);
        setPendingDelivery(pendingCount || 0);

        // 전체 최근 충전 내역
        const { data: txData } = await supabase
          .from('deposit_transactions')
          .select('*, stores(short_name, name)')
          .order('created_at', { ascending: false })
          .limit(10);
        setDepositTransactions((txData as DepositTransaction[]) || []);

        // 대기 중인 입금 요청
        const { data: reqData } = await supabase
          .from('deposit_requests')
          .select('*, stores(name, short_name)')
          .eq('status', 'pending')
          .order('created_at', { ascending: true });
        setPendingRequests((reqData as DepositRequest[]) || []);
      }

      // 가맹점: 이번 달 발주
      if (prof.role === 'store' && prof.store_id) {
        const monthStart = new Date();
        monthStart.setDate(1);
        monthStart.setHours(0, 0, 0, 0);

        const { data: mData } = await supabase
          .from('orders')
          .select('id, order_number, total_amount, status, created_at, stores(short_name, name)')
          .eq('store_id', prof.store_id)
          .gte('created_at', monthStart.toISOString())
          .neq('status', 'cancelled')
          .order('created_at', { ascending: false })
          .limit(5);
        setMonthlyOrderList((mData as OrderSummary[]) || []);

        const { count: mCount } = await supabase
          .from('orders')
          .select('*', { count: 'exact', head: true })
          .eq('store_id', prof.store_id)
          .gte('created_at', monthStart.toISOString())
          .neq('status', 'cancelled');
        setMonthlyOrders(mCount || 0);
      }

      // 신화푸드: 처리 대기 + 배송 예정
      if (prof.role === 'shinwa') {
        const { data: pData } = await supabase
          .from('orders')
          .select('id, order_number, total_amount, status, created_at, stores(short_name, name)')
          .eq('status', 'pending')
          .order('created_at', { ascending: false })
          .limit(5);
        setTodayOrderList((pData as OrderSummary[]) || []);

        const { count: pCount } = await supabase
          .from('orders')
          .select('*', { count: 'exact', head: true })
          .eq('status', 'pending');
        setTodayOrders(pCount || 0);

        const { data: cData } = await supabase
          .from('orders')
          .select('id, order_number, total_amount, status, created_at, stores(short_name, name)')
          .eq('status', 'confirmed')
          .order('created_at', { ascending: false })
          .limit(5);
        setPendingOrderList((cData as OrderSummary[]) || []);

        const { count: cCount } = await supabase
          .from('orders')
          .select('*', { count: 'exact', head: true })
          .eq('status', 'confirmed');
        setPendingDelivery(cCount || 0);
      }

      // 제주 파레트 현황 (관리자/신화만)
      if (prof.role === 'admin' || prof.role === 'shinwa') {
        const now = new Date();
        const day = now.getDay();
        const diffToMon = (day === 0 ? -6 : 1) - day;
        const weekStart = new Date(now);
        weekStart.setDate(now.getDate() + diffToMon);
        weekStart.setHours(0, 0, 0, 0);

        const { data: jejuStores } = await supabase.from('stores').select('id').eq('region', 'jeju');
        if (jejuStores && jejuStores.length > 0) {
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
              if (item.product_type === 'exclusive') totalBoxes += item.quantity;
            });
          });
          setJejuPalletBoxes(totalBoxes);
        }
      }

      // 최신 공지사항
      const { data: noticeData } = await supabase
        .from('notices')
        .select('id, title, is_pinned, created_at')
        .eq('is_active', true)
        .order('is_pinned', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(5);
      setNotices(noticeData || []);
    }
    load();
  }, []);

  async function handleRequest(id: string, action: 'approve' | 'reject') {
    setProcessingId(id);
    const res = await fetch('/api/deposit-requests', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action }),
    });

    if (res.ok) {
      setPendingRequests((prev) => prev.filter((r) => r.id !== id));
      if (action === 'approve') {
        const { data: txData } = await supabase
          .from('deposit_transactions')
          .select('*, stores(short_name, name)')
          .order('created_at', { ascending: false })
          .limit(10);
        setDepositTransactions((txData as DepositTransaction[]) || []);
      }
    }
    setProcessingId(null);
  }

  if (!profile) return null;

  const roleLabel = {
    admin: '관리자',
    store: '가맹점',
    shinwa: '신화푸드',
  }[profile.role];

  // 제주 파레트 계산
  const completedPallets = Math.floor(jejuPalletBoxes / JEJU_PALLET_MIN);
  const remainingBoxes = jejuPalletBoxes % JEJU_PALLET_MIN;
  const nextPalletProgress = Math.round((remainingBoxes / JEJU_PALLET_MIN) * 100);
  const hasFullPallet = completedPallets >= 1;

  return (
    <div className="space-y-6">
      {/* 환영 메시지 */}
      <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
        <h2 className="text-2xl font-bold text-gray-800">
          안녕하세요, {profile.name}님
        </h2>
        <p className="text-gray-500 mt-1">
          {roleLabel}
          {storeName && ` · ${storeName}`}
        </p>
      </div>

      {/* ========== 관리자 대시보드 ========== */}
      {profile.role === 'admin' && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              title="등록 가맹점"
              value={`${storeCount}곳`}
              isExpanded={expandedCard === 'stores'}
              onToggle={() => toggleCard('stores')}
            />
            <StatCard
              title="오늘 발주"
              value={`${todayOrders}건`}
              color="blue"
              isExpanded={expandedCard === 'todayOrders'}
              onToggle={() => toggleCard('todayOrders')}
            />
            <StatCard
              title="배송 대기"
              value={`${pendingDelivery}건`}
              color="yellow"
              isExpanded={expandedCard === 'pendingDelivery'}
              onToggle={() => toggleCard('pendingDelivery')}
            />
            <StatCard
              title="입금 확인 대기"
              value={`${pendingRequests.length}건`}
              color={pendingRequests.length > 0 ? 'red' : 'yellow'}
              isExpanded={expandedCard === 'depositRequests'}
              onToggle={() => toggleCard('depositRequests')}
            />
          </div>

          {/* 등록 가맹점 펼침 */}
          {expandedCard === 'stores' && (
            <ExpandedPanel>
              {storeList.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-4">등록된 가맹점이 없습니다.</p>
              ) : (
                <>
                  <div className="divide-y divide-gray-100">
                    {storeList.slice(0, 5).map((store) => (
                      <div key={store.id} className="px-4 py-3 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-gray-800">
                            {store.short_name || store.name}
                          </span>
                          <span className={`text-xs px-1.5 py-0.5 rounded ${
                            store.is_direct ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-600'
                          }`}>
                            {store.is_direct ? '직영' : '가맹'}
                          </span>
                          <span className="text-xs text-gray-400">
                            {store.region === 'jeju' ? '제주' : '서울·내륙'}
                          </span>
                        </div>
                        <span className="text-sm font-medium text-gray-700">
                          ₩{store.deposit_balance.toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                  <ExpandedFooter href="/stores" />
                </>
              )}
            </ExpandedPanel>
          )}

          {/* 오늘 발주 펼침 */}
          {expandedCard === 'todayOrders' && (
            <ExpandedPanel>
              {todayOrderList.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-4">오늘 발주가 없습니다.</p>
              ) : (
                <>
                  <OrderList orders={todayOrderList} />
                  <ExpandedFooter href="/orders" />
                </>
              )}
            </ExpandedPanel>
          )}

          {/* 배송 대기 펼침 */}
          {expandedCard === 'pendingDelivery' && (
            <ExpandedPanel>
              {pendingOrderList.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-4">배송 대기 건이 없습니다.</p>
              ) : (
                <>
                  <OrderList orders={pendingOrderList} />
                  <ExpandedFooter href="/orders" />
                </>
              )}
            </ExpandedPanel>
          )}

          {/* 입금 확인 대기 펼침 */}
          {expandedCard === 'depositRequests' && (
            <ExpandedPanel>
              {pendingRequests.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-4">대기 중인 입금 요청이 없습니다.</p>
              ) : (
                <>
                  <div className="divide-y divide-gray-100">
                    {pendingRequests.slice(0, 5).map((req) => {
                      const stName = req.stores ? (req.stores.short_name || req.stores.name) : '';
                      return (
                        <div key={req.id} className="px-4 py-3 flex items-center justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-semibold text-gray-800">{stName}</span>
                              <span className="text-lg font-bold text-green-600">₩{req.amount.toLocaleString()}</span>
                            </div>
                            <div className="flex items-center gap-2 mt-0.5">
                              {req.description && (
                                <span className="text-xs text-gray-500">{req.description}</span>
                              )}
                              <span className="text-xs text-gray-400">
                                {new Date(req.created_at).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                              </span>
                            </div>
                          </div>
                          <div className="flex gap-2 shrink-0">
                            <button
                              onClick={() => handleRequest(req.id, 'reject')}
                              disabled={processingId === req.id}
                              className="px-3 py-1.5 text-sm border border-gray-300 text-gray-600 rounded-lg hover:bg-gray-50 transition disabled:opacity-50"
                            >
                              반려
                            </button>
                            <button
                              onClick={() => handleRequest(req.id, 'approve')}
                              disabled={processingId === req.id}
                              className="px-3 py-1.5 text-sm bg-[#1B4332] text-white rounded-lg font-medium hover:bg-[#2D6A4F] transition disabled:opacity-50"
                            >
                              {processingId === req.id ? '처리 중...' : '승인'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <ExpandedFooter href="/deposits" />
                </>
              )}
            </ExpandedPanel>
          )}
        </>
      )}

      {/* ========== 제주 파레트 현황 (관리자/신화만) ========== */}
      {(profile.role === 'admin' || profile.role === 'shinwa') && (
        <div className={`rounded-xl p-4 shadow-sm border ${
          hasFullPallet ? 'bg-green-50 border-green-200' : 'bg-orange-50 border-orange-200'
        }`}>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-bold text-gray-800">이번 주 제주 발주 현황</p>
              <p className="text-lg font-bold mt-1">
                <span className={hasFullPallet ? 'text-green-700' : 'text-orange-700'}>
                  {completedPallets}파레트
                </span>
                {remainingBoxes > 0 && (
                  <span className="text-gray-500 text-sm font-normal">
                    {' '}+ {remainingBoxes}박스
                  </span>
                )}
                <span className="text-gray-400 text-xs font-normal ml-2">
                  (총 {jejuPalletBoxes}박스)
                </span>
              </p>
            </div>
            <div className="text-right">
              {hasFullPallet ? (
                <p className="text-lg font-bold text-green-600">{completedPallets}파레트 출고 가능</p>
              ) : (
                <p className="text-lg font-bold text-orange-600">{JEJU_PALLET_MIN - jejuPalletBoxes}박스 부족</p>
              )}
            </div>
          </div>
          {/* 다음 파레트 진행률 */}
          <div className="mt-3">
            <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
              <span>{completedPallets + 1}번째 파레트</span>
              <span>{remainingBoxes} / {JEJU_PALLET_MIN}박스 ({nextPalletProgress}%)</span>
            </div>
            <div className="h-3 bg-gray-200 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${hasFullPallet ? 'bg-green-500' : 'bg-orange-500'}`}
                style={{ width: `${nextPalletProgress}%` }}
              />
            </div>
          </div>
        </div>
      )}

      {/* ========== 가맹점 대시보드 ========== */}
      {profile.role === 'store' && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <StatCard
              title="예치금 잔액"
              value={depositBalance !== null ? `₩${depositBalance.toLocaleString()}` : '로딩 중...'}
              isExpanded={expandedCard === 'deposit'}
              onToggle={() => toggleCard('deposit')}
            />
            <StatCard
              title="이번 달 발주"
              value={`${monthlyOrders}건`}
              color="blue"
              isExpanded={expandedCard === 'monthlyOrders'}
              onToggle={() => toggleCard('monthlyOrders')}
            />
          </div>

          {/* 예치금 잔액 펼침 */}
          {expandedCard === 'deposit' && (
            <ExpandedPanel>
              {depositTransactions.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-4">거래 내역이 없습니다.</p>
              ) : (
                <>
                  <div className="divide-y divide-gray-100">
                    {depositTransactions.slice(0, 5).map((tx) => {
                      const tl = typeLabel[tx.type] || { text: tx.type, color: 'text-gray-600 bg-gray-50' };
                      return (
                        <div key={tx.id} className="px-4 py-3 flex items-center justify-between">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${tl.color}`}>{tl.text}</span>
                              <span className="text-xs text-gray-400">
                                {new Date(tx.created_at).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                              </span>
                            </div>
                            {tx.description && <p className="text-xs text-gray-500 mt-0.5 truncate">{tx.description}</p>}
                          </div>
                          <div className="text-right shrink-0 ml-3">
                            <p className={`font-semibold text-sm ${tx.amount >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                              {tx.amount >= 0 ? '+' : ''}₩{tx.amount.toLocaleString()}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <ExpandedFooter href="/deposits" />
                </>
              )}
            </ExpandedPanel>
          )}

          {/* 이번 달 발주 펼침 */}
          {expandedCard === 'monthlyOrders' && (
            <ExpandedPanel>
              {monthlyOrderList.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-4">이번 달 발주가 없습니다.</p>
              ) : (
                <>
                  <OrderList orders={monthlyOrderList} />
                  <ExpandedFooter href="/orders" />
                </>
              )}
            </ExpandedPanel>
          )}

          {/* 배송 스케줄 안내 */}
          {deliveryInfo && (
            <div className={`rounded-xl shadow-sm border overflow-hidden ${
              deliveryInfo.isPastDeadline
                ? 'bg-red-50 border-red-200'
                : deliveryInfo.remainingMs < 3600000
                  ? 'bg-amber-50 border-amber-200'
                  : 'bg-emerald-50 border-emerald-200'
            }`}>
              <div className={`px-4 py-2.5 text-sm font-semibold flex items-center justify-between ${
                deliveryInfo.isPastDeadline
                  ? 'bg-red-100 text-red-800'
                  : deliveryInfo.remainingMs < 3600000
                    ? 'bg-amber-100 text-amber-800'
                    : 'bg-emerald-100 text-emerald-800'
              }`}>
                <span>{storeRegion === 'jeju' ? '제주 배송 스케줄' : '서울·내륙 배송 스케줄'}</span>
                <a href="/orders/new" className="text-xs underline opacity-75 hover:opacity-100">발주하기 →</a>
              </div>
              <div className="px-4 py-4">
                <p className="text-xs text-gray-500 mb-3 text-center">{deliveryInfo.scheduleDescription}</p>
                {deliveryInfo.isPastDeadline ? (
                  <div className="text-center">
                    <p className="text-red-700 font-bold">이번 주 발주 마감 완료</p>
                    <p className="text-red-600 text-sm mt-1">다음 마감: {deliveryInfo.deadlineLabel}</p>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-3 gap-3 text-center">
                      <div className="bg-white/60 rounded-lg py-2.5 px-2">
                        <p className="text-xs text-gray-500 mb-0.5">발주 마감</p>
                        <p className="font-bold text-gray-800 text-sm">{deliveryInfo.deadlineLabel}</p>
                      </div>
                      <div className="bg-white/60 rounded-lg py-2.5 px-2">
                        <p className="text-xs text-gray-500 mb-0.5">{storeRegion === 'jeju' ? '상차일' : '출고일'}</p>
                        <p className="font-bold text-gray-800 text-sm">{deliveryInfo.shipLabel}</p>
                      </div>
                      <div className="bg-white/60 rounded-lg py-2.5 px-2">
                        <p className="text-xs text-gray-500 mb-0.5">{storeRegion === 'jeju' ? '도착 예정' : '배송일'}</p>
                        <p className="font-bold text-gray-800 text-sm">{deliveryInfo.arrivalLabel}</p>
                      </div>
                    </div>
                    <div className={`mt-3 text-center py-2 rounded-lg ${
                      deliveryInfo.remainingMs < 3600000 ? 'bg-amber-100' : 'bg-emerald-100'
                    }`}>
                      <span className="text-xs text-gray-500">마감까지 </span>
                      <span className={`font-bold text-base ${
                        deliveryInfo.remainingMs < 3600000 ? 'text-amber-700' : 'text-emerald-700'
                      }`}>
                        {deliveryInfo.remainingLabel}
                      </span>
                      <span className="text-xs text-gray-500"> 남음</span>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* ========== 신화푸드 대시보드 ========== */}
      {profile.role === 'shinwa' && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <StatCard
              title="처리 대기 발주"
              value={`${todayOrders}건`}
              color="blue"
              isExpanded={expandedCard === 'shinwaPending'}
              onToggle={() => toggleCard('shinwaPending')}
            />
            <StatCard
              title="배송 예정"
              value={`${pendingDelivery}건`}
              color="yellow"
              isExpanded={expandedCard === 'shinwaDelivery'}
              onToggle={() => toggleCard('shinwaDelivery')}
            />
          </div>

          {expandedCard === 'shinwaPending' && (
            <ExpandedPanel>
              {todayOrderList.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-4">처리 대기 발주가 없습니다.</p>
              ) : (
                <>
                  <OrderList orders={todayOrderList} />
                  <ExpandedFooter href="/orders" />
                </>
              )}
            </ExpandedPanel>
          )}

          {expandedCard === 'shinwaDelivery' && (
            <ExpandedPanel>
              {pendingOrderList.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-4">배송 예정 건이 없습니다.</p>
              ) : (
                <>
                  <OrderList orders={pendingOrderList} />
                  <ExpandedFooter href="/orders" />
                </>
              )}
            </ExpandedPanel>
          )}
        </>
      )}

      {/* ========== 예치금 충전현황 ========== */}
      {(profile.role === 'admin' || profile.role === 'store') && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
            <h3 className="font-semibold text-gray-700">예치금 충전현황</h3>
            <a href="/deposits" className="text-sm text-[#2D6A4F] hover:underline">전체보기</a>
          </div>
          {depositTransactions.length === 0 ? (
            <div className="p-6 text-center text-gray-400 text-sm">거래 내역이 없습니다.</div>
          ) : (
            <div className="divide-y divide-gray-100">
              {depositTransactions.map((tx) => {
                const tl = typeLabel[tx.type] || { text: tx.type, color: 'text-gray-600 bg-gray-50' };
                const stName = tx.stores ? (tx.stores.short_name || tx.stores.name) : null;
                return (
                  <div key={tx.id} className="px-4 py-3 flex items-center justify-between hover:bg-gray-50 transition">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${tl.color}`}>{tl.text}</span>
                        {stName && <span className="text-xs text-gray-500 font-medium">{stName}</span>}
                        <span className="text-xs text-gray-400">
                          {new Date(tx.created_at).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      {tx.description && (
                        <p className="text-xs text-gray-500 mt-0.5 truncate">{tx.description}</p>
                      )}
                    </div>
                    <div className="text-right shrink-0 ml-3">
                      <p className={`font-semibold text-sm ${tx.amount >= 0 ? 'text-green-600' : 'text-red-600'}`}>
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

      {/* ========== 최신 공지사항 ========== */}
      <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-gray-700">공지사항</h3>
          <a href="/notices" className="text-sm text-[#2D6A4F] hover:underline">전체보기</a>
        </div>
        {notices.length === 0 ? (
          <p className="text-sm text-gray-400">등록된 공지사항이 없습니다.</p>
        ) : (
          <div className="divide-y divide-gray-100">
            {notices.map((n) => (
              <a key={n.id} href="/notices" className="py-2 flex items-center justify-between hover:bg-gray-50 -mx-2 px-2 rounded">
                <div className="flex items-center gap-2">
                  {n.is_pinned && <span className="px-1.5 py-0.5 bg-red-100 text-red-700 rounded text-xs font-semibold">고정</span>}
                  <span className="text-sm text-gray-800">{n.title}</span>
                </div>
                <span className="text-xs text-gray-400 shrink-0 ml-2">{new Date(n.created_at).toLocaleDateString('ko-KR')}</span>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ========== 공통 컴포넌트 ========== */

function StatCard({
  title,
  value,
  color = 'green',
  isExpanded,
  onToggle,
}: {
  title: string;
  value: string;
  color?: 'green' | 'blue' | 'yellow' | 'red';
  isExpanded?: boolean;
  onToggle?: () => void;
}) {
  const bgColor = {
    green: 'bg-green-50 border-green-100',
    blue: 'bg-blue-50 border-blue-100',
    yellow: 'bg-yellow-50 border-yellow-100',
    red: 'bg-red-50 border-red-100',
  }[color];

  return (
    <button
      onClick={onToggle}
      className={`rounded-xl p-5 border shadow-sm ${bgColor} text-left w-full hover:shadow-md transition cursor-pointer ${
        isExpanded ? 'ring-2 ring-[#2D6A4F]' : ''
      }`}
    >
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">{title}</p>
        <span className={`text-xs transition-transform ${isExpanded ? 'rotate-180' : ''}`}>▼</span>
      </div>
      <p className="text-2xl font-bold text-gray-800 mt-1">{value}</p>
    </button>
  );
}

function ExpandedPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden animate-[fadeIn_0.15s_ease-out]">
      {children}
    </div>
  );
}

function ExpandedFooter({ href }: { href: string }) {
  return (
    <div className="px-4 py-3 border-t border-gray-100 text-center">
      <a href={href} className="text-sm text-[#2D6A4F] font-medium hover:underline">
        전체보기 →
      </a>
    </div>
  );
}

function OrderList({ orders }: { orders: OrderSummary[] }) {
  return (
    <div className="divide-y divide-gray-100">
      {orders.map((order) => {
        const st = statusLabel[order.status] || { text: order.status, color: 'text-gray-600 bg-gray-100' };
        const stName = order.stores ? (order.stores.short_name || order.stores.name) : '';
        return (
          <div key={order.id} className="px-4 py-3 flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-gray-800">{order.order_number}</span>
                <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${st.color}`}>{st.text}</span>
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs text-gray-500">{stName}</span>
                <span className="text-xs text-gray-400">
                  {new Date(order.created_at).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            </div>
            <span className="text-sm font-bold text-gray-800">₩{order.total_amount.toLocaleString()}</span>
          </div>
        );
      })}
    </div>
  );
}
