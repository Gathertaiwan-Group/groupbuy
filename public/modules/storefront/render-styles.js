/*
 * 其他發布樣式的前台互動（推導：原站帳號沒有這些樣式的團購，原站前台未擷取；spec/SPEC.md §9 #7）。
 * 伺服器輸出與樣式3 相同的品項區（form-itemsets.html），本檔只依 data 屬性重新組織顯示：
 *  - 日曆樣式（body.gb-render-calendar）：section[data-event-date] → 月曆選日期，只顯示該日期的品項（場次＝品項內商品）。
 *    沒有日期的品項（加購等）一律顯示。已選的數量不因切換日期而清除（可跨日期下單）。
 *  - 套裝行程（body.gb-render-travel）：section[data-travel]（plan／hotel／departure／return／additional／other）→ 分步驟；
 *    「選擇方案」為單選：某方案數量 > 0 時，其他方案自動歸零（觸發原站 change 事件同步購物袋）。
 * 數量選擇、購物袋與結帳仍由原站 gb_shopping_cart.js／gb_checkout_form.js 處理。
 */
(function ($) {
  'use strict';
  if (!$) return;
  var WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var ymd = function (d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  // 快速導覽列（原站 quick-guide，jumpToAnchor）點到目前隱藏的品項時，先切到該品項的日期／步驟再捲動
  var reveal = [];
  // capture 階段：在按鈕自己的 onclick（jumpToAnchor 捲動）之前先顯示目標
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('.quick-guide .btn-quick-guide') : null;
    if (!btn) return;
    var target = $($(btn).attr('data-anchor'));
    if (target.length && !target.is(':visible')) reveal.forEach(function (fn) { fn(target); });
  }, true);
  function quickGuideSync() {}

  // ───────── 日曆樣式 ─────────
  function initCalendar() {
    var $secs = $('section.itemset-section[data-event-date]');
    if (!$secs.length) return;
    var byDate = {};
    $secs.each(function () {
      var d = $(this).attr('data-event-date');
      (byDate[d] = byDate[d] || []).push(this);
    });
    var dates = Object.keys(byDate).sort();
    var today = ymd(new Date());
    var selected = dates.filter(function (d) { return d >= today; })[0] || dates[0];
    var parts = selected.split('-');
    var view = { y: +parts[0], m: +parts[1] - 1 };

    var $box = $('<section class="gb-calendar py-4" id="gb-calendar"><div class="container"><div class="card"><div class="card-body">' +
      '<div class="d-flex align-items-center justify-content-between mb-3">' +
      '<button type="button" class="btn btn-sm btn-outline-secondary m-0 gb-cal-prev" aria-label="上個月"><i class="fa-light fa-angle-left"></i></button>' +
      '<h5 class="mb-0 gb-cal-title"></h5>' +
      '<button type="button" class="btn btn-sm btn-outline-secondary m-0 gb-cal-next" aria-label="下個月"><i class="fa-light fa-angle-right"></i></button></div>' +
      '<div class="gb-cal-grid" role="grid"></div>' +
      '<p class="small text-muted mt-3 mb-0 gb-cal-selected" aria-live="polite"></p></div></div></div></section>');
    $box.insertBefore($('section.itemset-section').first());

    function render() {
      $box.find('.gb-cal-title').text(view.y + ' 年 ' + (view.m + 1) + ' 月');
      var first = new Date(view.y, view.m, 1);
      var days = new Date(view.y, view.m + 1, 0).getDate();
      var html = WEEK.map(function (w) { return '<div class="gb-cal-head">' + w + '</div>'; }).join('');
      for (var i = 0; i < first.getDay(); i++) html += '<div class="gb-cal-cell gb-cal-blank"></div>';
      for (var d = 1; d <= days; d++) {
        var key = view.y + '-' + pad(view.m + 1) + '-' + pad(d);
        var has = !!byDate[key];
        var cls = 'gb-cal-cell' + (has ? ' gb-cal-has' : '') + (key === selected ? ' gb-cal-active' : '') + (key < today ? ' gb-cal-past' : '');
        html += has
          ? '<button type="button" class="' + cls + '" data-date="' + key + '" aria-pressed="' + (key === selected) + '"><span>' + d + '</span><small>' + byDate[key].length + ' 場</small></button>'
          : '<div class="' + cls + '"><span>' + d + '</span></div>';
      }
      $box.find('.gb-cal-grid').html(html);
      var n = 0;
      $(byDate[selected] || []).each(function () { n += $(this).find('select.input-number-total').length; });
      $box.find('.gb-cal-selected').text('已選擇日期：' + selected + '（' + (byDate[selected] || []).length + ' 個品項、' + n + ' 個場次）');
    }
    function apply() {
      $secs.each(function () { $(this).toggle($(this).attr('data-event-date') === selected); });
      quickGuideSync();
      render();
    }
    $box.on('click', '.gb-cal-has', function () { selected = $(this).attr('data-date'); apply(); });
    reveal.push(function ($t) { var d = $t.attr('data-event-date'); if (d && byDate[d]) { selected = d; var p = d.split('-'); view = { y: +p[0], m: +p[1] - 1 }; apply(); } });
    $box.on('click', '.gb-cal-prev', function () { view.m--; if (view.m < 0) { view.m = 11; view.y--; } render(); });
    $box.on('click', '.gb-cal-next', function () { view.m++; if (view.m > 11) { view.m = 0; view.y++; } render(); });
    apply();
  }

  // ───────── 套裝行程 ─────────
  var STEPS = [
    ['plan', '選擇方案'], ['hotel', '住宿'], ['departure', '去程'], ['return', '回程'], ['additional', '加購'], ['other', '其他']
  ];
  function initTravel() {
    var $secs = $('section.itemset-section[data-travel]');
    if (!$secs.length) return;
    var steps = STEPS.filter(function (s) { return $secs.filter('[data-travel="' + s[0] + '"]').length; });
    var cur = 0;
    var $nav = $('<section class="gb-travel-steps pt-4" id="gb-travel-steps"><div class="container"><ol class="gb-steps"></ol><p class="small text-muted mb-0 gb-travel-plan"></p></div></section>');
    var $pager = $('<section class="gb-travel-pager pb-4"><div class="container d-flex justify-content-between">' +
      '<button type="button" class="btn btn-outline-secondary m-0 gb-travel-prev">上一步</button>' +
      '<button type="button" class="btn btn-primary m-0 gb-travel-next">下一步</button></div></section>');
    $nav.insertBefore($secs.first());
    $pager.insertAfter($secs.last());
    $nav.find('.gb-steps').html(steps.map(function (s, i) {
      return '<li><button type="button" class="gb-step" data-step="' + i + '"><span class="gb-step-no">' + (i + 1) + '</span>' + s[1] + '</button></li>';
    }).join(''));

    function planText() {
      var picked = [];
      $secs.filter('[data-travel="plan"]').find('select.input-number-total').each(function () {
        if (parseInt($(this).val(), 10) > 0) picked.push($(this).closest('.card-item').find('.item-inner-title').text() + ' × ' + $(this).val());
      });
      $nav.find('.gb-travel-plan').html(picked.length ? '已選方案：' + esc(picked.join('、')) : '請先選擇一個方案');
    }
    function show(i) {
      cur = Math.max(0, Math.min(steps.length - 1, i));
      $secs.each(function () { $(this).toggle($(this).attr('data-travel') === steps[cur][0]); });
      $nav.find('.gb-step').each(function (k) { $(this).toggleClass('active', k === cur).toggleClass('done', k < cur).attr('aria-current', k === cur ? 'step' : null); });
      $pager.find('.gb-travel-prev').prop('disabled', cur === 0);
      $pager.find('.gb-travel-next').text(cur === steps.length - 1 ? '填寫訂購資料' : '下一步');
      quickGuideSync();
    }
    $nav.on('click', '.gb-step', function () { show(+$(this).attr('data-step')); });
    reveal.push(function ($t) { var g = $t.attr('data-travel'); for (var k = 0; k < steps.length; k++) if (steps[k][0] === g) show(k); });
    $pager.on('click', '.gb-travel-prev', function () { show(cur - 1); $('html,body').animate({ scrollTop: $nav.offset().top - 80 }, 200); });
    $pager.on('click', '.gb-travel-next', function () {
      if (cur === steps.length - 1) {
        var $a = $('#section-address');
        if ($a.length) $('html,body').animate({ scrollTop: $a.offset().top - 80 }, 300);
        return;
      }
      show(cur + 1);
      $('html,body').animate({ scrollTop: $nav.offset().top - 80 }, 200);
    });
    // 方案單選：選了一個方案（數量 > 0），其他方案歸零並觸發 change（同步購物袋）
    $(document).on('change.gbTravel', 'section[data-travel="plan"] select.input-number-total', function () {
      var me = this;
      if (parseInt($(me).val(), 10) > 0) {
        $('section[data-travel="plan"] select.input-number-total').each(function () {
          if (this !== me && parseInt($(this).val(), 10) > 0) $(this).val('0').trigger('change');
        });
      }
      planText();
    });
    planText();
    show(0);
  }

  $(function () {
    if ($('body').hasClass('gb-render-calendar')) initCalendar();
    if ($('body').hasClass('gb-render-travel')) initTravel();
  });
})(window.jQuery);
