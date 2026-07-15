"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  AuthApiError,
  getSession,
  login,
  logout,
  signup,
  type StoredSession,
} from "@/lib/authApi";

export default function AccountPage() {
  const [session, setSession] = useState<StoredSession | null>(null);
  const [ready, setReady] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);

  // Signup card state
  const [signupToken, setSignupToken] = useState("");
  const [signupUsername, setSignupUsername] = useState("");
  const [signupPassword, setSignupPassword] = useState("");
  const [signupBusy, setSignupBusy] = useState(false);
  const [signupError, setSignupError] = useState<string | null>(null);

  // Login card state
  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  useEffect(() => {
    setSession(getSession());
    setReady(true);
  }, []);

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault();
    if (signupBusy) return;
    setSignupError(null);
    setSignupBusy(true);
    try {
      const s = await signup(signupToken.trim(), signupUsername.trim(), signupPassword);
      setSession(s);
    } catch (err) {
      setSignupError(err instanceof AuthApiError ? err.message : "channel unavailable");
    } finally {
      setSignupBusy(false);
    }
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    if (loginBusy) return;
    setLoginError(null);
    setLoginBusy(true);
    try {
      const s = await login(loginUsername.trim(), loginPassword);
      setSession(s);
    } catch (err) {
      if (err instanceof AuthApiError && err.status === 401) {
        setLoginError("credentials denied");
      } else if (err instanceof AuthApiError && err.status === 429) {
        setLoginError("too many attempts — wait a minute");
      } else {
        setLoginError("channel unavailable");
      }
    } finally {
      setLoginBusy(false);
    }
  }

  async function handleLogout() {
    if (logoutBusy) return;
    setLogoutBusy(true);
    try {
      await logout();
    } finally {
      setSession(null);
      setLogoutBusy(false);
    }
  }

  if (!ready) return null;

  if (session) {
    return (
      <section className="hairline mx-auto max-w-lg border bg-inset p-6">
        <p className="kicker text-sienna">Identity Desk</p>
        <h1 className="mt-2 font-display text-4xl tracking-[0.04em] text-ink">
          CLEARED: @{session.username}
        </h1>
        <p className="kicker mt-4 text-ink-soft">
          Session expires {new Date(session.expiresAt).toLocaleString()}
        </p>
        <div className="mt-6 flex items-center gap-5">
          <Link href="/studio" className="kicker transition hover:text-signal">
            Go to Studio →
          </Link>
        </div>
        <button
          type="button"
          disabled={logoutBusy}
          onClick={() => void handleLogout()}
          className="kicker mt-6 w-full border border-ink-faint/30 py-3 text-ink-soft transition hover:border-vermilion hover:text-vermilion disabled:opacity-40"
        >
          {logoutBusy ? "TRANSMITTING…" : "Log Out"}
        </button>
      </section>
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-8">
      <section className="hairline border bg-inset p-6">
        <p className="kicker text-sienna">Register — Invitation Required</p>
        <h1 className="mt-2 font-display text-4xl tracking-[0.04em] text-ink">Credential Desk</h1>
        <form className="mt-6 space-y-5" onSubmit={handleSignup}>
          <div>
            <label htmlFor="signup-token" className="kicker block text-ink-soft">
              Invitation token
            </label>
            <input
              id="signup-token"
              value={signupToken}
              onChange={(e) => setSignupToken(e.target.value)}
              className="mt-2 w-full border-b-2 border-ink-faint/40 bg-transparent pb-2 font-type text-base tracking-wide text-ink focus:border-brass focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="signup-username" className="kicker block text-ink-soft">
              Codename
            </label>
            <input
              id="signup-username"
              value={signupUsername}
              onChange={(e) => setSignupUsername(e.target.value)}
              className="mt-2 w-full border-b-2 border-ink-faint/40 bg-transparent pb-2 font-type text-base tracking-wide text-ink focus:border-brass focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="signup-password" className="kicker block text-ink-soft">
              Passphrase
            </label>
            <input
              id="signup-password"
              type="password"
              value={signupPassword}
              onChange={(e) => setSignupPassword(e.target.value)}
              className="mt-2 w-full border-b-2 border-ink-faint/40 bg-transparent pb-2 font-type text-base tracking-wide text-ink focus:border-brass focus:outline-none"
            />
          </div>
          <p className="font-body text-sm italic text-ink-soft">
            Codename: 3–20 characters, a–z 0–9 _. Passphrase: 8+ characters. There is no
            recovery — a lost passphrase can only be reset by the operator.
          </p>
          {signupError && (
            <p role="alert" className="kicker text-vermilion">
              ✕ {signupError}
            </p>
          )}
          <button
            type="submit"
            disabled={signupBusy || !signupToken.trim() || !signupUsername.trim() || !signupPassword}
            className="kicker w-full border border-ink-faint/30 py-3 text-ink-soft transition hover:border-brass hover:text-signal disabled:opacity-40"
          >
            {signupBusy ? "TRANSMITTING…" : "Register"}
          </button>
        </form>
      </section>

      <section className="hairline border bg-inset p-6">
        <p className="kicker text-sienna">Log In</p>
        <h2 className="mt-2 font-display text-3xl tracking-[0.04em] text-ink">Return Contact</h2>
        <form className="mt-6 space-y-5" onSubmit={handleLogin}>
          <div>
            <label htmlFor="login-username" className="kicker block text-ink-soft">
              Codename
            </label>
            <input
              id="login-username"
              value={loginUsername}
              onChange={(e) => setLoginUsername(e.target.value)}
              className="mt-2 w-full border-b-2 border-ink-faint/40 bg-transparent pb-2 font-type text-base tracking-wide text-ink focus:border-brass focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="login-password" className="kicker block text-ink-soft">
              Passphrase
            </label>
            <input
              id="login-password"
              type="password"
              value={loginPassword}
              onChange={(e) => setLoginPassword(e.target.value)}
              className="mt-2 w-full border-b-2 border-ink-faint/40 bg-transparent pb-2 font-type text-base tracking-wide text-ink focus:border-brass focus:outline-none"
            />
          </div>
          {loginError && (
            <p role="alert" className="kicker text-vermilion">
              ✕ {loginError}
            </p>
          )}
          <button
            type="submit"
            disabled={loginBusy || !loginUsername.trim() || !loginPassword}
            className="kicker w-full border border-ink-faint/30 py-3 text-ink-soft transition hover:border-brass hover:text-signal disabled:opacity-40"
          >
            {loginBusy ? "TRANSMITTING…" : "Log In"}
          </button>
        </form>
      </section>
    </div>
  );
}
