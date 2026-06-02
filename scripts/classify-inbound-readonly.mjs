// READ-ONLY — 전체 상품 입고(type=inbound) 트랜잭션 분류표. 백필 검토용. SELECT만.
//  - SYSTEM(자동): 설명이 "발주.." / "B2B.." 로 시작 → source는 비워둠(입고에서 제외)
//  - MANUAL(사람이 재고관리에서 등록): 그 외 → manual_inbound 후보
//    · 단, 설명에 조정/복수/반품/정합/차감 등이 있으면 '조정 의심'으로 표시 → manual_adjust 후보(검토)
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(join(__dirname, '..', '.env.local'), 'utf-8');
const env = Object.fromEntries(envText.split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const KR = (iso) => new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

const { data: prods } = await supabase.from('products').select('id, name');
const nameById = new Map((prods || []).map(p => [p.id, p.name]));

const { data: txs } = await supabase
  .from('inventory_transactions')
  .select('id, product_id, type, quantity, unit, description, created_at, created_by')
  .eq('type', 'inbound')
  .order('created_at');

// 생성자 이름
const uids = [...new Set((txs || []).map(t => t.created_by).filter(Boolean))];
const { data: profs } = await supabase.from('profiles').select('id, email, role, name').in('id', uids.length ? uids : ['00000000-0000-0000-0000-000000000000']);
const profById = new Map((profs || []).map(p => [p.id, p]));

const isSystem = (d) => {
  const s = (d || '').trim();
  return s.startsWith('발주') || s.startsWith('B2B') || s.startsWith('b2b');
};
const looksAdjust = (d) => /조정|복수|복구|반품|정합|차감|맞춤|조절|회수/.test(d || '');

let sysCount = 0, sysQty = 0;
const manualInbound = [];   // 진짜 입고 후보
const manualAdjust = [];    // 조정 의심 (검토)

for (const t of (txs || [])) {
  if (isSystem(t.description)) { sysCount++; sysQty += t.quantity; continue; }
  const row = {
    name: nameById.get(t.product_id) || '?',
    when: KR(t.created_at),
    qty: t.quantity,
    unit: t.unit === 'pack' ? '팩' : '박스',
    desc: t.description || '',
    who: (() => { const p = profById.get(t.created_by); return p ? `${p.name || p.email}(${p.role})` : 'system'; })(),
  };
  if (looksAdjust(t.description)) manualAdjust.push(row); else manualInbound.push(row);
}

console.log('========== 과거 입고(type=inbound) 분류표 ==========\n');
console.log(`총 입고 트랜잭션: ${txs?.length || 0}건`);
console.log(`  ❌ SYSTEM 자동(발주/B2B/롤백/복구) — source 비움, 입고 제외: ${sysCount}건 (${sysQty}박스 상당)\n`);

console.log(`✅ [manual_inbound 후보] 사람이 등록한 진짜 입고: ${manualInbound.length}건`);
const byProd = {};
for (const r of manualInbound) (byProd[r.name] ||= []).push(r);
for (const [name, rows] of Object.entries(byProd)) {
  const total = rows.reduce((s, r) => s + r.qty, 0);
  console.log(`\n  ── ${name} (계 ${total}박스/팩)`);
  for (const r of rows) console.log(`     [${r.when}] +${r.qty}${r.unit}  "${r.desc}"  by ${r.who}`);
}

console.log(`\n\n⚠️ [manual_adjust 후보 — 검토 필요] 사람이 입고로 넣었지만 '조정' 성격: ${manualAdjust.length}건`);
for (const r of manualAdjust) console.log(`     [${r.when}] ${r.name} +${r.qty}${r.unit}  "${r.desc}"  by ${r.who}`);
console.log('\n* manual_adjust 후보는 입고탭/입고정산에서 빠집니다. 사장님이 "이건 입고 맞다" 하시면 manual_inbound로 옮깁니다.');
