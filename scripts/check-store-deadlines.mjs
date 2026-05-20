// 각 매장 발주 마감 스케줄 조사 — READ ONLY
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

const { data: stores, error } = await supabase
  .from('stores')
  .select('*')
  .order('region')
  .order('short_name');

if (error) {
  console.error(error);
  process.exit(1);
}

const DAY = ['일', '월', '화', '수', '목', '금', '토'];
const fmtDays = (arr) => (arr && arr.length ? arr.map((d) => DAY[d]).join('·') : '(미지정)');

console.log('## 매장별 발주마감 스케줄');
console.log('매장명 | 지역 | 배송요일(delivery_days) | 마감규칙 | 마감연장(override_until)');
console.log('---'.repeat(20));

for (const s of stores) {
  const region = s.region;
  const days = s.delivery_days;
  const override = s.deadline_override_until;

  let rule;
  if (region === 'jeju') {
    rule = '매주 수(3) 16:00 마감 → 목 상차 → 금 도착';
  } else {
    const used = days && days.length ? days : [1, 3, 5];
    rule = `${fmtDays(used)} 출고, 출고 전일 17:00 마감${(!days || !days.length) ? ' (기본값 [1,3,5] 사용)' : ''}`;
  }

  console.log(
    `${(s.short_name || s.name || '').padEnd(14, ' ')} | ${region.padEnd(5)} | ${fmtDays(days).padEnd(12)} | ${rule} | ${override || '-'}`
  );
}

console.log('\n## 풀 필드 (스키마 확인)');
console.log(JSON.stringify(stores[0], null, 2));

console.log('\n## 매장 수:', stores.length);
