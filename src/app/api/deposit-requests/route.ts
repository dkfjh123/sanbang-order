import { createClient } from '@supabase/supabase-js';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// 입금 요청 목록 조회
export async function GET() {
  const serverSupabase = await createServerClient();
  const { data: { user } } = await serverSupabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: '인증이 필요합니다.' }, { status: 401 });
  }

  const { data: profile } = await serverSupabase
    .from('profiles')
    .select('role, store_id')
    .eq('id', user.id)
    .single();

  if (!profile) {
    return NextResponse.json({ error: '프로필을 찾을 수 없습니다.' }, { status: 400 });
  }

  if (profile.role === 'admin') {
    const { data } = await serverSupabase
      .from('deposit_requests')
      .select('*, stores(name, short_name)')
      .order('created_at', { ascending: false })
      .limit(50);
    return NextResponse.json(data || []);
  }

  if (profile.role === 'store' && profile.store_id) {
    const { data } = await serverSupabase
      .from('deposit_requests')
      .select('*')
      .eq('store_id', profile.store_id)
      .order('created_at', { ascending: false })
      .limit(20);
    return NextResponse.json(data || []);
  }

  return NextResponse.json([]);
}

// 입금 요청 생성 (가맹점)
export async function POST(request: Request) {
  const serverSupabase = await createServerClient();
  const { data: { user } } = await serverSupabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: '인증이 필요합니다.' }, { status: 401 });
  }

  const { data: profile } = await serverSupabase
    .from('profiles')
    .select('role, store_id')
    .eq('id', user.id)
    .single();

  if (!profile || profile.role !== 'store' || !profile.store_id) {
    return NextResponse.json({ error: '가맹점만 입금 요청을 할 수 있습니다.' }, { status: 403 });
  }

  const body = await request.json();
  const { amount, description } = body;

  if (!amount || amount <= 0) {
    return NextResponse.json({ error: '금액을 올바르게 입력해주세요.' }, { status: 400 });
  }

  const adminSupabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data, error } = await adminSupabase
    .from('deposit_requests')
    .insert({
      store_id: profile.store_id,
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

// 입금 요청 승인/반려 (관리자)
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

  // 요청 조회 (pending 상태만)
  const { data: req } = await adminSupabase
    .from('deposit_requests')
    .select('*')
    .eq('id', id)
    .eq('status', 'pending')
    .single();

  if (!req) {
    return NextResponse.json({ error: '이미 처리된 요청이거나 존재하지 않습니다.' }, { status: 400 });
  }

  // 상태 업데이트
  await adminSupabase
    .from('deposit_requests')
    .update({
      status: action === 'approve' ? 'approved' : 'rejected',
      reviewed_by: user.id,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', id);

  // 승인 시 예치금 반영
  if (action === 'approve') {
    const { data: store } = await adminSupabase
      .from('stores')
      .select('deposit_balance')
      .eq('id', req.store_id)
      .single();

    if (!store) {
      return NextResponse.json({ error: '가맹점을 찾을 수 없습니다.' }, { status: 400 });
    }

    const newBalance = store.deposit_balance + req.amount;

    await adminSupabase
      .from('stores')
      .update({ deposit_balance: newBalance })
      .eq('id', req.store_id);

    await adminSupabase
      .from('deposit_transactions')
      .insert({
        store_id: req.store_id,
        type: 'deposit',
        amount: req.amount,
        balance_after: newBalance,
        description: req.description || '입금 확인 승인',
        created_by: user.id,
      });

    return NextResponse.json({ success: true, action: 'approved', balance: newBalance });
  }

  return NextResponse.json({ success: true, action: 'rejected' });
}
