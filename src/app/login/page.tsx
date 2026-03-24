'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';
import Image from 'next/image';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberEmail, setRememberEmail] = useState(true);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  // 저장된 이메일 불러오기
  useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('sanbang_email');
      if (saved) setEmail(saved);
    }
  });

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const supabase = createClient();
      const { error: authError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (authError) {
        setError('이메일 또는 비밀번호가 올바르지 않습니다.');
        setLoading(false);
        return;
      }

      // 이메일 기억
      if (rememberEmail) {
        localStorage.setItem('sanbang_email', email);
      } else {
        localStorage.removeItem('sanbang_email');
      }

      window.location.href = '/dashboard';
    } catch {
      setError('로그인 중 오류가 발생했습니다.');
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#1B4332] to-[#2D6A4F] px-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl p-8">
        {/* 로고 */}
        <div className="flex justify-center mb-6">
          <Image
            src="/img/제주산방식당 로고 확정본 (2).jpg"
            alt="산방식당 로고"
            width={180}
            height={180}
            style={{ width: 180, height: 'auto' }}
            className="rounded-lg"
            priority
          />
        </div>

        <h1 className="text-center text-xl font-bold text-gray-800 mb-1">
          산방식당 발주시스템
        </h1>
        <p className="text-center text-sm text-gray-500 mb-6">
          가맹점 전용 발주 프로그램
        </p>

        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
              이메일
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="example@email.com"
              required
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] focus:border-transparent outline-none transition text-gray-900"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
              비밀번호
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="비밀번호를 입력하세요"
              required
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] focus:border-transparent outline-none transition text-gray-900"
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={rememberEmail}
              onChange={(e) => setRememberEmail(e.target.checked)}
              className="w-4 h-4"
            />
            이메일 기억하기
          </label>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 bg-[#1B4332] text-white rounded-lg font-medium hover:bg-[#2D6A4F] transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? '로그인 중...' : '로그인'}
          </button>
        </form>

        <p className="mt-6 text-center text-xs text-gray-400">
          계정이 없으시면 관리자에게 문의하세요
        </p>
      </div>
    </div>
  );
}
