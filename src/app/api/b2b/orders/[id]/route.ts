import { createClient } from '@supabase/supabase-js';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// PATCH: action = 'ship' | 'cancel' | 'update'
//  - ship   : pending → shipped, 재고 차감 (apply_b2b_inventory_delta, 양수)
//  - cancel : shipped/pending → cancelled, shipped였다면 재고 복구 (음수)
//  - update : pending 상태에서만 items/memo/ship_date 수정 가능
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

  const role = profile?.role;
  if (role !== 'admin' && role !== 'shinwa') {
    return NextResponse.json({ error: '권한이 없습니다.' }, { status: 403 });
  }

  const body = await request.json();
  const action = body.action as 'ship' | 'cancel' | 'update';

  // shinwa 는 출고 처리(ship)만 가능 — 나머지(cancel/update)는 admin 전용
  if (role === 'shinwa' && action !== 'ship') {
    return NextResponse.json({ error: '신화푸드는 출고 처리만 가능합니다.' }, { status: 403 });
  }

  const { data: order } = await adminSupabase
    .from('b2b_orders')
    .select('*')
    .eq('id', id)
    .single();

  if (!order) {
    return NextResponse.json({ error: '주문을 찾을 수 없습니다.' }, { status: 404 });
  }

  const { data: items } = await adminSupabase
    .from('b2b_order_items')
    .select('*')
    .eq('order_id', id);

  const logActor = {
    changed_by: user.id,
    changed_by_name: profile?.name || null,
    changed_by_role: role,
  };

  // ----------------------------------------------------------
  // ship: pending → shipped (재고 차감)
  // ----------------------------------------------------------
  if (action === 'ship') {
    if (order.status !== 'pending') {
      return NextResponse.json({ error: '대기 상태인 주문만 출고 처리할 수 있습니다.' }, { status: 400 });
    }
    if (!items || items.length === 0) {
      return NextResponse.json({ error: '발주 항목이 없습니다.' }, { status: 400 });
    }

    // 재고 차감 — 하나라도 실패하면 이전 차감분 복구
    // A안: RPC가 quantity/loose_pack_qty 처리 + 추가로 on_hand / on_hand_pack 도 같이 차감
    //      (B2B 는 발주 등록 시점에 inventory를 안 건드리는 기존 흐름 유지. POST 시 reserved 추적은 다음 이터레이션)
    const applied: { product_id: string; unit: string; quantity: number }[] = [];
    for (const it of items) {
      if (!it.product_id) continue;
      const { error } = await adminSupabase.rpc('apply_b2b_inventory_delta', {
        p_product_id: it.product_id,
        p_unit: it.unit,
        p_delta: it.quantity, // 양수 = 출고(차감)
        p_description: `B2B 출고 (${order.order_number})`,
        p_actor: user.id,
      });
      if (error) {
        // rollback 이전 차감분 (RPC + on_hand)
        for (const a of applied) {
          await adminSupabase.rpc('apply_b2b_inventory_delta', {
            p_product_id: a.product_id,
            p_unit: a.unit,
            p_delta: -a.quantity,
            p_description: `B2B 출고 롤백 (${order.order_number})`,
            p_actor: user.id,
          });
          const { data: invR } = await adminSupabase
            .from('inventory')
            .select('on_hand, on_hand_pack')
            .eq('product_id', a.product_id)
            .single();
          if (invR) {
            if (a.unit === 'box') {
              await adminSupabase.from('inventory')
                .update({ on_hand: (invR.on_hand || 0) + a.quantity })
                .eq('product_id', a.product_id);
            } else {
              await adminSupabase.from('inventory')
                .update({ on_hand_pack: (invR.on_hand_pack || 0) + a.quantity })
                .eq('product_id', a.product_id);
            }
          }
        }
        return NextResponse.json({ error: `재고 차감 실패: ${error.message}` }, { status: 400 });
      }

      // on_hand / on_hand_pack 도 같이 차감 (실제 창고 박스 빠짐)
      const { data: inv } = await adminSupabase
        .from('inventory')
        .select('on_hand, on_hand_pack')
        .eq('product_id', it.product_id)
        .single();
      if (inv) {
        if (it.unit === 'box') {
          await adminSupabase.from('inventory')
            .update({ on_hand: Math.max(0, (inv.on_hand || 0) - it.quantity) })
            .eq('product_id', it.product_id);
        } else {
          await adminSupabase.from('inventory')
            .update({ on_hand_pack: Math.max(0, (inv.on_hand_pack || 0) - it.quantity) })
            .eq('product_id', it.product_id);
        }
      }

      applied.push({ product_id: it.product_id, unit: it.unit, quantity: it.quantity });
    }

    await adminSupabase
      .from('b2b_orders')
      .update({ status: 'shipped', ship_date: order.ship_date || new Date().toISOString().slice(0, 10) })
      .eq('id', id);

    await adminSupabase.from('b2b_order_logs').insert({
      order_id: id,
      action: 'ship',
      description: `출고 처리 + 재고 차감`,
      ...logActor,
    });

    return NextResponse.json({ success: true });
  }

  // ----------------------------------------------------------
  // cancel: shipped였다면 재고 복구, pending이면 그냥 상태만 변경
  // ----------------------------------------------------------
  if (action === 'cancel') {
    if (order.status === 'cancelled') {
      return NextResponse.json({ error: '이미 취소된 주문입니다.' }, { status: 400 });
    }

    const needRestock = order.status === 'shipped';
    if (needRestock && items) {
      for (const it of items) {
        if (!it.product_id) continue;
        const { error } = await adminSupabase.rpc('apply_b2b_inventory_delta', {
          p_product_id: it.product_id,
          p_unit: it.unit,
          p_delta: -it.quantity, // 음수 = 복구
          p_description: `B2B 취소 복구 (${order.order_number})`,
          p_actor: user.id,
        });
        if (error) {
          return NextResponse.json({ error: `재고 복구 실패: ${error.message}` }, { status: 400 });
        }
        // A안: on_hand / on_hand_pack 도 같이 복구 (반품 = 박스가 창고로 돌아옴)
        const { data: inv } = await adminSupabase
          .from('inventory')
          .select('on_hand, on_hand_pack')
          .eq('product_id', it.product_id)
          .single();
        if (inv) {
          if (it.unit === 'box') {
            await adminSupabase.from('inventory')
              .update({ on_hand: (inv.on_hand || 0) + it.quantity })
              .eq('product_id', it.product_id);
          } else {
            await adminSupabase.from('inventory')
              .update({ on_hand_pack: (inv.on_hand_pack || 0) + it.quantity })
              .eq('product_id', it.product_id);
          }
        }
      }
    }

    await adminSupabase.from('b2b_orders').update({ status: 'cancelled' }).eq('id', id);

    await adminSupabase.from('b2b_order_logs').insert({
      order_id: id,
      action: 'cancel',
      description: needRestock ? '취소 + 재고 복구' : '취소 (재고 미차감)',
      ...logActor,
    });

    return NextResponse.json({ success: true });
  }

  // ----------------------------------------------------------
  // update: pending 상태에서만 items/memo/ship_date 수정 가능
  // ----------------------------------------------------------
  if (action === 'update') {
    if (order.status !== 'pending') {
      return NextResponse.json({ error: '대기 상태인 주문만 수정할 수 있습니다.' }, { status: 400 });
    }

    const newItems = body.items as Array<{
      product_id: string;
      product_name: string;
      unit: 'box' | 'pack';
      quantity: number;
      pack_per_box: number;
      unit_price: number;
      unit_price_with_tax: number;
      is_tax_free: boolean;
    }> | undefined;

    const updates: Record<string, unknown> = {};
    if (body.memo !== undefined) updates.memo = body.memo;
    if (body.ship_date !== undefined) updates.ship_date = body.ship_date;

    if (newItems && newItems.length > 0) {
      const total_amount = newItems.reduce((s, i) => s + i.unit_price_with_tax * i.quantity, 0);
      const total_amount_ex_tax = newItems.reduce((s, i) => s + i.unit_price * i.quantity, 0);

      await adminSupabase.from('b2b_order_items').delete().eq('order_id', id);

      const toInsert = newItems.map((i) => ({
        order_id: id,
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
      await adminSupabase.from('b2b_order_items').insert(toInsert);

      updates.total_amount = total_amount;
      updates.total_amount_ex_tax = total_amount_ex_tax;
    }

    if (Object.keys(updates).length > 0) {
      await adminSupabase.from('b2b_orders').update(updates).eq('id', id);
    }

    await adminSupabase.from('b2b_order_logs').insert({
      order_id: id,
      action: 'update',
      description: '주문 내용 수정',
      ...logActor,
    });

    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: 'action이 올바르지 않습니다.' }, { status: 400 });
}

// DELETE: pending 상태인 주문을 완전 삭제 (취소와 달리 이력도 남기지 않음)
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

  const { data: profile } = await adminSupabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'admin') {
    return NextResponse.json({ error: '권한이 없습니다.' }, { status: 403 });
  }

  const { data: order } = await adminSupabase
    .from('b2b_orders')
    .select('status')
    .eq('id', id)
    .single();

  if (!order) {
    return NextResponse.json({ error: '주문을 찾을 수 없습니다.' }, { status: 404 });
  }
  if (order.status !== 'pending') {
    return NextResponse.json({ error: '대기 상태 주문만 삭제 가능합니다. 출고된 주문은 취소를 사용하세요.' }, { status: 400 });
  }

  await adminSupabase.from('b2b_orders').delete().eq('id', id);
  return NextResponse.json({ success: true });
}
