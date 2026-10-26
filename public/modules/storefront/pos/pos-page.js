/*
 * POS 頁面腳本（在原站 /pos/Pos/js/pos-main.js 之前載入）。
 * 原站 POS 頁的 inline script 被擷取過濾擋下，這裡補上 pos-main.js 會呼叫、但定義在 inline 的函式（推導，見 spec/POS_SPEC.md）。
 */
(function () {
	'use strict';

	/** 商品明細彈窗（原站 inline：openForm 載入 {ctxPosAjax}/Item/show.do） */
	window.showItem = function (itemId) {
		openForm(GBF.ctxPosAjax + '/Item/show.do', 'itemId=' + encodeURIComponent(itemId), 'lg');
	};

	/** 商品排序（排序規則彈窗）→ 附加在 itemList 請求 */
	$.ajaxPrefilter(function (options) {
		if (options.url && options.url.indexOf('/Item/itemList') >= 0) {
			var sort = $('#itemSort').val() || 'PRICE_DESC';
			if (typeof options.data === 'string') {
				options.data += (options.data ? '&' : '') + 'sort=' + encodeURIComponent(sort);
			}
		}
	});

	/** 商品明細彈窗「加入購物車」（明細片段的按鈕呼叫） */
	window.posAddItemFromModal = function (btn) {
		var $form = $(btn).closest('form');
		var itemId = $form.find('[name="popOrderItems[0].itemId"]').val();
		var total = parseInt($form.find('[name="popOrderItems[0].total"]').val(), 10) || 1;
		var status = $form.find('[name="popOrderItems[0].status"]:checked').val() || 'UNSHIPPING';
		var discount = $form.find('[name="popOrderItems[0].discount"]').val() || 0;
		var $btn = $(btn);
		if ($btn.hasClass('disabled')) return;
		$btn.addClass('disabled');
		orderManager.addOrderItem({ uuid: uuid, itemId: itemId, total: total, status: status, discount: discount })
			.then(function (response) {
				toastr.success(GBFi18n.add_shopping_cart_success);
				reloadItems(response);
				$('#myModal').modal('hide');
				$btn.removeClass('disabled');
			}, function (data) {
				var json = data && data.responseJSON;
				toastr.error(json ? json.error : '加入購物車失敗');
				$btn.removeClass('disabled');
			});
	};

	/** 優惠券彈窗（displayCoupon.do 片段）內的使用／取消 */
	window.redeemCouponByCode = function (code, $btn) {
		if (!code) return;
		if ($btn) $btn.prop('disabled', true);
		couponManager.redeem({
			ajaxData: { code: code },
			successHandler: function (resp) {
				orderManager.currentSalesOrder = resp.data.salesOrder;
				reloadItems();
				couponListController.getCommonCoupons();
				$('#coupon_container .coupon-help').text('');
				toastr.success('已套用優惠券');
			},
			errorHandler: function (resp) {
				if ($btn) $btn.prop('disabled', false);
				var json = resp && resp.responseJSON;
				$('#coupon_container .coupon-help').text(json ? json.error : '優惠券無法使用');
			}
		});
	};
	window.removeCoupon = function (code) {
		couponManager.remove({
			ajaxData: { code: code },
			successHandler: function (resp) {
				orderManager.currentSalesOrder = resp.data.salesOrder;
				reloadItems();
				couponListController.getCommonCoupons();
			},
			errorHandler: function (resp) {
				var json = resp && resp.responseJSON;
				$('#coupon_container .coupon-help').text(json ? json.error : '取消失敗');
			}
		});
	};
})();
