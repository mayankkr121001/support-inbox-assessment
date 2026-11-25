export function LoginScreen() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        background: '#f8fafc',
      }}
    >
      <div
        style={{
          background: '#fff',
          border: '1px solid #e2e8f0',
          borderRadius: 10,
          padding: 32,
          maxWidth: 400,
          width: '100%',
          textAlign: 'center',
        }}
      >
        <h1 style={{ margin: '0 0 8px', fontSize: 24 }}>Switchboard</h1>
        <p style={{ margin: '0 0 24px', color: '#475569', fontSize: 14 }}>
          Shared team inbox. Sign in with your workspace account to continue.
        </p>
        <a
          href="/auth/login"
          style={{
            display: 'inline-block',
            background: '#0f172a',
            color: '#fff',
            padding: '10px 20px',
            borderRadius: 6,
            textDecoration: 'none',
            fontWeight: 500,
            fontSize: 14,
          }}
        >
          Sign in with Mock IdP
        </a>
      </div>
    </main>
  );
}
