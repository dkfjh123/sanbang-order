import { createClient } from '@supabase/supabase-js';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { getStoreDeliverySchedule, toLocalISODate } from '@/lib/delivery-schedule';

const DEFAULT_MIN_ORDER_AMOUNT = 150000;

type OrderItemInput = {
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
  const { store_id, items, memo, ship_date } = body as {
    store_id: string;
    items: OrderItemInput[];
    memo?: string;
    ship_date?: string | null; // 동일옥 전용: 점주가 선택한 이 주문의 배송일
  };

  if (!store_id || !items || items.length === 0) {
    return NextResponse.json({ error: '발주 항목을 선택해주세요.' }, { status: 400 });
  }

  if (profile.role === 'shinwa') {
    return NextResponse.json({ error: '발주 권한이 없습니다.' }, { status: 403 });
  }

  if (profile.role === 'store' && profile.store_id !== store_id) {
    return NextResponse.json({ error: '다른 가맹점으로 발주할 수 없습니다.' }, { status: 403 });
  }

  const adminSupabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: store } = await adminSupabase
    .from('stores')
    .select('*')
    .eq('id', store_id)
    .single();

  if (!store) {
    return NextResponse.json({ error: '가맹점을 찾을 수 없습니다.' }, { status: 400 });
  }

  // 매장별 주문 가능 상품 화이트리스트 검증
  // - 행 없음: 전체 상품 발주 가능 (기존 매장)
  // - 행 있음: 그 상품만 발주 가능 (동래정 등 제한 매장)
  const { data: allowedRows } = await adminSupabase
    .from('store_allowed_products')
    .select('product_id')
    .eq('store_id', store_id);
  if (allowedRows && allowedRows.length > 0) {
    const allowedSet = new Set(allowedRows.map((r: { product_id: string }) => r.product_id));
    const disallowed = items.find((it) => !allowedSet.has(it.product_id));
    if (disallowed) {
      return NextResponse.json({
        error: `${disallowed.product_name}은(는) 이 매장에서 주문 가능한 상품이 아닙니다.`,
      }, { status: 400 });
    }
  }

  // 총액 계산
  const totalAmount = items.reduce(
    (sum, item) => sum + item.unit_price_with_tax * item.quantity,
    0
  );

  // 최소발주금액 (주문 총액 기준 — 매장별 설정, 동일옥도 동일하게 적용)
  const minOrderAmount = store.min_order_amount ?? DEFAULT_MIN_ORDER_AMOUNT;
  if (totalAmount < minOrderAmount) {
    return NextResponse.json({
      error: `최소발주금액은 ₩${minOrderAmount.toLocaleString()}입니다.`,
    }, { status: 400 });
  }

  // 예치금 확인 (직영점은 예외)
  if (!store.is_direct && store.deposit_balance < totalAmount) {
    return NextResponse.json({
      error: `예치금이 부족합니다. 잔액: ₩${store.deposit_balance.toLocaleString()}, 필요: ₩${totalAmount.toLocaleString()}`,
    }, { status: 400 });
  }

  // 배송일 결정
  //  - 동일옥(allow_split_shipping=true): 점주가 선택한 ship_date 사용 (필수) + 매장 배송요일인지 검증
  //  - 그 외: delivery-schedule 자동 계산
  let shipDateStr: string;
  if (store.allow_split_shipping) {
    if (!ship_date) {
      return NextResponse.json({ error: '배송일을 선택해주세요.' }, { status: 400 });
    }
    const d = new Date(`${ship_date}T00:00:00`);
    if (Number.isNaN(d.getTime())) {
      return NextResponse.json({ error: '배송일 형식이 올바르지 않습니다.' }, { status: 400 });
    }
    const allowedDays = new Set<number>((store.delivery_days as number[] | null) || []);
    if (allowedDays.size === 0) {
      return NextResponse.json({
        error: '매장의 배송요일이 설정되지 않았습니다. 관리자에게 문의하세요.',
      }, { status: 400 });
    }
    if (!allowedDays.has(d.getDay())) {
      return NextResponse.json({
        error: `선택한 배송일 ${ship_date} 은 이 매장의 배송요일이 아닙니다.`,
      }, { status: 400 });
    }
    // 과거 날짜 방지
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (d.getTime() < today.getTime()) {
      return NextResponse.json({
        error: '배송일은 오늘 이후로 선택해 주세요.',
      }, { status: 400 });
    }
    shipDateStr = ship_date;
  } else {
    const schedule = getStoreDeliverySchedule({
      region: store.region,
      delivery_days: store.delivery_days,
      deadline_override_until: store.deadline_override_until,
    });
    shipDateStr = toLocalISODate(schedule.shipDate);
  }

  // 재고 확인 (박스/낱팩 단위 별도)
  const productIds = items.map((item) => item.product_id);
  const { data: inventoryData } = await adminSupabase
    .from('inventory')
    .select('product_id, quantity, loose_pack_qty, reserved, reserved_pack, products(name, pack_per_box)')
    .in('product_id', productIds);

  for (const item of items) {
    const unit = item.unit || 'box';
    const inv = inventoryData?.find((i: { product_id: string }) => i.product_id === item.product_id) as
      | { quantity: number; loose_pack_qty: number; reserved: number; reserved_pack: number; products: { pack_per_box: number } | null }
      | undefined;

    if (!inv) {
      if (item.product_type === 'exclusive') {
        return NextResponse.json({
          error: `${item.product_name} 재고가 등록되지 않았습니다. 관리자에게 문의하세요.`,
        }, { status: 400 });
      }
      continue;
    }

    if (unit === 'box') {
      if (inv.quantity < item.quantity) {
        return NextResponse.json({
          error: `${item.product_name} 재고가 부족합니다. (현재: ${inv.quantity}박스, 주문: ${item.quantity}박스)`,
        }, { status: 400 });
      }
    } else {
      // 단순화 옵션: 가맹점은 자투리(loose_pack_qty) 한도 내에서만 팩 발주.
      //               박스 분해는 B2B 팩 SHIP 시점에만 발생.
      if (inv.loose_pack_qty < item.quantity) {
        return NextResponse.json({
          error: `${item.product_name} 낱팩 재고가 부족합니다. (현재 자투리: ${inv.loose_pack_qty}팩, 주문: ${item.quantity}팩). 박스 단위로 주문하시거나 자투리 재고가 생긴 후 다시 시도해주세요.`,
        }, { status: 400 });
      }
    }
  }

  // 주문번호 생성 — 한국 시각 기준
  const dateStr = toLocalISODate(new Date()).replace(/-/g, '');
  const { data: seqData } = await adminSupabase.rpc('nextval', { seq_name: 'order_number_seq' }).single();
  const seq = seqData || Math.floor(Math.random() * 9999);
  const orderNumber = `ORD-${dateStr}-${String(seq).padStart(4, '0')}`;

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

  // 주문 상세 생성 — 모든 아이템의 ship_date는 주문 전체와 동일
  const orderItems = items.map((item) => {
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
      ship_date: shipDateStr,
    };
  });

  const { error: itemsError } = await adminSupabase
    .from('order_items')
    .insert(orderItems);

  if (itemsError) {
    return NextResponse.json({ error: itemsError.message }, { status: 400 });
  }

  // 재고 차감 — 공용 원자 RPC(apply_inventory_delta) 사용.
  // FOR UPDATE 행잠금으로 동시 요청의 lost update(덮어쓰기)를 원천 차단하고,
  // 음수 가드도 RPC 안에서 원자적으로 처리한다(재고 부족 시 RPC 가 에러 반환).
  const applied: Array<{ product_id: string; unit: 'box' | 'pack'; quantity: number }> = [];

  const rollbackAll = async () => {
    for (const a of applied) {
      if (a.unit === 'box') {
        // 박스 발주의 거울: quantity 복구 + reserved 차감
        await adminSupabase.rpc('apply_inventory_delta', {
          p_product_id: a.product_id,
          p_d_quantity: a.quantity,
          p_d_reserved: -a.quantity,
          p_tx_type: 'inbound',
          p_tx_quantity: a.quantity,
          p_tx_unit: 'box',
          p_tx_description: `발주 실패 롤백 (${orderNumber})`,
          p_actor: user.id,
        });
      } else {
        // 단순화 옵션: 팩 발주의 거울 = loose 복구 + reserved_pack 차감
        await adminSupabase.rpc('apply_inventory_delta', {
          p_product_id: a.product_id,
          p_d_loose_pack: a.quantity,
          p_d_reserved_pack: -a.quantity,
          p_tx_type: 'inbound',
          p_tx_quantity: a.quantity,
          p_tx_unit: 'pack',
          p_tx_description: `발주 실패 롤백 (${orderNumber}) · 낱팩`,
          p_actor: user.id,
        });
      }
    }
  };

  if (inventoryData && inventoryData.length > 0) {
    for (const item of items) {
      const unit: 'box' | 'pack' = item.unit || 'box';
      const inv = inventoryData.find((i: { product_id: string }) => i.product_id === item.product_id);
      if (!inv) continue;

      // A안: 박스 발주 = 매장주문가능(quantity)↓ + 나갈것들(reserved)↑, on_hand 불변.
      // 단순화 옵션: 팩 발주 = 자투리(loose_pack_qty)↓ + reserved_pack↑, 박스 분해 안 함.
      const { error: rpcErr } = unit === 'box'
        ? await adminSupabase.rpc('apply_inventory_delta', {
            p_product_id: item.product_id,
            p_d_quantity: -item.quantity,
            p_d_reserved: item.quantity,
            p_tx_type: 'outbound',
            p_tx_quantity: -item.quantity,
            p_tx_unit: 'box',
            p_tx_description: `발주 출고 (${orderNumber}) - ${store.short_name || store.name}`,
            p_actor: user.id,
          })
        : await adminSupabase.rpc('apply_inventory_delta', {
            p_product_id: item.product_id,
            p_d_loose_pack: -item.quantity,
            p_d_reserved_pack: item.quantity,
            p_tx_type: 'outbound',
            p_tx_quantity: -item.quantity,
            p_tx_unit: 'pack',
            p_tx_description: `발주 출고 (${orderNumber}) - ${store.short_name || store.name} · 낱팩`,
            p_actor: user.id,
          });

      if (rpcErr) {
        await rollbackAll();
        await adminSupabase.from('orders').delete().eq('id', order.id);
        return NextResponse.json({
          error: unit === 'box'
            ? `${item.product_name} 재고 차감 실패: ${rpcErr.message}`
            : `${item.product_name} 낱팩 차감 실패: ${rpcErr.message}`,
        }, { status: 400 });
      }
      applied.push({ product_id: item.product_id, unit, quantity: item.quantity });
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
