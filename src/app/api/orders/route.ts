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

  // 재고 확인 (박스/낱팩 단위 별도)
  const productIds = items.map((item: { product_id: string }) => item.product_id);
  const { data: inventoryData } = await adminSupabase
    .from('inventory')
    .select('product_id, quantity, loose_pack_qty, products(name, pack_per_box)')
    .in('product_id', productIds);

  type OrderItemInput = {
    product_id: string;
    product_name: string;
    product_type: string;
    quantity: number;
    unit?: 'box' | 'pack';
    pack_per_box?: number;
  };

  for (const item of items as OrderItemInput[]) {
    const unit = item.unit || 'box';
    const inv = inventoryData?.find((i: { product_id: string }) => i.product_id === item.product_id) as
      | { quantity: number; loose_pack_qty: number; products: { pack_per_box: number } | null }
      | undefined;

    if (!inv) {
      if (item.product_type === 'exclusive') {
        return NextResponse.json({
          error: `${item.product_name} 재고가 등록되지 않았습니다. 관리자에게 문의하세요.`,
        }, { status: 400 });
      }
      continue; // 범용상품은 재고 레코드 없어도 통과 (기존 동작)
    }

    if (unit === 'box') {
      if (inv.quantity < item.quantity) {
        return NextResponse.json({
          error: `${item.product_name} 재고가 부족합니다. (현재: ${inv.quantity}박스, 주문: ${item.quantity}박스)`,
        }, { status: 400 });
      }
    } else {
      // 팩 주문: 낱팩 + 박스를 깨서 충당 가능한지 확인
      const ppb = item.pack_per_box || inv.products?.pack_per_box || 1;
      const availablePacks = inv.loose_pack_qty + inv.quantity * ppb;
      if (availablePacks < item.quantity) {
        return NextResponse.json({
          error: `${item.product_name} 낱팩 재고가 부족합니다. (가용: ${availablePacks}팩, 주문: ${item.quantity}팩)`,
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

  // 주문 상세 생성 (unit / pack_per_box 스냅샷 포함)
  const orderItems = (items as Array<{
    product_id: string;
    product_name: string;
    product_type: string;
    quantity: number;
    unit_price: number;
    unit_price_with_tax: number;
    is_tax_free: boolean;
    unit?: 'box' | 'pack';
    pack_per_box?: number;
  }>).map((item) => {
    const inv = inventoryData?.find((i: { product_id: string }) => i.product_id === item.product_id) as
      | { products: { pack_per_box: number } | null }
      | undefined;
    const ppb = item.pack_per_box || inv?.products?.pack_per_box || 1;
    return {
      order_id: order.id,
      product_id: item.product_id,
      product_name: item.product_name,
      product_type: item.product_type,
      quantity: item.quantity,
      unit_price: item.unit_price,
      unit_price_with_tax: item.unit_price_with_tax,
      is_tax_free: item.is_tax_free,
      subtotal: item.unit_price_with_tax * item.quantity,
      unit: item.unit || 'box',
      pack_per_box: ppb,
    };
  });

  const { error: itemsError } = await adminSupabase
    .from('order_items')
    .insert(orderItems);

  if (itemsError) {
    return NextResponse.json({ error: itemsError.message }, { status: 400 });
  }

  // 재고 차감
  //  - 박스 주문(unit='box'): 기존 직접 경로 유지 (inventory.quantity -= qty + inventory_transactions insert)
  //  - 팩 주문 (unit='pack'): apply_b2b_inventory_delta RPC 재사용 (낱팩 먼저, 부족분은 박스 깨서 충당)
  //  - 팩 RPC 실패 시 앞서 차감한 박스/팩을 모두 복구
  const appliedBox: Array<{ product_id: string; quantity: number }> = [];
  const appliedPack: Array<{ product_id: string; quantity: number }> = [];

  const rollbackAll = async () => {
    for (const a of appliedBox) {
      const { data: cur } = await adminSupabase
        .from('inventory').select('quantity').eq('product_id', a.product_id).single();
      if (cur) {
        await adminSupabase.from('inventory')
          .update({ quantity: cur.quantity + a.quantity })
          .eq('product_id', a.product_id);
        await adminSupabase.from('inventory_transactions').insert({
          product_id: a.product_id, type: 'inbound', quantity: a.quantity,
          description: `발주 실패 롤백 (${orderNumber})`, created_by: user.id,
        });
      }
    }
    for (const a of appliedPack) {
      await adminSupabase.rpc('apply_b2b_inventory_delta', {
        p_product_id: a.product_id, p_unit: 'pack', p_delta: -a.quantity,
        p_description: `발주 실패 롤백 (${orderNumber})`, p_actor: user.id,
      });
    }
  };

  if (inventoryData && inventoryData.length > 0) {
    for (const item of items as Array<{
      product_id: string;
      product_name: string;
      quantity: number;
      unit?: 'box' | 'pack';
    }>) {
      const unit: 'box' | 'pack' = item.unit || 'box';
      const inv = inventoryData.find((i: { product_id: string }) => i.product_id === item.product_id);
      if (!inv) continue;

      if (unit === 'box') {
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
        appliedBox.push({ product_id: item.product_id, quantity: item.quantity });
      } else {
        const { error: rpcError } = await adminSupabase.rpc('apply_b2b_inventory_delta', {
          p_product_id: item.product_id,
          p_unit: 'pack',
          p_delta: item.quantity,
          p_description: `발주 출고 (${orderNumber}) - ${store.short_name || store.name} · 낱팩`,
          p_actor: user.id,
        });
        if (rpcError) {
          await rollbackAll();
          await adminSupabase.from('orders').delete().eq('id', order.id);
          return NextResponse.json({ error: `낱팩 차감 실패: ${rpcError.message}` }, { status: 400 });
        }
        appliedPack.push({ product_id: item.product_id, quantity: item.quantity });
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
