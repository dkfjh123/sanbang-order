import { createClient } from '@supabase/supabase-js';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { isPastDeadlineForShipDate } from '@/lib/delivery-schedule';

type Unit = 'box' | 'pack';

type IncomingItem = {
  product_id?: unknown;
  quantity?: unknown;
  unit?: unknown;
};

type ProductRow = {
  id: string;
  name: string;
  product_type: 'exclusive' | 'general';
  price: number;
  price_with_tax: number;
  is_tax_free: boolean;
  pack_per_box: number;
  is_loose_pack_sellable: boolean;
  is_active: boolean;
};

type ExistingOrderItem = {
  product_id: string;
  product_name: string;
  product_type: 'exclusive' | 'general';
  unit_price: number;
  unit_price_with_tax: number;
  is_tax_free: boolean;
  unit: Unit | null;
  pack_per_box: number | null;
};

type AtomicOrderItem = {
  product_id: string;
  product_name: string;
  product_type: 'exclusive' | 'general';
  quantity: number;
  unit_price: number;
  unit_price_with_tax: number;
  is_tax_free: boolean;
  unit: Unit;
  pack_per_box: number;
};

const itemKey = (productId: string, unit: Unit) => `${productId}|${unit}`;

function normalizeUnit(unit: unknown): Unit {
  return unit === 'pack' ? 'pack' : 'box';
}

// 주문 수정 (항목 추가/삭제/수량 변경)
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const serverSupabase = await createServerClient();
  const { data: { user } } = await serverSupabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: '인증이 필요합니다.' }, { status: 401 });
  }

  const adminSupabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // 주문 조회 — store 전체 (delivery_days, override 포함)
  const { data: order } = await adminSupabase
    .from('orders')
    .select('*, stores(region, delivery_days, deadline_override_until)')
    .eq('id', id)
    .single();

  if (!order) {
    return NextResponse.json({ error: '주문을 찾을 수 없습니다.' }, { status: 404 });
  }

  // 권한 확인
  const { data: profile } = await adminSupabase
    .from('profiles')
    .select('role, store_id')
    .eq('id', user.id)
    .single();

  if (!profile) {
    return NextResponse.json({ error: '수정 권한이 없습니다.' }, { status: 403 });
  }

  const isAdmin = profile?.role === 'admin';
  const isStore = profile?.role === 'store';

  if (isStore && profile?.store_id !== order.store_id) {
    return NextResponse.json({ error: '다른 가맹점 주문은 수정할 수 없습니다.' }, { status: 403 });
  }

  // 상태별 수정 허용: pending은 모두, confirmed는 admin만, 그 외는 금지
  if (order.status === 'pending') {
    // 통과
  } else if (order.status === 'confirmed') {
    if (!isAdmin) {
      return NextResponse.json({ error: '확정된 주문은 관리자만 수정할 수 있습니다.' }, { status: 400 });
    }
  } else {
    return NextResponse.json({ error: '출고 또는 취소된 주문은 수정할 수 없습니다.' }, { status: 400 });
  }

  // 신화푸드: 수정 불가
  if (profile?.role === 'shinwa') {
    return NextResponse.json({ error: '수정 권한이 없습니다.' }, { status: 403 });
  }

  // 가맹점: 마감 후 수정 불가 (override 활성이면 허용)
  if (isStore && order.stores) {
    const s = order.stores as {
      region: 'seoul' | 'jeju';
      delivery_days: number[] | null;
      deadline_override_until: string | null;
    };
    if (isPastDeadlineForShipDate(s, order.ship_date)) {
      return NextResponse.json({ error: '발주 마감 후에는 수정할 수 없습니다. 관리자에게 문의하세요.' }, { status: 400 });
    }
  }

  const body = await request.json();
  const { items } = body;

  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ error: '상품을 선택해주세요.' }, { status: 400 });
  }

  // 가맹점 정보
  const { data: store } = await adminSupabase
    .from('stores')
    .select('*')
    .eq('id', order.store_id)
    .single();

  if (!store) {
    return NextResponse.json({ error: '가맹점을 찾을 수 없습니다.' }, { status: 400 });
  }

  const normalized = new Map<string, { product_id: string; unit: Unit; quantity: number }>();
  for (const raw of items as IncomingItem[]) {
    if (typeof raw.product_id !== 'string' || !raw.product_id) {
      return NextResponse.json({ error: '상품 정보가 올바르지 않습니다.' }, { status: 400 });
    }
    const quantity = Number(raw.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return NextResponse.json({ error: '상품 수량은 1개 이상이어야 합니다.' }, { status: 400 });
    }
    const unit = normalizeUnit(raw.unit);
    const key = itemKey(raw.product_id, unit);
    const existing = normalized.get(key);
    normalized.set(key, {
      product_id: raw.product_id,
      unit,
      quantity: (existing?.quantity || 0) + quantity,
    });
  }

  // 기존 주문에 있던 상품은 당시 단가/상품명 스냅샷을 유지한다.
  const { data: oldItems, error: oldItemsError } = await adminSupabase
    .from('order_items')
    .select('product_id, product_name, product_type, unit_price, unit_price_with_tax, is_tax_free, unit, pack_per_box')
    .eq('order_id', id);

  if (oldItemsError) {
    return NextResponse.json({ error: oldItemsError.message }, { status: 400 });
  }

  const oldByKey = new Map<string, ExistingOrderItem>();
  for (const item of (oldItems || []) as ExistingOrderItem[]) {
    if (!item.product_id) continue;
    oldByKey.set(itemKey(item.product_id, item.unit || 'box'), item);
  }

  const productIds = [...new Set([...normalized.values()].map((item) => item.product_id))];
  const { data: products, error: productsError } = await adminSupabase
    .from('products')
    .select('id, name, product_type, price, price_with_tax, is_tax_free, pack_per_box, is_loose_pack_sellable, is_active')
    .in('id', productIds);

  if (productsError) {
    return NextResponse.json({ error: productsError.message }, { status: 400 });
  }

  const productById = new Map((products || []).map((product) => [product.id, product as ProductRow]));

  // 매장별 주문 가능 상품 화이트리스트 검증. 목록이 비어 있으면 전체 허용.
  const { data: allowedRows } = await adminSupabase
    .from('store_allowed_products')
    .select('product_id')
    .eq('store_id', order.store_id);
  const allowedSet =
    allowedRows && allowedRows.length > 0
      ? new Set(allowedRows.map((row: { product_id: string }) => row.product_id))
      : null;

  const atomicItems: AtomicOrderItem[] = [];
  for (const item of normalized.values()) {
    if (allowedSet && !allowedSet.has(item.product_id)) {
      const productName = productById.get(item.product_id)?.name || '선택한 상품';
      return NextResponse.json({
        error: `${productName}은(는) 이 매장에서 주문 가능한 상품이 아닙니다.`,
      }, { status: 400 });
    }

    const old = oldByKey.get(itemKey(item.product_id, item.unit));
    if (old) {
      atomicItems.push({
        product_id: old.product_id,
        product_name: old.product_name,
        product_type: old.product_type,
        quantity: item.quantity,
        unit_price: old.unit_price,
        unit_price_with_tax: old.unit_price_with_tax,
        is_tax_free: old.is_tax_free,
        unit: old.unit || 'box',
        pack_per_box: old.pack_per_box || 1,
      });
      continue;
    }

    const product = productById.get(item.product_id);
    if (!product || !product.is_active) {
      return NextResponse.json({ error: '판매 중인 상품만 추가할 수 있습니다.' }, { status: 400 });
    }
    if (item.unit === 'pack' && !product.is_loose_pack_sellable) {
      return NextResponse.json({ error: `${product.name}은(는) 낱팩 주문이 불가능한 상품입니다.` }, { status: 400 });
    }

    const packPerBox = product.pack_per_box || 1;
    atomicItems.push({
      product_id: product.id,
      product_name: item.unit === 'pack' ? `${product.name} (낱팩)` : product.name,
      product_type: product.product_type,
      quantity: item.quantity,
      unit_price: item.unit === 'pack' ? Math.round(product.price / packPerBox) : product.price,
      unit_price_with_tax: item.unit === 'pack'
        ? Math.round(product.price_with_tax / packPerBox)
        : product.price_with_tax,
      is_tax_free: product.is_tax_free,
      unit: item.unit,
      pack_per_box: packPerBox,
    });
  }

  const { data: editResult, error: editError } = await adminSupabase.rpc(
    'update_store_order_items_atomic',
    {
      p_order_id: id,
      p_items: atomicItems,
      p_actor: user.id,
    }
  );

  if (editError) {
    return NextResponse.json({ error: editError.message }, { status: 400 });
  }

  return NextResponse.json({ success: true, result: editResult });
}

// 주문 취소
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const serverSupabase = await createServerClient();
  const { data: { user } } = await serverSupabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: '인증이 필요합니다.' }, { status: 401 });
  }

  const adminSupabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: order } = await adminSupabase
    .from('orders')
    .select('*, stores(region, delivery_days, deadline_override_until)')
    .eq('id', id)
    .single();

  if (!order) {
    return NextResponse.json({ error: '주문을 찾을 수 없습니다.' }, { status: 404 });
  }

  // 권한 확인
  const { data: profile } = await adminSupabase
    .from('profiles')
    .select('role, store_id')
    .eq('id', user.id)
    .single();

  if (!profile) {
    return NextResponse.json({ error: '취소 권한이 없습니다.' }, { status: 403 });
  }

  const isAdmin = profile?.role === 'admin';

  if (profile?.role === 'store' && profile.store_id !== order.store_id) {
    return NextResponse.json({ error: '다른 가맹점 주문은 취소할 수 없습니다.' }, { status: 403 });
  }

  // 상태별 취소 허용: pending은 모두, confirmed는 admin만, 그 외는 금지
  if (order.status === 'pending') {
    // 통과
  } else if (order.status === 'confirmed') {
    if (!isAdmin) {
      return NextResponse.json({ error: '확정된 주문은 관리자만 취소할 수 있습니다.' }, { status: 400 });
    }
  } else {
    return NextResponse.json({ error: '출고 또는 이미 취소된 주문은 취소할 수 없습니다.' }, { status: 400 });
  }

  // 신화푸드: 취소 불가
  if (profile?.role === 'shinwa') {
    return NextResponse.json({ error: '취소 권한이 없습니다.' }, { status: 403 });
  }

  // 가맹점: 마감 후 취소 불가 (override 활성이면 허용)
  if (profile?.role === 'store' && order.stores) {
    const s = order.stores as {
      region: 'seoul' | 'jeju';
      delivery_days: number[] | null;
      deadline_override_until: string | null;
    };
    if (isPastDeadlineForShipDate(s, order.ship_date)) {
      return NextResponse.json({ error: '발주 마감 후에는 취소할 수 없습니다. 관리자에게 문의하세요.' }, { status: 400 });
    }
  }

  // 주문 취소 처리
  await adminSupabase.from('orders').update({ status: 'cancelled' }).eq('id', id);

  // 재고 복구 — 박스는 기존 직접 경로, 팩은 RPC 재사용
  const { data: cancelItems } = await adminSupabase
    .from('order_items')
    .select('product_id, product_name, quantity, unit')
    .eq('order_id', id);

  if (cancelItems) {
    for (const item of cancelItems as Array<{ product_id: string; product_name: string; quantity: number; unit: 'box' | 'pack' | null }>) {
      const unit = item.unit || 'box';
      if (unit === 'box') {
        const { data: inv } = await adminSupabase
          .from('inventory')
          .select('quantity, reserved')
          .eq('product_id', item.product_id)
          .single();

        if (inv) {
          // A안: 발주 취소 = 발주 생성의 거울. quantity 복구 + reserved 차감.
          await adminSupabase
            .from('inventory')
            .update({
              quantity: inv.quantity + item.quantity,
              reserved: Math.max(0, (inv.reserved || 0) - item.quantity),
            })
            .eq('product_id', item.product_id);

          await adminSupabase
            .from('inventory_transactions')
            .insert({
              product_id: item.product_id,
              type: 'inbound',
              quantity: item.quantity,
              description: `발주 취소 복구 (${order.order_number})`,
              created_by: user.id,
            });
        }
      } else {
        // 단순화 옵션: 팩 취소 복구 = loose_pack_qty 복구 + reserved_pack 차감. 박스 승격 안 함.
        const { data: inv } = await adminSupabase
          .from('inventory')
          .select('loose_pack_qty, reserved_pack')
          .eq('product_id', item.product_id)
          .single();
        if (inv) {
          await adminSupabase.from('inventory').update({
            loose_pack_qty: (inv.loose_pack_qty || 0) + item.quantity,
            reserved_pack:  Math.max(0, (inv.reserved_pack || 0) - item.quantity),
          }).eq('product_id', item.product_id);
          await adminSupabase.from('inventory_transactions').insert({
            product_id: item.product_id,
            type: 'inbound',
            quantity: item.quantity,
            unit: 'pack',
            description: `발주 취소 복구 (${order.order_number}) · 낱팩`,
            created_by: user.id,
          });
        }
      }
    }
  }

  // 예치금 환불 (직영점 제외)
  const { data: store } = await adminSupabase
    .from('stores')
    .select('*')
    .eq('id', order.store_id)
    .single();

  if (store && !store.is_direct) {
    const newBalance = store.deposit_balance + order.total_amount;
    await adminSupabase.from('stores').update({ deposit_balance: newBalance }).eq('id', store.id);
    await adminSupabase.from('deposit_transactions').insert({
      store_id: store.id,
      type: 'order_refund',
      amount: order.total_amount,
      balance_after: newBalance,
      description: `발주 취소 환불 (${order.order_number})`,
      order_id: id,
      created_by: user.id,
    });
  }

  return NextResponse.json({ success: true });
}

// PATCH: action='ship' — confirmed → shipped (재고는 발주 시점에 이미 차감, 여기선 상태만 변경)
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const serverSupabase = await createServerClient();
  const { data: { user } } = await serverSupabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: '인증이 필요합니다.' }, { status: 401 });
  }

  const adminSupabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: profile } = await adminSupabase
    .from('profiles')
    .select('role, name')
    .eq('id', user.id)
    .single();

  // shinwa 또는 admin만 출고 처리 가능
  if (profile?.role !== 'shinwa' && profile?.role !== 'admin') {
    return NextResponse.json({ error: '출고 권한이 없습니다.' }, { status: 403 });
  }

  const body = await request.json();
  const action = body.action as 'ship' | undefined;

  if (action !== 'ship') {
    return NextResponse.json({ error: 'action이 올바르지 않습니다.' }, { status: 400 });
  }

  const { data: order } = await adminSupabase
    .from('orders')
    .select('status, order_number')
    .eq('id', id)
    .single();

  if (!order) {
    return NextResponse.json({ error: '주문을 찾을 수 없습니다.' }, { status: 404 });
  }
  if (order.status !== 'confirmed') {
    return NextResponse.json({ error: '확정된 주문만 출고 처리할 수 있습니다.' }, { status: 400 });
  }

  // A안: 출고완료 시점에 reserved/on_hand(또는 reserved_pack/on_hand_pack) 차감.
  //  - quantity / loose_pack_qty 는 발주 시점에 이미 줄였으므로 그대로 둠.
  //  - inventory_transactions 는 발주 시점에 outbound 가 이미 기록됨 → 중복 방지 위해 여기선 추가 안 함.
  const { data: shipItems } = await adminSupabase
    .from('order_items')
    .select('product_id, quantity, unit')
    .eq('order_id', id);

  if (shipItems) {
    for (const it of shipItems as Array<{ product_id: string; quantity: number; unit: 'box' | 'pack' | null }>) {
      const unit = it.unit || 'box';
      if (unit === 'box') {
        const { data: inv } = await adminSupabase
          .from('inventory')
          .select('reserved, on_hand')
          .eq('product_id', it.product_id)
          .single();
        if (inv) {
          await adminSupabase
            .from('inventory')
            .update({
              reserved: Math.max(0, (inv.reserved || 0) - it.quantity),
              on_hand:  Math.max(0, (inv.on_hand  || 0) - it.quantity),
            })
            .eq('product_id', it.product_id);
        }
      } else {
        // 팩 단위 출고완료 — reserved_pack / on_hand_pack 차감
        const { data: inv } = await adminSupabase
          .from('inventory')
          .select('reserved_pack, on_hand_pack')
          .eq('product_id', it.product_id)
          .single();
        if (inv) {
          await adminSupabase
            .from('inventory')
            .update({
              reserved_pack: Math.max(0, (inv.reserved_pack || 0) - it.quantity),
              on_hand_pack:  Math.max(0, (inv.on_hand_pack  || 0) - it.quantity),
            })
            .eq('product_id', it.product_id);
        }
      }
    }
  }

  await adminSupabase.from('orders').update({ status: 'shipped' }).eq('id', id);

  await adminSupabase.from('order_logs').insert({
    order_id: id,
    action: '출고 처리',
    description: null,
    changed_by: user.id,
    changed_by_name: profile?.name,
    changed_by_role: profile?.role,
  });

  return NextResponse.json({ success: true });
}
