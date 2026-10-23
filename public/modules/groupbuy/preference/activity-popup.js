/*
 * 團購列表展開卡片「彈出活動」：全域 editActivitySettings(groupBuyId)。
 *
 * 原站此函式定義在 /public/scripts/dataTable.api.min.js（版面殼已載入；GroupBuyPreferenceSettings 類別＋gbpSettings 實例），
 * 所以後台頁面通常已經有這個函式——本檔只在它不存在時補上「同等」實作，絕不覆寫原站版本。
 *
 * 行為（與原站相同）：
 *   GET  {GBF.baseUrl}/ajax/GroupBuyPreference/activityPopupSettings?groupBuyId=<id>
 *        → {data:{image,imageUrl,imageMobile,imageMobileUrl,icon,iconUrl,link,startDateString,endDateString,groupBuyPreferenceId?}, recordsTotal, recordsFiltered, dateModified, executionTime, options}
 *   開 Editor（create 模式）填入目前值 → 「更新」
 *   POST 同網址：action=create&data[0][image]=…&data[0][startDateString]=YYYY-MM-DD HH:mm …
 *        → {data:[{…設定, groupBuyPreferenceId}]}；欄位錯誤 {fieldErrors:[{name,status}], data:[]}
 * 只依賴版面殼已載入的全域：jQuery、$.fn.dataTable.Editor（相容 shim）、DataTableConfig、GBF。
 */
(function (w, $) {
  if (!$ || typeof w.editActivitySettings === 'function') return;

  var editors = {};

  function editorFor(groupBuyId) {
    if (editors[groupBuyId]) return editors[groupBuyId];
    var url = GBF.baseUrl + '/ajax/GroupBuyPreference/activityPopupSettings?groupBuyId=' + groupBuyId;
    editors[groupBuyId] = new $.fn.dataTable.Editor({
      ajax: {
        create: { type: 'POST', url: url },
        remove: { type: 'POST', url: GBF.baseUrl + '/ajax/GroupBuyPreference/delete?groupBuyPreferenceId=_id_' }
      },
      idSrc: 'groupBuyPreferenceId',
      fields: [
        DataTableConfig.field_upload('圖片(預設)', 'image'),
        DataTableConfig.field_input('圖片連結(預設)', 'imageUrl'),
        DataTableConfig.field_upload('圖片(手機版)', 'imageMobile'),
        DataTableConfig.field_input('圖片連結(手機版)', 'imageMobileUrl'),
        DataTableConfig.field_upload('小圖示', 'icon'),
        DataTableConfig.field_input('圖示連結', 'iconUrl', '', '', '', '48x48'),
        DataTableConfig.field_input('點擊連結', 'link'),
        DataTableConfig.field_datetime('開始時間', 'startDateString', 'YYYY-MM-DD HH:mm', '', ''),
        DataTableConfig.field_datetime('結束時間', 'endDateString', 'YYYY-MM-DD HH:mm', '', '')
      ],
      formOptions: DataTableConfig.formOptions,
      i18n: DataTableConfig.i18n
    });
    return editors[groupBuyId];
  }

  w.editActivitySettings = function (groupBuyId) {
    var ed = editorFor(groupBuyId);
    $.ajax({
      url: GBF.baseUrl + '/ajax/GroupBuyPreference/activityPopupSettings?groupBuyId=' + groupBuyId,
      dataType: 'json',
      success: function (json) {
        var data = (json && json.data) || {};
        ed.title('前台-官網彈出活動設定')
          .message('圖片以及小圖示必須提供才會生效。可透過上傳圖片或是提供連結設定')
          .buttons([
            { label: '更新', className: 'btn-primary', tabIndex: 0, action: function () { this.submit(); } },
            { label: '關閉', className: 'btn-default', tabIndex: 1, action: function () { this.close(); } }
          ])
          .create(false);
        $.each(data, function (name, value) {
          if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            Object.keys(value).forEach(function (k) {
              var f = name + '.' + k;
              if (ed.s.fields[f]) ed.set(f, value[k]);
            });
          } else if (ed.s.fields[name]) {
            ed.set(name, value);
          }
        });
        ed.open();
      }
    });
  };
})(window, window.jQuery);
