import type { Metadata } from "next";
import "./globals.css";

// CSP nonce 必須 dynamic render 才注入得到（Next 16 官方：靜態頁 build 時無 request→無 nonce→
// middleware 的 strict-dynamic 會擋掉靜態頁所有 script＝死白頁）。釘在 root layout 收斂點強制全站
// dynamic，保證每頁 script 都拿得到 per-request nonce，且未來新增頁不會再靜默破 CSP（2026-07-21）。
export const dynamic = "force-dynamic";

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
