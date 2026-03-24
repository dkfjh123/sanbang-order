'use client';

export default function Header({ onMenuToggle }: { onMenuToggle: () => void }) {
  return (
    <header className="bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-4 lg:px-6">
      {/* 모바일 햄버거 */}
      <button
        onClick={onMenuToggle}
        className="lg:hidden p-2 rounded-lg hover:bg-gray-100 transition"
        aria-label="메뉴 열기"
      >
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      <h1 className="text-lg font-semibold text-gray-800">
        산방식당 발주시스템
      </h1>
    </header>
  );
}
