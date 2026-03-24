export type UserRole = 'admin' | 'store' | 'shinwa';

export interface Profile {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  store_id: string | null;
  created_at: string;
}

export interface Store {
  id: string;
  name: string;
  short_name: string;
  owner_name: string;
  business_number: string;
  address: string;
  contact_name: string;
  contact_phone: string;
  email: string;
  phone: string;
  region: 'seoul' | 'jeju';
  is_direct: boolean; // 직영점 여부
  deposit_balance: number;
  created_at: string;
}

export type DepositRequestStatus = 'pending' | 'approved' | 'rejected';

export interface DepositRequest {
  id: string;
  store_id: string;
  amount: number;
  status: DepositRequestStatus;
  description: string | null;
  created_by: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  stores?: { name: string; short_name: string | null };
  profiles?: { name: string };
}

export interface MenuItem {
  label: string;
  href: string;
  roles: UserRole[];
  storeReadOnly?: boolean; // 가맹점은 조회만
}
