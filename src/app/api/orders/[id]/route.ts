import { createClient } from '@supabase/supabase-js';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

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
    .select('*')
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

  const isShinwa = profile?.role === 'shinwa';

  // 신화푸드는 대기+확인 상태에서 수정 가능, 나머지는 대기만
  if (isShinwa) {
    if (order.status !== 'pending' && order.status !== 'confirmed') {
      return NextResponse.json({ error: '대기 또는 확인 상태인 주문만 수정할 수 있습니다.' }, { status: 400 });
    }
  } else {
    if (order.status !== 'pending') {
      return NextResponse.json({ error: '대기 상태인 주문만 수정할 수 있습니다.' }, { status: 400 });
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

  // 기존 항목 삭제 후 새로 삽입
  await adminSupabase.from('order_items').delete().eq('order_id', id);

  const orderItems = items.map((item: {
    product_id: string;
    product_name: string;
    product_type: string;
    quantity: number;
    unit_price: number;
    unit_price_with_tax: number;
    is_tax_free: boolean;
  }) => ({
    order_id: id,
    product_id: item.product_id,
    product_name: item.product_name,
    product_type: item.product_type,
    quantity: item.quantity,
    unit_price: item.unit_price,
    unit_price_with_tax: item.unit_price_with_tax,
    is_tax_free: item.is_tax_free,
    subtotal: item.unit_price_with_tax * item.quantity,
  }));

  await adminSupabase.from('order_items').insert(orderItems);

  // 주문 총액 업데이트
  await adminSupabase.from('orders').update({ total_amount: newTotal }).eq('id', id);

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
    .select('*')
    .eq('id', id)
    .single();

  if (!order) {
    return NextResponse.json({ error: '주문을 찾을 수 없습니다.' }, { status: 404 });
  }

  if (order.status !== 'pending') {
    return NextResponse.json({ error: '대기 상태인 주문만 취소할 수 있습니다.' }, { status: 400 });
  }

  // 주문 취소 처리
  await adminSupabase.from('orders').update({ status: 'cancelled' }).eq('id', id);

  // 재고 복구
  const { data: cancelItems } = await adminSupabase
    .from('order_items')
    .select('product_id, product_name, quantity')
    .eq('order_id', id);

  if (cancelItems) {
    for (const item of cancelItems) {
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
