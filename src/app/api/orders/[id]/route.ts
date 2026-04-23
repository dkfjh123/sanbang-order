import { createClient } from '@supabase/supabase-js';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { getDeliverySchedule } from '@/lib/delivery-schedule';

// 주문 수정 (수량 변경)
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

  // 주문 조회
  const { data: order } = await adminSupabase
    .from('orders')
    .select('*, stores(region)')
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

  const isAdmin = profile?.role === 'admin';
  const isStore = profile?.role === 'store';

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

  // 가맹점: 마감 후 수정 불가
  if (isStore) {
    const region = order.stores?.region as 'seoul' | 'jeju';
    if (region) {
      const schedule = getDeliverySchedule(region);
      if (schedule.isPastDeadline) {
        return NextResponse.json({ error: '발주 마감 후에는 수정할 수 없습니다. 관리자에게 문의하세요.' }, { status: 400 });
      }
    }
  }

  const body = await request.json();
  const { items } = body;

  if (!items || items.length === 0) {
    return NextResponse.json({ error: '상품을 선택해주세요.' }, { status: 400 });
  }

  // 새 총액 계산
  const newTotal = items.reduce(
    (sum: number, item: { unit_price_with_tax: number; quantity: number }) =>
      sum + item.unit_price_with_tax * item.quantity,
    0
  );

  // 가맹점 정보
  const { data: store } = await adminSupabase
    .from('stores')
    .select('*')
    .eq('id', order.store_id)
    .single();

  if (!store) {
    return NextResponse.json({ error: '가맹점을 찾을 수 없습니다.' }, { status: 400 });
  }

  // 예치금 차이 확인 (직영점 제외)
  const diff = newTotal - order.total_amount;
  if (!store.is_direct && store.deposit_balance < diff) {
    return NextResponse.json({ error: '예치금이 부족합니다.' }, { status: 400 });
  }

  // 기존 항목 조회 (재고 조정용) — unit/pack_per_box 포함
  const { data: oldItems } = await adminSupabase
    .from('order_items')
    .select('product_id, quantity, unit, pack_per_box')
    .eq('order_id', id);

  // 기존 항목 삭제 후 새로 삽입 (unit/pack_per_box 스냅샷 유지)
  await adminSupabase.from('order_items').delete().eq('order_id', id);

  type EditItemInput = {
    product_id: string;
    product_name: string;
    product_type: string;
    quantity: number;
    unit_price: number;
    unit_price_with_tax: number;
    is_tax_free: boolean;
    unit?: 'box' | 'pack';
    pack_per_box?: number;
  };

  const orderItems = (items as EditItemInput[]).map((item) => ({
    order_id: id,
    product_id: item.product_id,
    product_name: item.product_name,
    product_type: item.product_type,
    quantity: item.quantity,
    unit_price: item.unit_price,
    unit_price_with_tax: item.unit_price_with_tax,
    is_tax_free: item.is_tax_free,
    subtotal: item.unit_price_with_tax * item.quantity,
    unit: item.unit || 'box',
    pack_per_box: item.pack_per_box || 1,
  }));

  await adminSupabase.from('order_items').insert(orderItems);

  // 주문 총액 업데이트
  await adminSupabase.from('orders').update({ total_amount: newTotal }).eq('id', id);

  // 재고 조정: (product_id, unit) 키로 묶어서 delta 계산
  //  - 박스 delta: 기존 직접 경로 유지
  //  - 팩 delta: apply_b2b_inventory_delta RPC 재사용
  if (oldItems) {
    const oldQtyMap: Record<string, number> = {};
    for (const oi of oldItems as Array<{ product_id: string; quantity: number; unit: 'box' | 'pack' | null }>) {
      const key = `${oi.product_id}|${oi.unit || 'box'}`;
      oldQtyMap[key] = (oldQtyMap[key] || 0) + oi.quantity;
    }
    const newQtyMap: Record<string, number> = {};
    for (const ni of items as EditItemInput[]) {
      const key = `${ni.product_id}|${ni.unit || 'box'}`;
      newQtyMap[key] = (newQtyMap[key] || 0) + ni.quantity;
    }

    const allKeys = [...new Set([...Object.keys(oldQtyMap), ...Object.keys(newQtyMap)])];

    for (const key of allKeys) {
      const [productId, unit] = key.split('|') as [string, 'box' | 'pack'];
      const oldQty = oldQtyMap[key] || 0;
      const newQty = newQtyMap[key] || 0;
      const qtyDiff = newQty - oldQty; // 양수: 추가 차감 필요, 음수: 복구 필요

      if (qtyDiff === 0) continue;

      if (unit === 'box') {
        const { data: inv } = await adminSupabase
          .from('inventory')
          .select('quantity')
          .eq('product_id', productId)
          .single();

        if (inv) {
          const updatedQty = inv.quantity - qtyDiff;
          if (updatedQty < 0) {
            return NextResponse.json({ error: '재고가 부족하여 수량을 변경할 수 없습니다.' }, { status: 400 });
          }
          await adminSupabase
            .from('inventory')
            .update({ quantity: updatedQty })
            .eq('product_id', productId);

          await adminSupabase
            .from('inventory_transactions')
            .insert({
              product_id: productId,
              type: qtyDiff > 0 ? 'outbound' : 'inbound',
              quantity: -qtyDiff,
              description: `발주 수정 (${order.order_number}) - ${qtyDiff > 0 ? '추가 출고' : '수량 감소 복구'}`,
              created_by: user.id,
            });
        }
      } else {
        // 팩 델타: RPC 로 처리. qtyDiff>0 → 양수 델타(추가 차감), qtyDiff<0 → 음수 델타(복구)
        const { error: rpcError } = await adminSupabase.rpc('apply_b2b_inventory_delta', {
          p_product_id: productId,
          p_unit: 'pack',
          p_delta: qtyDiff,
          p_description: `발주 수정 (${order.order_number}) · 낱팩 ${qtyDiff > 0 ? '추가' : '감소'}`,
          p_actor: user.id,
        });
        if (rpcError) {
          return NextResponse.json({ error: `낱팩 재고 조정 실패: ${rpcError.message}` }, { status: 400 });
        }
      }
    }
  }

  // 예치금 차이 반영 (직영점 제외)
  if (!store.is_direct && diff !== 0) {
    const newBalance = store.deposit_balance - diff;
    await adminSupabase.from('stores').update({ deposit_balance: newBalance }).eq('id', store.id);
    await adminSupabase.from('deposit_transactions').insert({
      store_id: store.id,
      type: 'adjustment',
      amount: -diff,
      balance_after: newBalance,
      description: `발주 수정 (${order.order_number})`,
      order_id: id,
      created_by: user.id,
    });
  }

  return NextResponse.json({ success: true });
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
    .select('*, stores(region)')
    .eq('id', id)
    .single();

  if (!order) {
    return NextResponse.json({ error: '주문을 찾을 수 없습니다.' }, { status: 404 });
  }

  // 권한 확인
  const { data: profile } = await adminSupabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  const isAdmin = profile?.role === 'admin';

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

  // 가맹점: 마감 후 취소 불가
  if (profile?.role === 'store') {
    const region = order.stores?.region as 'seoul' | 'jeju';
    if (region) {
      const schedule = getDeliverySchedule(region);
      if (schedule.isPastDeadline) {
        return NextResponse.json({ error: '발주 마감 후에는 취소할 수 없습니다. 관리자에게 문의하세요.' }, { status: 400 });
      }
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
          .select('quantity')
          .eq('product_id', item.product_id)
          .single();

        if (inv) {
          await adminSupabase
            .from('inventory')
            .update({ quantity: inv.quantity + item.quantity })
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
        // 낱팩 주문: RPC 음수 델타로 복구 (낱팩 누적 → 박스 승격)
        await adminSupabase.rpc('apply_b2b_inventory_delta', {
          p_product_id: item.product_id,
          p_unit: 'pack',
          p_delta: -item.quantity,
          p_description: `발주 취소 복구 (${order.order_number}) · 낱팩`,
          p_actor: user.id,
        });
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
