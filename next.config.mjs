/** @type {import('next').NextConfig} */
const nextConfig = {
  // 本機可用 NEXT_DIST_DIR=.next-build npm run build 另開輸出目錄，避免覆蓋執行中的 next dev
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // 頁面 HTML 由 route handler 輸出，不需要 Next 的 x-powered-by
  poweredByHeader: false,
  // 防點擊劫持：只允許同源頁面以 iframe 嵌入本站（站內下載／預覽用的同源 iframe 不受影響；嵌入 YouTube 等外部 iframe 不受此限）
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
        ],
      },
    ];
  },
  experimental: {
    // 模板以 fs 讀取（lib/core/render/template.ts），需讓 Vercel 函式打包 templates/**
    outputFileTracingIncludes: {
      "/**": ["./templates/**/*"],
    },
  },
};
export default nextConfig;
