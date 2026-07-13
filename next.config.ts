import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 這些套件內部用 dynamic require（讀 package.json / metadata），Turbopack 一 bundle 就炸
  // （「Cannot find module as expression is too dynamic」）。留給 runtime 原生 require。
  serverExternalPackages: [
    'firebase-admin',
    'google-auth-library',
    'google-gax',
    'gcp-metadata',
    'ffmpeg-static',
  ],
  // ffmpeg 二進位不是 require 得到的 JS，file tracing 追不到，明點才會進 lambda
  outputFileTracingIncludes: {
    '/api/admin/recordings/condense': ['./node_modules/ffmpeg-static/ffmpeg'],
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '20mb',
    },
  },
  // 全站安全標頭（audit MEDIUM）。麥克風是語音通話必需，Permissions-Policy 只放行 self
  async headers() {
    return [{
      source: '/(.*)',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
        { key: 'Permissions-Policy', value: 'microphone=(self), camera=(), geolocation=()' },
      ],
    }];
  },
};

export default nextConfig;
