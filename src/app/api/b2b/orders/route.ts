import { createClient } from '@supabase/supabase-js';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

type IncomingItem = {
  product_id: string;
  product_name: string;
  unit: 'box' | 'pack';
  quantity: number;
  pack_per_box: number;
  unit_price: number;
  unit_price_with_tax: number;
  is_tax_free: boolean;
};

// B2B 발주 생성 (pending 상태로 등록, 재고는 건드리지 않음)
export async function POST(request: Request) {
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

  if (profile?.role !== 'admin') {
    return NextResponse.json({ error: 'B2B 발주는 관리자만 처리할 수 있습니다.' }, { status: 403 });
  }

  const body = await request.json();
  const { b2b_customer_id, order_date, ship_date, memo, items } = body as {
    b2b_customer_id: string;
    order_date?: string;
    ship_date?: string | null;
    memo?: string | null;
    items: IncomingItem[];
  };

  if (!b2b_customer_id || !items || items.length === 0) {
    return NextResponse.json({ error: '거래처와 발주 항목이 필요합니다.' }, { status: 400 });
  }

  for (const item of items) {
    if (item.quantity <= 0) {
      return NextResponse.json({ error: `${item.product_name}: 수량은 1 이상이어야 합니다.` }, { status: 400 });
    }
    if (item.unit !== 'box' && item.unit !== 'pack') {
      return NextResponse.json({ error: `${item.product_name}: 단위가 올바르지 않습니다.` }, { status: 400 });
    }
  }

  // 합계 계산
  const total_amount = items.reduce((s, i) => s + i.unit_price_with_tax * i.quantity, 0);
  const total_amount_ex_tax = items.reduce((s, i) => s + i.unit_price * i.quantity, 0);

  // 주문번호 채번 (B-YYYYMMDD-NNN)
  const today = (order_date || new Date().toISOString().slice(0, 10)).replace(/-/g, '');
  const { data: seqData } = await adminSupabase.rpc('nextval', { seq_name: 'b2b_order_number_seq' }).single();
  const seq = (seqData as number) || Math.floor(Math.random() * 9999);
  const order_number = `B-${today}-${String(seq).padStart(3, '0')}`;

  // 주문 생성
  const { data: order, error: orderError } = await adminSupabase
    .from('b2b_orders')
    .insert({
      order_number,
      b2b_customer_id,
      ordered_by: user.id,
      status: 'pending',
      total_amount,
      total_amount_ex_tax,
      memo: memo || null,
      order_date: order_date || new Date().toISOString().slice(0, 10),
      ship_date: ship_date || null,
    })
    .select()
    .single();

  if (orderError) {
    return NextResponse.json({ error: orderError.message }, { status: 400 });
  }

  // 주문 상세 생성
  const orderItems = items.map((i) => ({
    order_id: order.id,
    product_id: i.product_id,
    product_name: i.product_name,
    unit: i.unit,
    quantity: i.quantity,
    pack_per_box: i.pack_per_box,
    unit_price: i.unit_price,
    unit_price_with_tax: i.unit_price_with_tax,
    is_tax_free: i.is_tax_free,
    subtotal: i.unit_price_with_tax * i.quantity,
    subtotal_ex_tax: i.unit_price * i.quantity,
  }));

  const { error: itemsError } = await adminSupabase
    .from('b2b_order_items')
    .insert(orderItems);

  if (itemsError) {
    // rollback
    await adminSupabase.from('b2b_orders').delete().eq('id', order.id);
    return NextResponse.json({ error: itemsError.message }, { status: 400 });
  }

  // 로그
  await adminSupabase.from('b2b_order_logs').insert({
    order_id: order.id,
    action: 'create',
    description: `${items.length}개 품목 등록 (합계 ₩${total_amount.toLocaleString()})`,
    changed_by: user.id,
    changed_by_name: profile?.name || null,
    changed_by_role: 'admin',
  });

  return NextResponse.json({ success: true, order_number, order_id: order.id });
}
