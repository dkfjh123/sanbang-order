'use client';

import Image from 'next/image';

export default function GuidePage() {
  return (
    <div className="min-h-screen bg-white">
      <div className="max-w-lg mx-auto px-5 py-8">
        {/* 헤더 */}
        <div className="text-center mb-8">
          <Image
            src="/img/제주산방식당 로고 확정본 (2).jpg"
            alt="산방식당 로고"
            width={120}
            height={120}
            style={{ width: 120, height: 'auto' }}
            className="rounded-lg mx-auto mb-4"
          />
          <h1 className="text-2xl font-bold text-gray-800">산방식당 발주시스템</h1>
          <p className="text-gray-500 mt-1">홈 화면에 추가하면 앱처럼 사용할 수 있습니다</p>
        </div>

        {/* 아이폰 가이드 */}
        <div className="mb-8">
          <h2 className="text-lg font-bold text-gray-800 mb-4 flex items-center gap-2">
            <span className="w-8 h-8 bg-black text-white rounded-lg flex items-center justify-center text-sm font-bold">i</span>
            아이폰 (Safari)
          </h2>
          <div className="space-y-4">
            <Step num={1} text="Safari로 이 페이지에 접속합니다" />
            <Step num={2}>
              <span>하단의 <strong>공유 버튼</strong> (□↑ 모양)을 누릅니다</span>
            </Step>
            <Step num={3}>
              <span><strong>&quot;홈 화면에 추가&quot;</strong>를 누릅니다</span>
            </Step>
            <Step num={4}>
              <span>오른쪽 상단 <strong>&quot;추가&quot;</strong>를 누르면 완료!</span>
            </Step>
          </div>
        </div>

        {/* 안드로이드 가이드 */}
        <div className="mb-8">
          <h2 className="text-lg font-bold text-gray-800 mb-4 flex items-center gap-2">
            <span className="w-8 h-8 bg-green-600 text-white rounded-lg flex items-center justify-center text-sm font-bold">A</span>
            안드로이드 (Chrome)
          </h2>
          <div className="space-y-4">
            <Step num={1} text="Chrome으로 이 페이지에 접속합니다" />
            <Step num={2}>
              <span>오른쪽 상단 <strong>메뉴 (⋮)</strong>를 누릅니다</span>
            </Step>
            <Step num={3}>
              <span><strong>&quot;홈 화면에 추가&quot;</strong> 또는 <strong>&quot;앱 설치&quot;</strong>를 누릅니다</span>
            </Step>
            <Step num={4}>
              <span><strong>&quot;추가&quot;</strong>를 누르면 완료!</span>
            </Step>
          </div>
        </div>

        {/* 설치 후 */}
        <div className="bg-green-50 border border-green-200 rounded-xl p-5 mb-8">
          <h3 className="font-bold text-green-800 mb-2">설치 완료!</h3>
          <p className="text-green-700 text-sm">
            홈 화면에 &quot;산방발주&quot; 아이콘이 생깁니다.
            앱처럼 전체화면으로 열리며, 로그인 정보가 유지됩니다.
          </p>
        </div>

        {/* 로그인 안내 */}
        <div className="bg-gray-50 border border-gray-200 rounded-xl p-5 mb-8">
          <h3 className="font-bold text-gray-800 mb-2">로그인 안내</h3>
          <p className="text-gray-600 text-sm mb-3">
            관리자로부터 받은 이메일/비밀번호로 로그인하세요.
            계정이 없으면 관리자에게 문의해주세요.
          </p>
          <div className="text-sm text-gray-500 space-y-1">
            <p>산방에프앤비 : contact@jejusanbang.com / 010-4011-5348</p>
          </div>
        </div>

        {/* 바로 시작 */}
        <a
          href="/login"
          className="block w-full py-4 bg-[#1B4332] text-white text-center rounded-xl font-bold text-lg hover:bg-[#2D6A4F] transition"
        >
          발주시스템 시작하기
        </a>
      </div>
    </div>
  );
}

function Step({ num, text, children }: { num: number; text?: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="w-7 h-7 bg-[#1B4332] text-white rounded-full flex items-center justify-center text-sm font-bold shrink-0 mt-0.5">
        {num}
      </span>
      <p className="text-gray-700 text-base leading-relaxed">
        {text || children}
      </p>
    </div>
  );
}
