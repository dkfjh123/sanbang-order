import { createClient } from '@supabase/supabase-js';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

/**
 * 관리자 전용 — 매장별 발주 마감 연장/해제.
 *
 * POST body:
 *   { action: 'extend', minutes: number }  — minutes 만큼 마감 연장
 *   { action: 'clear' }                    — 연장 해제 (NULL)
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
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

  if (profile?.role !== 'admin') {
    return NextResponse.json({ error: '관리자만 변경할 수 있습니다.' }, { status: 403 });
  }

  const body = await request.json() as
    | { action: 'extend'; minutes: number }
    | { action: 'clear' };

  if (body.action === 'clear') {
    const { error } = await adminSupabase
      .from('stores')
      .update({ deadline_override_until: null })
      .eq('id', id);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ success: true, deadline_override_until: null });
  }

  if (body.action === 'extend') {
    const minutes = Number(body.minutes);
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) {
      return NextResponse.json({ error: '연장 시간이 올바르지 않습니다. (1분 ~ 24시간)' }, { status: 400 });
    }
    const until = new Date(Date.now() + minutes * 60 * 1000).toISOString();
    const { error } = await adminSupabase
      .from('stores')
      .update({ deadline_override_until: until })
      .eq('id', id);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ success: true, deadline_override_until: until });
  }

  return NextResponse.json({ error: 'action 이 올바르지 않습니다.' }, { status: 400 });
}
