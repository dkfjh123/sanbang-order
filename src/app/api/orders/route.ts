import { createClient } from '@supabase/supabase-js';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { getDeliverySchedule } from '@/lib/delivery-schedule';

export async function POST(request: Request) {
  const serverSupabase = await createServerClient();
  const { data: { user } } = await serverSupabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: '인증이 필요합니다.' }, { status: 401 });
  }

  const { data: profile } = await serverSupabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  if (!profile) {
    return NextResponse.json({ error: '프로필을 찾을 수 없습니다.' }, { status: 400 });
  }

  const body = await request.json();
  const { store_id, items, memo } = body;

  if (!store_id || !items || items.length === 0) {
    return NextResponse.json({ error: '발주 항목을 선택해주세요.' }, { status: 400 });
  }

  // Service Role로 처리 (RLS 우회)
  const adminSupabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // 가맹점 정보 조회
  const { data: store } = await adminSupabase
    .from('stores')
    .select('*')
    .eq('id', store_id)
    .single();

  if (!store) {
    return NextResponse.json({ error: '가맹점을 찾을 수 없습니다.' }, { status: 400 });
  }

  // 총액 계산
  const totalAmount = items.reduce(
    (sum: number, item: { unit_price_with_tax: number; quantity: number }) =>
      sum + item.unit_price_with_tax * item.quantity,
    0
  );

  // 최소발주금액 확인
  const MIN_ORDER_AMOUNT = 150000;
  if (totalAmount < MIN_ORDER_AMOUNT) {
    return NextResponse.json({
      error: `최소발주금액은 ₩${MIN_ORDER_AMOUNT.toLocaleString()}입니다.`,
    }, { status: 400 });
  }

  // 예치금 확인 (직영점은 예외)
  if (!store.is_direct && store.deposit_balance < totalAmount) {
    return NextResponse.json({
      error: `예치금이 부족합니다. 잔액: ₩${store.deposit_balance.toLocaleString()}, 필요: ₩${totalAmount.toLocaleString()}`,
    }, { status: 400 });
  }

  // 재고 확인 (inventory에 등록된 상품만)
  const productIds = items.map((item: { product_id: string }) => item.product_id);
  const { data: inventoryData } = await adminSupabase
    .from('inventory')
    .select('product_id, quantity, products(name)')
    .in('product_id', productIds);

  if (inventoryData && inventoryData.length > 0) {
    for (const item of items as { product_id: string; product_name: string; quantity: number }[]) {
      const inv = inventoryData.find((i: { product_id: string }) => i.product_id === item.product_id);
      if (inv && inv.quantity < item.quantity) {
        return NextResponse.json({
          error: `${item.product_name} 재고가 부족합니다. (현재: ${inv.quantity}개, 주문: ${item.quantity}개)`,
        }, { status: 400 });
      }
    }
  }

  // 주문번호 생성
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const { data: seqData } = await adminSupabase.rpc('nextval', { seq_name: 'order_number_seq' }).single();
  const seq = seqData || Math.floor(Math.random() * 9999);
  const orderNumber = `ORD-${dateStr}-${String(seq).padStart(4, '0')}`;

  // 출고일 자동 계산
  const region = store.region as 'seoul' | 'jeju';
  const schedule = getDeliverySchedule(region);
  const shipDateStr = schedule.shipDate.toISOString().slice(0, 10);

  // 주문 생성
  const { data: order, error: orderError } = await adminSupabase
    .from('orders')
    .insert({
      order_number: orderNumber,
      store_id,
      ordered_by: user.id,
      status: 'pending',
      total_amount: totalAmount,
      memo: memo || null,
      ship_date: shipDateStr,
    })
    .select()
    .single();

  if (orderError) {
    return NextResponse.json({ error: orderError.message }, { status: 400 });
  }

  // 주문 상세 생성
  const orderItems = items.map((item: {
    product_id: string;
    product_name: string;
    product_type: string;
    quantity: number;
    unit_price: number;
    unit_price_with_tax: number;
    is_tax_free: boolean;
  }) => ({
    order_id: order.id,
    product_id: item.product_id,
    product_name: item.product_name,
    product_type: item.product_type,
    quantity: item.quantity,
    unit_price: item.unit_price,
    unit_price_with_tax: item.unit_price_with_tax,
    is_tax_free: item.is_tax_free,
    subtotal: item.unit_price_with_tax * item.quantity,
  }));

  const { error: itemsError } = await adminSupabase
    .from('order_items')
    .insert(orderItems);

  if (itemsError) {
    return NextResponse.json({ error: itemsError.message }, { status: 400 });
  }

  // 재고 차감 (inventory에 등록된 상품만)
  if (inventoryData && inventoryData.length > 0) {
    for (const item of items as { product_id: string; product_name: string; quantity: number }[]) {
      const inv = inventoryData.find((i: { product_id: string }) => i.product_id === item.product_id);
      if (inv) {
        const newQty = inv.quantity - item.quantity;
        await adminSupabase
          .from('inventory')
          .update({ quantity: newQty })
          .eq('product_id', item.product_id);

        await adminSupabase
          .from('inventory_transactions')
          .insert({
            product_id: item.product_id,
            type: 'outbound',
            quantity: -item.quantity,
            description: `발주 출고 (${orderNumber}) - ${store.short_name || store.name}`,
            created_by: user.id,
          });
      }
    }
  }

  // 예치금 차감 (직영점은 건너뜀)
  if (!store.is_direct) {
    const newBalance = store.deposit_balance - totalAmount;

    await adminSupabase
      .from('stores')
      .update({ deposit_balance: newBalance })
      .eq('id', store_id);

    await adminSupabase
      .from('deposit_transactions')
      .insert({
        store_id,
        type: 'order_deduct',
        amount: -totalAmount,
        balance_after: newBalance,
        description: `발주 차감 (${orderNumber})`,
        order_id: order.id,
        created_by: user.id,
      });
  }

  return NextResponse.json({ success: true, order_number: orderNumber, order_id: order.id });
}
