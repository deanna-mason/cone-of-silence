import Link from "next/link";

export default function NavBar() {
  return (
    <nav className="flex items-center gap-6 border-b border-slate-800 bg-slate-900 px-6 py-4 text-slate-100">
      <span className="font-semibold tracking-tight text-white">🔒 PrivateCall</span>
      <div className="flex gap-4 text-sm">
        <Link href="/" className="text-slate-300 transition hover:text-white">
          Lobby
        </Link>
        <Link href="/brainstorm" className="text-slate-300 transition hover:text-white">
          Brainstorm
        </Link>
      </div>
    </nav>
  );
}
