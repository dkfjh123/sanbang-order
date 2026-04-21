import type { MenuItem, UserRole } from '@/types';

export const menuItems: MenuItem[] = [
  { label: '대시보드', href: '/dashboard', roles: ['admin', 'store', 'shinwa'] },
  { label: '발주하기', href: '/orders/new', roles: ['admin', 'store'] },
  { label: '발주내역', href: '/orders', roles: ['admin', 'store', 'shinwa'] },
  { label: '상품관리', href: '/products', roles: ['admin', 'shinwa'] },
  { label: '예치금관리', href: '/deposits', roles: ['admin', 'store'], storeReadOnly: true },
  { label: '재고관리', href: '/inventory', roles: ['admin', 'shinwa'] },
  { label: '가맹점관리', href: '/stores', roles: ['admin'] },
  { label: '정산관리', href: '/settlement', roles: ['admin'] },
  { label: '공지사항', href: '/notices', roles: ['admin', 'store', 'shinwa'] },
  { label: 'B2B 발주', href: '/b2b', roles: ['admin'] },
];

export function getMenuForRole(role: UserRole): MenuItem[] {
  return menuItems.filter((item) => item.roles.includes(role));
}
