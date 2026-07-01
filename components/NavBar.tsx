import Link from "next/link";

export default function NavBar() {
  return (
    <nav className="flex items-center justify-between gap-4 border-b-4 border-slate-900 bg-violet-500 px-6 py-4">
      <Link href="/" className="text-lg font-extrabold tracking-tight text-white">
        🤫 Cone of Silence
      </Link>
      <div className="flex gap-2 text-sm font-bold">
        <Link
          href="/"
          className="rounded-full border-2 border-slate-900 bg-white px-3 py-1 text-slate-900 shadow-[2px_2px_0_0_#0f172a] transition hover:-translate-y-0.5"
        >
          Lobby
        </Link>
        <Link
          href="/brainstorm"
          className="rounded-full border-2 border-slate-900 bg-teal-300 px-3 py-1 text-slate-900 shadow-[2px_2px_0_0_#0f172a] transition hover:-translate-y-0.5"
        >
          Brainstorm
        </Link>
      </div>
    </nav>
  );
}
