import type { Metadata, Viewport } from "next";
import { Bebas_Neue, Special_Elite, Spectral } from "next/font/google";
import "./globals.css";
import NavBar from "@/components/NavBar";
import { THEME_NO_FLASH_SCRIPT } from "@/lib/theme";

const bebas = Bebas_Neue({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-bebas",
});

const elite = Special_Elite({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-elite",
});

const spectral = Spectral({
  weight: ["400", "500", "600"],
  subsets: ["latin"],
  variable: "--font-spectral",
});

export const metadata: Metadata = {
  title: "Cone of Silence — Classified",
  description: "A private, encrypted line for up to four. Nothing recorded, nothing remembered.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#e7d9bb" },
    { media: "(prefers-color-scheme: dark)", color: "#14110f" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${bebas.variable} ${elite.variable} ${spectral.variable} h-full antialiased`}
      // The script below adds data-theme, which React did not render.
      suppressHydrationWarning
    >
      <head>
        {/*
          No flash of the wrong palette. localStorage is not readable during
          SSR, so the saved DAY/NIGHT choice has to reach <html> before the
          browser paints — an inline <script> is the supported way in this
          version, and it runs during HTML parsing, ahead of both paint and
          React (see the "Themes" section of
          node_modules/next/dist/docs/01-app/02-guides/preventing-flash-before-hydration.md).
          useEffect paints first and corrects after; useLayoutEffect still
          waits for hydration.

          Unlike that doc's example, <html> carries NO default data-theme:
          hard-coding one would pin the palette and break OS-follow. With
          nothing stored the script does nothing at all, and a first visit
          resolves through @media (prefers-color-scheme) exactly as before.

          CSP already allows this: script-src carries 'unsafe-inline' for the
          RSC payload (next.config.ts), so no nonce is needed.
        */}
        <script dangerouslySetInnerHTML={{ __html: THEME_NO_FLASH_SCRIPT }} />
      </head>
      <body className="flex min-h-full flex-col">
        <NavBar />
        <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">{children}</main>
        <footer className="kicker mx-auto w-full max-w-3xl px-6 py-8 text-center text-ink-soft">
          <span className="hairline block border-t pt-3">
            Cone of Silence · Property of the Bureau · Destroy after reading
          </span>
        </footer>
      </body>
    </html>
  );
}
