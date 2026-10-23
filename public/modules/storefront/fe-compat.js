/*
 * storefront 前台 MDB PRO 行為補丁（MDB Free 4.8.8 沒有的前台 jQuery 行為）：
 * - #mdb-preloader：window.load 或 2 秒後淡出（PRO 行為）
 * - .chip .close：移除 chip
 * - .smooth-scroll a[href^="#"]：700ms 平滑捲動
 * - .fixed-action-btn：滑過時展開子按鈕（原站未用 ul，保留行為）
 * 依據：MDB PRO 缺口報告 F1–F3（只依外觀與行為描述重寫）。
 */
(function ($) {
  if (!$) return;
  $(function () {
    $('body').attr('aria-busy', true);
    var hidePreloader = function () {
      $('#mdb-preloader').fadeOut('slow');
      $('body').removeAttr('aria-busy');
    };
    $(window).on('load', hidePreloader);
    setTimeout(hidePreloader, 2000);

    $(document).on('click', '.chip .close', function () {
      var $chip = $(this).closest('.chip');
      if ($chip.closest('.chips').length === 0) $chip.remove();
    });

    $(document).on('click', '.smooth-scroll a[href^="#"]', function (e) {
      var href = $(this).attr('href');
      if (!href || href === '#') return;
      var $t = $(href);
      if ($t.length === 0) return;
      e.preventDefault();
      var offset = parseInt($(this).closest('.smooth-scroll').attr('data-offset') || '0', 10) || 0;
      $('html, body').animate({ scrollTop: $t.offset().top - offset }, 700);
      if ($(this).closest('.smooth-scroll').is('[data-allow-hashes]') && window.history && history.replaceState) {
        history.replaceState(null, '', href);
      }
      return false;
    });

    $(document).on('mouseenter', '.fixed-action-btn', function () {
      $(this).addClass('active').find('ul .btn-floating').addClass('shown');
    }).on('mouseleave', '.fixed-action-btn', function () {
      $(this).removeClass('active').find('ul .btn-floating').removeClass('shown');
    });
  });
})(window.jQuery);
