// 路由樣式編譯與比對。見 docs/ARCHITECTURE.md「路由」。
import type { HttpMethod, RegisteredRoute } from "./types";

/** 不可能是租戶代碼的第一段（避免把 /backend/... 等誤判成 /{tenant}/...） */
const RESERVED_FIRST_SEGMENTS = new Set([
  "backend",
  "ajax",
  "public",
  "scripts",
  "images",
  "upload",
  "js",
  "css",
  "fonts",
  "compat",
  "_next",
  "api",
  "rp",
  "pups",
  "favicon.ico",
  "robots.txt",
]);

const TENANT_RE = /^[A-Za-z0-9_-]{2,64}$/;

/**
 * 正規化 pathname：
 * - decode 各段（無效編碼保留原樣）
 * - 移除 `;jsessionid=...`
 * - 合併多餘斜線、去掉結尾斜線
 * - 最後一段去掉 `.do`（原站 /backend/X/y.do 與 /backend/X/y 等價）
 * - `/backend/ajax/...` → `/ajax/...`（原站頁面有 <base href="/backend/X/y.jsp">，相對路徑 ../ajax/... 會解析到這裡）
 */
export function normalizePath(pathname: string): string {
  let p = pathname.replace(/;jsessionid=[^/?#]*/gi, "");
  const segs = p
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  if (segs.length > 0) {
    const last = segs[segs.length - 1];
    if (last.length > 3 && last.endsWith(".do")) segs[segs.length - 1] = last.slice(0, -3);
  }
  if (segs[0] === "backend" && segs[1] === "ajax") segs.shift();
  p = "/" + segs.join("/");
  return p;
}

export function splitPath(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

interface CompiledRoute {
  route: RegisteredRoute;
  segments: string[];
  wildcard: boolean;
  methods: Set<HttpMethod> | null;
  tenantPrefix: "allow" | "require" | "deny";
  priority: number;
  staticCount: number;
}

export interface MatchResult {
  route: RegisteredRoute;
  params: Record<string, string>;
  tenantPrefix: string | null;
  /** 比對用的路徑（去掉租戶前綴後） */
  matchedPath: string;
}

export type MatchOutcome =
  | { kind: "match"; result: MatchResult }
  | { kind: "method-not-allowed"; allowed: HttpMethod[] }
  | { kind: "not-found" };

function defaultTenantPrefix(path: string): "allow" | "require" | "deny" {
  if (path === "/backend" || path.startsWith("/backend/")) return "deny";
  if (path.startsWith("/p/")) return "require";
  const segs = splitPath(path);
  if (segs.length > 0 && (segs[0].startsWith(":") || segs[0] === "*")) return "deny";
  return "allow";
}

function compile(route: RegisteredRoute): CompiledRoute {
  const segments = splitPath(route.path);
  const wildcard = segments[segments.length - 1] === "*";
  if (wildcard) segments.pop();
  let methods: Set<HttpMethod> | null = null;
  if (route.method && route.method !== "ANY") {
    const list = Array.isArray(route.method) ? route.method : [route.method];
    methods = new Set(list);
    if (methods.has("GET")) methods.add("HEAD");
  }
  return {
    route,
    segments,
    wildcard,
    methods,
    tenantPrefix: route.tenantPrefix ?? defaultTenantPrefix(route.path),
    priority: route.priority ?? 100,
    staticCount: segments.filter((s) => !s.startsWith(":")).length,
  };
}

function matchSegments(c: CompiledRoute, segs: string[]): Record<string, string> | null {
  if (c.wildcard ? segs.length < c.segments.length : segs.length !== c.segments.length) return null;
  // 全萬用路由（'/*'，前台 404 fallback 用）不接保留字開頭的網址（後台未知網址由 core 回後台樣式 404／登入頁）
  if (c.wildcard && c.segments.length === 0 && segs.length > 0 && RESERVED_FIRST_SEGMENTS.has(segs[0])) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < c.segments.length; i++) {
    const pat = c.segments[i];
    // 第一段是參數（如前台 /:shortUrl）時，不可吃掉保留字（/backend、/ajax…），避免把後台網址當成短網址
    if (i === 0 && pat.startsWith(":") && RESERVED_FIRST_SEGMENTS.has(segs[0])) return null;
    if (pat.startsWith(":")) params[pat.slice(1)] = segs[i];
    else if (pat !== segs[i]) return null;
  }
  if (c.wildcard) params["*"] = segs.slice(c.segments.length).join("/");
  return params;
}

export class Router {
  private compiled: CompiledRoute[];

  constructor(routes: RegisteredRoute[]) {
    this.compiled = routes.map(compile);
    const seen = new Map<string, RegisteredRoute>();
    for (const c of this.compiled) {
      const key = `${c.methods ? [...c.methods].sort().join(",") : "ANY"} ${c.route.path}`;
      const prev = seen.get(key);
      if (prev) {
        // 不同模組登錄了同一路徑＋方法：後者永遠不會被用到，提早報出來
        console.error(`[router] 重複路由 ${key}（${prev.module} 與 ${c.route.module}）`);
      } else {
        seen.set(key, c.route);
      }
    }
  }

  /** 列出所有路由（除錯/文件用） */
  list(): { module: string; method: string; path: string; auth: string; priority: number }[] {
    return this.compiled.map((c) => ({
      module: c.route.module,
      method: c.methods ? [...c.methods].filter((m) => m !== "HEAD").join("|") : "ANY",
      path: c.route.path,
      auth: c.route.auth ?? "(default)",
      priority: c.priority,
    }));
  }

  match(path: string, method: HttpMethod): MatchOutcome {
    const segs = splitPath(path);
    type Cand = { c: CompiledRoute; params: Record<string, string>; tenant: string | null; matchedPath: string };
    const cands: Cand[] = [];

    for (const c of this.compiled) {
      if (c.tenantPrefix === "require") continue;
      const params = matchSegments(c, segs);
      if (params) cands.push({ c, params, tenant: null, matchedPath: path });
    }
    if (segs.length >= 2 && TENANT_RE.test(segs[0]) && !RESERVED_FIRST_SEGMENTS.has(segs[0])) {
      const rest = segs.slice(1);
      const restPath = "/" + rest.join("/");
      for (const c of this.compiled) {
        if (c.tenantPrefix === "deny") continue;
        const params = matchSegments(c, rest);
        if (params) cands.push({ c, params, tenant: segs[0], matchedPath: restPath });
      }
    }
    if (cands.length === 0) return { kind: "not-found" };

    cands.sort((a, b) => {
      if (a.c.priority !== b.c.priority) return a.c.priority - b.c.priority;
      if (a.c.wildcard !== b.c.wildcard) return a.c.wildcard ? 1 : -1;
      if (a.c.staticCount !== b.c.staticCount) return b.c.staticCount - a.c.staticCount;
      if ((a.tenant === null) !== (b.tenant === null)) return a.tenant === null ? -1 : 1;
      return 0;
    });

    const allowed = new Set<HttpMethod>();
    for (const cand of cands) {
      if (!cand.c.methods || cand.c.methods.has(method)) {
        return {
          kind: "match",
          result: { route: cand.c.route, params: cand.params, tenantPrefix: cand.tenant, matchedPath: cand.matchedPath },
        };
      }
      cand.c.methods.forEach((m) => allowed.add(m));
    }
    return { kind: "method-not-allowed", allowed: [...allowed] };
  }
}
