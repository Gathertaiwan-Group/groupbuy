/*!
 * groupbuy CKFinder 相容樁（自行撰寫）。原站 CKFinder 為商業授權，不可散佈。
 * 原站僅在 DataTableHelper.injectCKFinder（目前頁面未啟用）呼叫 CKFinder.setupCKEditor；
 * 圖片上傳改由 /json/uploadImage/* 端點（Supabase Storage）處理。
 */
(function (window, $) {
  'use strict';
  if (window.CKFinder) return;
  function pickAndUpload(done) {
    var input = $('<input type="file" accept="image/*" style="display:none">').appendTo('body');
    input.on('change', function () {
      var file = this.files && this.files[0];
      if (!file) { input.remove(); return; }
      var fd = new FormData();
      fd.append('upload', file);
      $.ajax({ url: '/json/uploadImage/ckfinder?v=ck4', type: 'POST', data: fd, processData: false, contentType: false, dataType: 'json' })
        .done(function (json) {
          if (json && json.uploaded) done(json.url, json);
          else window.alert((json && json.error && json.error.message) || '上傳失敗');
        })
        .fail(function () { window.alert('上傳失敗'); })
        .always(function () { input.remove(); });
    });
    input.trigger('click');
  }
  window.CKFinder = {
    setupCKEditor: function (editor) {
      if (editor && editor.config) editor.config.filebrowserImageUploadUrl = '/json/uploadImage/vcf?v=ck4';
    },
    popup: function (opts) {
      opts = opts || {};
      pickAndUpload(function (url) {
        if (typeof opts.selectActionFunction === 'function') opts.selectActionFunction(url);
      });
    },
    modal: function (opts) { this.popup(opts); },
    widget: function () {}
  };
})(window, window.jQuery);
