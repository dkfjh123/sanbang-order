'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Store, Profile } from '@/types';

/** 사업자번호에서 숫자만 추출 — 하이픈 유무가 달라도 같은 번호로 판정하기 위함 */
function bizDigits(v: string | null | undefined) {
  return (v || '').replace(/[^0-9]/g, '');
}

/** 사업자번호를 000-00-00000 형태로 통일. 10자리가 아니면 입력값 그대로 둔다 */
function formatBusinessNumber(v: string) {
  const d = bizDigits(v);
  if (d.length !== 10) return v.trim();
  return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
}

/**
 * 같은 사업자번호로 이미 등록된 가맹점이 있는지 확인.
 * excludeId 는 수정 시 자기 자신을 제외하기 위한 값.
 */
async function findDuplicateStore(
  supabase: ReturnType<typeof createClient>,
  businessNumber: string,
  excludeId?: string
) {
  const target = bizDigits(businessNumber);
  if (!target) return null;
  const { data } = await supabase.from('stores').select('id, name, short_name, business_number');
  const rows = (data ?? []) as Pick<Store, 'id' | 'name' | 'short_name' | 'business_number'>[];
  return rows.find((s) => s.id !== excludeId && bizDigits(s.business_number) === target) ?? null;
}

export default function StoresPage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showStoreModal, setShowStoreModal] = useState(false);
  const [prefillStoreId, setPrefillStoreId] = useState<string>('');
  const [detailStore, setDetailStore] = useState<Store | null>(null);
  const [role, setRole] = useState<'admin' | 'store' | 'shinwa' | null>(null);
  const supabase = createClient();

  useEffect(() => {
    init();
  }, []);

  async function init() {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { data: prof } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .single();
      if (prof) setRole(prof.role as 'admin' | 'store' | 'shinwa');
    }
    await loadStores();
  }

  async function loadStores() {
    const { data } = await supabase
      .from('stores')
      .select('*')
      .order('created_at');
    setStores((data as Store[]) || []);
    setLoading(false);
  }

  const isAdmin = role === 'admin';

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-gray-800">가맹점 관리</h2>
        {isAdmin && (
          <div className="flex gap-2">
            <button
              onClick={() => setShowStoreModal(true)}
              className="px-4 py-2 border border-primary text-primary rounded-lg text-sm font-medium hover:bg-primary/5 transition"
            >
              + 신규 가맹점
            </button>
            <button
              onClick={() => {
                setPrefillStoreId('');
                setShowCreateModal(true);
              }}
              className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary-light transition"
            >
              + 계정 생성
            </button>
          </div>
        )}
      </div>

      <p className="text-sm text-gray-500 -mt-3">
        매장을 클릭하면 주소·담당자·배송조건 등 상세정보를 볼 수 있습니다
        {isAdmin && ' (관리자는 수정 가능)'}.
      </p>

      {/* 가맹점 목록 테이블 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        {/* 모바일: 카드형 */}
        <div className="lg:hidden divide-y divide-gray-100">
          {stores.map((store) => (
            <div
              key={store.id}
              onClick={() => setDetailStore(store)}
              className="p-4 space-y-2 cursor-pointer active:bg-gray-50 transition"
            >
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-gray-800">{store.short_name || store.name}</h3>
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                  store.is_direct
                    ? 'bg-blue-100 text-blue-700'
                    : 'bg-green-100 text-green-700'
                }`}>
                  {store.is_direct ? '직영' : '가맹'}
                </span>
              </div>
              <p className="text-sm text-gray-500">{store.owner_name} · {store.contact_phone}</p>
              <p className="text-sm text-gray-500">📍 {store.address}</p>
              <p className="text-sm text-gray-500">{store.region === 'seoul' ? '서울·내륙' : '제주'}</p>
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-400">{store.business_number}</span>
                <span className="font-semibold text-gray-800">
                  {store.is_direct
                    ? '후불정산'
                    : `₩${store.deposit_balance.toLocaleString()}`}
                </span>
              </div>
              {store.notes && (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded px-2 py-1 mt-2 whitespace-pre-line">
                  📝 {store.notes}
                </p>
              )}
            </div>
          ))}
        </div>

        {/* 데스크톱: 테이블 */}
        <div className="hidden lg:block overflow-x-auto">
          <table className="w-full text-sm min-w-[900px]">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">#</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">매장명</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">구분</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">대표자</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">연락처</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">권역</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">사업자번호</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">예치금 잔액</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {stores.map((store, idx) => (
                <tr
                  key={store.id}
                  onClick={() => setDetailStore(store)}
                  className="hover:bg-gray-50 transition cursor-pointer"
                >
                  <td className="px-4 py-3 text-gray-400">{idx + 1}</td>
                  <td className="px-4 py-3 font-medium text-gray-800">
                    <div>{store.short_name || store.name}</div>
                    <div className="mt-0.5 text-xs text-gray-400 font-normal">{store.address}</div>
                    {store.notes && (
                      <div className="mt-1 text-xs text-amber-700 font-normal whitespace-pre-line">
                        📝 {store.notes}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                      store.is_direct
                        ? 'bg-blue-100 text-blue-700'
                        : 'bg-green-100 text-green-700'
                    }`}>
                      {store.is_direct ? '직영' : '가맹'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{store.owner_name}</td>
                  <td className="px-4 py-3 text-gray-600">{store.contact_phone}</td>
                  <td className="px-4 py-3 text-gray-600">
                    {store.region === 'seoul' ? '서울·내륙' : '제주'}
                  </td>
                  <td className="px-4 py-3 text-gray-400">{store.business_number}</td>
                  <td className="px-4 py-3 text-right font-semibold text-gray-800">
                    {store.is_direct
                      ? '후불정산'
                      : `₩${store.deposit_balance.toLocaleString()}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {stores.length === 0 && (
          <div className="text-center py-12 text-gray-400">
            등록된 가맹점이 없습니다.
          </div>
        )}
      </div>

      {/* 가맹점 상세 / 수정 모달 */}
      {detailStore && (
        <StoreDetailModal
          store={detailStore}
          canEdit={isAdmin}
          onClose={() => setDetailStore(null)}
          onSaved={async (updated) => {
            await loadStores();
            setDetailStore(updated);
          }}
        />
      )}

      {/* 신규 가맹점 등록 모달 (관리자만) */}
      {isAdmin && showStoreModal && (
        <CreateStoreModal
          onClose={() => setShowStoreModal(false)}
          onCreated={async (newStoreId) => {
            await loadStores();
            setShowStoreModal(false);
            setPrefillStoreId(newStoreId);
            setShowCreateModal(true);
          }}
        />
      )}

      {/* 계정 생성 모달 (관리자만) */}
      {isAdmin && showCreateModal && (
        <CreateUserModal
          stores={stores}
          prefillStoreId={prefillStoreId}
          onClose={() => {
            setShowCreateModal(false);
            setPrefillStoreId('');
          }}
          onCreated={loadStores}
        />
      )}
    </div>
  );
}

function CreateStoreModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (newStoreId: string) => void | Promise<void>;
}) {
  const supabase = createClient();
  const [form, setForm] = useState({
    name: '',
    short_name: '',
    owner_name: '',
    business_number: '',
    corporate_number: '',
    address: '',
    contact_name: '',
    contact_phone: '',
    email: '',
    phone: '',
    region: 'jeju' as 'jeju' | 'seoul',
    is_direct: false,
    notes: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    // 중복 등록 방지 — 하이픈 유무만 다른 사업자번호도 같은 매장으로 본다
    const dup = await findDuplicateStore(supabase, form.business_number);
    if (dup) {
      setError(
        `이미 등록된 사업자번호입니다 — ${dup.short_name || dup.name} (${dup.business_number}). 정보를 바꾸려면 목록에서 해당 매장을 눌러 수정하세요.`
      );
      setLoading(false);
      return;
    }

    const payload = {
      ...form,
      business_number: formatBusinessNumber(form.business_number),
      corporate_number: form.corporate_number || null,
      email: form.email || null,
      phone: form.phone || null,
      notes: form.notes || null,
      short_name: form.short_name || form.name,
      deposit_balance: 0,
    };

    const { data, error: insertErr } = await supabase
      .from('stores')
      .insert(payload)
      .select('id')
      .single();

    if (insertErr) {
      setError(insertErr.message);
      setLoading(false);
      return;
    }

    setLoading(false);
    await onCreated(data.id);
  };

  const input =
    'w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 text-sm';

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-gray-800">신규 가맹점 등록</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">매장명 *</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
                placeholder="제주산방식당 OO점"
                className={input}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">짧은명</label>
              <input
                type="text"
                value={form.short_name}
                onChange={(e) => setForm({ ...form, short_name: e.target.value })}
                placeholder="OO점"
                className={input}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">대표자 *</label>
              <input
                type="text"
                value={form.owner_name}
                onChange={(e) => setForm({ ...form, owner_name: e.target.value })}
                required
                className={input}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">사업자번호 *</label>
              <input
                type="text"
                value={form.business_number}
                onChange={(e) => setForm({ ...form, business_number: e.target.value })}
                required
                placeholder="000-00-00000"
                className={input}
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">법인번호</label>
            <input
              type="text"
              value={form.corporate_number}
              onChange={(e) => setForm({ ...form, corporate_number: e.target.value })}
              placeholder="선택"
              className={input}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">주소 *</label>
            <input
              type="text"
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              required
              className={input}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">담당자 *</label>
              <input
                type="text"
                value={form.contact_name}
                onChange={(e) => setForm({ ...form, contact_name: e.target.value })}
                required
                className={input}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">담당자 연락처 *</label>
              <input
                type="text"
                value={form.contact_phone}
                onChange={(e) => setForm({ ...form, contact_phone: e.target.value })}
                required
                placeholder="010-0000-0000"
                className={input}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">이메일</label>
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className={input}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">대표번호</label>
              <input
                type="text"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                className={input}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">권역 *</label>
              <select
                value={form.region}
                onChange={(e) => setForm({ ...form, region: e.target.value as 'jeju' | 'seoul' })}
                className={input}
              >
                <option value="jeju">제주</option>
                <option value="seoul">서울·내륙</option>
              </select>
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={form.is_direct}
                  onChange={(e) => setForm({ ...form, is_direct: e.target.checked })}
                  className="w-4 h-4"
                />
                직영점 (후불정산)
              </label>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">운영 메모</label>
            <textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              rows={2}
              placeholder="출입 비번 등 (관리자·신화푸드 조회용)"
              className={`${input} resize-none`}
            />
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg text-sm">
              {error}
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50 transition"
            >
              취소
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 py-2 bg-primary text-white rounded-lg font-medium hover:bg-primary-light transition disabled:opacity-50"
            >
              {loading ? '등록 중...' : '등록 후 계정 생성'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CreateUserModal({
  stores,
  prefillStoreId,
  onClose,
  onCreated,
}: {
  stores: Store[];
  prefillStoreId?: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const prefilled = stores.find((s) => s.id === prefillStoreId);
  const [form, setForm] = useState({
    email: prefilled?.email || '',
    password: prefilled ? 'sanbang1234' : '',
    name: prefilled?.owner_name || '',
    role: 'store' as 'store' | 'shinwa' | 'admin',
    store_id: prefillStoreId || '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setLoading(true);

    const res = await fetch('/api/create-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });

    const data = await res.json();

    if (!res.ok) {
      setError(data.error || '계정 생성 실패');
      setLoading(false);
      return;
    }

    setSuccess(`${form.name} 계정이 생성되었습니다.`);
    setLoading(false);
    onCreated();
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-gray-800">계정 생성</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">역할</label>
            <select
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value as typeof form.role, store_id: '' })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
            >
              <option value="store">가맹점</option>
              <option value="shinwa">신화푸드</option>
              <option value="admin">관리자</option>
            </select>
          </div>

          {form.role === 'store' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">소속 가맹점</label>
              <select
                value={form.store_id}
                onChange={(e) => setForm({ ...form, store_id: e.target.value })}
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
              >
                <option value="">선택하세요</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>{s.short_name || s.name}</option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">이름</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">이메일</label>
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">비밀번호</label>
            <input
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              required
              minLength={6}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
            />
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg text-sm">
              {error}
            </div>
          )}
          {success && (
            <div className="bg-green-50 border border-green-200 text-green-700 px-3 py-2 rounded-lg text-sm">
              {success}
            </div>
          )}

          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50 transition"
            >
              닫기
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 py-2 bg-primary text-white rounded-lg font-medium hover:bg-primary-light transition disabled:opacity-50"
            >
              {loading ? '생성 중...' : '생성'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ============================================================
// 가맹점 상세 / 수정 모달
// ============================================================

const DAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];

/** 배송요일 표시용 문자열. delivery_days 가 비어있으면 권역 기본값 안내 */
function deliveryDaysText(store: Store) {
  const days = store.delivery_days;
  if (days && days.length > 0) {
    return [...days].sort((a, b) => a - b).map((d) => DAY_LABELS[d]).join('·');
  }
  return store.region === 'seoul'
    ? '미지정 → 권역 기본값 (월·수·금)'
    : '미지정 → 제주 기본 스케줄 (주 1회)';
}

function toForm(store: Store) {
  return {
    name: store.name || '',
    short_name: store.short_name || '',
    owner_name: store.owner_name || '',
    business_number: store.business_number || '',
    corporate_number: store.corporate_number || '',
    address: store.address || '',
    contact_name: store.contact_name || '',
    contact_phone: store.contact_phone || '',
    email: store.email || '',
    phone: store.phone || '',
    region: store.region,
    is_direct: store.is_direct,
    min_order_amount: String(store.min_order_amount ?? 150000),
    notes: store.notes || '',
  };
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-2 border-b border-gray-50 last:border-0">
      <span className="w-24 shrink-0 text-sm text-gray-500">{label}</span>
      <span className="flex-1 text-sm text-gray-800 break-words whitespace-pre-line">
        {value === null || value === '' ? <span className="text-gray-300">-</span> : value}
      </span>
    </div>
  );
}

function StoreDetailModal({
  store,
  canEdit,
  onClose,
  onSaved,
}: {
  store: Store;
  canEdit: boolean;
  onClose: () => void;
  onSaved: (updated: Store) => void | Promise<void>;
}) {
  const supabase = createClient();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(() => toForm(store));
  // 배송요일: 권역 기본값 사용(=null) 여부와 선택 요일을 따로 관리
  const [useDefaultDays, setUseDefaultDays] = useState(
    !store.delivery_days || store.delivery_days.length === 0
  );
  const [days, setDays] = useState<number[]>(store.delivery_days ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  const startEdit = () => {
    setForm(toForm(store));
    setUseDefaultDays(!store.delivery_days || store.delivery_days.length === 0);
    setDays(store.delivery_days ?? []);
    setError('');
    setSaved('');
    setEditing(true);
  };

  const toggleDay = (d: number) => {
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSaved('');

    const min = Number(form.min_order_amount);
    if (!Number.isFinite(min) || min < 0) {
      setError('최소발주금액은 0 이상의 숫자여야 합니다.');
      return;
    }
    if (!useDefaultDays && days.length === 0) {
      setError('배송요일을 하나 이상 선택하거나 "권역 기본값 사용"을 켜주세요.');
      return;
    }

    setLoading(true);

    // 다른 매장이 이미 쓰고 있는 사업자번호로는 바꿀 수 없다
    const dup = await findDuplicateStore(supabase, form.business_number, store.id);
    if (dup) {
      setError(`이미 등록된 사업자번호입니다 — ${dup.short_name || dup.name} (${dup.business_number}).`);
      setLoading(false);
      return;
    }

    const payload = {
      name: form.name.trim(),
      short_name: form.short_name.trim() || form.name.trim(),
      owner_name: form.owner_name.trim(),
      business_number: formatBusinessNumber(form.business_number),
      corporate_number: form.corporate_number.trim() || null,
      address: form.address.trim(),
      contact_name: form.contact_name.trim(),
      contact_phone: form.contact_phone.trim(),
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      region: form.region,
      is_direct: form.is_direct,
      min_order_amount: min,
      delivery_days: useDefaultDays ? null : [...days].sort((a, b) => a - b),
      notes: form.notes.trim() || null,
    };

    const { data, error: updErr } = await supabase
      .from('stores')
      .update(payload)
      .eq('id', store.id)
      .select('*')
      .single();

    setLoading(false);
    if (updErr) {
      setError(updErr.message);
      return;
    }

    setEditing(false);
    setSaved('저장되었습니다.');
    await onSaved(data as Store);
  };

  const input = 'w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 text-sm';
  const labelCls = 'block text-sm font-medium text-gray-700 mb-1';

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-lg font-bold text-gray-800">{store.short_name || store.name}</h3>
            <p className="text-xs text-gray-400 mt-0.5">
              {editing ? '가맹점 정보 수정' : '가맹점 상세정보'}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>

        {/* ---------- 보기 모드 ---------- */}
        {!editing && (
          <>
            <div className="divide-y divide-gray-50">
              <DetailRow label="매장명" value={store.name} />
              <DetailRow label="짧은명" value={store.short_name} />
              <DetailRow
                label="구분"
                value={
                  <span
                    className={`px-2 py-0.5 rounded text-xs font-medium ${
                      store.is_direct ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
                    }`}
                  >
                    {store.is_direct ? '직영 (후불정산)' : '가맹 (예치금)'}
                  </span>
                }
              />
              <DetailRow label="대표자" value={store.owner_name} />
              <DetailRow label="사업자번호" value={store.business_number} />
              <DetailRow label="법인번호" value={store.corporate_number} />
              <DetailRow label="주소" value={store.address} />
              <DetailRow label="담당자" value={store.contact_name} />
              <DetailRow label="담당자 연락처" value={store.contact_phone} />
              <DetailRow label="이메일" value={store.email} />
              <DetailRow label="대표번호" value={store.phone} />
              <DetailRow label="권역" value={store.region === 'seoul' ? '서울·내륙' : '제주'} />
              <DetailRow label="배송요일" value={deliveryDaysText(store)} />
              <DetailRow label="분할배송" value={store.allow_split_shipping ? '허용' : '불가'} />
              <DetailRow
                label="최소발주금액"
                value={`₩${(store.min_order_amount ?? 0).toLocaleString()}`}
              />
              <DetailRow
                label="예치금 잔액"
                value={
                  store.is_direct ? (
                    '후불정산 (예치금 없음)'
                  ) : (
                    <>
                      ₩{store.deposit_balance.toLocaleString()}
                      <span className="ml-2 text-xs text-gray-400">입금관리 화면에서만 변경</span>
                    </>
                  )
                }
              />
              <DetailRow label="운영 메모" value={store.notes} />
              <DetailRow
                label="등록일"
                value={new Date(store.created_at).toLocaleDateString('ko-KR')}
              />
            </div>

            {saved && (
              <div className="mt-4 bg-green-50 border border-green-200 text-green-700 px-3 py-2 rounded-lg text-sm">
                {saved}
              </div>
            )}

            <div className="flex gap-3 pt-5">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 py-2 border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50 transition"
              >
                닫기
              </button>
              {canEdit && (
                <button
                  type="button"
                  onClick={startEdit}
                  className="flex-1 py-2 bg-primary text-white rounded-lg font-medium hover:bg-primary-light transition"
                >
                  수정
                </button>
              )}
            </div>
          </>
        )}

        {/* ---------- 수정 모드 (관리자만) ---------- */}
        {editing && canEdit && (
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>매장명 *</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  required
                  className={input}
                />
              </div>
              <div>
                <label className={labelCls}>짧은명</label>
                <input
                  type="text"
                  value={form.short_name}
                  onChange={(e) => setForm({ ...form, short_name: e.target.value })}
                  className={input}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>대표자 *</label>
                <input
                  type="text"
                  value={form.owner_name}
                  onChange={(e) => setForm({ ...form, owner_name: e.target.value })}
                  required
                  className={input}
                />
              </div>
              <div>
                <label className={labelCls}>사업자번호 *</label>
                <input
                  type="text"
                  value={form.business_number}
                  onChange={(e) => setForm({ ...form, business_number: e.target.value })}
                  required
                  placeholder="000-00-00000"
                  className={input}
                />
              </div>
            </div>

            <div>
              <label className={labelCls}>법인번호</label>
              <input
                type="text"
                value={form.corporate_number}
                onChange={(e) => setForm({ ...form, corporate_number: e.target.value })}
                placeholder="선택"
                className={input}
              />
            </div>

            <div>
              <label className={labelCls}>주소 *</label>
              <input
                type="text"
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
                required
                className={input}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>담당자 *</label>
                <input
                  type="text"
                  value={form.contact_name}
                  onChange={(e) => setForm({ ...form, contact_name: e.target.value })}
                  required
                  className={input}
                />
              </div>
              <div>
                <label className={labelCls}>담당자 연락처 *</label>
                <input
                  type="text"
                  value={form.contact_phone}
                  onChange={(e) => setForm({ ...form, contact_phone: e.target.value })}
                  required
                  placeholder="010-0000-0000"
                  className={input}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>이메일</label>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  className={input}
                />
              </div>
              <div>
                <label className={labelCls}>대표번호</label>
                <input
                  type="text"
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  className={input}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>권역 *</label>
                <select
                  value={form.region}
                  onChange={(e) => setForm({ ...form, region: e.target.value as 'jeju' | 'seoul' })}
                  className={input}
                >
                  <option value="jeju">제주</option>
                  <option value="seoul">서울·내륙</option>
                </select>
              </div>
              <div>
                <label className={labelCls}>최소발주금액 (원)</label>
                <input
                  type="number"
                  min={0}
                  step={10000}
                  value={form.min_order_amount}
                  onChange={(e) => setForm({ ...form, min_order_amount: e.target.value })}
                  className={input}
                />
              </div>
            </div>

            <label className="flex items-center gap-2 py-1 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={form.is_direct}
                onChange={(e) => setForm({ ...form, is_direct: e.target.checked })}
                className="w-4 h-4"
              />
              직영점 (후불정산)
            </label>

            {/* 배송요일 */}
            <div className="border border-gray-200 rounded-lg p-3 space-y-2">
              <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
                <input
                  type="checkbox"
                  checked={useDefaultDays}
                  onChange={(e) => setUseDefaultDays(e.target.checked)}
                  className="w-4 h-4"
                />
                배송요일 — 권역 기본값 사용
              </label>
              <p className="text-xs text-gray-400">
                {form.region === 'seoul'
                  ? '기본값: 월·수·금 (전일 17시 마감)'
                  : '기본값: 제주 주 1회 스케줄 (요일 지정 무시)'}
              </p>
              {!useDefaultDays && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => toggleDay(d)}
                      className={`w-10 py-1.5 rounded-lg text-sm border transition ${
                        days.includes(d)
                          ? 'bg-primary text-white border-primary'
                          : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                      }`}
                    >
                      {DAY_LABELS[d]}
                    </button>
                  ))}
                </div>
              )}
              {form.region === 'jeju' && !useDefaultDays && (
                <p className="text-xs text-amber-600">
                  ※ 제주 권역은 고정 스케줄을 사용하므로 선택한 요일이 적용되지 않습니다.
                </p>
              )}
            </div>

            <div>
              <label className={labelCls}>운영 메모</label>
              <textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                rows={2}
                placeholder="출입 비번 등 (관리자·신화푸드 조회용)"
                className={`${input} resize-none`}
              />
            </div>

            <p className="text-xs text-gray-400">
              ※ 예치금 잔액과 발주 가능 상품(화이트리스트)은 이 화면에서 바꿀 수 없습니다.
            </p>

            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg text-sm">
                {error}
              </div>
            )}

            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={() => { setEditing(false); setError(''); }}
                className="flex-1 py-2 border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50 transition"
              >
                취소
              </button>
              <button
                type="submit"
                disabled={loading}
                className="flex-1 py-2 bg-primary text-white rounded-lg font-medium hover:bg-primary-light transition disabled:opacity-50"
              >
                {loading ? '저장 중...' : '저장'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
