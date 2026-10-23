/*
 * 加退換商品精靈（/backend/ReturnRefund/wizard）＋退貨／換貨（/ajax/ReturnRefund/displayReturn）、
 * 補寄（/ajax/ReturnRefund/displayReshipment）表單。
 * orders 模組自寫：原站精靈各步驟畫面未擷取，依本系統後端契約（lib/modules/orders/returns.ts）推導。
 *   GET  /ajax/ReturnRefund/get?salesOrderId=            → {data: 訂單（sortedOrderItems[]）}
 *   POST /ajax/ReturnRefund/doReturn | doReshipment       data[<orderItemId>][orderItemId|total]、exchange_mode、staffNote
 *                                                         → {code:200, error:訊息, data:[{salesOrderId, uuid, relation}…]}
 *   POST /ajax/SalesOrder/createNewForReturnRefund        salesOrderId、markAsHolded → {code:200, data:{salesOrderId, uuid}}
 *   POST /ajax/SalesOrder/createAndMove                   salesOrderId → {code:200, data:{salesOrderId, uuid}}
 *   GET  /backend/ReturnRefund/displayReturnAndRefund     原單操作（returns-edit.js）
 */
(function ($, window) {
	'use strict';

	var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

	function esc(v) {
		return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
			return ESC[c];
		});
	}

	/** 後端訊息可能以 <br> 分行（多筆原因）；其餘內容一律跳脫 */
	function safeMsg(v) {
		return esc(v).replace(/&lt;br\s*\/?&gt;/gi, '<br>');
	}

	function money(v) {
		var n = Number(v);
		return isNaN(n) ? '0' : n.toLocaleString();
	}

	function errorOf(xhr, fallback) {
		var j = xhr && xhr.responseJSON;
		if (j && (j.error || j.message)) return j.error || j.message;
		return fallback || '系統忙碌中，請稍後再試（HTTP ' + (xhr ? xhr.status : '') + '）';
	}

	/** 背景頁面上以 ajax 載入的 DataTables（所有訂單、退換貨、保留單…）重新整理 */
	function reloadTables() {
		if (!$.fn.dataTable || !$.fn.dataTable.tables) return;
		$.each($.fn.dataTable.tables(), function (i, node) {
			var api = $(node).DataTable();
			var s = api.settings()[0];
			if (s && (s.ajax || s.sAjaxSource)) {
				try {
					api.ajax.reload(null, false);
				} catch (e) {
					/* 背景表重新整理失敗不影響精靈 */
				}
			}
		});
	}

	function openEditor(baseUrl, salesOrderId) {
		openFormF(baseUrl + '/backend/ReturnRefund/displayReturnAndRefund', 'salesOrderId=' + encodeURIComponent(salesOrderId));
	}

	var RRWizard = {
		esc: esc,
		safeMsg: safeMsg,
		money: money,
		errorOf: errorOf,
		reloadTables: reloadTables,
		openEditor: openEditor,

		/**
		 * 精靈第一步：選擇操作 → 下一步。
		 * o: {baseUrl, salesOrderId, uuid}
		 */
		init: function (o) {
			var $root = $('#rrWizard');
			var $choose = $('#rrWizardChoose');
			var $step = $('#rrWizardStep');
			var $next = $('#rrWizardNext');
			var $back = $('#rrWizardBack');

			function mark() {
				$choose.find('.rr-mode').removeClass('border border-primary');
				$choose.find('input[name=rrMode]:checked').closest('.rr-mode').addClass('border border-primary');
			}

			function clearMessage() {
				$root.find('.rr-panel .modal-message').empty().hide();
			}

			function showStep(panel) {
				clearMessage();
				$choose.hide();
				$next.hide();
				$back.show();
				$root.find('.rr-panel').hide();
				if (panel) $(panel).show();
			}

			function backToChoose() {
				clearMessage();
				$step.empty();
				$root.find('.rr-panel').hide();
				$choose.show();
				$next.show();
				$back.hide();
			}

			$choose.on('click', '.rr-mode', function (e) {
				var radio = $(this).find('input[name=rrMode]');
				if (radio.prop('disabled') || $(e.target).is('input, label')) return;
				radio.prop('checked', true).trigger('change');
			});
			$choose.on('change', 'input[name=rrMode]', mark);
			mark();

			$back.on('click', backToChoose);

			$next.on('click', function () {
				var mode = $choose.find('input[name=rrMode]:checked').val();
				switch (mode) {
					case 'edit':
						openEditor(o.baseUrl, o.salesOrderId);
						return;
					case 'return':
					case 'reshipment':
						showStep(null);
						$step.html('<div class="text-center grey-text p-4">載入中...</div>');
						$.ajax({
							type: 'GET',
							url: o.baseUrl + (mode === 'return' ? '/ajax/ReturnRefund/displayReturn' : '/ajax/ReturnRefund/displayReshipment'),
							data: { salesOrderId: o.salesOrderId },
						})
							.done(function (html) {
								$step.html(html);
							})
							.fail(function (xhr) {
								$step.html('<div class="alert alert-danger">' + safeMsg(errorOf(xhr, '無法載入表單')) + '</div>');
							});
						return;
					case 'newOrder':
						showStep('#rrNewOrderPanel');
						return;
					case 'move':
						showStep('#rrMovePanel');
						return;
				}
			});

			// 建立新單／重開新單（不需表單片段：直接送出）
			function createOrder(btn, url, data) {
				var $panel = btn.closest('.rr-panel');
				btnStartLoading(btn);
				btn.prop('disabled', true);
				$.ajax({ type: 'POST', url: url, data: data, dataType: 'json' })
					.done(function (json) {
						var made = json.data || {};
						btn.hide();
						$panel.find('input').prop('disabled', true);
						$panel
							.find('.rr-after-create')
							.html(
								'<button type="button" class="btn btn-primary btn-sm m-0 rr-open-editor" data-id="' +
									esc(made.salesOrderId) +
									'">開始修改訂單</button>',
							)
							.show();
						modalShowSuccess($panel, safeMsg(json.error || json.message || '已產生訂單 ' + (made.uuid || '')));
						reloadTables();
					})
					.fail(function (xhr) {
						modalShowDanger($panel, safeMsg(errorOf(xhr)));
						btn.prop('disabled', false);
					})
					.always(function () {
						btnStopLoading(btn);
					});
			}

			$root.on('click', '#rrNewOrderSubmit', function () {
				createOrder($(this), o.baseUrl + '/ajax/SalesOrder/createNewForReturnRefund.do', {
					salesOrderId: o.salesOrderId,
					markAsHolded: $('#rrMarkAsHolded').prop('checked'),
				});
			});
			$root.on('click', '#rrMoveSubmit', function () {
				createOrder($(this), o.baseUrl + '/ajax/SalesOrder/createAndMove.do', { salesOrderId: o.salesOrderId });
			});
			$root.on('click', '.rr-open-editor', function () {
				openEditor(o.baseUrl, $(this).attr('data-id'));
			});
		},

		/**
		 * 退貨／換貨、補寄表單：載入訂單商品 → 輸入數量 → 送出產生退貨（＋換貨）或補寄訂單。
		 * o: {formId, baseUrl, salesOrderId, kind: 'RETURN' | 'RESHIPMENT'}
		 */
		itemForm: function (o) {
			var kindLabel = o.kind === 'RETURN' ? '退貨' : '補寄';
			var $form = $('#' + o.formId);
			var $tbody = $form.find('tbody.rr-items');

			function stateText(it) {
				var t = [];
				if (it.backOrder) t.push('<span class="badge badge-success z-depth-0 mr-1">預購</span>');
				if (it.gift) t.push('<span class="badge badge-info z-depth-0 mr-1">贈品</span>');
				if (it.bundleRoot) t.push('<span class="badge badge-default z-depth-0 mr-1">組合</span>');
				return t.join('');
			}

			function render(items) {
				if (!items.length) {
					$tbody.html('<tr><td colspan="4" class="text-center grey-text">此訂單沒有商品</td></tr>');
					return;
				}
				$tbody.html(
					$.map(items, function (it) {
						var id = Number(it.orderItemId);
						var max = Math.max(0, parseInt(it.total, 10) || 0);
						var child = !!it.bundleChild && it.parentOrderItemId !== null && it.parentOrderItemId !== undefined;
						var off = max <= 0 ? ' disabled' : '';
						var title =
							esc(it.title) + (it.specificationsLabel ? ' <span class="small grey-text">(' + esc(it.specificationsLabel) + ')</span>' : '');
						return (
							'<tr data-id="' +
							id +
							'"' +
							(child ? ' data-parent="' + esc(it.parentOrderItemId) + '"' : '') +
							'>' +
							'<td' +
							(child ? ' class="pl-4"' : '') +
							'>' +
							(child ? '<span class="grey-text mr-1">└</span>' : '') +
							stateText(it) +
							title +
							'</td>' +
							'<td class="text-right">' +
							money(it.price) +
							'</td>' +
							'<td class="text-right">' +
							max +
							'</td>' +
							'<td>' +
							'<input type="hidden" name="data[' +
							id +
							'][orderItemId]" value="' +
							id +
							'"' +
							off +
							'>' +
							'<input type="text" inputmode="numeric" autocomplete="off" class="form-control form-control-sm text-right rr-qty" name="data[' +
							id +
							'][total]" value="0" data-max="' +
							max +
							'" data-title="' +
							esc(it.title) +
							'"' +
							off +
							'>' +
							'</td>' +
							'</tr>'
						);
					}).join(''),
				);
			}

			$.ajax({ type: 'GET', url: o.baseUrl + '/ajax/ReturnRefund/get.do', data: { salesOrderId: o.salesOrderId }, dataType: 'json' })
				.done(function (json) {
					render((json && json.data && json.data.sortedOrderItems) || []);
				})
				.fail(function (xhr) {
					$tbody.html('<tr><td colspan="4" class="text-danger">' + safeMsg(errorOf(xhr, '無法載入訂單商品')) + '</td></tr>');
				});

			// 組合商品：母項有輸入數量時，子項由母項依比例帶出（後端忽略子項自己的數量）→ 子項輸入停用
			$tbody.on('input change', '.rr-qty', function () {
				var tr = $(this).closest('tr');
				var on = (parseInt($(this).val(), 10) || 0) > 0;
				$tbody.find('tr[data-parent="' + tr.attr('data-id') + '"]').each(function () {
					var qty = $(this).find('.rr-qty');
					var off = on || (Number(qty.attr('data-max')) || 0) <= 0;
					$(this).find('input').prop('disabled', off);
					if (on) qty.val('0');
				});
			});

			$form.on('click', '.rr-qty-all', function () {
				$tbody.find('.rr-qty:enabled').each(function () {
					if (!$(this).closest('tr').attr('data-parent')) $(this).val($(this).attr('data-max')).trigger('change');
				});
			});

			$form.find('input[name=exchange_mode]').on('change', function () {
				$form.find('.rr-exchange-note').hide();
				$form.find('.rr-exchange-note[data-mode="' + $(this).val() + '"]').show();
			});

			// 前端先檢查數量（後端 orders_rr_create 也會再檢查一次）；必須在 initAjaxForm 之前綁定才能攔下送出
			$form.on('submit', function (e) {
				var errors = [];
				var picked = 0;
				$tbody.find('.rr-qty:enabled').each(function () {
					var v = $.trim($(this).val()) || '0';
					var max = Number($(this).attr('data-max')) || 0;
					var title = esc($(this).attr('data-title'));
					if (!/^\d+$/.test(v)) {
						errors.push('「' + title + '」' + kindLabel + '數量格式錯誤');
					} else if (Number(v) > max) {
						errors.push('「' + title + '」' + kindLabel + '數量 ' + Number(v) + ' 超過訂單剩餘數量 ' + max);
					} else {
						picked += Number(v);
					}
				});
				if (!errors.length && picked <= 0) errors.push('請選擇' + kindLabel + '商品');
				if (errors.length) {
					e.preventDefault();
					e.stopImmediatePropagation();
					modalShowDanger($form, errors.join('<br>'));
					return false;
				}
			});

			initAjaxForm(
				o.formId,
				function (json) {
					var made = json.data || [];
					var lines = [];
					if (made[0]) lines.push('成功產生' + kindLabel + '單：' + esc(made[0].uuid));
					if (made[1]) lines.push('換貨單：' + esc(made[1].uuid));
					var actions = '<a class="btn btn-default btn-sm ml-0" href="/backend/SalesOrderReturn/list">前往退換貨訂單</a>';
					if (made[1] && $form.find('input[name=exchange_mode]:checked').val() === 'diff') {
						actions +=
							'<button type="button" class="btn btn-primary btn-sm rr-open-editor" data-id="' + esc(made[1].salesOrderId) + '">編輯換貨單</button>';
					}
					$form.find('.rr-form-body').hide();
					$form.find('[type=submit]').hide();
					modalShowSuccess($form, (lines.length ? lines.join('、') : safeMsg(json.error)) + '<div class="mt-2">' + actions + '</div>');
					reloadTables();
				},
				function (json) {
					modalShowDanger($form, safeMsg((json && (json.error || json.message)) || '送出失敗'));
				},
			);

			$form.on('click', '.rr-open-editor', function () {
				openEditor(o.baseUrl, $(this).attr('data-id'));
			});
		},
	};

	window.RRWizard = RRWizard;
})(jQuery, window);
