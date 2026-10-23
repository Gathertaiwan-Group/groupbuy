#!/usr/bin/env python3
"""前台頁面 DOM 骨架相似度自查（storefront 模組）。

把原站 spec/html/<代號>.html 與本系統輸出的 HTML 各自正規化成「主內容區 DOM 骨架」序列後比對：
  - 元素 token：tag#id.class1.class2（class 排序；id/class 內的數字視為動態值換成 #）
  - 文字 token：可見文字（壓縮空白；數字換成 #）；<script>/<style> 只保留標籤、不比內容
  - 主內容區：預設 <body>（前台頁沒有後台側欄殼）；可用 --root 指定 tag#id
相似度 = difflib.SequenceMatcher(token 序列).ratio()；並列出差異段落。

用法：
  python3 dom_compare.py <原站.html> <我們的.html 或 http(s)://網址> [--root body|main#main|div#id|all] [--show 40] [--no-text]
"""
import argparse
import difflib
import re
import sys
import urllib.request
from html.parser import HTMLParser

VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
RAW = {"script", "style"}
NUM = re.compile(r"\d+")
WS = re.compile(r"\s+")


class Node:
    __slots__ = ("tag", "attrs", "children", "text", "parent")

    def __init__(self, tag, attrs=None, parent=None, text=None):
        self.tag = tag
        self.attrs = dict(attrs or [])
        self.children = []
        self.text = text
        self.parent = parent


class TreeBuilder(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("#root")
        self.cur = self.root
        self.raw_depth = 0

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs, self.cur)
        self.cur.children.append(node)
        if tag not in VOID:
            self.cur = node

    def handle_startendtag(self, tag, attrs):
        self.cur.children.append(Node(tag, attrs, self.cur))

    def handle_endtag(self, tag):
        n = self.cur
        while n is not None and n.tag != tag:
            n = n.parent
        if n is not None and n.parent is not None:
            self.cur = n.parent

    def handle_data(self, data):
        if self.cur.tag in RAW:
            return
        t = WS.sub(" ", data).strip()
        if t:
            self.cur.children.append(Node("#text", None, self.cur, t))


def parse(html):
    b = TreeBuilder()
    b.feed(html)
    b.close()
    return b.root


def find_root(node, spec):
    if spec in ("#root", "all"):  # 彈窗片段：整份比對
        return node
    tag, _, ident = spec.partition("#")
    stack = [node]
    while stack:
        n = stack.pop(0)
        if n.tag == tag and (not ident or n.attrs.get("id") == ident):
            return n
        stack.extend(n.children)
    return None


def norm_ident(s):
    return NUM.sub("#", s or "")


def tokens(node, with_text=True, out=None):
    if out is None:
        out = []
    for c in node.children:
        if c.tag == "#text":
            if with_text:
                out.append("T:" + NUM.sub("#", c.text)[:80])
            continue
        if c.tag.startswith("#"):
            continue
        cls = ".".join(sorted(norm_ident(x) for x in (c.attrs.get("class") or "").split() if x and x != "null"))
        ident = norm_ident(c.attrs.get("id") or "")
        tok = c.tag + ("#" + ident if ident else "") + ("." + cls if cls else "")
        out.append("<" + tok)
        if c.tag not in RAW:
            tokens(c, with_text, out)
    return out


def load(src):
    if src.startswith("http://") or src.startswith("https://"):
        req = urllib.request.Request(src, headers={"Accept-Language": "zh-TW", "User-Agent": "dom-compare/1.0"})
        try:
            with urllib.request.urlopen(req) as r:
                return r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:  # 403/404 頁也要比
            return e.read().decode("utf-8", "replace")
    with open(src, encoding="utf-8", errors="replace") as f:
        return f.read()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("orig")
    ap.add_argument("ours")
    ap.add_argument("--root", default="body")
    ap.add_argument("--show", type=int, default=30)
    ap.add_argument("--no-text", action="store_true")
    a = ap.parse_args()
    ra = find_root(parse(load(a.orig)), a.root)
    rb = find_root(parse(load(a.ours)), a.root)
    if ra is None or rb is None:
        print(f"找不到主內容區 {a.root}（orig={ra is not None} ours={rb is not None}）")
        sys.exit(2)
    ta = tokens(ra, not a.no_text)
    tb = tokens(rb, not a.no_text)
    sm = difflib.SequenceMatcher(None, ta, tb, autojunk=False)
    ratio = sm.ratio()
    print(f"similarity={ratio * 100:.2f}%  orig_tokens={len(ta)}  ours_tokens={len(tb)}")
    shown = 0
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal":
            continue
        if shown >= a.show:
            print("  …（其餘差異省略）")
            break
        left = " | ".join(ta[i1:i2])[:220]
        right = " | ".join(tb[j1:j2])[:220]
        print(f"  [{op}] orig[{i1}:{i2}] {left}\n         ours[{j1}:{j2}] {right}")
        shown += 1


if __name__ == "__main__":
    main()
