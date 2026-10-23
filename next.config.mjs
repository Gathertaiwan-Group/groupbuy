/** @type {import('next').NextConfig} */
const nextConfig = {
  // 本機可用 NEXT_DIST_DIR=.next-build npm run build 另開輸出目錄，避免覆蓋執行中的 next dev
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // 頁面 HTML 由 route handler 輸出，不需要 Next 的 x-powered-by
  poweredByHeader: false,
  experimental: {
    // 模板以 fs 讀取（lib/core/render/template.ts），需讓 Vercel 函式打包 templates/**
    outputFileTracingIncludes: {
      "/**": ["./templates/**/*"],
    },
  },
};
export default nextConfig;
