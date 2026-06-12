import { createClient } from '@supabase/supabase-js';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// B2B 거래처 예치금 충전요청 — 가맹점 deposit-requests 와 동일 흐름의 B2B 버전.
// 차이점: 승인 시 잔액 반영을 원자 RPC(apply_b2b_deposit_delta)로 처리해
//         잔액 갱신/원장 기록이 중간에 끊기는 일이 없게 함.

// 충전요청 목록 조회 (admin: 전체 / b2b: 자기 거래처)
export async function GET() {
  const serverSupabase = await createServerClient();
  const { data: { user } } = await serverSupabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: '인증이 필요합니다.' }, { status: 401 });
  }

  const { data: profile } = await serverSupabase
    .from('profiles')
    .select('role, b2b_customer_id')
    .eq('id', user.id)
    .single();

  if (!profile) {
    return NextResponse.json({ error: '프로필을 찾을 수 없습니다.' }, { status: 400 });
  }

  if (profile.role === 'admin') {
    const { data } = await serverSupabase
      .from('b2b_deposit_requests')
      .select('*, b2b_customers(name)')
      .order('created_at', { ascending: false })
      .limit(50);
    return NextResponse.json(data || []);
  }

  if (profile.role === 'b2b' && profile.b2b_customer_id) {
    const { data } = await serverSupabase
      .from('b2b_deposit_requests')
      .select('*')
      .eq('b2b_customer_id', profile.b2b_customer_id)
      .order('created_at', { ascending: false })
      .limit(20);
    return NextResponse.json(data || []);
  }

  return NextResponse.json([]);
}

// 충전요청 생성 (b2b 거래처 — 입금 후 "입금했어요")
export async function POST(request: Request) {
  const serverSupabase = await createServerClient();
  const { data: { user } } = await serverSupabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: '인증이 필요합니다.' }, { status: 401 });
  }

  const { data: profile } = await serverSupabase
    .from('profiles')
    .select('role, b2b_customer_id')
    .eq('id', user.id)
    .single();

  if (!profile || profile.role !== 'b2b' || !profile.b2b_customer_id) {
    return NextResponse.json({ error: 'B2B 거래처만 입금 요청을 할 수 있습니다.' }, { status: 403 });
  }

  const body = await request.json();
  const { amount, description } = body as { amount: number; description?: string };

  if (!amount || amount <= 0) {
    return NextResponse.json({ error: '금액을 올바르게 입력해주세요.' }, { status: 400 });
  }

  const adminSupabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data, error } = await adminSupabase
    .from('b2b_deposit_requests')
    .insert({
      b2b_customer_id: profile.b2b_customer_id,
      amount,
      description: description || null,
      created_by: user.id,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: '요청 생성에 실패했습니다.' }, { status: 500 });
  }

  return NextResponse.json(data);
}

// 충전요청 승인/반려 (관리자)
export async function PATCH(request: Request) {
  const serverSupabase = await createServerClient();
  const { data: { user } } = await serverSupabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: '인증이 필요합니다.' }, { status: 401 });
  }

  const { data: profile } = await serverSupabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!profile || profile.role !== 'admin') {
    return NextResponse.json({ error: '관리자만 승인/반려할 수 있습니다.' }, { status: 403 });
  }

  const body = await request.json();
  const { id, action } = body as { id: string; action: 'approve' | 'reject' };

  if (!id || !['approve', 'reject'].includes(action)) {
    return NextResponse.json({ error: '잘못된 요청입니다.' }, { status: 400 });
  }

  const adminSupabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // pending → 처리 상태로 조건부 전환 (동시 더블클릭/중복 승인 차단)
  const { data: updated } = await adminSupabase
    .from('b2b_deposit_requests')
    .update({
      status: action === 'approve' ? 'approved' : 'rejected',
      reviewed_by: user.id,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'pending')
    .select()
    .single();

  if (!updated) {
    return NextResponse.json({ error: '이미 처리된 요청이거나 존재하지 않습니다.' }, { status: 400 });
  }

  if (action === 'approve') {
    // 잔액 반영 + 원장 기록 — 원자 RPC (행잠금)
    const { data: result, error: rpcError } = await adminSupabase.rpc('apply_b2b_deposit_delta', {
      p_customer_id: updated.b2b_customer_id,
      p_type: 'deposit',
      p_amount: updated.amount,
      p_description: updated.description || '입금 확인 승인',
      p_actor: user.id,
    });

    if (rpcError) {
      // 잔액 반영 실패 → 요청을 pending 으로 되돌려 재시도 가능하게
      await adminSupabase
        .from('b2b_deposit_requests')
        .update({ status: 'pending', reviewed_by: null, reviewed_at: null })
        .eq('id', id);
      return NextResponse.json({ error: `잔액 반영 실패: ${rpcError.message}` }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      action: 'approved',
      balance: (result as { balance_after?: number })?.balance_after ?? null,
    });
  }

  return NextResponse.json({ success: true, action: 'rejected' });
}
