"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { AuthApiError, getSessionSnapshot, login, logout, signup } from "@/lib/authApi";
import { parseInviteFragment, pinStudioRoom, type InviteFragment } from "@/lib/studioRoom";
import { buildInviteLink } from "@/lib/roomLink";

// No native "session changed" event to subscribe to — login/signup/logout all
// write to localStorage synchronously before their promise resolves, and the
// busy-flag setState right after picks up the fresh getSessionSnapshot() read
// on the next render. A no-op subscribe preserves the original "read once,
// re-check on every render" behavior.
function noopSubscribe() {
  return () => {};
}

// Server render never touches localStorage (documented SSR contract below);
// `ready` mirrors that via the same hydration-resync mechanism as `session`
// so both flip from their placeholder values to real ones in the same pass —
// same timing as the old mount effect's setSession + setReady pair.
function getReadySnapshot(): boolean {
  return true;
}
function getReadyServerSnapshot(): boolean {
  return false;
}

export default function AccountPage() {
  const session = useSyncExternalStore(noopSubscribe, getSessionSnapshot, () => null);
  const ready = useSyncExternalStore(noopSubscribe, getReadySnapshot, getReadyServerSnapshot);
  const [logoutBusy, setLogoutBusy] = useState(false);

  // First-run "Seal Broken" screen: a combined invite carries the signup token
  // + room key. Claiming registers, pins the studio, and lands in the room.
  const [invite, setInvite] = useState<InviteFragment | null>(null);
  const [claimCodename, setClaimCodename] = useState("");
  const [claimPassphrase, setClaimPassphrase] = useState("");
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);

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

  // Combined first-run invite: `#invite=<token>&r=<id>&s=<secret>` opens the
  // Seal Broken screen. The fragment is scrubbed via replaceState so the E2EE
  // secret never lingers in history — same idiom as the room page's arrival scrub.
  useEffect(() => {
    const parsed = parseInviteFragment(window.location.hash);
    if (!parsed) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- atomic read-then-scrub: the parse and the replaceState scrub are one mount-only act (see comment above — the E2EE secret must not linger in history), not a resubscribable snapshot.
    setInvite(parsed);
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  // Claim your Studio — one act: register with the carried token, pin the
  // studio, then land the new host inside the room via a full page load (the
  // hash-navigation rule). On success the page navigates away, so busy stays set.
  async function handleClaim(e: React.FormEvent) {
    e.preventDefault();
    if (!invite || claimBusy) return;
    setClaimError(null);
    setClaimBusy(true);
    try {
      await signup(invite.signupToken, claimCodename.trim(), claimPassphrase);
      pinStudioRoom(invite.room);
      window.location.assign(buildInviteLink(invite.room, window.location.origin));
    } catch (err) {
      setClaimError(err instanceof AuthApiError ? err.message : "channel unavailable");
      setClaimBusy(false);
    }
  }

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault();
    if (signupBusy) return;
    setSignupError(null);
    setSignupBusy(true);
    try {
      // saveSession() (inside signup()) writes localStorage before this
      // resolves; setSignupBusy(false) below re-renders and the derived
      // `session` snapshot picks up the fresh value — no separate setter needed.
      await signup(signupToken.trim(), signupUsername.trim(), signupPassword);
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
      // Same store-resync-on-next-render idiom as handleSignup above.
      await login(loginUsername.trim(), loginPassword);
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
      // logout() clears localStorage before this resolves; setLogoutBusy(false)
      // re-renders and the derived `session` snapshot reads null.
      setLogoutBusy(false);
    }
  }

  if (!ready) return null;

  // First run, from the one invite link: a sealed, single-use transfer. Breaking
  // the seal sets the new host's credentials and seats them in the studio.
  if (invite && !session) {
    return (
      <section className="hairline mx-auto max-w-lg border bg-inset p-4 sm:p-6">
        <p className="kicker text-sienna">◈ Sealed Transfer — Single Use</p>
        <h1 className="mt-2 font-display text-3xl tracking-[0.04em] text-ink sm:text-4xl">
          Seal Broken
        </h1>
        <p className="mt-4 font-display text-xl tracking-[0.03em] text-ink sm:text-2xl">
          You&rsquo;ve been issued a studio
        </p>
        <p className="mt-3 font-body text-ink-soft">
          The operator has posted you to a standing studio. Set your credentials — this link
          seats you there the moment you&rsquo;re cleared.
        </p>
        <form className="mt-6 space-y-5" onSubmit={handleClaim}>
          <div>
            <label htmlFor="claim-username" className="kicker block text-ink-soft">
              Codename
            </label>
            <input
              id="claim-username"
              value={claimCodename}
              onChange={(e) => setClaimCodename(e.target.value)}
              className="mt-2 w-full border-b-2 border-ink-faint/40 bg-transparent pb-2 font-type text-base tracking-wide text-ink focus:border-brass focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="claim-password" className="kicker block text-ink-soft">
              Passphrase
            </label>
            <input
              id="claim-password"
              type="password"
              value={claimPassphrase}
              onChange={(e) => setClaimPassphrase(e.target.value)}
              className="mt-2 w-full border-b-2 border-ink-faint/40 bg-transparent pb-2 font-type text-base tracking-wide text-ink focus:border-brass focus:outline-none"
            />
          </div>
          <p className="font-body text-sm italic text-ink-soft">
            Codename: 3–20 characters, a–z 0–9 _. Passphrase: 8+ characters. There is no
            recovery — a lost passphrase can only be reset by the operator.
          </p>
          {claimError && (
            <p role="alert" className="kicker text-vermilion">
              ✕ {claimError}
            </p>
          )}
          <button
            type="submit"
            disabled={claimBusy || !claimCodename.trim() || !claimPassphrase}
            className="cta-glow group flex w-full items-center justify-between gap-3 bg-vermilion px-4 py-4 font-display text-2xl tracking-[0.06em] text-cream transition hover:bg-vermilion-bright disabled:cursor-not-allowed disabled:opacity-50 sm:px-6 sm:py-5 sm:text-3xl"
          >
            <span>{claimBusy ? "CLEARING…" : "Claim your Studio"}</span>
            <span aria-hidden className="font-body text-2xl transition group-hover:translate-x-1">
              ➔
            </span>
          </button>
        </form>
        <p className="kicker mt-4 text-ink-soft">Token accepted · burns on use</p>
      </section>
    );
  }

  if (session) {
    return (
      <section className="hairline mx-auto max-w-lg border bg-inset p-4 sm:p-6">
        <p className="kicker text-sienna">Identity Desk</p>
        <h1 className="mt-2 break-words font-display text-3xl tracking-[0.04em] text-ink sm:text-4xl">
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
    <div className="mx-auto max-w-lg space-y-6 sm:space-y-8">
      <section className="hairline border bg-inset p-4 sm:p-6">
        <p className="kicker text-sienna">Register — Invitation Required</p>
        <h1 className="mt-2 font-display text-3xl tracking-[0.04em] text-ink sm:text-4xl">
          Credential Desk
        </h1>
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

      <section className="hairline border bg-inset p-4 sm:p-6">
        <p className="kicker text-sienna">Log In</p>
        <h2 className="mt-2 font-display text-2xl tracking-[0.04em] text-ink sm:text-3xl">
          Return Contact
        </h2>
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
