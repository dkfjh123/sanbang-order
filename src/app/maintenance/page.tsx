// 서비스 점검 안내 페이지 — proxy.ts 가 MAINTENANCE_MODE='on' 일 때 이리로 rewrite.
// 외부 의존 없이 자족적으로 구성 (점검 중에도 확실히 렌더되도록).

export const metadata = {
  title: '시스템 점검 중 · 산방식당 발주',
};

export default function MaintenancePage() {
  return (
    <main
      style={{
        minHeight: '100dvh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        backgroundColor: '#f8f7f4',
        color: '#2b2b2b',
        fontFamily:
          "system-ui, -apple-system, 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif",
      }}
    >
      <div style={{ maxWidth: 420, textAlign: 'center', lineHeight: 1.7 }}>
        <p style={{ fontSize: 13, letterSpacing: 2, color: '#9a8f80', margin: 0 }}>
          SANBANG
        </p>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: '12px 0 16px' }}>
          시스템 점검 중입니다
        </h1>
        <p style={{ fontSize: 15, color: '#55504a', margin: 0 }}>
          더 안정적인 발주·재고 관리를 위해
          <br />
          잠시 점검을 진행하고 있습니다.
        </p>
        <p style={{ fontSize: 15, color: '#55504a', margin: '12px 0 0' }}>
          잠시 후 다시 접속해 주세요.
          <br />
          이용에 불편을 드려 죄송합니다.
        </p>
        <div
          style={{
            marginTop: 28,
            paddingTop: 18,
            borderTop: '1px solid #e7e2da',
            fontSize: 13,
            color: '#9a8f80',
          }}
        >
          문의는 관리자에게 연락 주세요.
        </div>
      </div>
    </main>
  );
}
