// READ-ONLY — 5월 생밀면/비빔전용장 입고내역 검증. 진짜 수동입고 vs 시스템 자동(롤백/복구/반품) 구분. SELECT만.
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(join(__dirname, '..', '.env.local'), 'utf-8');
const env = Object.fromEntries(
  envText.split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  })
);
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

// 대상 상품
const { data: prods } = await supabase
  .from('products')
  .select('id, name')
  .or('name.ilike.%생밀면%,name.ilike.%비빔전용장%');
console.log('대상 상품:', prods.map(p => `${p.name}(${p.id})`).join(', '));
const pids = prods.map(p => p.id);
const nameById = new Map(prods.map(p => [p.id, p.name]));

// 5월 입고 (created_at KR 기준, 정산과 동일 범위: 5/1 00:00 KST ~ 6/1 00:00 KST)
const startKR = '2026-05-01T00:00:00+09:00';
const endKR = '2026-06-01T00:00:00+09:00';
const { data: txs } = await supabase
  .from('inventory_transactions')
  .select('id, product_id, type, quantity, unit, description, created_at, created_by')
  .eq('type', 'inbound')
  .in('product_id', pids.length ? pids : ['00000000-0000-0000-0000-000000000000'])
  .gte('created_at', startKR)
  .lt('created_at', endKR)
  .order('created_at');

// 생성자 이름
const uids = [...new Set((txs || []).map(t => t.created_by).filter(Boolean))];
const { data: profs } = await supabase.from('profiles').select('id, email, role, name').in('id', uids.length ? uids : ['00000000-0000-0000-0000-000000000000']);
const profById = new Map((profs || []).map(p => [p.id, p]));

// 분류: 수동입고(포함) vs 시스템자동(제외)
const isSystem = (d) => {
  const s = d || '';
  return s.includes('롤백') || s.includes('복구') || s.includes('반품') || s.includes('취소') || s.includes('삭제') || s.includes('B2B') || /ORD-|B2B-/.test(s);
};
const settlementExcludes = (d) => (d || '').includes('복구'); // 정산 코드의 현재 필터

const KR = (iso) => new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

const summary = {}; // name -> {manualBox, manualPack, sysBox, sysPack, settlementBox}
for (const p of prods) summary[p.name] = { manualBox: 0, manualPack: 0, sysBox: 0, sysPack: 0, settlementCountedBox: 0, settlementCountedPack: 0 };

console.log(`\n=== 5월 입고 트랜잭션 (type=inbound) — ${txs?.length || 0}건 ===`);
for (const t of (txs || [])) {
  const name = nameById.get(t.product_id) || '?';
  const prof = profById.get(t.created_by);
  const who = prof ? `${prof.name || prof.email}(${prof.role})` : (t.created_by ? t.created_by.slice(0, 8) : 'system');
  const unit = t.unit || 'box';
  const sys = isSystem(t.description);
  const tag = sys ? '❌시스템자동(제외)' : '✅수동입고(포함)';
  const settleTag = settlementExcludes(t.description) ? '정산제외' : '정산포함';

  const s = summary[name];
  if (sys) { if (unit === 'pack') s.sysPack += t.quantity; else s.sysBox += t.quantity; }
  else { if (unit === 'pack') s.manualPack += t.quantity; else s.manualBox += t.quantity; }
  if (!settlementExcludes(t.description)) { if (unit === 'pack') s.settlementCountedPack += t.quantity; else s.settlementCountedBox += t.quantity; }

  console.log(`  [${KR(t.created_at)}] ${name} +${t.quantity}${unit === 'pack' ? '팩' : '박스'}  ${tag} / ${settleTag}  by ${who}`);
  console.log(`       desc: "${t.description || ''}"`);
}

console.log('\n============== 요약 (박스 기준) ==============');
for (const [name, s] of Object.entries(summary)) {
  console.log(`\n[${name}]`);
  console.log(`  ✅ 진짜 수동입고      : ${s.manualBox}박스${s.manualPack ? ` + ${s.manualPack}팩` : ''}`);
  console.log(`  ❌ 시스템자동(롤백등) : ${s.sysBox}박스${s.sysPack ? ` + ${s.sysPack}팩` : ''}`);
  console.log(`  ─ 정산이 현재 집계(복구만 제외): ${s.settlementCountedBox}박스${s.settlementCountedPack ? ` + ${s.settlementCountedPack}팩` : ''}`);
  const diff = s.settlementCountedBox - s.manualBox;
  if (diff !== 0) console.log(`  ⚠️ 정산 집계가 진짜 입고보다 ${diff > 0 ? '+' : ''}${diff}박스 차이 (롤백/반품이 정산에 섞여있을 수 있음)`);
  else console.log(`  ✅ 정산 집계 = 진짜 수동입고 (일치)`);
}
