// 현재 pending 발주 + 그 매장 정보 + 마감여부 — READ ONLY
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

const { data: orders, error } = await supabase
  .from('orders')
  .select('order_number, status, created_at, ship_date, store_id, stores ( short_name, region, delivery_days, deadline_override_until )')
  .order('created_at', { ascending: true });

if (error) { console.error(error); process.exit(1); }

const now = new Date();
console.log('## 현재시각:', now.toISOString(), '| KST:', now.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }));
console.log('\n## 모든 pending/confirmed 발주');
console.log('order_no | status | 매장 | ship_date | 계산된 마감 | 마감지났나?');
console.log('---'.repeat(30));

function deadlineFor(store, shipDate) {
  if (!shipDate) return null;
  const ship = new Date(`${shipDate}T00:00:00+09:00`);
  const d = new Date(ship);
  d.setDate(d.getDate() - 1);
  if (store.region === 'jeju') d.setHours(16, 0, 0, 0);
  else d.setHours(17, 0, 0, 0);
  return d;
}

for (const o of orders) {
  if (!['pending', 'confirmed'].includes(o.status)) continue;
  const s = o.stores;
  const dl = deadlineFor(s, o.ship_date);
  const past = dl ? (now >= dl) : null;
  const dlLabel = dl ? dl.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '(ship_date 없음)';
  console.log(`${o.order_number} | ${o.status.padEnd(9)} | ${(s.short_name || '').padEnd(12)} | ${o.ship_date || '-'} | ${dlLabel} | ${past === null ? '?' : (past ? '✅지남' : '아직')}`);
}
