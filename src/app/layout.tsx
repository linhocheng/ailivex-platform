import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ailiveX",
  description: "以用戶為中心的角色對話平台",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
