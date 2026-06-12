import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 這些套件內部用 dynamic require（讀 package.json / metadata），Turbopack 一 bundle 就炸
  // （「Cannot find module as expression is too dynamic」）。留給 runtime 原生 require。
  serverExternalPackages: [
    'firebase-admin',
    'google-auth-library',
    'google-gax',
    'gcp-metadata',
  ],
  experimental: {
    serverActions: {
      bodySizeLimit: '20mb',
    },
  },
};

export default nextConfig;
