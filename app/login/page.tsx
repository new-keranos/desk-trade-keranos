export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main className="login">
      <form method="post" action="/api/login" className="pane login-card">
        <h1 className="brand-h">Keranos <span>Desk</span></h1>
        <label htmlFor="password" className="label">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required autoFocus />
        {error && <p className="down">That password didn't match. Try again.</p>}
        <button className="btn primary" type="submit">Sign in</button>
      </form>
    </main>
  );
}
