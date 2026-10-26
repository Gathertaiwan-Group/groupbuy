/*
 * POS 作廢（本系統補充，fix3）：後台訂單列表與 POS「查詢訂單」分頁共用。
 * 流程：讀摘要（可否作廢、回補件數、沖銷金額）→ 確認並輸入作廢原因（選填）→ 送出 → 重新載入表格。
 * 原子操作在伺服器（DB 函式 pos_void_order）：回補已取貨庫存、沖銷付款明細、訂單改為已取消、寫歷程；重複作廢會被擋下。
 */
(function ($) {
	'use strict';

	function errorOf(x, fallback) {
		var j = x && x.responseJSON;
		return (j && (j.error || j.message)) || fallback;
	}

	window.GBPosVoid = {
		/**
		 * opts: { ids:[salesOrderId], previewUrl, voidUrl, onDone(response) }
		 */
		run: function (opts) {
			var ids = (opts.ids || []).filter(function (x) { return x; });
			if (!ids.length) { toastr.warning('請先選擇訂單'); return; }
			$.getJSON(opts.previewUrl, { salesOrderId: ids.join(',') }).done(function (r) {
				var list = (r && r.data) || [];
				var ok = list.filter(function (x) { return x.canVoid; });
				var lines = list.map(function (x) {
					return x.uuid + '：' + (x.canVoid ? '回補庫存 ' + x.restoredQty + ' 件、沖銷付款 $' + x.reversedAmount : '不可作廢（' + x.error + '）');
				});
				if (!ok.length) { toastr.warning(lines.join('\n') || '所選訂單皆不可作廢'); return; }
				var reason = window.prompt('確定要作廢以下 POS 訂單？作廢後訂單改為「已取消」，無法復原。\n\n' + lines.join('\n') + '\n\n作廢原因（選填）：', '');
				if (reason === null) return;
				$.post(opts.voidUrl, {
					salesOrderId: ok.map(function (x) { return x.salesOrderId; }).join(','),
					reason: reason
				}).done(function (res) {
					toastr.success((res && (res.message || res.error)) || '已作廢');
					if (opts.onDone) opts.onDone(res);
				}).fail(function (x) {
					toastr.error(errorOf(x, '作廢失敗'));
					if (opts.onDone) opts.onDone(null);
				});
			}).fail(function (x) {
				toastr.error(errorOf(x, '讀取訂單失敗'));
			});
		}
	};
})(jQuery);
