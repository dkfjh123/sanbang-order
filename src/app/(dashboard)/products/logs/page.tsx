'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

interface ProductLog {
  id: string;
  product_id: string | null;
  product_name: string | null;
  product_type: 'exclusive' | 'general' | null;
  action: 'create' | 'update' | 'delete';
  changes: Record<string, unknown> | null;
  changed_by_name: string | null;
  changed_by_role: string | null;
  created_at: string;
}

const actionLabel: Record<ProductLog['action'], { text: string; cls: string }> = {
  create: { text: '등록', cls: 'bg-green-100 text-green-700' },
  update: { text: '수정', cls: 'bg-blue-100 text-blue-700' },
  delete: { text: '삭제', cls: 'bg-red-100 text-red-700' },
};

const fieldLabel: Record<string, string> = {
  name: '상품명',
  category: '카테고리',
  product_type: '구분',
  unit: '단위',
  spec: '규격',
  price: '공급가',
  price_with_tax: '부가세포함가',
  is_tax_free: '면세여부',
  storage: '보관',
  cost_price: '매입원가(세전)',
  cost_price_with_tax: '매입원가(세포함)',
  sort_order: '정렬순서',
  is_active: '판매상태',
  brand: '브랜드',
  manufacturer: '제조사',
};

const roleLabel: Record<string, string> = {
  admin: '관리자',
  shinwa: '신화푸드',
  store: '가맹점',
};

function formatValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'boolean') {
    if (key === 'is_active') return value ? '판매중' : '판매중지';
    if (key === 'is_tax_free') return value ? '면세' : '과세';
    return value ? 'Y' : 'N';
  }
  if (typeof value === 'number') {
    if (key.includes('price')) return `₩${value.toLocaleString()}`;
    return value.toLocaleString();
  }
  if (key === 'storage') {
    const map: Record<string, string> = { frozen: '냉동', refrigerated: '냉장', room_temp: '상온' };
    return map[String(value)] || String(value);
  }
  if (key === 'product_type') {
    return value === 'exclusive' ? '전용' : '범용';
  }
  return String(value);
}

export default function ProductLogsPage() {
  const [logs, setLogs] = useState<ProductLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [filterAction, setFilterAction] = useState<'all' | 'create' | 'update' | 'delete'>('all');
  const [filterType, setFilterType] = useState<'all' | 'exclusive' | 'general'>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    async function init() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        router.push('/login');
        return;
      }
      const { data: profile } = await supabase
        .from('profiles').select('role').eq('id', user.id).single();
      if (!profile || (profile as { role: string }).role !== 'admin') {
        setAuthorized(false);
        return;
      }
      setAuthorized(true);
      await loadLogs();
    }
    init();
  }, []);

  async function loadLogs() {
    setLoading(true);
    const { data } = await supabase
      .from('product_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(500);
    setLogs((data as ProductLog[]) || []);
    setLoading(false);
  }

  if (authorized === false) {
    return (
      <div className="max-w-md mx-auto mt-12 bg-white rounded-xl shadow-sm border border-gray-200 p-6 text-center">
        <h2 className="text-lg font-bold text-gray-800 mb-2">접근 권한 없음</h2>
        <p className="text-sm text-gray-500 mb-4">이 페이지는 관리자만 열람할 수 있습니다.</p>
        <Link href="/products" className="inline-block px-4 py-2 bg-[#1B4332] text-white rounded-lg text-sm">
          상품관리로 돌아가기
        </Link>
      </div>
    );
  }

  if (authorized === null || loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="w-8 h-8 border-4 border-[#1B4332] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const filtered = logs.filter((l) => {
    if (filterAction !== 'all' && l.action !== filterAction) return false;
    if (filterType !== 'all' && l.product_type !== filterType) return false;
    return true;
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-bold text-gray-800">상품 변경 이력</h2>
          <p className="text-sm text-gray-500 mt-0.5">최근 500건 · 관리자 전용</p>
        </div>
        <Link
          href="/products"
          className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-600 hover:bg-gray-50"
        >
          상품관리로
        </Link>
      </div>

      {/* 필터 */}
      <div className="flex flex-wrap gap-2">
        {([
          ['all', '전체'],
          ['create', '등록'],
          ['update', '수정'],
          ['delete', '삭제'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setFilterAction(key)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
              filterAction === key
                ? 'bg-[#1B4332] text-white'
                : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
            }`}
          >
            {label}
          </button>
        ))}
        <div className="w-px bg-gray-200 mx-1" />
        {([
          ['all', '전체'],
          ['exclusive', '전용상품'],
          ['general', '범용상품'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setFilterType(key)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
              filterType === key
                ? 'bg-[#1B4332] text-white'
                : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 text-center text-gray-400 text-sm">
          변경 이력이 없습니다.
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 divide-y divide-gray-100">
          {filtered.map((log) => {
            const isExpanded = expandedId === log.id;
            const a = actionLabel[log.action];
            const when = new Date(log.created_at).toLocaleString('ko-KR', {
              year: 'numeric', month: '2-digit', day: '2-digit',
              hour: '2-digit', minute: '2-digit',
            });

            return (
              <div key={log.id}>
                <button
                  onClick={() => setExpandedId(isExpanded ? null : log.id)}
                  className="w-full px-4 py-3 flex items-center gap-3 hover:bg-gray-50 transition text-left"
                >
                  <span className={`px-2 py-0.5 rounded text-xs font-medium shrink-0 ${a.cls}`}>
                    {a.text}
                  </span>
                  {log.product_type && (
                    <span className={`px-2 py-0.5 rounded text-xs font-medium shrink-0 ${
                      log.product_type === 'exclusive'
                        ? 'bg-orange-100 text-orange-700'
                        : 'bg-blue-100 text-blue-700'
                    }`}>
                      {log.product_type === 'exclusive' ? '전용' : '범용'}
                    </span>
                  )}
                  <span className="font-medium text-gray-800 truncate flex-1">
                    {log.product_name || '(이름없음)'}
                  </span>
                  <span className="text-xs text-gray-500 shrink-0 hidden sm:inline">
                    {log.changed_by_name || '알수없음'}
                    {log.changed_by_role && ` (${roleLabel[log.changed_by_role] || log.changed_by_role})`}
                  </span>
                  <span className="text-xs text-gray-400 shrink-0">{when}</span>
                  <span className="text-gray-400 shrink-0">{isExpanded ? '▲' : '▼'}</span>
                </button>

                {isExpanded && (
                  <div className="px-4 py-3 bg-gray-50 border-t border-gray-100">
                    <div className="text-xs text-gray-500 mb-2 sm:hidden">
                      작성자: {log.changed_by_name || '알수없음'}
                      {log.changed_by_role && ` (${roleLabel[log.changed_by_role] || log.changed_by_role})`}
                    </div>
                    {log.action === 'update' ? (
                      <div className="space-y-1.5">
                        {log.changes && Object.entries(log.changes).map(([key, val]) => {
                          const v = val as { old: unknown; new: unknown };
                          return (
                            <div key={key} className="flex items-start gap-2 text-sm">
                              <span className="w-32 shrink-0 text-gray-500">
                                {fieldLabel[key] || key}
                              </span>
                              <span className="text-gray-400 line-through">
                                {formatValue(key, v.old)}
                              </span>
                              <span className="text-gray-400">→</span>
                              <span className="text-gray-800 font-medium">
                                {formatValue(key, v.new)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        {log.changes && Object.entries(log.changes)
                          .filter(([key]) => fieldLabel[key])
                          .map(([key, val]) => (
                            <div key={key} className="flex items-start gap-2 text-sm">
                              <span className="w-32 shrink-0 text-gray-500">
                                {fieldLabel[key]}
                              </span>
                              <span className="text-gray-800">{formatValue(key, val)}</span>
                            </div>
                          ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
