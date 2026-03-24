import { createBrowserClient } from '@supabase/ssr';

let client: ReturnType<typeof createBrowserClient> | null = null;

export function createClient() {
  if (typeof window === 'undefined') {
    // SSR/빌드 시에는 더미 클라이언트 생성 방지
    // 실제 서버 작업은 server.ts를 사용
    return createBrowserClient(
      'http://localhost',
      'placeholder'
    );
  }

  if (client) return client;

  client = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
  return client;
}
