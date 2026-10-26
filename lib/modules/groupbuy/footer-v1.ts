// Footer V1（舊版 Footer 編輯器，group_buys.group_buy_settings.footerView）→ 前台頁尾 HTML（fix3；純函式、不連 DB）。
// 標記比照 V1 編輯器右側預覽（templates/groupbuy/webeditor-footer.html 的 #footer-edit，原站 footerEditor.js reload() 的套色規則）：
//   左：Logo；中：資訊（每行一個 <p>）；右：選單 1–6（標題#連結）；下：FB／IG／LINE 圖示；最下：版權列（系統區塊背景色）。
// 外層 <footer class="page-footer …"> 由暫存（homeview.ts rebuildCache）加上，所以這裡用 div.footer-v1 帶文字色／背景色 class。
// 所有文字 HTML escape；連結只允許 http(s)／站內路徑／錨點／mailto／tel；顏色只接受 class 名稱字元。

export interface FooterV1 {
  footerInfo?: string;
  footerMenu?: string;
  footerTextColor?: string;
  footerBGColor?: string;
  footerSysBGColor?: string;
  facebookId?: string;
  instagramId?: string;
  lineId?: string;
  footerLogo?: string;
  footerLogoURL?: string;
  copyright?: string;
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escHtml = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

/** 只允許 http(s)、站內路徑、錨點、mailto/tel；其他（javascript: 等）→ ''（不輸出連結） */
export function safeLink(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (/^(https?:)?\/\//i.test(s) || s.startsWith("/") || s.startsWith("#") || s.startsWith("?") || /^(mailto|tel):/i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return "";
  return s;
}

/** class 名稱（顏色）：只留 [a-z0-9 -] */
export function cssClass(v: unknown): string {
  return String(v ?? "")
    .replace(/[^a-z0-9 -]/gi, "")
    .trim()
    .slice(0, 60);
}

/** Logo 網址：footerLogo 是上傳 id（或完整網址）時 → /upload/images/{id}；否則用 footerLogoURL */
export function footerV1Logo(fv: FooterV1): string {
  const logo = String(fv.footerLogo ?? "").trim();
  if (logo) return /^https?:\/\//i.test(logo) ? safeLink(logo) : `/upload/images/${encodeURI(logo.replace(/^\/+/, ""))}`;
  return safeLink(fv.footerLogoURL);
}

/** 選單「標題#連結」一行一個 */
export function footerV1Menu(text: unknown): { title: string; link: string }[] {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => {
      const i = line.indexOf("#");
      return i >= 0 ? { title: line.slice(0, i).trim(), link: line.slice(i + 1).trim() } : { title: line.trim(), link: "" };
    })
    .filter((m) => m.title);
}

/** 是否有任何內容（全空時發布會得到空頁尾） */
export function footerV1IsEmpty(fv: FooterV1): boolean {
  return !["footerInfo", "footerMenu", "facebookId", "instagramId", "lineId", "footerLogo", "footerLogoURL", "copyright"].some((k) => String((fv as Record<string, unknown>)[k] ?? "").trim());
}

export function renderFooterV1(fv: FooterV1): string {
  const text = cssClass(fv.footerTextColor);
  const bg = cssClass(fv.footerBGColor);
  const sys = cssClass(fv.footerSysBGColor);
  const logo = footerV1Logo(fv);
  const info = String(fv.footerInfo ?? "")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => `<p>${escHtml(l)}</p>`)
    .join("");
  const menu = footerV1Menu(fv.footerMenu)
    .map((m) => {
      const href = safeLink(m.link);
      return `<li>${href ? `<a class="${text}" href="${escHtml(href)}">${escHtml(m.title)}</a>` : `<span class="${text}">${escHtml(m.title)}</span>`}</li>`;
    })
    .join("");
  const social = [
    ["facebookId", "fab fa-facebook-square"],
    ["instagramId", "fab fa-instagram"],
    ["lineId", "fab fa-line"],
  ]
    .map(([k, icon]) => {
      const href = safeLink((fv as Record<string, unknown>)[k]);
      return href ? `<a class="btn-social-flat mx-1" href="${escHtml(href)}" target="_blank" rel="noopener noreferrer"><i class="${icon} ${text}"></i></a>` : "";
    })
    .join("");
  const copyright = String(fv.copyright ?? "").trim();
  return (
    `<div class="footer-v1 ${[bg, text].filter(Boolean).join(" ")}">` +
    `<div class="container text-center text-md-left"><div class="row">` +
    `<div class="col-md-3 mx-auto mb-3">${logo ? `<img class="img-fluid" style="max-height:80px" src="${escHtml(logo)}" alt="">` : ""}</div>` +
    `<div class="col-md-5 mx-auto mb-3">${info}</div>` +
    `<div class="col-md-4 mx-auto mb-3"><ul class="list-unstyled">${menu}</ul></div>` +
    `</div>` +
    (social ? `<div class="text-center">${social}</div>` : "") +
    `</div>` +
    (copyright ? `<div class="footer-copyright text-center py-3 ${sys}"><span>${escHtml(copyright)}</span></div>` : "") +
    `</div>`
  );
}
