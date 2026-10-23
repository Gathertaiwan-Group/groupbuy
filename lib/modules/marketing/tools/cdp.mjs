// marketing 自查工具共用：headless Chrome（CDP）＋ 既有登入 cookie（curl cookie jar，不重新登入）。
// - 攔截 editor-shim.js，在檔尾掛鉤把每個 Editor 實例收進 window.__dteEditors（只影響本工具開的瀏覽器）
// - 收集 JS 例外、console.error、HTTP ≥400
// - 結束（含例外／逾時／Ctrl-C）一律關 Chrome 並刪除暫存設定檔（SHOT_TMP 下的 shotprof-*）
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseArgs(argv) {
  return Object.fromEntries(
    argv.reduce((acc, v, i, arr) => {
      if (v.startsWith("--")) acc.push([v.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "true"]);
      return acc;
    }, []),
  );
}

const HOOK = `
;(function(){try{var E=window.jQuery&&jQuery.fn.dataTable&&jQuery.fn.dataTable.Editor;if(!E||E.__ucHooked)return;E.__ucHooked=true;window.__dteEditors=window.__dteEditors||[];var c=E.prototype._constructor;E.prototype._constructor=function(){window.__dteEditors.push(this);return c.apply(this,arguments);};}catch(e){}})();`;

export async function openBrowser({ base, jar, timeoutMs = 900000 }) {
  const host = new URL(base).hostname;
  const cookies = readFileSync(jar, "utf8")
    .split("\n")
    .map((l) => l.replace(/^#HttpOnly_/, ""))
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split("\t"))
    .filter((p) => p.length >= 7)
    .map((p) => ({ name: p[5], value: p[6].trim(), domain: host, path: p[2] || "/" }));

  const port = 9800 + Math.floor(Math.random() * 150);
  const prof = mkdtempSync(path.join(process.env.SHOT_TMP || tmpdir(), "shotprof-"));
  const chrome = spawn(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, "--window-size=1512,900", "about:blank"],
    { stdio: "ignore" },
  );
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      chrome.kill("SIGKILL");
    } catch {}
    for (let i = 0; i < 3; i++) {
      try {
        rmSync(prof, { recursive: true, force: true });
        break;
      } catch {}
    }
  };
  process.on("exit", cleanup);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => (cleanup(), process.exit(130)));
  process.on("uncaughtException", (e) => (console.error(e), cleanup(), process.exit(1)));
  process.on("unhandledRejection", (e) => (console.error(e), cleanup(), process.exit(1)));
  const watchdog = setTimeout(() => (console.error("[cdp] 逾時，強制結束"), cleanup(), process.exit(2)), timeoutMs);

  let target;
  for (let i = 0; i < 80 && !target; i++) {
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
    } catch {}
    if (!target) await sleep(250);
  }
  if (!target) throw new Error("devtools 沒起來");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let seq = 0;
  const pending = new Map();
  let logs = [];
  const dialogs = [];
  const send = (method, params = {}) =>
    new Promise((res) => {
      const id = ++seq;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
  ws.onmessage = async (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
      return;
    }
    if (m.method === "Runtime.exceptionThrown") logs.push("[exception] " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).split("\n").slice(0, process.env.UC_STACK ? 8 : 1).map((x) => x.trim().replace(/https?:\/\/[^ )]*\//, "")).join(" / "));
    else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")
      logs.push("[console.error] " + m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200));
    else if (m.method === "Network.responseReceived" && m.params.response.status >= 400) logs.push(`[http ${m.params.response.status}] ${m.params.response.url}`);
    else if (m.method === "Page.javascriptDialogOpening") {
      // alert／confirm：記錄文字並一律按「確定」
      dialogs.push(`[${m.params.type}] ${m.params.message}`);
      send("Page.handleJavaScriptDialog", { accept: true });
    } else if (m.method === "Fetch.requestPaused") {
      const { requestId, responseStatusCode, responseHeaders } = m.params;
      const body = await send("Fetch.getResponseBody", { requestId });
      let text = body.result?.base64Encoded ? Buffer.from(body.result.body, "base64").toString("utf8") : body.result?.body ?? "";
      text += HOOK;
      await send("Fetch.fulfillRequest", {
        requestId,
        responseCode: responseStatusCode || 200,
        responseHeaders: (responseHeaders || []).filter((h) => !/^content-(length|encoding)$/i.test(h.name)),
        body: Buffer.from(text, "utf8").toString("base64"),
      });
    }
  };
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text };
    return r.result?.result?.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Fetch.enable", { patterns: [{ urlPattern: "*editor-shim.js*", requestStage: "Response" }] });
  for (const c of cookies) await send("Network.setCookie", { ...c, url: base });

  return {
    send,
    evaluate,
    logs: () => logs.filter((l) => !/favicon/.test(l)),
    dialogs: () => dialogs.splice(0),
    resetLogs: () => (logs = []),
    /** 開頁並等 DataTables 初始化與 ajax 完成 */
    async open(url, extraWait = 800) {
      logs = [];
      await send("Page.navigate", { url: base + url });
      for (let i = 0; i < 60; i++) {
        await sleep(250);
        const ready = await evaluate(
          `document.readyState==='complete' && !!window.jQuery && !!jQuery.fn.dataTable && jQuery.fn.dataTable.settings.length>0 && jQuery.fn.dataTable.settings.every(function(s){return !s.jqXHR || s.jqXHR.readyState===4;})`,
        );
        if (ready === true) break;
      }
      await sleep(extraWait);
    },
    async screenshot(dir, name) {
      const { result } = await send("Page.captureScreenshot", { format: "png" });
      const raw = path.join(dir, `${name}.png`);
      writeFileSync(raw, Buffer.from(result.data, "base64"));
      const preview = path.join(dir, `preview-${name}.png`);
      execFileSync("sips", ["-Z", "1024", raw, "--out", preview], { stdio: "ignore" });
      rmSync(raw, { force: true });
      return preview;
    },
    close() {
      clearTimeout(watchdog);
      try {
        ws.close();
      } catch {}
      cleanup();
    },
  };
}
