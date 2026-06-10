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
  // ship: pending → shipped (단순화 옵션 — 박스 환산 + 자투리 발생)
  //   box 항목:  reserved -= qty, on_hand -= qty
  //   pack 항목: 박스 환산(CEIL(qty/ppb))만큼 reserved/on_hand 차감,
  //              자투리(환산*ppb - qty)만큼 loose_pack_qty/on_hand_pack 증가 (가맹점 판매분)
  //   inventory_transactions 는 POST 시점에 이미 outbound 기록됨 → 여기선 추가 안 함
  // ----------------------------------------------------------
  if (action === 'ship') {
    if (order.status !== 'pending') {
      return NextResponse.json({ error: '대기 상태인 주문만 출고 처리할 수 있습니다.' }, { status: 400 });
    }
    if (!items || items.length === 0) {
      return NextResponse.json({ error: '발주 항목이 없습니다.' }, { status: 400 });
    }

    // product 단위로 누적 (box 차감, pack 자투리 추가)
    type ShipDelta = { box: number; loosePackAdd: number };
    const deltaByProduct = new Map<string, ShipDelta>();
    for (const it of items as Array<{ product_id: string; unit: 'box' | 'pack'; quantity: number; pack_per_box: number | null }>) {
      if (!it.product_id) continue;
      const ppb = it.pack_per_box || 1;
      const boxes = it.unit === 'box' ? it.quantity : Math.ceil(it.quantity / ppb);
      const leftover = it.unit === 'pack' ? boxes * ppb - it.quantity : 0;
      const cur = deltaByProduct.get(it.product_id) || { box: 0, loosePackAdd: 0 };
      cur.box += boxes;
      cur.loosePackAdd += leftover;
      deltaByProduct.set(it.product_id, cur);
    }

    const applied: Array<{ product_id: string; box: number; loosePackAdd: number }> = [];
    let shipError: string | null = null;
    for (const [pid, d] of deltaByProduct) {
      // B2B 출고 = reserved↓ + on_hand↓ (박스 환산) + 자투리 loose_pack_qty↑ + on_hand_pack↑.
      // 공용 원자 RPC(행잠금 + 음수가드). 자투리 발생 시에만 트랜잭션 기록.
      const { error: rpcErr } = await adminSupabase.rpc('apply_inventory_delta', {
        p_product_id: pid,
        p_d_reserved: -d.box,
        p_d_on_hand: -d.box,
        p_d_loose_pack: d.loosePackAdd,
        p_d_on_hand_pack: d.loosePackAdd,
        p_tx_type: d.loosePackAdd > 0 ? 'adjustment' : null,
        p_tx_quantity: d.loosePackAdd > 0 ? d.loosePackAdd : null,
        p_tx_unit: 'pack',
        p_tx_description: d.loosePackAdd > 0
          ? `B2B 출고 자투리 (${order.order_number}) — 박스 분해 후 가맹점 판매분 +${d.loosePackAdd}팩`
          : null,
        p_actor: user.id,
        p_require_exist: false,
      });
      if (rpcErr) { shipError = rpcErr.message; break; }
      applied.push({ product_id: pid, box: d.box, loosePackAdd: d.loosePackAdd });
    }

    if (shipError) {
      for (const a of applied) {
        // 거울 롤백
        await adminSupabase.rpc('apply_inventory_delta', {
          p_product_id: a.product_id,
          p_d_reserved: a.box,
          p_d_on_hand: a.box,
          p_d_loose_pack: -a.loosePackAdd,
          p_d_on_hand_pack: -a.loosePackAdd,
          p_actor: user.id,
          p_require_exist: false,
        });
      }
      return NextResponse.json({ error: `재고 차감 실패: ${shipError}` }, { status: 400 });
    }

    await adminSupabase
      .from('b2b_orders')
      .update({ status: 'shipped', ship_date: order.ship_date || new Date().toISOString().slice(0, 10) })
      .eq('id', id);

    await adminSupabase.from('b2b_order_logs').insert({
      order_id: id,
      action: 'ship',
      description: `출고 처리 + 박스 환산 차감 (자투리 발생 시 가맹점 판매분으로 등록)`,
      ...logActor,
    });

    // 자투리 발생 → 가맹점 공지 자동 등록 (전체 매장 대상)
    const looseAddedProducts = applied.filter((a) => a.loosePackAdd > 0);
    if (looseAddedProducts.length > 0) {
      const { data: prods } = await adminSupabase
        .from('products')
        .select('id, name')
        .in('id', looseAddedProducts.map((a) => a.product_id));
      const nameByPid = new Map((prods || []).map((p: { id: string; name: string }) => [p.id, p.name]));
      const lines = looseAddedProducts
        .map((a) => `· ${nameByPid.get(a.product_id) || ''} +${a.loosePackAdd}팩`)
        .join('\n');
      await adminSupabase.from('notices').insert({
        title: '낱팩 자투리 발주 가능',
        content: `B2B 출고로 박스 분해 시 자투리가 발생했습니다. 아래 상품은 낱팩 단위로 주문하실 수 있습니다 (선착순 한도 내).\n\n${lines}\n\n발주 화면 > "낱팩 잔량 발주 가능" 안내에서 확인.`,
        is_pinned: false,
        is_active: true,
        target_type: 'all',
        target_store_ids: [],
        created_by: user.id,
      });
    }

    return NextResponse.json({ success: true });
  }

  // ----------------------------------------------------------
  // cancel (단순화 옵션):
  //   pending → cancelled: POST 거울. quantity += 환산박스, reserved -= 환산박스
  //   shipped → cancelled: 반품. quantity += 환산박스, on_hand += 환산박스
  //                        + 자투리(ship 시 발생분)는 loose_pack_qty/on_hand_pack 에서 회수
  // ----------------------------------------------------------
  if (action === 'cancel') {
    if (order.status === 'cancelled') {
      return NextResponse.json({ error: '이미 취소된 주문입니다.' }, { status: 400 });
    }

    type CancelDelta = { box: number; loosePackAdd: number };
    const deltaByProduct = new Map<string, CancelDelta>();
    for (const it of (items || []) as Array<{ product_id: string; unit: 'box' | 'pack'; quantity: number; pack_per_box: number | null }>) {
      if (!it.product_id) continue;
      const ppb = it.pack_per_box || 1;
      const boxes = it.unit === 'box' ? it.quantity : Math.ceil(it.quantity / ppb);
      const leftover = it.unit === 'pack' ? boxes * ppb - it.quantity : 0;
      const cur = deltaByProduct.get(it.product_id) || { box: 0, loosePackAdd: 0 };
      cur.box += boxes;
      cur.loosePackAdd += leftover;
      deltaByProduct.set(it.product_id, cur);
    }

    const wasShipped = order.status === 'shipped';
    for (const [pid, d] of deltaByProduct) {
      // 공용 원자 RPC(행잠금). 재고행 없으면 조용히 스킵.
      if (wasShipped) {
        // 반품: 박스 창고로 회수(quantity↑ on_hand↑) + 자투리 회수(loose↓ on_hand_pack↓)
        await adminSupabase.rpc('apply_inventory_delta', {
          p_product_id: pid,
          p_d_quantity: d.box,
          p_d_on_hand: d.box,
          p_d_loose_pack: -d.loosePackAdd,
          p_d_on_hand_pack: -d.loosePackAdd,
          p_tx_type: 'inbound',
          p_tx_quantity: d.box,
          p_tx_unit: 'box',
          p_tx_description: `B2B 출고취소 반품 (${order.order_number}) — 박스 환산 ${d.box}박스`
            + (d.loosePackAdd > 0 ? ` + 자투리 ${d.loosePackAdd}팩 회수` : ''),
          p_actor: user.id,
          p_require_exist: false,
        });
      } else {
        // pending → cancelled: POST 거울 (quantity↑ reserved↓)
        await adminSupabase.rpc('apply_inventory_delta', {
          p_product_id: pid,
          p_d_quantity: d.box,
          p_d_reserved: -d.box,
          p_tx_type: 'inbound',
          p_tx_quantity: d.box,
          p_tx_unit: 'box',
          p_tx_description: `B2B 발주 취소 (${order.order_number}) — 박스 환산 ${d.box}박스 복구`,
          p_actor: user.id,
          p_require_exist: false,
        });
      }
    }

    await adminSupabase.from('b2b_orders').update({ status: 'cancelled' }).eq('id', id);

    await adminSupabase.from('b2b_order_logs').insert({
      order_id: id,
      action: 'cancel',
      description: wasShipped ? '출고취소 반품 (재고/자투리 회수)' : '발주 취소 (reserved 복구)',
      ...logActor,
    });

    return NextResponse.json({ success: true });
  }

  // ----------------------------------------------------------
  // update (단순화 옵션): pending 상태에서만, item diff 만큼 reserved 동기화
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
      // 기존 items 의 박스 환산 누적 (product 별)
      const oldBoxByPid = new Map<string, number>();
      for (const it of (items || []) as Array<{ product_id: string; unit: 'box' | 'pack'; quantity: number; pack_per_box: number | null }>) {
        if (!it.product_id) continue;
        const ppb = it.pack_per_box || 1;
        const boxes = it.unit === 'box' ? it.quantity : Math.ceil(it.quantity / ppb);
        oldBoxByPid.set(it.product_id, (oldBoxByPid.get(it.product_id) || 0) + boxes);
      }

      // 새 items 의 박스 환산 누적
      const newBoxByPid = new Map<string, number>();
      for (const i of newItems) {
        const ppb = i.pack_per_box || 1;
        const boxes = i.unit === 'box' ? i.quantity : Math.ceil(i.quantity / ppb);
        newBoxByPid.set(i.product_id, (newBoxByPid.get(i.product_id) || 0) + boxes);
      }

      // diff = new - old (양수 = 추가 차감, 음수 = 복구)
      const allPids = new Set<string>([...oldBoxByPid.keys(), ...newBoxByPid.keys()]);
      const diffs: Array<{ product_id: string; diff: number }> = [];
      for (const pid of allPids) {
        const diff = (newBoxByPid.get(pid) || 0) - (oldBoxByPid.get(pid) || 0);
        if (diff !== 0) diffs.push({ product_id: pid, diff });
      }

      // 추가 차감되는 product 에 대해 박스 재고 부족 검증
      const addPids = diffs.filter((d) => d.diff > 0).map((d) => d.product_id);
      if (addPids.length > 0) {
        const { data: invs } = await adminSupabase
          .from('inventory').select('product_id, quantity').in('product_id', addPids);
        const invByPid = new Map((invs || []).map((r: { product_id: string; quantity: number }) => [r.product_id, r]));
        for (const d of diffs) {
          if (d.diff <= 0) continue;
          const inv = invByPid.get(d.product_id);
          if (!inv || inv.quantity < d.diff) {
            return NextResponse.json({
              error: `상품 박스 재고 부족 (가용 ${inv?.quantity ?? 0}박스, 추가 필요 ${d.diff}박스)`,
            }, { status: 400 });
          }
        }
      }

      // items 갱신
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

      // inventory diff 반영 — quantity는 -diff, reserved는 +diff (등식 유지). 공용 원자 RPC.
      for (const d of diffs) {
        await adminSupabase.rpc('apply_inventory_delta', {
          p_product_id: d.product_id,
          p_d_quantity: -d.diff,
          p_d_reserved: d.diff,
          p_tx_type: d.diff > 0 ? 'outbound' : 'inbound',
          p_tx_quantity: -d.diff,
          p_tx_unit: 'box',
          p_tx_description: `B2B 발주 수정 (${order.order_number}) — diff ${d.diff > 0 ? '+' : ''}${d.diff}박스`,
          p_actor: user.id,
          p_require_exist: false,
        });
      }

      updates.total_amount = total_amount;
      updates.total_amount_ex_tax = total_amount_ex_tax;
    }

    if (Object.keys(updates).length > 0) {
      await adminSupabase.from('b2b_orders').update(updates).eq('id', id);
    }

    await adminSupabase.from('b2b_order_logs').insert({
      order_id: id,
      action: 'update',
      description: '주문 내용 수정 (reserved 동기화)',
      ...logActor,
    });

    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: 'action이 올바르지 않습니다.' }, { status: 400 });
}

// DELETE: pending 상태인 주문을 완전 삭제 (단순화 옵션: 박스 환산만큼 재고 복구도 같이)
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
    .select('status, order_number')
    .eq('id', id)
    .single();

  if (!order) {
    return NextResponse.json({ error: '주문을 찾을 수 없습니다.' }, { status: 404 });
  }
  if (order.status !== 'pending') {
    return NextResponse.json({ error: '대기 상태 주문만 삭제 가능합니다. 출고된 주문은 취소를 사용하세요.' }, { status: 400 });
  }

  // 박스 환산만큼 재고 복구 (POST 거울)
  const { data: items } = await adminSupabase
    .from('b2b_order_items')
    .select('product_id, unit, quantity, pack_per_box')
    .eq('order_id', id);

  const boxByPid = new Map<string, number>();
  for (const it of (items || []) as Array<{ product_id: string; unit: 'box' | 'pack'; quantity: number; pack_per_box: number | null }>) {
    if (!it.product_id) continue;
    const ppb = it.pack_per_box || 1;
    const boxes = it.unit === 'box' ? it.quantity : Math.ceil(it.quantity / ppb);
    boxByPid.set(it.product_id, (boxByPid.get(it.product_id) || 0) + boxes);
  }

  for (const [pid, box] of boxByPid) {
    // POST 거울 (quantity↑ reserved↓). 공용 원자 RPC(행잠금). 재고행 없으면 조용히 스킵.
    await adminSupabase.rpc('apply_inventory_delta', {
      p_product_id: pid,
      p_d_quantity: box,
      p_d_reserved: -box,
      p_tx_type: 'inbound',
      p_tx_quantity: box,
      p_tx_unit: 'box',
      p_tx_description: `B2B 발주 삭제 (${order.order_number}) — 박스 환산 ${box}박스 복구`,
      p_actor: user.id,
      p_require_exist: false,
    });
  }

  // b2b_order_items 와 b2b_orders 삭제
  await adminSupabase.from('b2b_order_items').delete().eq('order_id', id);
  await adminSupabase.from('b2b_orders').delete().eq('id', id);
  return NextResponse.json({ success: true });
}
