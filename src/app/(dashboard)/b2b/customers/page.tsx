'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import type { B2bCustomer } from '@/types';

export default function B2bCustomersPage() {
  const [customers, setCustomers] = useState<B2bCustomer[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const supabase = createClient();

  useEffect(() => { load(); }, []);

  async function load() {
    const { data } = await supabase
      .from('b2b_customers')
      .select('*')
      .order('created_at');
    setCustomers((data as B2bCustomer[]) || []);
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
        <div>
          <h2 className="text-xl font-bold text-gray-800">B2B 거래처</h2>
          <Link href="/b2b" className="text-sm text-primary hover:underline">← 발주 목록으로</Link>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary-light transition"
        >
          + 신규 거래처
        </button>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        {customers.length === 0 ? (
          <div className="text-center py-12 text-gray-400">등록된 거래처가 없습니다.</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {customers.map((c) => (
              <div key={c.id} className="p-4 flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-gray-800">{c.name}</h3>
                    <span className={`px-2 py-0.5 text-xs rounded ${c.region === 'jeju' ? 'bg-amber-50 text-amber-700' : 'bg-sky-50 text-sky-700'}`}>
                      {c.region === 'jeju' ? '제주 12.5%' : '육지 8.5%'}
                    </span>
                    {!c.is_active && (
                      <span className="px-2 py-0.5 bg-gray-100 text-gray-500 text-xs rounded">비활성</span>
                    )}
                  </div>
                  <p className="text-sm text-gray-500 mt-1">
                    {c.business_number || '사업자번호 미등록'} · {c.contact_name || '담당자 미등록'} · {c.contact_phone || '연락처 미등록'}
                  </p>
                  {c.memo && <p className="text-xs text-gray-400 mt-1">{c.memo}</p>}
                </div>
                <button
                  onClick={() => setEditingId(c.id)}
                  className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50 transition"
                >
                  편집
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {editingId && (
        <CustomerModal
          customer={customers.find((c) => c.id === editingId)!}
          onClose={() => setEditingId(null)}
          onSaved={async () => { await load(); setEditingId(null); }}
        />
      )}
      {showCreateModal && (
        <CustomerModal
          customer={null}
          onClose={() => setShowCreateModal(false)}
          onSaved={async () => { await load(); setShowCreateModal(false); }}
        />
      )}
    </div>
  );
}

function CustomerModal({
  customer,
  onClose,
  onSaved,
}: {
  customer: B2bCustomer | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const supabase = createClient();
  const [form, setForm] = useState({
    name: customer?.name || '',
    business_number: customer?.business_number || '',
    contact_name: customer?.contact_name || '',
    contact_phone: customer?.contact_phone || '',
    contact_email: customer?.contact_email || '',
    address: customer?.address || '',
    memo: customer?.memo || '',
    region: (customer?.region as 'jeju' | 'seoul') || 'seoul',
    is_active: customer?.is_active ?? true,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSaving(true);

    const payload = {
      name: form.name,
      business_number: form.business_number || null,
      contact_name: form.contact_name || null,
      contact_phone: form.contact_phone || null,
      contact_email: form.contact_email || null,
      address: form.address || null,
      memo: form.memo || null,
      region: form.region,
      is_active: form.is_active,
    };

    const result = customer
      ? await supabase.from('b2b_customers').update(payload).eq('id', customer.id)
      : await supabase.from('b2b_customers').insert(payload);

    if (result.error) {
      setError(result.error.message);
      setSaving(false);
      return;
    }

    setSaving(false);
    onSaved();
  };

  const input = 'w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 text-sm';

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-gray-800">{customer ? '거래처 편집' : '신규 거래처'}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">거래처명 *</label>
            <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required className={input} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">사업자번호</label>
            <input type="text" value={form.business_number} onChange={(e) => setForm({ ...form, business_number: e.target.value })} placeholder="000-00-00000" className={input} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">담당자</label>
              <input type="text" value={form.contact_name} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} className={input} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">연락처</label>
              <input type="text" value={form.contact_phone} onChange={(e) => setForm({ ...form, contact_phone: e.target.value })} className={input} />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">이메일</label>
            <input type="email" value={form.contact_email} onChange={(e) => setForm({ ...form, contact_email: e.target.value })} className={input} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">주소</label>
            <input type="text" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} className={input} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">권역 *</label>
            <select
              value={form.region}
              onChange={(e) => setForm({ ...form, region: e.target.value as 'jeju' | 'seoul' })}
              className={input}
            >
              <option value="seoul">육지 (신화수수료 8.5%)</option>
              <option value="jeju">제주 (신화수수료 12.5%)</option>
            </select>
            <p className="mt-1 text-xs text-gray-400">신화 물류수수료율 산정 기준. 수수료 베이스는 가맹점 판가입니다.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">메모</label>
            <textarea value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} rows={2} className={input} />
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} className="w-4 h-4" />
            활성 (발주 등록 시 선택 가능)
          </label>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg text-sm">{error}</div>
          )}

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 py-2 border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50 transition">취소</button>
            <button type="submit" disabled={saving} className="flex-1 py-2 bg-primary text-white rounded-lg font-medium hover:bg-primary-light transition disabled:opacity-50">
              {saving ? '저장 중...' : '저장'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
