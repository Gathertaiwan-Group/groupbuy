/*
 * POS 頁面腳本（在原站 pos-main.js 之後載入）。
 * 1) 寫入端點改用 POST：原站 pos-main.js 以 $.get 呼叫建立/綁定/刪除/加入/更新/登出等端點；本系統所有會改資料的端點只收 POST
 *    （SameSite=Lax cookie 在跨站頂層 GET 導覽仍會送出），所以在這裡覆寫 orderService 的方法，不修改原站檔。
 * 2) 原站 inline 行為（推導）：分頁延遲載入、查詢訂單 DataTable、QR Code 產生、自動/手動折扣標籤、商品排序、
 *    現金找零（本系統補充）、收據列印、keepalive。
 */
(function () {
	'use strict';

	/* ── 1) 寫入改 POST ───────────────────────────────── */
	orderService.createDraftOrder = function (customerId) {
		var d = { groupBuyId: groupBuyId };
		if (customerId) d.customerId = customerId;
		return $.post(GBF.ctxPosAjax + '/SalesOrder/create.do', d).promise();
	};
	orderService.updateCustomer = function (salesOrderId, customerId) {
		return $.post(GBF.ctxPosAjax + '/SalesOrder/bind.do', { salesOrderId: salesOrderId, customerId: customerId }).promise();
	};
	orderService.prepareReturnAndRefund = function (salesOrderId) {
		return $.post(baseUrl + '/ajax/ReturnRefund/prepare.do', { salesOrderId: salesOrderId }).promise();
	};
	orderService.cancelOrder = function (salesOrderId) {
		return $.post(GBF.ctxPosAjax + '/SalesOrder/delete.do', { salesOrderId: salesOrderId }).promise();
	};
	orderService.updateOrderItem = function (data) {
		return $.post(baseUrl + '/ajax/ReturnRefund/updateOrderItem.do', data).promise();
	};
	orderService.addOrderItem = function (data) {
		return $.post(baseUrl + '/ajax/ReturnRefund/addOrderItem.do', data).promise();
	};
	orderService.getOrder = function (data) {
		return $.post(GBF.ctxPosAjax + '/SalesOrder/get.do', data).promise();
	};
	window.adminUserSignout = function () {
		$.post(GBF.ctxPosAjax + '/AdminUser/logout.do').then(function (data) {
			if (data.code === 200) location.reload();
		});
	};

	/* 現金找零：結帳送出時附上現金實收（本系統補充欄位） */
	var origCheckout = orderService.checkout;
	orderService.checkout = function (ajaxData) {
		ajaxData = $.extend({}, ajaxData, { cashReceived: window.posCashReceived || '' });
		return origCheckout.call(orderService, ajaxData);
	};

	/* ── 2) 自動／手動折扣按鈕 ─────────────────────── */
	$('.btn-auto-discount').on('click', function (e) {
		if ($(e.target).is('input, label')) return;
		$('#autoApplySalesRules').prop('checked', !$('#autoApplySalesRules').prop('checked')).trigger('change');
	});
	$('#autoApplySalesRules').on('change', function () {
		var on = $(this).prop('checked');
		$('#autoApplySalesRulesLabel').text(on ? '自動折扣' : '手動折扣');
		$('.btn-auto-discount').toggleClass('manual', !on);
		if (on && orderManager.currentSalesOrder) {
			$.post(baseUrl + '/ajax/ReturnRefund/applySalesRules.do', { salesOrderId: orderManager.currentSalesOrder.salesOrderId }).then(function (r) { reloadItems(r); });
		}
	});

	/* ── 商品排序 ────────────────────────────────── */
	$(document).on('click', '.js-item-sort', function (e) {
		e.preventDefault();
		$('.js-item-sort').removeClass('active');
		$(this).addClass('active');
		$('#itemSort').val(this.dataset.sort);
		$('#itemSortLabel').text($(this).text());
		$('#itemSortModal').modal('hide');
		filterManager.queryItems(true);
	});

	/* ── 分頁：延遲載入片段、查詢訂單表格 ─────────────── */
	function syncTabs(href) {
		$('a[data-toggle="tab"][href="' + href + '"]').addClass('active');
		$('a[data-toggle="tab"]').not('[href="' + href + '"]').filter(function () {
			return /^#tab-/.test(this.getAttribute('href'));
		}).removeClass('active');
	}
	$(document).on('shown.bs.tab', 'a[data-toggle="tab"]', function (e) {
		var href = e.target.getAttribute('href');
		if (!/^#tab-/.test(href)) return;
		syncTabs(href);
		$('.button-collapse-pos').sideNav('hide');
		var $lazy = $(href).find('.js-lazy-tab');
		if ($lazy.length && !$lazy.data('loaded')) {
			$lazy.data('loaded', true).html('<div class="text-center p-5"><div class="spinner-border"></div></div>');
			$.get($lazy.data('src')).done(function (html) { $lazy.html(html); }).fail(function (x) {
				$lazy.data('loaded', false).html('<div class="alert alert-danger">' + ((x.responseJSON && x.responseJSON.error) || '載入失敗') + '</div>');
			});
		}
		if (href === '#tab-salesOrder') initSalesOrderTable();
	});

	var salesOrderTable = null;
	function initSalesOrderTable() {
		if (salesOrderTable) { salesOrderTable.ajax.reload(null, false); return; }
		var cols = ['uuid', 'customerFirstname', 'customerTelephone', 'customerEmail', 'state', 'status', 'paymentMethod', 'grandTotal', 'totalPaid',
			'salesOrderBillingAddress.bankAccount', 'virtualBankAccount', 'creditCardNumber', 'shippingTag', 'shippingType', 'shippingProvider',
			'shippingReceiptNumber', 'apiUserData', 'dateLastSms', 'dateModifiedString'];
		var labels = {};
		var columns = [
			{ data: null, defaultContent: '', orderable: false, className: 'control' },
			{ data: null, defaultContent: '', orderable: false, className: 'select-checkbox' }
		].concat(cols.map(function (c) {
			return {
				data: c, defaultContent: '',
				render: function (v, type) {
					if (type !== 'display') return v;
					if (c === 'uuid') return '<a href="/backend/SalesOrder/list?uuid=' + encodeURIComponent(v) + '" target="_blank">' + $('<span>').text(v).html() + '</a>';
					var map = labels[c];
					var s = (map && map[v] != null) ? map[v] : (v == null ? '' : v);
					return $('<span>').text(s).html();
				}
			};
		}));
		salesOrderTable = $('#mydt').DataTable({
			serverSide: true,
			processing: true,
			dom: 'lBrtip',
			order: [[2, 'desc']],
			pageLength: 10,
			scrollX: true,
			select: { style: 'multi', selector: 'td.select-checkbox' },
			buttons: [
				{ text: '全選', action: function (e, dt) { dt.rows({ page: 'current' }).select(); } },
				{ text: '取消選取', action: function (e, dt) { dt.rows().deselect(); } },
				{ text: '<i class="fa-light fa-print"></i> 列印收據', action: function (e, dt) {
					var r = dt.rows({ selected: true }).data().toArray();
					if (!r.length) { toastr.warning('請先選擇訂單'); return; }
					r.forEach(function (row) { posOpenReceipt(row.salesOrderId); });
				} },
				{ text: '後台訂單管理', action: function () { window.open('/backend/SalesOrder/list?groupBuyId=' + groupBuyId, '_blank'); } }
			],
			ajax: {
				url: GBF.baseUrl + '/ajax/SalesOrder/list.do',
				type: 'POST',
				data: function (d) { d.groupBuyId = groupBuyId; },
				dataSrc: function (json) {
					var o = json.options || {};
					['state', 'status', 'paymentMethod', 'shippingType', 'shippingProvider'].forEach(function (k) {
						if (Array.isArray(o[k])) { labels[k] = {}; o[k].forEach(function (x) { labels[k][x.value] = x.label; }); }
					});
					return json.data || [];
				}
			},
			columns: columns,
			language: window.DataTableConfig ? DataTableConfig.i18n : undefined
		});
		$(salesOrderTable.table().container()).find('.dataTables_scrollFoot tfoot th, tfoot th').each(function () {
			var i = $(this).index();
			if (i < 2 || $(this).find('input').length) return;
			var title = $(this).text();
			$(this).html('<input type="text" class="form-control form-control-sm" placeholder="' + title + '">');
			$('input', this).on('change', function () { salesOrderTable.column(i).search(this.value).draw(); });
		});
	}

	/* ── QR Code（img 先載 1×1 透明圖，再以 ?format=json 取得網址於瀏覽器產生） ── */
	function renderQr(img) {
		var src = img.getAttribute('src') || '';
		if (!/registerQrCode|generateQRCode/.test(src) || img.dataset.qrFor === src) return;
		img.dataset.qrFor = src;
		$.getJSON(src + (src.indexOf('?') >= 0 ? '&' : '?') + 'format=json').done(function (r) {
			var holder = document.createElement('div');
			new QRCode(holder, { text: r.data, width: 240, height: 240, correctLevel: QRCode.CorrectLevel.M });
			setTimeout(function () {
				var c = holder.querySelector('canvas');
				var url = c ? c.toDataURL('image/png') : (holder.querySelector('img') || {}).src;
				if (url) { img.dataset.qrFor = url; img.src = url; }
			}, 30);
		});
	}
	new MutationObserver(function (list) {
		list.forEach(function (m) {
			if (m.type === 'attributes' && m.target.tagName === 'IMG') renderQr(m.target);
			if (m.type === 'childList') $(m.target).find('img').each(function () { renderQr(this); });
		});
	}).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });

	/* ── 現金找零（本系統補充：原站付款金額上限＝待付款，無法輸入大於應收的現金） ── */
	window.posCashReceived = '';
	$('#paymentInputModal').on('show.bs.modal', function () {
		var name = $('#paymentTypeName').val() || $('#paymentTypeTitle').text();
		var isCash = /現金/.test(name);
		$('#cashReceivedGroup').toggleClass('d-none', !isCash);
		$('#cashReceivedInput').val('');
		$('#cashChangePreview').text('$0');
	});
	$('#cashReceivedInput').on('input', function () {
		var received = parseInt(this.value, 10) || 0;
		var amount = parseInt($('#paymentPriceInput').val(), 10) || 0;
		$('#cashChangePreview').text('$' + Math.max(0, received - amount));
	});
	document.getElementById('paymentPriceForm').addEventListener('submit', function () {
		var name = $('#paymentTypeName').val();
		if (!/現金/.test(name)) return;
		var received = parseInt($('#cashReceivedInput').val(), 10) || 0;
		var amount = parseInt($('#paymentPriceInput').val(), 10) || 0;
		if (received > 0 && received >= amount) {
			window.posCashReceived = received;
			$('#posCashReceivedText').text('$' + received);
			$('#posChangeText').text('$' + (received - amount));
			$('#posChangeRow').removeClass('d-none');
		} else {
			window.posCashReceived = '';
			$('#posChangeRow').addClass('d-none');
		}
	}, true);
	$('#checkoutV2Modal').on('hidden.bs.modal', function () {
		if (this.style.display === 'none') {
			window.posCashReceived = '';
			$('#posChangeRow').addClass('d-none');
		}
	});

	/* ── 收據列印（電子發票未串接；收據＝交易明細） ── */
	window.posOpenReceipt = function (salesOrderId) {
		if (!salesOrderId) return;
		window.open(GBF.ctxPosAjax + '/Invoice/print.do?' + $.param({ salesOrderId: salesOrderId, type: 'receipt' }), '_blank');
	};
	$('#printReceiptButton').on('click', function () {
		posOpenReceipt($('#checkoutV2ResultModal').data('salesOrderId'));
	});
	$('#checkoutV2ResultModal').on('show.bs.modal', function () {
		$('#printReceiptButton').toggle(!!$(this).data('uuid'));
	});
})();
