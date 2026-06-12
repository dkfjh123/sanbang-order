import { createClient } from '@supabase/supabase-js';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// B2B 예치금 수기 조정 (관리자 전용) — 충전/출금/조정
// 가맹점 /api/deposits 의 B2B 버전. 차이점:
//  - 원자 RPC(apply_b2b_deposit_delta)로 잔액+원장을 한 트랜잭션 처리
//  - 에러를 그대로 반환 (가맹점 버전의 '원장 기록 조용히 누락' 패턴 제거)
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
    return NextResponse.json({ error: '관리자만 조정할 수 있습니다.' }, { status: 403 });
  }

  const body = await request.json();
  const { b2b_customer_id, type, amount, description } = body as {
    b2b_customer_id: string;
    type: 'deposit' | 'withdrawal' | 'adjustment';
    amount: number; // 항상 양수로 입력받음 — 부호는 type 으로 결정
    description?: string;
  };

  if (!b2b_customer_id || !type || !amount || amount <= 0) {
    return NextResponse.json({ error: '거래처, 유형, 금액(양수)을 입력해주세요.' }, { status: 400 });
  }
  if (!['deposit', 'withdrawal', 'adjustment'].includes(type)) {
    return NextResponse.json({ error: '유형이 올바르지 않습니다.' }, { status: 400 });
  }

  // 부호 결정: 충전 +, 출금 -, 조정은 body.direction('add'|'subtract')으로 (기본 add)
  let signedAmount = amount;
  if (type === 'withdrawal') signedAmount = -amount;
  if (type === 'adjustment' && (body as { direction?: string }).direction === 'subtract') {
    signedAmount = -amount;
  }

  const adminSupabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: result, error } = await adminSupabase.rpc('apply_b2b_deposit_delta', {
    p_customer_id: b2b_customer_id,
    p_type: type,
    p_amount: signedAmount,
    p_description: description || (type === 'deposit' ? '관리자 수기 충전' : type === 'withdrawal' ? '관리자 출금' : '관리자 조정'),
    p_actor: user.id,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({
    success: true,
    balance: (result as { balance_after?: number })?.balance_after ?? null,
  });
}
