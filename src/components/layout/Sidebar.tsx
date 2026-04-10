'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { getMenuForRole } from '@/lib/menu';
import type { Profile } from '@/types';

const menuIcons: Record<string, string> = {
  '/dashboard': '·',
  '/orders/new': '·',
  '/orders': '·',
  '/products': '·',
  '/deposits': '·',
  '/inventory': '·',
  '/stores': '·',
  '/settlement': '·',
  '/notices': '·',
};

export default function Sidebar({
  profile,
  open,
  onClose,
}: {
  profile: Profile;
  open: boolean;
  onClose: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createClient();
  const menu = getMenuForRole(profile.role);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  };

  const roleLabel = {
    admin: '관리자',
    store: '가맹점',
    shinwa: '신화푸드',
  }[profile.role];

  return (
    <>
      {/* 모바일 오버레이 */}
      {open && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={`max-lg:fixed max-lg:top-0 max-lg:left-0 max-lg:z-50 max-lg:transition-transform max-lg:duration-200 h-full w-64 shrink-0 bg-sidebar-bg text-sidebar-text flex flex-col ${
          open ? 'max-lg:translate-x-0' : 'max-lg:-translate-x-full'
        }`}
      >
        {/* 로고 영역 */}
        <div className="p-4 border-b border-white/10">
          <div className="flex items-center gap-3">
            <Image
              src="/img/제주산방식당 로고 확정본 (2).jpg"
              alt="로고"
              width={40}
              height={40}
              className="rounded"
            />
            <div>
              <h2 className="font-bold text-sm">산방식당</h2>
              <p className="text-xs opacity-70">발주시스템</p>
            </div>
          </div>
        </div>

        {/* 사용자 정보 */}
        <div className="px-4 py-3 border-b border-white/10">
          <p className="text-sm font-medium">{profile.name}</p>
          <span className="inline-block mt-1 px-2 py-0.5 bg-white/15 rounded text-xs">
            {roleLabel}
          </span>
        </div>

        {/* 메뉴 */}
        <nav className="flex-1 overflow-y-auto py-2">
          {menu.map((item) => {
            const isActive = pathname === item.href || (pathname.startsWith(item.href + '/') && !menu.some((m) => m.href !== item.href && pathname.startsWith(m.href)));
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onClose}
                className={`flex items-center gap-3 px-4 py-3 mx-2 rounded-lg text-sm transition ${
                  isActive
                    ? 'bg-sidebar-active text-white font-medium'
                    : 'hover:bg-sidebar-hover'
                }`}
              >
                <span>{menuIcons[item.href] || '📄'}</span>
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* 로그아웃 */}
        <div className="p-4 border-t border-white/10">
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-3 px-4 py-2 rounded-lg text-sm hover:bg-sidebar-hover transition"
          >
            <span>🚪</span>
            <span>로그아웃</span>
          </button>
        </div>
      </aside>
    </>
  );
}
