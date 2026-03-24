import { createClient } from '@supabase/supabase-js';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  // 요청한 사용자가 관리자인지 확인
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
    return NextResponse.json({ error: '관리자만 계정을 생성할 수 있습니다.' }, { status: 403 });
  }

  const body = await request.json();
  const { email, password, name, role, store_id } = body;

  if (!email || !password || !name || !role) {
    return NextResponse.json({ error: '필수 항목을 입력해주세요.' }, { status: 400 });
  }

  if (role === 'store' && !store_id) {
    return NextResponse.json({ error: '가맹점을 선택해주세요.' }, { status: 400 });
  }

  // Service Role 키로 사용자 생성 (관리자 권한)
  const adminSupabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: newUser, error: createError } = await adminSupabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (createError) {
    return NextResponse.json({ error: createError.message }, { status: 400 });
  }

  // profiles 테이블에 추가
  const { error: profileError } = await adminSupabase
    .from('profiles')
    .insert({
      id: newUser.user.id,
      email,
      name,
      role,
      store_id: role === 'store' ? store_id : null,
    });

  if (profileError) {
    return NextResponse.json({ error: profileError.message }, { status: 400 });
  }

  return NextResponse.json({ success: true, user_id: newUser.user.id });
}
