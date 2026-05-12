'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Profile, Store } from '@/types';

interface Notice {
  id: string;
  title: string;
  content: string;
  is_pinned: boolean;
  is_active: boolean;
  target_type: 'all' | 'selected';
  target_store_ids: string[];
  created_by: string;
  created_at: string;
}

export default function NoticesPage() {
  const [notices, setNotices] = useState<Notice[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [showEditor, setShowEditor] = useState(false);
  const [editingNotice, setEditingNotice] = useState<Notice | null>(null);
  const [selectedNotice, setSelectedNotice] = useState<Notice | null>(null);
  const supabase = createClient();

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data: prof } = await supabase.from('profiles').select('*').eq('id', user.id).single();
      if (prof) setProfile(prof as Profile);

      if (prof?.role === 'admin') {
        const { data: storeList } = await supabase.from('stores').select('*').order('created_at');
        setStores((storeList as Store[]) || []);
      }

      await loadNotices(prof as Profile);
      setLoading(false);
    }
    load();
  }, []);

  async function loadNotices(prof?: Profile) {
    const p = prof || profile;
    let query = supabase
      .from('notices')
      .select('*')
      .eq('is_active', true)
      .order('is_pinned', { ascending: false })
      .order('created_at', { ascending: false });

    const { data } = await query;
    let result = (data as Notice[]) || [];

    // 가맹점은 전체 공지 + 자기 매장 대상 공지만 표시
    if (p && p.role === 'store' && p.store_id) {
      result = result.filter(
        (n) => n.target_type === 'all' || (n.target_store_ids && n.target_store_ids.includes(p.store_id!))
      );
    }

    setNotices(result);
  }

  const handleDelete = async (id: string) => {
    if (!confirm('이 공지사항을 삭제하시겠습니까?')) return;
    await supabase.from('notices').update({ is_active: false }).eq('id', id);
    setSelectedNotice(null);
    loadNotices();
  };

  const getTargetLabel = (notice: Notice) => {
    if (notice.target_type === 'all') return '전체';
    if (!notice.target_store_ids || notice.target_store_ids.length === 0) return '전체';
    const names = notice.target_store_ids
      .map((id) => stores.find((s) => s.id === id))
      .filter(Boolean)
      .map((s) => s!.short_name || s!.name);
    return names.join(', ');
  };

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
        <h2 className="text-xl font-bold text-gray-800">공지사항</h2>
        {profile?.role === 'admin' && (
          <button
            onClick={() => { setEditingNotice(null); setShowEditor(true); }}
            className="px-4 py-2 bg-[#1B4332] text-white rounded-lg text-sm font-medium hover:bg-[#2D6A4F] transition"
          >
            + 새 공지
          </button>
        )}
      </div>

      {notices.length === 0 ? (
        <div className="bg-white rounded-xl p-12 text-center text-gray-400 shadow-sm border border-gray-100">
          등록된 공지사항이 없습니다.
        </div>
      ) : (
        <div className="space-y-3">
          {notices.map((notice) => (
            <div
              key={notice.id}
              onClick={() => setSelectedNotice(notice)}
              className="bg-white rounded-xl p-5 shadow-sm border border-gray-100 cursor-pointer hover:border-[#2D6A4F] transition"
            >
              <div className="flex items-center gap-2 mb-1">
                {notice.is_pinned && (
                  <span className="px-2 py-0.5 bg-red-100 text-red-700 rounded text-xs font-semibold">고정</span>
                )}
                {profile?.role === 'admin' && (
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                    notice.target_type === 'all' ? 'bg-green-100 text-green-700' : 'bg-purple-100 text-purple-700'
                  }`}>
                    {notice.target_type === 'all' ? '전체' : '지정'}
                  </span>
                )}
                <h3 className="font-semibold text-gray-800">{notice.title}</h3>
              </div>
              <div className="flex items-center justify-between">
                <p className="text-xs text-gray-400">
                  {new Date(notice.created_at).toLocaleDateString('ko-KR')}
                </p>
                {profile?.role === 'admin' && notice.target_type === 'selected' && (
                  <p className="text-xs text-purple-500">{getTargetLabel(notice)}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 공지 상세 모달 */}
      {selectedNotice && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setSelectedNotice(null)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                {selectedNotice.is_pinned && (
                  <span className="px-2 py-0.5 bg-red-100 text-red-700 rounded text-xs font-semibold">고정</span>
                )}
                <h3 className="text-lg font-bold text-gray-800">{selectedNotice.title}</h3>
              </div>
              <button onClick={() => setSelectedNotice(null)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <div className="flex items-center gap-2 mb-4">
              <span className="text-xs text-gray-400">
                {new Date(selectedNotice.created_at).toLocaleString('ko-KR')}
              </span>
              {profile?.role === 'admin' && (
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                  selectedNotice.target_type === 'all' ? 'bg-green-100 text-green-700' : 'bg-purple-100 text-purple-700'
                }`}>
                  대상: {getTargetLabel(selectedNotice)}
                </span>
              )}
            </div>
            <div className="text-gray-700 whitespace-pre-wrap leading-relaxed">
              {selectedNotice.content}
            </div>

            {profile?.role === 'admin' && (
              <div className="flex gap-2 mt-6 pt-4 border-t border-gray-200">
                <button
                  onClick={() => { setEditingNotice(selectedNotice); setShowEditor(true); setSelectedNotice(null); }}
                  className="px-4 py-2 bg-[#1B4332] text-white rounded-lg text-sm hover:bg-[#2D6A4F] transition"
                >
                  수정
                </button>
                <button
                  onClick={() => handleDelete(selectedNotice.id)}
                  className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm hover:bg-red-700 transition"
                >
                  삭제
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 작성/수정 모달 */}
      {showEditor && (
        <NoticeEditor
          notice={editingNotice}
          stores={stores}
          onClose={() => setShowEditor(false)}
          onSaved={() => { setShowEditor(false); loadNotices(); }}
        />
      )}
    </div>
  );
}

function NoticeEditor({
  notice,
  stores,
  onClose,
  onSaved,
}: {
  notice: Notice | null;
  stores: Store[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(notice?.title || '');
  const [content, setContent] = useState(notice?.content || '');
  const [isPinned, setIsPinned] = useState(notice?.is_pinned || false);
  const [targetType, setTargetType] = useState<'all' | 'selected'>(notice?.target_type || 'all');
  const [targetStoreIds, setTargetStoreIds] = useState<string[]>(notice?.target_store_ids || []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const supabase = createClient();

  const toggleStore = (storeId: string) => {
    setTargetStoreIds((prev) =>
      prev.includes(storeId) ? prev.filter((id) => id !== storeId) : [...prev, storeId]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    if (targetType === 'selected' && targetStoreIds.length === 0) {
      setError('대상 매장을 선택해주세요.');
      setLoading(false);
      return;
    }

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const payload = {
      title,
      content,
      is_pinned: isPinned,
      target_type: targetType,
      target_store_ids: targetType === 'all' ? [] : targetStoreIds,
    };

    if (notice) {
      const { error: updateError } = await supabase
        .from('notices')
        .update(payload)
        .eq('id', notice.id);
      if (updateError) { setError(updateError.message); setLoading(false); return; }
    } else {
      const { error: insertError } = await supabase
        .from('notices')
        .insert({ ...payload, created_by: user.id });
      if (insertError) { setError(insertError.message); setLoading(false); return; }
    }

    onSaved();
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-gray-800">{notice ? '공지 수정' : '새 공지'}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">제목</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">내용</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              required
              rows={8}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 resize-none"
            />
          </div>

          {/* 대상 매장 선택 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">공지 대상</label>
            <div className="flex gap-3 mb-3">
              <button
                type="button"
                onClick={() => setTargetType('all')}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                  targetType === 'all'
                    ? 'bg-[#1B4332] text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                전체 매장
              </button>
              <button
                type="button"
                onClick={() => setTargetType('selected')}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                  targetType === 'selected'
                    ? 'bg-[#1B4332] text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                매장 선택
              </button>
            </div>

            {targetType === 'selected' && (
              <div className="border border-gray-200 rounded-lg p-3 space-y-2 max-h-48 overflow-y-auto">
                {stores.map((store) => (
                  <label key={store.id} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer hover:bg-gray-50 p-1 rounded">
                    <input
                      type="checkbox"
                      checked={targetStoreIds.includes(store.id)}
                      onChange={() => toggleStore(store.id)}
                      className="w-4 h-4"
                    />
                    {store.short_name || store.name}
                    {store.is_direct && <span className="text-xs text-blue-500">(직영)</span>}
                  </label>
                ))}
              </div>
            )}
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={isPinned}
              onChange={(e) => setIsPinned(e.target.checked)}
              className="w-4 h-4"
            />
            상단 고정
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
              {loading ? '저장 중...' : notice ? '수정' : '등록'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
