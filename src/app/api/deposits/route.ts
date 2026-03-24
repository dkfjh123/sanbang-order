import { createClient } from '@supabase/supabase-js';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
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
    return NextResponse.json({ error: '관리자만 예치금을 조정할 수 있습니다.' }, { status: 403 });
  }

  const body = await request.json();
  const { store_id, type, amount, description } = body;

  if (!store_id || !type || amount === undefined) {
    return NextResponse.json({ error: '필수 항목을 입력해주세요.' }, { status: 400 });
  }

  const adminSupabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // 현재 잔액 조회
  const { data: store } = await adminSupabase
    .from('stores')
    .select('deposit_balance')
    .eq('id', store_id)
    .single();

  if (!store) {
    return NextResponse.json({ error: '가맹점을 찾을 수 없습니다.' }, { status: 400 });
  }

  const newBalance = store.deposit_balance + amount;

  // 잔액 업데이트
  await adminSupabase
    .from('stores')
    .update({ deposit_balance: newBalance })
    .eq('id', store_id);

  // 거래 내역 기록
  await adminSupabase
    .from('deposit_transactions')
    .insert({
      store_id,
      type,
      amount,
      balance_after: newBalance,
      description,
      created_by: user.id,
    });

  return NextResponse.json({ success: true, balance: newBalance });
}
