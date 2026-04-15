// 가맹점 로그인 계정 일괄 생성 스크립트
// 실행: node scripts/create-store-accounts.mjs
//
// - hwabuk@test.com 테스트 계정 삭제
// - stores 테이블의 8개 가맹점에 대해 auth 계정 + profiles 행 생성
// - 대한상공회의소점은 관리자 이메일(dkfjh1234@gmail.com) 대신 contact@jejusanbang.com 사용
// - 초기 비번: sanbang1234

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(resolve(__dirname, '..', '.env.local'), 'utf8');
const env = Object.fromEntries(
  envText
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const idx = l.indexOf('=');
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
    })
);

const supabase = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const INITIAL_PASSWORD = 'sanbang1234';

// 대한상공회의소점은 관리자와 이메일 충돌 → 회사 대표 메일로 교체
const EMAIL_OVERRIDES = {
  '876-85-01776': 'contact@jejusanbang.com',
};

async function findUserByEmail(email) {
  // listUsers는 페이지네이션. 8명 규모라 1페이지면 충분하지만 안전하게 반복.
  let page = 1;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (hit) return hit;
    if (data.users.length < 200) return null;
    page += 1;
  }
}

async function deleteTestAccount() {
  const user = await findUserByEmail('hwabuk@test.com');
  if (!user) {
    console.log('[skip] hwabuk@test.com 없음');
    return;
  }
  const { error } = await supabase.auth.admin.deleteUser(user.id);
  if (error) throw error;
  console.log('[delete] hwabuk@test.com 삭제 완료');
}

async function createStoreAccount(store) {
  const email = EMAIL_OVERRIDES[store.business_number] || store.email;
  if (!email) {
    console.log(`[skip] ${store.short_name}: 이메일 없음`);
    return;
  }

  // 이미 존재하면 건너뛰기
  const existing = await findUserByEmail(email);
  if (existing) {
    // profiles 행 없으면 삽입
    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('id', existing.id)
      .maybeSingle();
    if (!profile) {
      const { error: pErr } = await supabase.from('profiles').insert({
        id: existing.id,
        email,
        name: store.owner_name,
        role: 'store',
        store_id: store.id,
      });
      if (pErr) throw pErr;
      console.log(`[link] ${store.short_name} (${email}) — auth 존재, profiles만 연결`);
    } else {
      console.log(`[skip] ${store.short_name} (${email}) — 이미 존재`);
    }
    return;
  }

  const { data: newUser, error: createErr } = await supabase.auth.admin.createUser({
    email,
    password: INITIAL_PASSWORD,
    email_confirm: true,
  });
  if (createErr) throw new Error(`${store.short_name}: ${createErr.message}`);

  const { error: profErr } = await supabase.from('profiles').insert({
    id: newUser.user.id,
    email,
    name: store.owner_name,
    role: 'store',
    store_id: store.id,
  });
  if (profErr) throw new Error(`${store.short_name} profiles: ${profErr.message}`);

  console.log(`[create] ${store.short_name} (${email}) / ${INITIAL_PASSWORD}`);
}

async function main() {
  console.log('=== 1. 테스트 계정 정리 ===');
  await deleteTestAccount();

  console.log('\n=== 2. stores 조회 ===');
  const { data: stores, error } = await supabase
    .from('stores')
    .select('id, short_name, owner_name, business_number, email')
    .order('created_at');
  if (error) throw error;
  console.log(`${stores.length}개 가맹점 확인`);

  console.log('\n=== 3. 계정 생성 ===');
  for (const store of stores) {
    await createStoreAccount(store);
  }

  console.log('\n완료.');
}

main().catch((e) => {
  console.error('실패:', e);
  process.exit(1);
});
