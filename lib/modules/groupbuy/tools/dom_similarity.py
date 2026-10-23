#!/usr/bin/env python3
"""頁面一致性自查：把原站 spec/html/<代號>.html 與本系統輸出各自正規化成「主內容區 DOM 骨架」後比對。

用法：
  python3 dom_similarity.py <原站.html> <我們的.html 或 URL> [--jar cookie檔] [--fragment] [--show 40]

- 主內容區：整頁＝「<!--/. Sidebar navigation」之後到 </main>（側欄之後的頁面內容，與原站版面殼切點相同）；
  --fragment（彈窗片段）＝整份。
- 骨架 token：開始標籤 `tag#id.class1.class2`（class 排序）＋可見文字（空白壓縮、數字換成 #）。
  script/style 內容不算；原站擷取缺段 ⟦未擷取:N字元⟧ 視為斷點（結束 script/style 狀態），缺段本身不算 token。
- 相似度＝difflib.SequenceMatcher ratio（2*M/T）。另列出差異段落（最多 --show 筆）。
只讀檔案／發 GET，不寫任何東西。
"""
import difflib
import html
import re
import sys
import urllib.request
from html.parser import HTMLParser

GAP_RE = re.compile(r"⟦未擷取:\d+字元⟧")
DYNAMIC_ATTR_VALUE = re.compile(r"\d")


class Skeleton(HTMLParser):
    VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tokens = []
        self.raw_mode = None  # 'script' | 'style'

    def handle_starttag(self, tag, attrs):
        if self.raw_mode:
            return
        a = dict(attrs)
        tok = tag
        if a.get("id"):
            tok += "#" + DYNAMIC_ATTR_VALUE.sub("#", a["id"])
        cls = sorted(set((a.get("class") or "").split()))
        if cls:
            tok += "." + ".".join(cls)
        if tag == "input" and a.get("type"):
            tok += "[" + a["type"] + "]"
        self.tokens.append("<" + tok + ">")
        if tag in ("script", "style"):
            self.raw_mode = tag

    def handle_endtag(self, tag):
        if self.raw_mode and tag == self.raw_mode:
            self.raw_mode = None

    def handle_data(self, data):
        if self.raw_mode:
            return
        t = re.sub(r"\s+", " ", data).strip()
        if not t:
            return
        t = re.sub(r"\d", "#", t)
        self.tokens.append(t)


def skeleton(text):
    """缺段切成多段分別解析（每段重置 script/style 狀態）。回傳 (tokens, 缺段所在的 token 位置集合)"""
    toks = []
    gaps = set()
    parts = GAP_RE.split(text)
    for k, part in enumerate(parts):
        if k > 0:
            gaps.add(len(toks))
        p = Skeleton()
        try:
            p.feed(part)
            p.close()
        except Exception:
            pass
        toks.extend(p.tokens)
    # 區段開頭的殘留文字（缺段吞掉 <script> 結尾時，側欄 script 的程式碼殘片）不算
    while toks and not toks[0].startswith("<"):
        toks.pop(0)
        gaps = {g - 1 for g in gaps if g > 0} | ({0} if gaps else set())
    return toks, gaps


def main_region(text, fragment):
    if fragment:
        return text
    start = text.find("<!--/. Sidebar navigation")
    if start < 0:
        m = re.search(r"<main[\s>]", text)
        start = m.start() if m else 0
    end = text.rfind("</main>")
    if end < 0:
        end = len(text)
    region = text[start:end]
    # 跳過側欄後的那支側欄 script（原站與我們版面殼相同的位置）
    region = re.sub(r"^<!--/\. Sidebar navigation[^>]*-->\s*<script>.*?</script>", "", region, count=1, flags=re.S)
    return region


def load(arg, jar):
    if arg.startswith("http://") or arg.startswith("https://"):
        req = urllib.request.Request(arg)
        if jar:
            cookies = []
            for line in open(jar, encoding="utf-8"):
                if line.startswith("#") and not line.startswith("#HttpOnly_"):
                    continue
                parts = line.rstrip("\n").split("\t")
                if len(parts) >= 7:
                    cookies.append(parts[5] + "=" + parts[6])
            req.add_header("Cookie", "; ".join(cookies))
        with urllib.request.urlopen(req) as r:
            return r.read().decode("utf-8", "replace")
    return open(arg, encoding="utf-8").read()


def main():
    args = sys.argv[1:]
    jar = None
    fragment = False
    show = 40
    pos = []
    i = 0
    while i < len(args):
        if args[i] == "--jar":
            jar = args[i + 1]
            i += 2
        elif args[i] == "--fragment":
            fragment = True
            i += 1
        elif args[i] == "--show":
            show = int(args[i + 1])
            i += 2
        else:
            pos.append(args[i])
            i += 1
    orig_text = load(pos[0], None)
    ours_text = load(pos[1], jar)
    a, gaps = skeleton(main_region(orig_text, fragment))
    b, _ = skeleton(main_region(ours_text, fragment))
    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    ratio = sm.ratio()
    matched = sum(i2 - i1 for op, i1, i2, j1, j2 in sm.get_opcodes() if op == "equal")
    explained = 0  # 位於原站擷取缺段處的差異（原站內容本來就缺，不是我們的差異）
    n = 0
    lines = []
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal":
            continue
        at_gap = any(g in gaps for g in range(i1, i2 + 2))
        if at_gap:
            explained += (i2 - i1) + (j2 - j1)
        n += 1
        if n > show:
            continue
        left = " ".join(a[i1:i2])[:220]
        right = " ".join(b[j1:j2])[:220]
        lines.append(f"- {op}{' [缺段處]' if at_gap else ''} 原[{i1}:{i2}] {left!r}\n  → 本[{j1}:{j2}] {right!r}")
    total = len(a) + len(b)
    adjusted = (2 * matched + explained) / total if total else 1.0
    print(f"tokens 原站={len(a)} 本系統={len(b)}  相似度={ratio * 100:.1f}%  （排除原站缺段處差異後={adjusted * 100:.1f}%）")
    print("\n".join(lines))
    if n > show:
        print(f"…另有 {n - show} 段差異")


if __name__ == "__main__":
    main()
