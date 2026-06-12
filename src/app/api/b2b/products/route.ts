import { createClient } from '@supabase/supabase-js';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// B2B 발주 화면용 상품 조회 — 거래처 단가표 + 상품 안전 필드만 JOIN 해서 반환.
// b2b 역할은 products 테이블 직접 SELECT 권한이 없으므로(원가 노출 차단)
// 이 API 가 이름/입수/단가만 추려서 내려준다. admin 은 customer_id 지정 가능.
export async function GET(request: Request) {
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
    .select('role, b2b_customer_id')
    .eq('id', user.id)
    .single();

  const role = profile?.role;
  if (role !== 'admin' && role !== 'b2b') {
    return NextResponse.json({ error: '권한이 없습니다.' }, { status: 403 });
  }

  // b2b 역할은 자기 거래처 강제, admin 은 쿼리스트링으로 지정
  const url = new URL(request.url);
  const customerId = role === 'b2b'
    ? profile?.b2b_customer_id
    : url.searchParams.get('customer_id');

  if (!customerId) {
    return NextResponse.json({ error: '거래처 정보가 없습니다.' }, { status: 400 });
  }

  const { data: prices, error: priceError } = await adminSupabase
    .from('b2b_customer_product_prices')
    .select('product_id, b2b_price, b2b_price_with_tax, available_units')
    .eq('customer_id', customerId)
    .eq('is_active', true);

  if (priceError) {
    return NextResponse.json({ error: priceError.message }, { status: 400 });
  }

  const productIds = (prices || []).map((p) => p.product_id);
  if (productIds.length === 0) {
    return NextResponse.json([]);
  }

  // 안전 필드만 — 원가(cost_price 등) 제외
  const { data: products, error: productError } = await adminSupabase
    .from('products')
    .select('id, name, product_type, pack_per_box, is_tax_free')
    .in('id', productIds)
    .eq('product_type', 'exclusive')
    .order('name');

  if (productError) {
    return NextResponse.json({ error: productError.message }, { status: 400 });
  }

  const priceByProduct = new Map((prices || []).map((p) => [p.product_id, p]));
  const result = (products || []).map((product) => {
    const price = priceByProduct.get(product.id)!;
    return {
      id: product.id,
      name: product.name,
      product_type: product.product_type,
      pack_per_box: product.pack_per_box,
      is_tax_free: product.is_tax_free,
      b2b_price: price.b2b_price,
      b2b_price_with_tax: price.b2b_price_with_tax,
      available_units: price.available_units || ['box'],
      is_b2b_eligible: true,
    };
  });

  return NextResponse.json(result);
}
