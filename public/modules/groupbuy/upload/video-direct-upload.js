/*
 * 上傳影片（/backend/Upload/uploadVideo）：Supabase Storage 簽名直傳。groupbuy 模組。
 * 原站把檔案 multipart 一次 POST 到外部主機；本系統部署在 Vercel（請求上限 4.5MB），影片改由瀏覽器直傳 Storage：
 *   1) POST opts.url（/ajax/Upload/signVideoUpload）{ fileName, contentType, size } → { signedUrl, path, contentType } 或 { error }
 *   2) PUT 檔案到 signedUrl（Supabase Storage，簽名 token 授權，不需金鑰）
 *   3) POST opts.completeUrl（/ajax/Upload/saveVideoUpload）{ path, fileName } → { upload: { id } } 或 { error }
 * 介面與原站頁面的 $.ajax 選項相同（data 為含 'upload' 檔案的 FormData；success(json)／error(xhr, status, error)），
 * 頁面原本的成功／失敗處理（toastr、displayError、displayVideoLink）不用改。
 */
(function (window, $) {
	'use strict';

	function jsonError(xhr) {
		var j = xhr && xhr.responseJSON;
		if (!j && xhr && xhr.responseText) {
			try { j = JSON.parse(xhr.responseText); } catch (e) { j = null; }
		}
		if (!j) return '';
		if (typeof j.error === 'string') return j.error;
		if (j.error && j.error.message) return j.error.message;
		return j.message || '';
	}

	// Storage 錯誤（HTTP 400，body 例：{ statusCode:'413', error:'Payload too large', code:'EntityTooLarge' }）
	function storageError(xhr, sign) {
		var j = null;
		try { j = JSON.parse(xhr.responseText || 'null'); } catch (e) { j = null; }
		j = j || {};
		var code = String(j.statusCode || xhr.status || '');
		var text = [j.error, j.message, j.code].join(' ');
		if (code === '413' || /too large|maximum allowed size|EntityTooLarge/i.test(text)) {
			return '檔案大小超過 ' + Math.round((sign.maxBytes || 4194304) / 1048576) + 'MB 限制';
		}
		if (code === '415' || /mime/i.test(text)) return '僅支援 mp4、m4v、mov、webm 影片';
		return '上傳到儲存空間失敗' + (xhr.status ? '（HTTP ' + xhr.status + '）' : '');
	}

	function ajax(opts) {
		var success = typeof opts.success === 'function' ? opts.success : function () {};
		var error = typeof opts.error === 'function' ? opts.error : function () {};
		var file = opts.data && typeof opts.data.get === 'function' ? opts.data.get('upload') : null;
		// 伺服器回的業務錯誤（{ error }）交給頁面的 success → 顯示「檔案上傳失敗: …」（同原站）；連線錯誤交給 error
		var fail = function (xhr, status, err) {
			var msg = jsonError(xhr);
			if (msg) success({ error: msg });
			else error(xhr, status, err || (xhr && xhr.statusText) || '網路錯誤');
		};
		if (!file) {
			success({ error: '沒有收到檔案' });
			return;
		}
		$.ajax({
			url: opts.url,
			type: 'POST',
			dataType: 'json',
			data: { fileName: file.name, contentType: file.type || '', size: file.size }
		}).done(function (sign) {
			if (!sign || sign.error || !sign.signedUrl) {
				success({ error: (sign && sign.error) || '無法取得上傳網址' });
				return;
			}
			var xhr = new XMLHttpRequest();
			xhr.open('PUT', sign.signedUrl, true);
			xhr.setRequestHeader('Content-Type', sign.contentType || file.type);
			xhr.setRequestHeader('Cache-Control', 'max-age=31536000');
			xhr.setRequestHeader('x-upsert', 'false');
			xhr.onload = function () {
				if (xhr.status < 200 || xhr.status >= 300) {
					success({ error: storageError(xhr, sign) });
					return;
				}
				$.ajax({
					url: opts.completeUrl,
					type: 'POST',
					dataType: 'json',
					data: { path: sign.path, fileName: file.name }
				}).done(function (json) {
					success(json || {});
				}).fail(fail);
			};
			xhr.onerror = function () {
				error(xhr, 'error', '網路錯誤');
			};
			xhr.send(file);
		}).fail(fail);
	}

	window.GBVideoUpload = { ajax: ajax };
})(window, jQuery);
