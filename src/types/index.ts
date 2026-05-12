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
  delivery_days: number[] | null;          // Date.getDay() 기준 배송요일. null=region 기본값
  allow_split_shipping: boolean;           // true면 아이템별 ship_date 분할 주문 가능 (동일옥)
  deadline_override_until: string | null;  // 관리자가 마감 연장한 경우 해당 시각까지 마감 무시
  min_order_amount: number;                // 매장별 최소발주금액. 기본 150,000
  notes: string | null;                    // 출입 비번 등 매장 운영 메모. 관리자·신화푸드 조회
  created_at: string;
}

export interface StoreAllowedProduct {
  store_id: string;
  product_id: string;
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

// B2B (아워홈 등 대기업 거래처) — 가맹점/예치금 시스템과 완전히 분리
export interface B2bCustomer {
  id: string;
  name: string;
  business_number: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  address: string | null;
  memo: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export type B2bOrderStatus = 'pending' | 'confirmed' | 'shipped' | 'cancelled';
export type B2bUnit = 'box' | 'pack';

export interface B2bOrder {
  id: string;
  order_number: string;
  b2b_customer_id: string;
  ordered_by: string;
  status: B2bOrderStatus;
  total_amount: number;          // 세포함 합계
  total_amount_ex_tax: number;   // 세전 합계
  memo: string | null;
  order_date: string;            // YYYY-MM-DD
  ship_date: string | null;
  created_at: string;
  updated_at: string;
  b2b_customers?: { name: string };
  b2b_order_items?: B2bOrderItem[];
}

export interface B2bOrderItem {
  id: string;
  order_id: string;
  product_id: string | null;
  product_name: string;
  unit: B2bUnit;
  quantity: number;
  pack_per_box: number;
  unit_price: number;
  unit_price_with_tax: number;
  is_tax_free: boolean;
  subtotal: number;
  subtotal_ex_tax: number;
  created_at: string;
}

// 상품 (발주에서 사용하는 최소 필드 — B2B용)
export interface B2bProduct {
  id: string;
  name: string;
  product_type: 'exclusive' | 'general';
  pack_per_box: number;
  b2b_price: number;
  b2b_price_with_tax: number;
  available_units: B2bUnit[];
  is_b2b_eligible: boolean;
  is_tax_free: boolean;
}
