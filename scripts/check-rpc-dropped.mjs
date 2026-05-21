// apply_b2b_inventory_delta RPC 가 DROP 됐는지 확인
// 0 delta 호출로 함수 존재 여부 검증 (side effect 없음)
// READ-ONLY
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(resolve(__dirname, '..', '.env.local'), 'utf8');
const env = Object.fromEntries(
  envText.split('\n').filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => {
    const i = l.indexOf('=');
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  })
);
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// 임의 product_id, p_delta=0 (RPC 안에서 0 이면 RETURN 으로 빠짐 — side effect 없음)
const { error } = await supabase.rpc('apply_b2b_inventory_delta', {
  p_product_id: '00000000-0000-0000-0000-000000000000',
  p_unit: 'box',
  p_delta: 0,
  p_description: '030 DROP 확인 테스트',
  p_actor: null,
});

if (error) {
  if (error.message.includes('function') || error.message.includes('does not exist') || error.code === 'PGRST202') {
    console.log('★ apply_b2b_inventory_delta DROP 확인 — 함수 사라짐 ✓');
    console.log(`   (호출 에러: ${error.message})`);
  } else {
    console.log(`⚠ 예상치 못한 에러: ${error.message}`);
    console.log(`   code: ${error.code}, details: ${JSON.stringify(error)}`);
  }
} else {
  console.log('✗ apply_b2b_inventory_delta 여전히 존재 — DROP 실패 또는 미적용');
}
