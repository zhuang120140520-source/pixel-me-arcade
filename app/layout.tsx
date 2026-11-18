import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pixel Me — Pixel Avatar Maker",
  description: "Create and refine a personal pixel avatar in a retro arcade. Save it as a PNG with a transparent, white or custom background.",
  icons: { icon: "/assets/pixel-icon.png" },
};

export default function RootLayout({ children }: Readonly<{children: React.ReactNode}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

