'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';

interface PasswordConfirmModalProps {
  title?: string;
  message?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function PasswordConfirmModal({
  title = '비밀번호 확인',
  message = '보안을 위해 비밀번호를 다시 입력해주세요.',
  onConfirm,
  onCancel,
}: PasswordConfirmModalProps) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const supabase = createClient();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    const { data: { user } } = await supabase.auth.getUser();
    if (!user?.email) {
      setError('사용자 정보를 확인할 수 없습니다.');
      setLoading(false);
      return;
    }

    const { error: authError } = await supabase.auth.signInWithPassword({
      email: user.email,
      password,
    });

    if (authError) {
      setError('비밀번호가 일치하지 않습니다.');
      setLoading(false);
      return;
    }

    setLoading(false);
    onConfirm();
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
        <h3 className="text-lg font-bold text-gray-800 mb-1">{title}</h3>
        <p className="text-sm text-gray-500 mb-4">{message}</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="비밀번호 입력"
            required
            autoFocus
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
          />

          {error && (
            <p className="text-red-600 text-sm">{error}</p>
          )}

          <div className="flex gap-3">
            <button type="button" onClick={onCancel}
              className="flex-1 py-2 border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50 transition">
              취소
            </button>
            <button type="submit" disabled={loading}
              className="flex-1 py-2 bg-[#1B4332] text-white rounded-lg font-medium hover:bg-[#2D6A4F] transition disabled:opacity-50">
              {loading ? '확인 중...' : '확인'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
