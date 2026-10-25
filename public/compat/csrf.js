/* 後台 CSRF token 注入（lib/core/http/csrf.ts）。由伺服器自動插入每個後台頁面的 </head> 前。
 * token 取自 cookie GBXSRF（每次請求時讀取，重新登入後自動換新），只送往同源網址：
 *  1) jQuery：全域 ajax 設定（$.ajaxPrefilter）加 X-CSRF-Token 標頭 → 原站 $.ajax／$.post／DataTables／Editor 不需修改
 *  2) 非 jQuery 的 XMLHttpRequest、fetch：同源的寫入請求補標頭
 *  3) 原生表單送出（含程式呼叫 form.submit()）：POST 到同源時補隱藏欄位 _csrf
 */
(function () {
  "use strict";
  if (window.__gbCsrfInstalled) return;
  window.__gbCsrfInstalled = true;
  var HEADER = "X-CSRF-Token";
  var FIELD = "_csrf";
  function token() {
    var m = document.cookie.match(/(?:^|;\s*)GBXSRF=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : "";
  }
  function sameOrigin(url) {
    try {
      return new URL(url, window.location.href).origin === window.location.origin;
    } catch (e) {
      return false;
    }
  }
  function unsafe(method) {
    return !/^(GET|HEAD|OPTIONS|TRACE)$/i.test(method || "GET");
  }

  // 2) XMLHttpRequest（jQuery 也走這裡；已帶標頭時不重複）
  var XO = XMLHttpRequest.prototype.open;
  var XS = XMLHttpRequest.prototype.send;
  var XH = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__gbCsrf = { method: method, url: url, set: false };
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name) {
    if (this.__gbCsrf && String(name).toLowerCase() === HEADER.toLowerCase()) this.__gbCsrf.set = true;
    return XH.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var c = this.__gbCsrf;
    if (c && !c.set && unsafe(c.method) && sameOrigin(c.url)) {
      var t = token();
      if (t) XH.call(this, HEADER, t);
    }
    return XS.apply(this, arguments);
  };

  // fetch
  if (window.fetch) {
    var F = window.fetch;
    window.fetch = function (input, init) {
      try {
        var url = typeof input === "string" ? input : input && input.url;
        var method = (init && init.method) || (input && input.method) || "GET";
        if (unsafe(method) && sameOrigin(url)) {
          var t = token();
          if (t) {
            init = init || {};
            var h = new Headers(init.headers || (typeof input !== "string" && input.headers) || {});
            if (!h.has(HEADER)) h.set(HEADER, t);
            init.headers = h;
          }
        }
      } catch (e) {}
      return F.call(this, input, init);
    };
  }

  // 3) 原生表單
  function addField(form) {
    try {
      if (!form || String(form.method || "get").toLowerCase() !== "post") return;
      if (!sameOrigin(form.action || window.location.href)) return;
      var t = token();
      if (!t) return;
      var el = form.querySelector('input[name="' + FIELD + '"]');
      if (!el) {
        el = document.createElement("input");
        el.type = "hidden";
        el.name = FIELD;
        form.appendChild(el);
      }
      el.value = t;
    } catch (e) {}
  }
  document.addEventListener("submit", function (e) { addField(e.target); }, true);
  var FS = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () {
    addField(this);
    return FS.apply(this, arguments);
  };

  // 1) jQuery 全域 ajax 設定（jQuery 可能在本檔之後才載入 → DOMContentLoaded 再試一次）
  function setupJq() {
    var $ = window.jQuery;
    if (!$ || !$.ajaxPrefilter || $.__gbCsrf) return;
    $.__gbCsrf = true;
    $.ajaxPrefilter(function (options) {
      if (!unsafe(options.type || options.method) || !sameOrigin(options.url || window.location.href)) return;
      var t = token();
      if (!t) return;
      options.headers = options.headers || {};
      if (!options.headers[HEADER]) options.headers[HEADER] = t;
    });
  }
  setupJq();
  document.addEventListener("DOMContentLoaded", setupJq);
})();
