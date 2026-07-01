import type { Metadata } from "next";
import { Bebas_Neue, Special_Elite, Spectral } from "next/font/google";
import "./globals.css";
import NavBar from "@/components/NavBar";

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
  description: "A private, encrypted line for two. Nothing recorded, nothing remembered.",
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
    >
      <body className="flex min-h-full flex-col">
        <NavBar />
        <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">{children}</main>
        <footer className="kicker mx-auto w-full max-w-3xl px-6 py-8 text-paper-dim">
          <span className="hairline border-t pt-3 block">
            Cone of Silence · Property of the Bureau · Destroy after reading
          </span>
        </footer>
      </body>
    </html>
  );
}
