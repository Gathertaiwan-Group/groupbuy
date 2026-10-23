/*!
 * groupbuy compat：MDB PRO 元件行為補丁（自行撰寫，非 MDB PRO 程式碼）
 * 頁面先載入 MDB Free 4.8.8 JS（MIT），再載入本檔。提供原站用到的 PRO API：
 *   $.fn.sideNav、$.fn.collapsible、toastr、$.fn.materialSelect（最小相容）、
 *   以及後台側欄版面初始化 GBSideNav（原站 inline script 因擷取過濾不可得，依實際行為重寫）。
 */
(function ($, window, document) {
  'use strict';
  if (!$) return;

  /* ── collapsible（側欄手風琴）──────────────────────────────── */
  $.fn.collapsible = function (options) {
    var opts = $.extend({ accordion: true }, options);
    return this.each(function () {
      var $root = $(this);
      if ($root.data('gb-collapsible')) return;
      $root.data('gb-collapsible', true);
      $root.on('click.gbcollapsible', '> li > a.collapsible-header', function (e) {
        var $header = $(this);
        var $li = $header.parent();
        var $body = $header.next('.collapsible-body');
        if ($body.length === 0) return; // 單一連結（非群組）
        e.preventDefault();
        var opening = !$header.hasClass('active');
        if (opts.accordion && opening) {
          $root.children('li').not($li).each(function () {
            var $o = $(this);
            $o.removeClass('active');
            $o.children('a.collapsible-header').removeClass('active');
            $o.children('.collapsible-body').stop(true, false).slideUp(200);
          });
        }
        $li.toggleClass('active', opening);
        $header.toggleClass('active', opening);
        if (opening) $body.stop(true, false).slideDown(200);
        else $body.stop(true, false).slideUp(200);
      });
      // 初始：已標 active 的群組展開
      $root.children('li.active').each(function () {
        $(this).children('a.collapsible-header').addClass('active');
        $(this).children('.collapsible-body').show();
      });
    });
  };

  /* ── sideNav（小螢幕：按鈕滑出；大螢幕：固定）──────────────── */
  var overlay = null;
  function closeSideNav($side) {
    $side.removeClass('gb-shown');
    if (overlay) { overlay.remove(); overlay = null; }
    $('body').css('overflow', '');
  }
  function openSideNav($side) {
    $side.addClass('gb-shown');
    if (!overlay) {
      overlay = $('<div id="sidenav-overlay"></div>').appendTo('body');
      overlay.on('click', function () { closeSideNav($side); });
    }
    $('body').css('overflow', 'hidden');
  }
  $.fn.sideNav = function (options) {
    var opts = $.extend({ slim: false, breakpoint: 1199, closeOnClick: false }, options);
    if (options === 'show' || options === 'hide') {
      return this.each(function () {
        var $side = $('#' + $(this).attr('data-activates'));
        if (options === 'show') openSideNav($side); else closeSideNav($side);
      });
    }
    return this.each(function () {
      var $btn = $(this);
      var $side = $('#' + $btn.attr('data-activates'));
      $btn.data('gb-sidenav-opts', opts);
      $btn.off('click.gbsidenav').on('click.gbsidenav', function (e) {
        e.preventDefault();
        if ($side.hasClass('gb-shown') && $(window).width() <= opts.breakpoint) closeSideNav($side);
        else openSideNav($side);
      });
      if (opts.closeOnClick) {
        $side.on('click', 'a:not(.collapsible-header)', function () {
          if ($(window).width() <= opts.breakpoint) closeSideNav($side);
        });
      }
    });
  };

  /* ── 後台側欄版面（原站：cookie _side_nav_slim 記憶收合；依視窗寬度切換）── */
  var GBSideNav = {
    LBP: { md: 768, lg: 1200 },
    lbp: function () {
      var w = $(window).width();
      if (w < this.LBP.md) return 'sm';
      if (w < this.LBP.lg) return 'md';
      return 'lg';
    },
    isMini: function () {
      return window.Cookies ? Cookies.get('_side_nav_slim') === 'slim' : false;
    },
    setMini: function (mini) {
      if (!window.Cookies) return;
      if (mini) Cookies.set('_side_nav_slim', 'slim', { path: '/' });
      else Cookies.remove('_side_nav_slim', { path: '/' });
    },
    targets: function () {
      return $('nav.navbar.fixed-top, main, footer.page-footer');
    },
    display: function (mode) {
      // mode: on（展開 250px）/ mini（收合 70px）/ off（隱藏）
      var $t = this.targets();
      $t.addClass('side-fixed').removeClass('side-nav-on side-nav-mini');
      if (mode === 'on') $t.addClass('side-nav-on');
      else if (mode === 'mini') $t.addClass('side-nav-mini');
      $(document).trigger('sidebar.display', [mode]);
    },
    apply: function () {
      var $side = $('#slide-out');
      var $btn = $('#side-button');
      var $toggle = $('#toggle');
      if ($side.length === 0) return;
      var size = this.lbp();
      var mini = this.isMini();
      var $icon = $toggle.find('i');
      switch (size) {
        case 'lg':
          closeSideNav($side);
          $side.addClass('gb-shown');
          $btn.hide();
          $toggle.closest('li').show();
          $side.toggleClass('slim', mini);
          $icon.toggleClass('fa-angle-double-right', mini).toggleClass('fa-angle-double-left', !mini);
          this.display(mini ? 'mini' : 'on');
          break;
        case 'md':
          closeSideNav($side);
          $side.addClass('gb-shown slim');
          $btn.hide();
          $toggle.closest('li').hide();
          $icon.addClass('fa-angle-double-right').removeClass('fa-angle-double-left');
          this.display('mini');
          break;
        case 'sm':
        default:
          $side.removeClass('slim gb-shown');
          $toggle.closest('li').hide();
          $btn.show();
          this.display('off');
          break;
      }
    },
    openActive: function (activeHref) {
      // 原站：$('a[href*="'+location.pathname+'"]').closest('.collapsible-body').prev('.collapsible-header').click()
      var $side = $('#slide-out');
      var $links = $();
      if (activeHref) $links = $side.find('a[href="' + activeHref + '"]');
      if ($links.length === 0) {
        var p = window.location.pathname.replace(/\.do$/, '');
        $links = $side.find('a[href*="' + p + '"]');
      }
      var $headers = $links.closest('.collapsible-body').prev('.collapsible-header');
      $headers.first().each(function () {
        var $h = $(this);
        $h.addClass('active').parent().addClass('active');
        $h.next('.collapsible-body').show();
      });
    },
    init: function (activeHref) {
      var self = this;
      var $side = $('#slide-out');
      if ($side.length === 0) return;
      $side.find('.collapsible').collapsible();
      $('#side-button').sideNav({ slim: this.isMini(), breakpoint: this.LBP.md - 1 });
      this.openActive(activeHref);
      this.apply();
      $('main').css('min-height', 'calc(100vh - 172px)');
      $('#toggle').on('click', function (e) {
        e.preventDefault();
        if (self.lbp() !== 'lg') return;
        self.setMini(!self.isMini());
        self.apply();
      });
      var last = this.lbp();
      $(window).on('resize.gbsidenav', function () {
        var now = self.lbp();
        if (now !== last) {
          last = now;
          $(document).trigger('lbp.changed', [now]);
          self.apply();
        }
      });
      if ($.fn.tooltip) $('[data-toggle="tooltip"]').tooltip();
    }
  };
  window.GBSideNav = GBSideNav;

  // 原站側欄 script 內的全域函式
  if (typeof window.openUrlInNewTab !== 'function') {
    window.openUrlInNewTab = function (a, selector) {
      window.open($(selector).val(), '_blank');
    };
  }

  /* ── toastr（MDB PRO 內建；原站 ias_v5 用 toastr.success）──────── */
  if (!window.toastr) {
    var toastr = {
      options: { positionClass: 'md-toast-top-right', timeOut: 5000, closeButton: false, progressBar: false },
      _container: function () {
        var $c = $('#toast-container');
        if ($c.length === 0) $c = $('<div id="toast-container"></div>').addClass(this.options.positionClass || 'md-toast-top-right').appendTo('body');
        return $c;
      },
      _notify: function (type, message, title, overrides) {
        var o = $.extend({}, this.options, overrides || {});
        var $t = $('<div class="md-toast md-toast-' + type + '"></div>');
        if (o.closeButton) $t.append('<button type="button" class="md-toast-close-button" role="button">×</button>');
        if (title) $t.append($('<div class="md-toast-title"></div>').text(title));
        if (message) $t.append($('<div class="md-toast-message"></div>').html(message));
        var $c = this._container();
        $t.hide().appendTo($c).fadeIn(200);
        var remove = function () { $t.fadeOut(200, function () { $t.remove(); }); };
        $t.on('click', remove);
        if (o.timeOut > 0) setTimeout(remove, o.timeOut);
        return $t;
      },
      success: function (m, t, o) { return this._notify('success', m, t, o); },
      error: function (m, t, o) { return this._notify('error', m, t, o); },
      info: function (m, t, o) { return this._notify('info', m, t, o); },
      warning: function (m, t, o) { return this._notify('warning', m, t, o); },
      clear: function () { $('#toast-container').children().remove(); },
      remove: function () { $('#toast-container').remove(); }
    };
    window.toastr = toastr;
  }

  /* ── materialSelect（最小相容：保留原生 select 外觀）──────────── */
  if (!$.fn.materialSelect) {
    $.fn.materialSelect = function (options) {
      return this.each(function () {
        var $s = $(this);
        if (options && options.destroy) { $s.removeClass('gb-material-select'); return; }
        $s.addClass('gb-material-select browser-default custom-select');
      });
    };
  }
})(window.jQuery, window, document);
