'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import PasswordConfirmModal from '@/components/PasswordConfirmModal';

interface Product {
  id: string;
  name: string;
  category: string;
  product_type: 'exclusive' | 'general';
  brand: string | null;
  manufacturer: string | null;
  storage: string | null;
  unit: string;
  spec: string | null;
  price: number;
  price_with_tax: number;
  is_tax_free: boolean;
  is_active: boolean;
  sort_order: number;
}

const storageLabel: Record<string, string> = {
  frozen: '냉동',
  refrigerated: '냉장',
  room_temp: '상온',
};

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'exclusive' | 'general'>('all');
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [profile, setProfile] = useState<{ role: string } | null>(null);
  const supabase = createClient();

  useEffect(() => {
    loadProducts();
    supabase.auth.getUser().then(({ data: { user } }: { data: { user: { id: string } | null } }) => {
      if (user) {
        supabase.from('profiles').select('role').eq('id', user.id).single()
          .then(({ data }: { data: { role: string } | null }) => { if (data) setProfile(data); });
      }
    });
  }, []);

  async function loadProducts() {
    const { data } = await supabase
      .from('products')
      .select('*')
      .order('sort_order');
    setProducts((data as Product[]) || []);
    setLoading(false);
  }

  const filtered = products.filter((p) =>
    filter === 'all' ? true : p.product_type === filter
  );

  const exclusiveCount = products.filter((p) => p.product_type === 'exclusive').length;
  const generalCount = products.filter((p) => p.product_type === 'general').length;

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
        <h2 className="text-xl font-bold text-gray-800">상품 관리</h2>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-500">전용 {exclusiveCount}종 · 범용 {generalCount}종</span>
          {(profile?.role === 'admin' || profile?.role === 'shinwa') && (
            <button
              onClick={() => setShowAddModal(true)}
              className="px-4 py-2 bg-[#1B4332] text-white rounded-lg text-sm font-medium hover:bg-[#2D6A4F] transition"
            >
              + 범용상품 추가
            </button>
          )}
        </div>
      </div>

      {/* 필터 탭 */}
      <div className="flex gap-2">
        {([
          ['all', '전체'],
          ['exclusive', '전용상품'],
          ['general', '범용상품'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
              filter === key
                ? 'bg-[#1B4332] text-white'
                : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 상품 목록 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        {/* 모바일: 카드형 */}
        <div className="lg:hidden divide-y divide-gray-100">
          {filtered.map((product) => (
            <div
              key={product.id}
              className={`p-4 space-y-2 ${!product.is_active ? 'opacity-50' : ''} ${
                profile?.role === 'shinwa' && product.product_type === 'exclusive' ? '' : 'cursor-pointer hover:bg-gray-50'
              }`}
              onClick={() => {
                if (profile?.role === 'shinwa' && product.product_type === 'exclusive') return;
                setEditingProduct(product);
              }}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold text-gray-800 text-sm">{product.name}</h3>
                  {!product.is_active && <span className="px-1.5 py-0.5 bg-gray-200 text-gray-500 rounded text-xs">판매중지</span>}
                </div>
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                  product.product_type === 'exclusive'
                    ? 'bg-orange-100 text-orange-700'
                    : 'bg-blue-100 text-blue-700'
                }`}>
                  {product.product_type === 'exclusive' ? '전용' : '범용'}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-500">
                  {product.category} · {product.spec} · {storageLabel[product.storage || ''] || ''}
                </span>
                <span className="font-semibold text-gray-800">
                  ₩{product.price_with_tax.toLocaleString()}
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* 데스크톱: 테이블 */}
        <div className="hidden lg:block overflow-x-auto">
          <table className="w-full text-sm min-w-[900px]">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">구분</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">상품명</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">카테고리</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">규격</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">단위</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">보관</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">공급가</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">부가세포함</th>
                <th className="px-4 py-3 text-center font-medium text-gray-500">면세</th>
                <th className="px-4 py-3 text-center font-medium text-gray-500">수정</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((product) => (
                <tr key={product.id} className={`hover:bg-gray-50 transition ${!product.is_active ? 'opacity-50' : ''}`}>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                      product.product_type === 'exclusive'
                        ? 'bg-orange-100 text-orange-700'
                        : 'bg-blue-100 text-blue-700'
                    }`}>
                      {product.product_type === 'exclusive' ? '전용' : '범용'}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-medium text-gray-800">
                    {product.name}
                    {!product.is_active && <span className="ml-2 px-1.5 py-0.5 bg-gray-200 text-gray-500 rounded text-xs">판매중지</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{product.category}</td>
                  <td className="px-4 py-3 text-gray-600">{product.spec}</td>
                  <td className="px-4 py-3 text-gray-600">{product.unit}</td>
                  <td className="px-4 py-3 text-gray-600">{storageLabel[product.storage || ''] || '-'}</td>
                  <td className="px-4 py-3 text-right text-gray-600">₩{product.price.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right font-semibold text-gray-800">₩{product.price_with_tax.toLocaleString()}</td>
                  <td className="px-4 py-3 text-center">{product.is_tax_free ? '✅' : ''}</td>
                  <td className="px-4 py-3 text-center">
                    {profile?.role === 'shinwa' && product.product_type === 'exclusive' ? (
                      <span className="text-gray-300 text-sm">—</span>
                    ) : (
                      <button
                        onClick={() => setEditingProduct(product)}
                        className="text-[#2D6A4F] hover:underline text-sm"
                      >
                        수정
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 수정 모달 */}
      {editingProduct && (
        <EditProductModal
          product={editingProduct}
          userRole={profile?.role || ''}
          onClose={() => setEditingProduct(null)}
          onSaved={() => {
            setEditingProduct(null);
            loadProducts();
          }}
        />
      )}

      {/* 추가 모달 */}
      {showAddModal && (
        <AddProductModal
          onClose={() => setShowAddModal(false)}
          onSaved={() => {
            setShowAddModal(false);
            loadProducts();
          }}
        />
      )}
    </div>
  );
}

function AddProductModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: '',
    category: '조미료/소스',
    price: '',
    price_with_tax: '',
    is_tax_free: false,
    spec: '',
    unit: 'EA',
    storage: 'room_temp',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const supabase = createClient();

  const categories = ['조미료/소스', '장류', '양념/향신료', '설탕류', '농산물', '음료', '소모품', '세제/위생', '반찬류', '기타'];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    const { error: insertError } = await supabase
      .from('products')
      .insert({
        name: form.name,
        category: form.category,
        product_type: 'general',
        brand: null,
        manufacturer: '신화푸드',
        storage: form.storage,
        unit: form.unit,
        spec: form.spec,
        price: Number(form.price),
        price_with_tax: Number(form.price_with_tax),
        is_tax_free: form.is_tax_free,
        is_active: true,
        sort_order: 200,
      });

    if (insertError) {
      setError(insertError.message);
      setLoading(false);
      return;
    }

    onSaved();
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-gray-800">범용상품 추가</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">상품명</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
              placeholder="예: 참기름(오뚜기) 320ml"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">카테고리</label>
            <select
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
            >
              {categories.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">공급가 (원)</label>
              <input
                type="number"
                value={form.price}
                onChange={(e) => setForm({ ...form, price: e.target.value })}
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">부가세포함 (원)</label>
              <input
                type="number"
                value={form.price_with_tax}
                onChange={(e) => setForm({ ...form, price_with_tax: e.target.value })}
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">규격</label>
              <input
                type="text"
                value={form.spec}
                onChange={(e) => setForm({ ...form, spec: e.target.value })}
                placeholder="예: 320ml"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">단위</label>
              <input
                type="text"
                value={form.unit}
                onChange={(e) => setForm({ ...form, unit: e.target.value })}
                placeholder="EA, BOX, kg 등"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">보관</label>
            <select
              value={form.storage}
              onChange={(e) => setForm({ ...form, storage: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
            >
              <option value="room_temp">상온</option>
              <option value="refrigerated">냉장</option>
              <option value="frozen">냉동</option>
            </select>
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={form.is_tax_free}
              onChange={(e) => setForm({ ...form, is_tax_free: e.target.checked })}
              className="w-4 h-4"
            />
            면세 상품
          </label>

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
              {loading ? '등록 중...' : '등록'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function EditProductModal({
  product,
  userRole,
  onClose,
  onSaved,
}: {
  product: Product;
  userRole: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: product.name,
    price: product.price,
    price_with_tax: product.price_with_tax,
    is_tax_free: product.is_tax_free,
    spec: product.spec || '',
    unit: product.unit,
    storage: product.storage || 'room_temp',
    is_active: product.is_active,
  });
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const supabase = createClient();

  // 비밀번호 확인이 필요한 경우:
  // - 전용상품 수정 (admin만 가능, 항상 비번 확인)
  // - 범용상품 가격 변경 (shinwa가 가격을 바꿨을 때)
  const needsPasswordConfirm = () => {
    if (product.product_type === 'exclusive') return true;
    if (product.product_type === 'general' && userRole === 'shinwa') {
      return form.price !== product.price || form.price_with_tax !== product.price_with_tax;
    }
    return false;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (needsPasswordConfirm()) {
      setShowPasswordModal(true);
      return;
    }
    await doSave();
  };

  const doSave = async () => {
    setLoading(true);
    setError('');

    const { error: updateError } = await supabase
      .from('products')
      .update({
        name: form.name,
        price: form.price,
        price_with_tax: form.price_with_tax,
        is_tax_free: form.is_tax_free,
        spec: form.spec,
        unit: form.unit,
        storage: form.storage,
        is_active: form.is_active,
      })
      .eq('id', product.id);

    if (updateError) {
      setError(updateError.message);
      setLoading(false);
      return;
    }

    onSaved();
  };

  const handleDelete = async () => {
    if (!confirm('이 상품을 삭제하시겠습니까?\n삭제된 상품은 복구할 수 없습니다.')) return;
    setDeleting(true);
    setError('');

    const { error: deleteError } = await supabase
      .from('products')
      .delete()
      .eq('id', product.id);

    if (deleteError) {
      setError(deleteError.message.includes('violates foreign key')
        ? '이미 발주에 사용된 상품은 삭제할 수 없습니다. 판매중지를 이용해주세요.'
        : deleteError.message);
      setDeleting(false);
      return;
    }

    onSaved();
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-lg font-bold text-gray-800">상품 수정</h3>
            {product.product_type === 'exclusive' && (
              <p className="text-xs text-orange-600 mt-0.5">전용상품 — 저장 시 비밀번호 확인 필요</p>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">상품명</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">공급가 (원)</label>
              <input
                type="number"
                value={form.price}
                onChange={(e) => setForm({ ...form, price: Number(e.target.value) })}
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">부가세포함 (원)</label>
              <input
                type="number"
                value={form.price_with_tax}
                onChange={(e) => setForm({ ...form, price_with_tax: Number(e.target.value) })}
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">규격</label>
              <input
                type="text"
                value={form.spec}
                onChange={(e) => setForm({ ...form, spec: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">단위</label>
              <input
                type="text"
                value={form.unit}
                onChange={(e) => setForm({ ...form, unit: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">보관</label>
            <select
              value={form.storage}
              onChange={(e) => setForm({ ...form, storage: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
            >
              <option value="room_temp">상온</option>
              <option value="refrigerated">냉장</option>
              <option value="frozen">냉동</option>
            </select>
          </div>

          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={form.is_tax_free}
                onChange={(e) => setForm({ ...form, is_tax_free: e.target.checked })}
                className="w-4 h-4"
              />
              면세 상품
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={form.is_active}
                onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
                className="w-4 h-4"
              />
              판매 중
            </label>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg text-sm">
              {error}
            </div>
          )}

          <div className="flex gap-3">
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
              className="flex-1 py-2 bg-[#1B4332] text-white rounded-lg font-medium hover:bg-[#2D6A4F] transition disabled:opacity-50"
            >
              {loading ? '저장 중...' : '저장'}
            </button>
          </div>

          {/* 범용상품 삭제 버튼 */}
          {product.product_type === 'general' && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              className="w-full mt-2 py-2 text-red-600 border border-red-300 rounded-lg text-sm hover:bg-red-50 transition disabled:opacity-50"
            >
              {deleting ? '삭제 중...' : '이 상품 삭제'}
            </button>
          )}
        </form>

        {showPasswordModal && (
          <PasswordConfirmModal
            title="비밀번호 확인"
            message={product.product_type === 'exclusive'
              ? '전용상품 수정은 비밀번호 확인이 필요합니다.'
              : '가격 변경은 비밀번호 확인이 필요합니다.'}
            onConfirm={() => { setShowPasswordModal(false); doSave(); }}
            onCancel={() => setShowPasswordModal(false)}
          />
        )}
      </div>
    </div>
  );
}
