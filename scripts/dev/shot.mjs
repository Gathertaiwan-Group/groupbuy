// 用 headless Chrome（CDP）登入後截圖／執行檢查腳本。
// node shot.mjs --url URL --w 1512 --h 900 --out file.png [--login BASE] [--eval 'js expr'] [--wait 3000] [--steps steps.json]
// 帳密從環境變數 GB_ACC / GB_PW 讀取（不輸出）。
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, arr) => { if (v.startsWith('--')) acc.push([v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']); return acc; }, []));
const W = +(args.w || 1512), H = +(args.h || 900);
const port = 9400 + Math.floor(Math.random() * 400);
const prof = mkdtempSync(path.join(process.env.SHOT_TMP || tmpdir(), 'shotprof-'));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 結束時（正常、例外、被 timeout/Ctrl-C 中斷）一律關掉 Chrome 並刪除暫存設定檔（每個約 50–150MB，殘留會塞爆磁碟）
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  try { chrome.kill('SIGKILL'); } catch {}
  for (let i = 0; i < 3; i++) { try { rmSync(prof, { recursive: true, force: true }); break; } catch {} }
};
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanup(); process.exit(130); });
process.on('uncaughtException', (e) => { console.error(e); cleanup(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(e); cleanup(); process.exit(1); });
const watchdog = setTimeout(() => { console.error('[shot] 逾時 180 秒，強制結束'); cleanup(); process.exit(2); }, +(process.env.SHOT_TIMEOUT_MS || 180000));
let target;
for (let i = 0; i < 80; i++) { try { const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); target = list.find((t) => t.type === 'page'); if (target) break; } catch {} await sleep(250); }
if (!target) { cleanup(); throw new Error('devtools 沒起來'); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map(); const logs = []; const reqUrl = new Map();
let inLogin = false; // 登入前的登入頁會打 /ajax/AdminUser/info → 401（正常），不列入輸出
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method === 'Network.requestWillBeSent') { reqUrl.set(m.params.requestId, m.params.request.url); } else if (m.method === 'Runtime.consoleAPICalled') { logs.push(`[console.${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')); } else if (m.method === 'Runtime.exceptionThrown') { logs.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)); } else if (m.method === 'Network.loadingFailed') { logs.push('[netfail] ' + m.params.errorText + ' ' + (reqUrl.get(m.params.requestId) || '').slice(0, 200)); } else if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) { if (inLogin && m.params.response.status === 401 && /\/ajax\/AdminUser\/(info|keepalive)/.test(m.params.response.url)) return; logs.push(`[http ${m.params.response.status}] ${m.params.response.url}`); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description; };
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
const wait = +(args.wait || 3000);
if (args.login) {
  inLogin = true;
  await send('Page.navigate', { url: args.login + '/backend/panel.do' });
  await sleep(3500);
  const acc = JSON.stringify(process.env.GB_ACC || ''), pw = JSON.stringify(process.env.GB_PW || '');
  const r = await evaluate(`(async()=>{ for(let i=0;i<40 && !$('#btn-submit').is(':visible');i++) await new Promise(r=>setTimeout(r,250)); $('#username').val(${acc}); $('#password').val(${pw}); $('#AdminUserForm').submit(); return 'submitted:' + $('#btn-submit').is(':visible'); })()`);
  logs.push('[login] ' + r);
  await sleep(3500);
  inLogin = false;
}
if (args.url) { await send('Page.navigate', { url: args.url }); await sleep(wait); }
if (args.steps) {
  const steps = JSON.parse(readFileSync(args.steps, 'utf8'));
  for (const s of steps) {
    if (s.eval) { const v = await evaluate(s.eval); logs.push(`[step ${s.name || ''}] ` + (typeof v === 'string' ? v : JSON.stringify(v))); }
    if (s.wait) await sleep(s.wait);
    if (s.shot) { const { result } = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(s.shot, Buffer.from(result.data, 'base64')); logs.push('[shot] ' + s.shot); }
  }
}
if (args.eval) { const v = await evaluate(args.eval); logs.push('[eval] ' + (typeof v === 'string' ? v : JSON.stringify(v))); }
if (args.out) { const { result } = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(args.out, Buffer.from(result.data, 'base64')); logs.push('[shot] ' + args.out); }
clearTimeout(watchdog);
ws.close();
const exited = new Promise((r) => chrome.once('exit', r));
chrome.kill();
await Promise.race([exited, sleep(3000)]);
cleanup();
console.log(logs.join('\n'));
process.exit(0);
