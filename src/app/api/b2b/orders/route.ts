import { createClient } from '@supabase/supabase-js';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

type B2bUnit = 'box' | 'pack';

type IncomingItem = {
  product_id: string;
  product_name: string;
  unit: B2bUnit;
  quantity: number;
};

type PriceRow = {
  product_id: string;
  b2b_price: number;
  b2b_price_with_tax: number;
  available_units: B2bUnit[];
};

type ProductRow = {
  id: string;
  name: string;
  product_type: 'exclusive' | 'general';
  pack_per_box: number;
  is_tax_free: boolean;
};

type NormalizedItem = {
  product_id: string;
  product_name: string;
  unit: B2bUnit;
  quantity: number;
  pack_per_box: number;
  unit_price: number;
  unit_price_with_tax: number;
  is_tax_free: boolean;
  subtotal: number;
  subtotal_ex_tax: number;
};

export async function POST(request: Request) {
  const serverSupabase = await createServerClient();
  const { data: { user } } = await serverSupabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: '인증이 필요합니다.' }, { status: 401 });
  }

  const adminSupabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
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

  const productIds = Array.from(new Set(items.map((item) => item.product_id)));
  const [{ data: priceRows, error: priceError }, { data: productRows, error: productError }] = await Promise.all([
    adminSupabase
      .from('b2b_customer_product_prices')
      .select('product_id, b2b_price, b2b_price_with_tax, available_units')
      .eq('customer_id', b2b_customer_id)
      .eq('is_active', true)
      .in('product_id', productIds),
    adminSupabase
      .from('products')
      .select('id, name, product_type, pack_per_box, is_tax_free')
      .in('id', productIds),
  ]);

  if (priceError) {
    return NextResponse.json({ error: priceError.message }, { status: 400 });
  }
  if (productError) {
    return NextResponse.json({ error: productError.message }, { status: 400 });
  }

  const priceMap = new Map(((priceRows as PriceRow[]) || []).map((price) => [price.product_id, price]));
  const productMap = new Map(((productRows as ProductRow[]) || []).map((product) => [product.id, product]));
  const normalizedItems: NormalizedItem[] = [];

  for (const item of items) {
    const product = productMap.get(item.product_id);
    const price = priceMap.get(item.product_id);

    if (!product) {
      return NextResponse.json({ error: `${item.product_name}: 상품 정보를 찾을 수 없습니다.` }, { status: 400 });
    }
    if (!price) {
      return NextResponse.json({ error: `${product.name}: 이 거래처의 B2B 단가표에 없는 상품입니다.` }, { status: 400 });
    }
    if (product.product_type !== 'exclusive') {
      return NextResponse.json({ error: `${product.name}: B2B는 전용상품만 등록할 수 있습니다.` }, { status: 400 });
    }
    if (product.pack_per_box <= 0) {
      return NextResponse.json({ error: `${product.name}: 입수 설정이 올바르지 않습니다.` }, { status: 400 });
    }
    if (!price.available_units.includes(item.unit)) {
      return NextResponse.json({ error: `${product.name}: 이 거래처에는 ${item.unit === 'box' ? '박스' : '팩'} 단위가 열려 있지 않습니다.` }, { status: 400 });
    }
    if (price.b2b_price <= 0 || price.b2b_price_with_tax <= 0) {
      return NextResponse.json({ error: `${product.name}: B2B 단가가 설정되지 않았습니다.` }, { status: 400 });
    }

    const unitPrice = item.unit === 'box'
      ? price.b2b_price
      : Math.round(price.b2b_price / product.pack_per_box);
    const unitPriceWithTax = item.unit === 'box'
      ? price.b2b_price_with_tax
      : Math.round(price.b2b_price_with_tax / product.pack_per_box);

    normalizedItems.push({
      product_id: product.id,
      product_name: product.name,
      unit: item.unit,
      quantity: item.quantity,
      pack_per_box: product.pack_per_box,
      unit_price: unitPrice,
      unit_price_with_tax: unitPriceWithTax,
      is_tax_free: product.is_tax_free,
      subtotal: unitPriceWithTax * item.quantity,
      subtotal_ex_tax: unitPrice * item.quantity,
    });
  }

  const totalAmount = normalizedItems.reduce((sum, item) => sum + item.subtotal, 0);
  const totalAmountExTax = normalizedItems.reduce((sum, item) => sum + item.subtotal_ex_tax, 0);

  const today = (order_date || new Date().toISOString().slice(0, 10)).replace(/-/g, '');
  const { data: seqData } = await adminSupabase.rpc('nextval', { seq_name: 'b2b_order_number_seq' }).single();
  const seq = (seqData as number) || Math.floor(Math.random() * 9999);
  const orderNumber = `B-${today}-${String(seq).padStart(3, '0')}`;

  const { data: order, error: orderError } = await adminSupabase
    .from('b2b_orders')
    .insert({
      order_number: orderNumber,
      b2b_customer_id,
      ordered_by: user.id,
      status: 'pending',
      total_amount: totalAmount,
      total_amount_ex_tax: totalAmountExTax,
      memo: memo || null,
      order_date: order_date || new Date().toISOString().slice(0, 10),
      ship_date: ship_date || null,
    })
    .select()
    .single();

  if (orderError) {
    return NextResponse.json({ error: orderError.message }, { status: 400 });
  }

  const orderItems = normalizedItems.map((item) => ({
    order_id: order.id,
    product_id: item.product_id,
    product_name: item.product_name,
    unit: item.unit,
    quantity: item.quantity,
    pack_per_box: item.pack_per_box,
    unit_price: item.unit_price,
    unit_price_with_tax: item.unit_price_with_tax,
    is_tax_free: item.is_tax_free,
    subtotal: item.subtotal,
    subtotal_ex_tax: item.subtotal_ex_tax,
  }));

  const { error: itemsError } = await adminSupabase
    .from('b2b_order_items')
    .insert(orderItems);

  if (itemsError) {
    await adminSupabase.from('b2b_orders').delete().eq('id', order.id);
    return NextResponse.json({ error: itemsError.message }, { status: 400 });
  }

  // 단순화 옵션: B2B 발주는 박스 환산으로 reserved 잡음.
  //  - box row:  reserved += qty,                 quantity -= qty
  //  - pack row: reserved += CEIL(qty / pack_per_box), quantity -= 같은 값
  //              (자투리는 SHIP 시점에 loose_pack_qty / on_hand_pack 으로 발생)
  // 한 발주 안에 같은 product_id 의 box/pack 이 둘 다 있을 수 있으므로 product 단위로 누적.
  type Delta = { box: number };
  const deltaByProduct = new Map<string, Delta>();
  for (const item of normalizedItems) {
    const boxes = item.unit === 'box'
      ? item.quantity
      : Math.ceil(item.quantity / item.pack_per_box);
    const cur = deltaByProduct.get(item.product_id) || { box: 0 };
    cur.box += boxes;
    deltaByProduct.set(item.product_id, cur);
  }

  // 박스 재고 부족 검증 (단순화 옵션: 박스만 본다)
  if (deltaByProduct.size > 0) {
    const { data: invRows } = await adminSupabase
      .from('inventory')
      .select('product_id, quantity, reserved')
      .in('product_id', [...deltaByProduct.keys()]);
    const invByPid = new Map(
      (invRows || []).map((r: { product_id: string; quantity: number; reserved: number }) => [r.product_id, r])
    );
    for (const [pid, d] of deltaByProduct) {
      const inv = invByPid.get(pid);
      const name = productMap.get(pid)?.name || pid;
      if (!inv || inv.quantity < d.box) {
        await adminSupabase.from('b2b_order_items').delete().eq('order_id', order.id);
        await adminSupabase.from('b2b_orders').delete().eq('id', order.id);
        return NextResponse.json({
          error: `${name}: 박스 재고 부족 (가용 ${inv?.quantity ?? 0}박스, 필요 ${d.box}박스)`,
        }, { status: 400 });
      }
    }
  }

  // inventory 갱신 + outbound 기록 (실패 시 롤백)
  const applied: Array<{ product_id: string; box: number }> = [];
  let inventoryError: string | null = null;
  for (const [pid, d] of deltaByProduct) {
    const { data: inv } = await adminSupabase
      .from('inventory')
      .select('quantity, reserved')
      .eq('product_id', pid)
      .single();
    if (!inv) continue;
    const { error: updErr } = await adminSupabase
      .from('inventory')
      .update({
        quantity: inv.quantity - d.box,
        reserved: (inv.reserved || 0) + d.box,
      })
      .eq('product_id', pid);
    if (updErr) { inventoryError = updErr.message; break; }

    await adminSupabase.from('inventory_transactions').insert({
      product_id: pid,
      type: 'outbound',
      quantity: -d.box,
      unit: 'box',
      description: `B2B 발주 등록 (${orderNumber}) — 박스 환산 ${d.box}박스`,
      created_by: user.id,
    });
    applied.push({ product_id: pid, box: d.box });
  }

  if (inventoryError) {
    for (const a of applied) {
      const { data: cur } = await adminSupabase
        .from('inventory').select('quantity, reserved').eq('product_id', a.product_id).single();
      if (cur) {
        await adminSupabase.from('inventory')
          .update({
            quantity: cur.quantity + a.box,
            reserved: Math.max(0, (cur.reserved || 0) - a.box),
          })
          .eq('product_id', a.product_id);
      }
    }
    await adminSupabase.from('b2b_order_items').delete().eq('order_id', order.id);
    await adminSupabase.from('b2b_orders').delete().eq('id', order.id);
    return NextResponse.json({ error: `재고 갱신 실패: ${inventoryError}` }, { status: 400 });
  }

  await adminSupabase.from('b2b_order_logs').insert({
    order_id: order.id,
    action: 'create',
    description: `${orderItems.length}개 품목 등록 (합계 ₩${totalAmount.toLocaleString()})`,
    changed_by: user.id,
    changed_by_name: profile?.name || null,
    changed_by_role: 'admin',
  });

  return NextResponse.json({ success: true, order_number: orderNumber, order_id: order.id });
}
