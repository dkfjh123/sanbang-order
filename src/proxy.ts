import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// ============================================================
// 서비스 점검 모드 (Next 16: middleware → proxy 로 명칭 변경됨)
// ------------------------------------------------------------
// 환경변수 MAINTENANCE_MODE='on' 일 때만 활성화.
//  - 페이지 요청  → /maintenance 안내 페이지로 rewrite (503)
//  - API 요청     → 503 JSON (가맹점/관리자/신화 모든 쓰기 차단)
//  - 점검 페이지 자체·정적 리소스는 통과
// 점검 ON/OFF 는 Vercel 환경변수 토글 후 재배포로 제어. 코드 변경 불필요.
// ============================================================
export function proxy(request: NextRequest) {
  if (process.env.MAINTENANCE_MODE !== 'on') {
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;

  // 점검 페이지 자체는 통과 (무한 rewrite 방지)
  if (pathname === '/maintenance') {
    return NextResponse.next();
  }

  // API 요청 → 503 JSON (발주/출고/입출고 등 모든 쓰기 차단)
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { error: '현재 시스템 점검 중입니다. 잠시 후 다시 시도해 주세요.' },
      { status: 503, headers: { 'Retry-After': '1800' } },
    );
  }

  // 그 외 모든 페이지 → 점검 안내 페이지로 rewrite (URL 은 유지, 상태는 503)
  const url = request.nextUrl.clone();
  url.pathname = '/maintenance';
  return NextResponse.rewrite(url, { status: 503 });
}

export const config = {
  // 정적 리소스 제외하고 모든 경로에 적용. 점검 OFF 면 위에서 즉시 통과하므로 평상시 부담 없음.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
