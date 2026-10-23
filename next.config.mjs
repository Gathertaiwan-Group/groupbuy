/** @type {import('next').NextConfig} */
const nextConfig = {
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
