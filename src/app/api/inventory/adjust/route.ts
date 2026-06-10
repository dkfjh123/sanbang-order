import { createClient } from '@supabase/supabase-js';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// 입출고 등록(입고/출고/조정) — 재고관리 화면에서 호출.
// 기존엔 클라이언트가 inventory 를 직접 update 했으나, lost update 방지를 위해
// 서버에서 공용 원자 RPC(apply_inventory_delta) 를 통해 처리한다.
//  - 입고/출고/조정은 reserved 와 무관 → quantity 와 on_hand 를 같은 폭으로 변경.
//  - 권한: admin = 전체, shinwa = 범용상품(general)만.
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
    .select('role')
    .eq('id', user.id)
    .single();

  const role = profile?.role;
  if (role !== 'admin' && role !== 'shinwa') {
    return NextResponse.json({ error: '입출고 권한이 없습니다.' }, { status: 403 });
  }

  const body = await request.json();
  const { product_id, type, quantity, description } = body as {
    product_id: string;
    type: 'inbound' | 'outbound' | 'adjustment';
    quantity: number;
    description?: string;
  };

  if (!product_id || !['inbound', 'outbound', 'adjustment'].includes(type)) {
    return NextResponse.json({ error: '입력이 올바르지 않습니다.' }, { status: 400 });
  }
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty <= 0) {
    return NextResponse.json({ error: '수량은 1 이상의 정수여야 합니다.' }, { status: 400 });
  }

  // 상품 확인 + 신화 권한(범용상품만)
  const { data: product } = await adminSupabase
    .from('products')
    .select('id, product_type')
    .eq('id', product_id)
    .single();
  if (!product) {
    return NextResponse.json({ error: '상품을 찾을 수 없습니다.' }, { status: 400 });
  }
  if (role === 'shinwa' && product.product_type !== 'general') {
    return NextResponse.json({ error: '신화푸드는 범용상품만 입출고할 수 있습니다.' }, { status: 403 });
  }

  const change = type === 'outbound' ? -qty : qty;
  const txDescription = description || (type === 'inbound' ? '입고' : type === 'outbound' ? '출고' : '조정');
  const txSource = type === 'inbound' ? 'manual_inbound' : 'manual_adjust';

  // 재고행 존재 여부
  const { data: invRow } = await adminSupabase
    .from('inventory')
    .select('product_id')
    .eq('product_id', product_id)
    .maybeSingle();

  if (!invRow) {
    // 재고행 없음(첫 등록) → 신규 생성. reserved=0 이므로 on_hand=quantity.
    if (change < 0) {
      return NextResponse.json({ error: '재고가 없는 상품은 출고할 수 없습니다.' }, { status: 400 });
    }
    const { error: insErr } = await adminSupabase
      .from('inventory')
      .insert({ product_id, quantity: change, on_hand: change });
    if (insErr) {
      return NextResponse.json({ error: insErr.message }, { status: 400 });
    }
    await adminSupabase.from('inventory_transactions').insert({
      product_id,
      type,
      quantity: change,
      description: txDescription,
      source: txSource,
      created_by: user.id,
    });
    return NextResponse.json({ success: true });
  }

  // 기존 재고행 → 공용 원자 RPC(행잠금 + 음수가드).
  // 입고/출고/조정: quantity 와 on_hand 를 같은 폭으로 변경(reserved 불변).
  const { error: rpcErr } = await adminSupabase.rpc('apply_inventory_delta', {
    p_product_id: product_id,
    p_d_quantity: change,
    p_d_on_hand: change,
    p_tx_type: type,
    p_tx_quantity: change,
    p_tx_unit: 'box',
    p_tx_description: txDescription,
    p_tx_source: txSource,
    p_actor: user.id,
  });
  if (rpcErr) {
    return NextResponse.json({ error: rpcErr.message }, { status: 400 });
  }

  return NextResponse.json({ success: true });
}
