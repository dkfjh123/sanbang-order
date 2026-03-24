'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Store, Profile } from '@/types';

export default function StoresPage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const supabase = createClient();

  useEffect(() => {
    loadStores();
  }, []);

  async function loadStores() {
    const { data } = await supabase
      .from('stores')
      .select('*')
      .order('created_at');
    setStores((data as Store[]) || []);
    setLoading(false);
  }

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
        <button
          onClick={() => setShowCreateModal(true)}
          className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary-light transition"
        >
          + 계정 생성
        </button>
      </div>

      {/* 가맹점 목록 테이블 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        {/* 모바일: 카드형 */}
        <div className="lg:hidden divide-y divide-gray-100">
          {stores.map((store) => (
            <div key={store.id} className="p-4 space-y-2">
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
              <p className="text-sm text-gray-500">{store.region === 'seoul' ? '서울·내륙' : '제주'}</p>
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-400">{store.business_number}</span>
                <span className="font-semibold text-gray-800">
                  {store.is_direct
                    ? '후불정산'
                    : `₩${store.deposit_balance.toLocaleString()}`}
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* 데스크톱: 테이블 */}
        <div className="hidden lg:block overflow-x-auto">
          <table className="w-full text-sm">
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
                <tr key={store.id} className="hover:bg-gray-50 transition">
                  <td className="px-4 py-3 text-gray-400">{idx + 1}</td>
                  <td className="px-4 py-3 font-medium text-gray-800">{store.short_name || store.name}</td>
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

      {/* 계정 생성 모달 */}
      {showCreateModal && (
        <CreateUserModal
          stores={stores}
          onClose={() => setShowCreateModal(false)}
          onCreated={loadStores}
        />
      )}
    </div>
  );
}

function CreateUserModal({
  stores,
  onClose,
  onCreated,
}: {
  stores: Store[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState({
    email: '',
    password: '',
    name: '',
    role: 'store' as 'store' | 'shinwa' | 'admin',
    store_id: '',
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
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
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
