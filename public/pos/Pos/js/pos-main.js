function createDraftList(list) {
	if (!list || !list.length) {
		return '無暫存訂單';
	}

	var result = '';
	for (var i = 0; i < list.length; i++) {
		var so = list[i];
		
		var customerHtml = '';
		if (so.customerIsGuest) {
			customerHtml = '<span class="order-uuid">' + so.uuid + '</span>'
					+ '<span class="order-create-date text-muted">'
					+ so.dateCreatedString + '</span>';
		} else {
			customerHtml = '<span class="order-customer-firstname">'
					+ so.customerFirstname + '</span>'
					+ '<span class="order-customer-telephone text-muted">'
					+ so.customerTelephone + '</span>'
					+ '<span class="order-create-date text-muted">'
					+ so.dateCreatedString + '</span>';
		}
		const count = so.sortedOrderItems.reduce(function (accu, curr) {
			return accu + curr.total;
		}, 0);
		
		result += '<div class="card" id="salesOrderId-' + so.salesOrderId + '">'
				+ '<div class="card-body p-0">'
				+ '<div class="row mx-0">'
				+ '<div class="col-2 px-0 d-flex justify-content-center align-items-center">'
				+ '<button class="btn btn-warning px-3" onclick="getSalesOrder(event)" data-sales-order-id="' + so.salesOrderId + '">取單</button>'
				+ '</div>'
				+ '<div class="col-5 pr-0 py-3 border-bottom d-flex flex-column justify-content-center">'
				+ customerHtml
				+ '</div>'
				+ '<div class="col-3 px-0 border-bottom d-flex flex-column justify-content-center align-items-center">'
				+ '<span class="text-secondary">' + count + ' 件商品</span>'
				+ '<span class="font-weight-bold">$' + so.grandTotal + '</span>'
				+ '</div>'
				+ '<div class="col-2 px-0 d-flex justify-content-center align-items-center">'
				+ '<button class="btn btn-danger border-0 js-delete-order" onclick="cancelSalesOrder(event)" data-sales-order-id="' + so.salesOrderId + '">'
				+ '<i class="fa-light fa-trash-can"></i>'
				+ '</button>'
				+ '</div>' + '</div>' + '</div>' + '</div>';
	}
	return result;
}

function getSalesOrder(param) {
	const ajaxData = {};
	if (!!param && !!param.currentTarget) {
		const event = param;
		event.preventDefault();
		event.stopPropagation();
		ajaxData.salesOrderId = event.currentTarget.dataset.salesOrderId;
	} else if (!!param && typeof param === 'object') {
		$.extend(ajaxData, param);
	}
	orderService.getOrder(ajaxData)
	.then(function(data) {
		// Close modal
		const cachedOrdersModal = $('#cachedOrders');
		if (cachedOrdersModal.is('.show')) {
			cachedOrdersModal.modal('hide');
		}
		
		// Update data
		let salesOrder = data.data;
		orderManager.currentSalesOrder = salesOrder;
		return orderManager.prepareReturnAndRefund();
	})
	.then(function(response) {
		let so = response.data.salesOrder;
		orderManager.currentSalesOrder = so;
		// Update customer data.
		customerManager.currentCustomer = null;
		customerManager.cleanCustomerPane();
		if (!so.customerIsGuest) {
			// Bind the customer again and revoke updating customer pane.
			let telephone = so.customerTelephone;
			customerManager.getCustomer(telephone, true);
		}
		// Update bag
		reloadItems();
	}, function(error) {
		let err = error.responseJSON.error;
		$('#cachedOrders .help').text(err);
	});
}

var applyDiscountTag = function() {
	const element = event.currentTarget;
	const operator = element.dataset.operator;
	const factor = parseFloat(element.dataset.factor);

	const selectedItems = posShoppingCartListView.selectedCells();
	selectedItems.each(function(ele) {
		const index = this.dataset.index;
		const namePrefix = 'orderItems\\[' + index + '\\]\\.';
		// Update discount input.
		const price = $('input[name=' + namePrefix + 'price]').val();
		const total = $('input[name=' + namePrefix + 'total]').val();
		const totalPrice = price * total;
		if (operator === '*') {
			const discount = Math.round( totalPrice * factor );
			$('input[name=' + namePrefix + 'discount]').val(discount);
		} else {
			$('input[name=' + namePrefix + 'discount]').val(factor);
		}
		orderManager.updateOrderItem(namePrefix)
		.then(function(result) {
			reloadItems(result);
		}, function(error) {
			const json = error.responseJSON;
			toastr.error(json.error, GBFi18n.error_update);
			reloadItems();
		});
	});
	
	$('#myModal').modal('hide');
}

function reloadItems(data) {
	
	if (data === undefined) {
		data = orderManager.getReloadItemsData();
	}

	var selectBuilder = function(item, index) {
		let status = item.status;
		// Hide select.
		let select = '<select class="browser-default custom-select custom-select-sm item-status" name="orderItems[' + index + '].status" style="visibility: hidden;">';
		if (status === 'BACKORDER') {
			select += '<option value="UNSHIPPING">現貨</option>'
					+ '<option value="BACKORDER" selected>預購</option>';
		} else {
			select += '<option value="UNSHIPPING" selected>現貨</option>'
					+ '<option value="BACKORDER">預購</option>';
		}
		select += '</select>';
		return select;
	}

	let salesOrder = data.data.salesOrder;
	// Update salesOrder
	orderManager.currentSalesOrder = salesOrder;
	let items = salesOrder.sortedOrderItems;
	let anyItems = !items.every( soi => soi.total === 0 );
	let totalCount = 0;
	let result = '';
	for (let i = 0; i < items.length; i++) {
		let oi = items[i];
		let title = oi.title;
		let total = oi.total;
		let state = oi.stateString;
		let price = oi.price;
		let image = oi.image;
		const isBackOrder = oi.backOrder;
		let discount = oi.discount;
		let discountTextColorClass = (discount > 0) ? ' text-danger' : '';
		let maxDiscount = price * total;

		// must render all orderItems for returnAndRefund.do
		let display = (total == 0) ? ' d-none ' : ' ';
		
		let discountReadonly = '';
		if (orderManager.autoApplySalesRules) {
			discountReadonly += ' readonly';
		}
		
		totalCount += total;

		result += '<div class="card border' + display + 'rounded mb-2 order-item-list-cell" name="orderItemId-' + oi.orderItemId + '" data-index="'+i+'" data-order-item-id="'+oi.orderItemId+'" onclick="clickOnCell()">'
				+ '<div class="row no-gutters">'

				// Left Side: Image
				+ '<div class="col-3 pr-1">'
				+ '<div class="card-body p-1">'
				+ '<img class="img-fluid border rounded" src="' + image + '">'
				+ '</div><!-- /.Card Body -->'
				+ '</div><!-- /.Image -->'
				// Image

				// Editor Block
				+ '<div class="col pl-1">'
				+ '<div class="card-body p-1">'
				+ '<div class="d-flex flex-column">'

				+ '<div class="md-form input-group my-0">'
				+ '<div class="input-group-prepend">'
				+ '<span class="input-group-text md-addon py-0 pl-0 font-weight-light" id="orderItems['+i+'].price-label">單價</span>'
				+ '</div>'
				+ '<input type="text" size="6" class="form-control py-0 pl-0 js-oi-editor-modal" name="orderItems[' + i + '].price" value="' + oi.price + '">'
				+ '</div>'
				// Price

				+ '<div class="md-form input-group my-0">'
				+ '<div class="input-group-prepend">'
				+ '<span class="input-group-text md-addon py-0 pl-0 font-weight-light" id="orderItems['+i+'].total-label">數量</span>'
				+ '</div>'
				+ '<input type="text" size="6" class="form-control py-0 pl-0 js-oi-editor-modal" name="orderItems[' + i + '].total" value="' + oi.total + '" data-order-item-id="' + oi.orderItemId + '" data-max-total="' + oi.maxOrderQuota + '" data-stock-available="' + oi.stockAvailable + '" data-stock-back-order-available="' + oi.stockBackOrderAvailable + '">'
				+ '</div>'
				// Total

				+ '<div class="md-form input-group my-0">'
				+ '<div class="input-group-prepend">'
				+ '<span class="input-group-text md-addon py-0 pl-0 font-weight-light" id="orderItems['+i+'].discount-label">折價</span>'
				+ '</div>'
				//+ '<span class="order-item-discount-value' + discountTextColorClass + '" id="orderItems['+i+'].discount-value">' + oi.discount + '</span>'
				+ '<input type="text" size="6" class="form-control py-0 pl-0 js-oi-editor-modal' + discountTextColorClass + '" name="orderItems[' + i + '].discount" value="' + oi.discount + '"' + discountReadonly + ' data-max-discount="' + maxDiscount + '">'
				+ '</div>'
				// Discount

				+ '</div><!-- /.Flex Column -->'
				+ '</div><!-- /.Card Body -->'
				+ '</div><!-- /.Col-5 -->'
				// /.Editor Block

				// Delete Button
				+ '<div class="col-4 pl-1">'
				+ '<div class="card-body p-1 text-right">'
				+ '<button type="button" class="btn btn-sm btn-flat px-3 pt-2 pb-3 m-0 border-0 js-remove-order-item" '
				+ 'onclick="removeOrderItem(' + i + ');event.stopPropagation();">'
				+ '<i class="fa-light fa-trash"></i>'
				+ '</button><!-- /.Delete Button -->'
				+ selectBuilder(oi, i)
				+ '</div><!-- /.Card Body -->'
				+ '</div><!-- /.Col-4 -->'

				+ '<div class="w-100"></div>'

				// Shipping Editor
				+ '<div class="col">'
				+ '<div class="card-footer p-1">'
				+ '<h5 class="d-flex aligns-items-center text-small">'
				+ (isBackOrder ? '<span class="badge badge-warning">預購</span> ' : '')
				+ title
				+ '</h5>'
				+ '</div><!-- /.Card Footer -->'
				+ '</div><!-- /.Col -->'
				// Title

				+ '</div><!-- /.Row -->'
				+ '<input type="hidden" name="orderItems[' + i + '].orderItemId" value="' + oi.orderItemId + '">'
				+ '<input type="hidden" name="orderItems[' + i + '].groupBuyItemSetId" value="' + oi.groupBuyItemSetId + '">'
				+ '<input type="hidden" name="orderItems[' + i + '].itemId" value="' + oi.itemId + '">'
				
				+ '</div><!-- /.Card -->';

		var promiseThen = function(value) {
			toastr.success(GBFi18n.pos_shoppingCart_update_success);
			return value;
		};
		var promiseError = function(error) {
			const json = error.responseJSON;
			toastr.error(json.error, GBFi18n.error_update);
			reloadItems();
		};
		// Add change event
		const namePrefix = 'orderItems\\[' + i + '\\]\\.';
		$('body').off('change', 'input[name=' + namePrefix + 'total]');
		$('body').on('change', 'input[name=' + namePrefix + 'total]', function(e) {
			const inputSelector = 'input[name=' + namePrefix + 'total]';
			const input = $(this);
			const total = input.val();
			if (total == 0) {
				removeOrderItem(i);
			} else {
				const triggerTargetElem = event.target;
				// Update order item
				orderManager.updateOrderItem(namePrefix)
				.then(function(value) {
					// Show success message
					toastr.success(GBFi18n.pos_shoppingCart_update_success);
					if (triggerTargetElem !== input[0]) {
						// Close spinning block div on item
						$(triggerTargetElem).closest('.card').removeClass('disabled').find('.add-cart-processor').hide();
						// Animate result input for user's attention
						const targetInput = $('#ReturnRefundForm ' + inputSelector);
						// Scroll into view
						targetInput.closest('.card')[0].scrollIntoView({behavior:"smooth", block:"center", inline:"center"});
						// Shake input
						targetInput.removeClass('animated shakeGB').addClass('animated shakeGB');
						// Pulse card
						targetInput.closest('.card').removeClass('animated pulse').addClass('animated pulse');	
					}
					return value;
				}, function(error) {
					if (triggerTargetElem !== input[0]) {
						// Close spinning block div on item
						$(triggerTargetElem).closest('.card').removeClass('disabled').find('.add-cart-processor').hide();
					}
					// Show error message
					const json = error.responseJSON;
					toastr.error(json.error, GBFi18n.error_update);
					// Restore items
					reloadItems();
				});
			}
		});
		$('body').off('change', 'input[name=' + namePrefix + 'price]');
		$('body').on('change', 'input[name=' + namePrefix + 'price]', function(e) {
			orderManager.updateOrderItem(namePrefix)
			.then(promiseThen, promiseError);
		});
		$('body').off('change', 'input[name=' + namePrefix + 'discount]');
		$('body').on('change', 'input[name=' + namePrefix + 'discount]', function(e) {
			// Prevent from discount larger than total price of order item.
			const value = parseInt(this.value);
			const maxDiscount = this.dataset.maxDiscount;
			if (value > maxDiscount) {
				this.value = maxDiscount;
			}
			orderManager.updateOrderItem(namePrefix)
			.then(promiseThen, promiseError);
		});
		$('body').off('change', 'select[name=' + namePrefix + 'status]');
		$('body').on('change', 'select[name=' + namePrefix + 'status]', function(e) {
			orderManager.updateOrderItem(namePrefix)
			.then(promiseThen, promiseError);
		});
	}

	if (salesOrder.salesOrderSalesRules.length > 0 && anyItems) {
		for (let i = 0; i < salesOrder.salesOrderSalesRules.length; i++) {
			let salesRule = salesOrder.salesOrderSalesRules[i];
			result += '<div class="text-muted border p-1 sales-rule" id="salesRuleId-' + salesRule.salesRuleId + '">'
					+ '<i class="fa-light fa-check"></i> '
					+ salesRule.title
					+ '</div>';
		}
	}

	result += '<input type="hidden" name="shippingAmount" value="' + salesOrder.shippingAmount + '">'
			+ '<input type="hidden" name="grandTotal" value="' + salesOrder.grandTotal + '">'
			+ '<input type="hidden" name="grandTotalToPay" value="' + salesOrder.grandTotal + '">'
			+ '<input type="hidden" name="salesOrderId" value="' + salesOrder.salesOrderId + '">';

	// Append coupons.
	let salesOrderCoupons = salesOrder.salesOrderCoupons;
	let couponsTable = salesOrderCoupons.reduce(function(accu, salesOrderCoupon) {
		const gbfrsId = salesOrderCoupon.groupBuyFlatRateShippingId;
		const coupon = salesOrderCoupon.coupon;
		const couponTitle = coupon.title;
		const couponCode = coupon.code;
		return accu
				+ '<div class="sales-order-coupon" data-gbfrs-id="' + gbfrsId + '" data-coupon-code="' + couponCode + '">'
				+ '<div>'
				+ '<i class="fa-light fa-check text-info mr-1"></i>'
				+ '<span class="sales-order-coupon__title">'
				+ couponTitle
				+ '</span>'
				+ '</div>'
				+ '<button type="button" class="btn btn-danger border-0" data-code="'
				+ couponCode
				+ '" onclick="deleteCoupon(\'' + couponCode + '\')"><i class="fa-light fa-trash"></i></button>'
				+ '</div>'
				+ '</div>';
	}, '');
	result += couponsTable;

	// For bag in main view.
	let url = baseUrl + '/ajax/ReturnRefund/returnAndRefund.do';
	var result1 = '<form name="ReturnRefundForm" method="post" action="'+url+'" class="form-horizontal" id="ReturnRefundForm">'
			+ '<input type="hidden" name="optionDeleteEmptyOrderItem" value="true">'
			+ result
			+ '<input id="returnRefundFormSubmitButton" name="submitButton" type="submit" class="btn d-none" value="送出">'
			+ '</form>';
	$('.item-display-window .card-body.bag-body').html(result1);
	
	// After add ReturnRefundForm, enable 'Cache Order' button.
	$('.js-cache-order-items').removeClass('disabled');

	// Avoid to excape this page when submits.
	$('#ReturnRefundForm').ajaxForm(function() {
		messagebox('暫存成功', '', '關閉');
	});
	
	disableFormSubmitOnEnter($('#ReturnRefundForm'));
	
	$('#quickDiscountButtton').addClass('disabled');

	// For bag in checkout modal.
	$('#checkoutDetailsModal .card-body.bag-body').html(result);

	// For bag in checkout v2 modal. (Currently use.)
	$('#checkoutV2Modal .card-body.bag-body').html(result);

	// Update total price.
	$('p.bag-amount').text('$' + salesOrder.grandTotal);

	// Update inputs
	$('input[name=grand-total]').val(salesOrder.grandTotal);
	$('input[name=total-paid]').val("0");

	let grandTotalWithoutShipping = parseInt(salesOrder.grandTotalWithoutShipping);
	let totalDiscount = parseInt(salesOrder.totalDiscount);
	let totalPrice = grandTotalWithoutShipping + totalDiscount;
	
	updatePriceAndDiscount(totalPrice, totalDiscount);
	
	updateCheckoutButton(totalCount, grandTotalWithoutShipping);

	$('.js-start-checkout').toggleClass('disabled', !anyItems);
}

var updatePriceAndDiscount = function(price, discount) {
	// Update total price and total discount labels.
	$('#totalPriceValue').text('$' + price);
	$('#totalDiscountValue').text('-' + discount);

	// Update total discount label text.
	let totalDiscountLabel = (discount > 0) ? '新增優惠' : '尚未新增優惠';
	$('#totalDiscountLabel').text(totalDiscountLabel);
}

var updateCheckoutButton = function(totalCount, grandTotal) {
	let button = $('button.js-start-checkout');
	let totalLabel = button.find('span.checkout-total-label');
	let priceLabel = button.find('span.checkout-price-label');
	totalLabel.text(totalCount);
	priceLabel.text(grandTotal);
}

function cancelSalesOrder(event) {
	const salesOrderId = event.currentTarget.dataset.salesOrderId; 
	orderService.cancelOrder(salesOrderId)
	.then( function() {
		$('#cachedOrders .modal-body .draft-order-list')
		.find('#salesOrderId-' + salesOrderId).remove();
	});
}

var orderItemModalFormValidator = null;
function showOrderItemEditorModal ( event ) {
	const input = event.currentTarget;
	if ($(input).prop('readonly')) {
		return false;
	}
	
	const $cell = $(input).closest('.order-item-list-cell');
	// Get inputs from oi table
	const priceInput = $cell.find('[name$=price]')[0];
	const totalInput = $cell.find('[name$=total]')[0];
	const discountInput = $cell.find('[name$=discount]')[0];
	
	const discountInputReadonly = $(discountInput).prop('readonly'); 
	
	// Get max discount
	const price = +priceInput.value;
	const total = +totalInput.value;
	const maxTotal = +totalInput.dataset.maxTotal;
	const stockAvailable = +totalInput.dataset.stockAvailable;
	const stockBackOrderAvailable = +totalInput.dataset.stockBackOrderAvailable;
	const maxDiscount = price * total;
	if (isNaN(maxDiscount) || maxDiscount === 0) return;
	event.stopPropagation();
	event.preventDefault();
	
	// Update modal
	const $modal = getOrderItemEditorModal();
	
	// Update inputs in modal
	$modal.find('input[name="price"]').val(priceInput.value);
	$modal.find('input[name="total"]').val(totalInput.value);
	$modal.find('input[name="discount"]').val(discountInput.value);
	
	// Update attribute
	$modal.find('input[name="total"]').attr('max-total', maxTotal);
	$modal.find('input[name="discount"]').prop('readonly', discountInputReadonly);
	
	// Update note in modal
	$modal.find('span.max-total').text(maxTotal);
	$modal.find('span.max-discount').text(maxDiscount);
	$modal.find('span.item-stock-available').text(stockAvailable);
	$modal.find('span.item-stock-back-order-available').text(stockBackOrderAvailable);
	
	// Register submission of form
	$('#discountForm').on('submit', submitHandler);
	
	const $submitButton = $modal.find('button.js-save-discount');
	
	// Refresh validator for the form
	const validator = getValidation();
	
	$modal.modal('show');

	function submitHandler ( event ) {
		event.stopPropagation();
		event.preventDefault();
		if (validator.valid() === false) {
			$submitButton.spinning(false);
			return false;
		}

		// Get input values
		const newTotal = $modal.find('input[name="total"]').val();
		const newDiscount = $modal.find('input[name="discount"]').val();
		
		// Set values to original order item table
		$(totalInput).val(newTotal);
		$(discountInput).val(newDiscount);
		
		// Update order item
		const index = $cell.data('index');
		const namePrefix = 'orderItems\\[' + index + '\\]\\.';
		orderManager.updateOrderItem(namePrefix)
		.then(function (result) {
			toastr.success(GBFi18n.pos_shoppingCart_update_success);
			$modal.modal('hide');
		}, function (error) {
			const json = error.responseJSON;
			toastr.error(json.error, GBFi18n.error_update);
			reloadItems();
		});
	}

	function getOrderItemEditorModal () {
		var $m = $('#orderItemEditorModal');
		if ($m.length === 0) {
			$m = $(
				'<div class="modal fade" id="orderItemEditorModal" tabindex="-1" aria-labelledby="orderItemEditorModalLabel" aria-hidden="true"> \
				<div class="modal-dialog"> \
				<div class="modal-content"> \
				<div class="modal-header"> \
				<h5 class="modal-title" id="orderItemEditorModalLabel">購物車商品編輯</h5><button type="button" class="close" data-dismiss="modal" aria-label="Close"><span aria-hidden="true">&times;</span></button></div> \
				<div class="modal-body"> \
				<form id="discountForm"> \
				<div class="form-group"> \
				<label for="price">單價</label> \
				<input type="text" class="form-control" name="price" id="orderItemEditorModal-Price"> \
				</div> \
				<div class="form-group"> \
				<label for="total">數量</label> \
				<input type="text" class="form-control" name="total" id="orderItemEditorModal-Total"> \
				<small for="totalHelpBlock" class="form-text text-muted"> \
				最多可選 <span class="max-total"></span> 個\
				，可售現貨數量 \
				<span class="item-stock-available"></span> \
				個 \
				，可售預購數量 \
				<span class="item-stock-back-order-available"></span> \
				個 \
				</small> \
				</div> \
				<div class="form-group"> \
				<label for="discount">折扣</label> \
				<input type="text" class="form-control" name="discount"> \
				<small for="discountHelpBlock" class="form-text text-muted"> \
				最小折扣為 0，最大折扣為 <span class="max-discount" id="orderItemEditorModal-maxDiscountNum">0</span> </small> \
				</div> \
				</form></div> \
				<div class="modal-footer"><button type="button" class="btn btn-secondary" data-dismiss="modal">關閉</button><button type="button" class="btn btn-primary js-save-discount">儲存</button></div></div></div></div>').appendTo('body');

			$m
			.on('change', 'input[name=price]', function (event) {
				$('#orderItemEditorModal-maxDiscountNum').text( getMaxDiscount() );
			})
			.on('change', 'input[name=total]', function (event) {
				$('#orderItemEditorModal-maxDiscountNum').text( getMaxDiscount() );
			})
			.on('click', 'button.js-save-discount', function (e) {
				$submitButton.spinning(true);
				$('#discountForm').submit();
			})
			.on('hidden.bs.modal', function(event) {
				$submitButton.spinning(false)
				$('#discountForm').off('submit');
				validator.resetForm();
			})
		}
		return $m;
	}
	
	function getValidation () {
		if (orderItemModalFormValidator !== null) {
			return orderItemModalFormValidator;
		}
		const validator = $('#discountForm').validate({
			rules: {
				price: {
					number: true,
				},
				total: {
					number: true,
					min: 0
				},
				discount: {
					max: getMaxDiscount,
					min: 0
				}
			},
			messages: {
				price: {
					number: GBFi18n.pos_error_NaN,
				},
				total: {
					number: GBFi18n.pos_error_NaN,
					min: GBFi18n.pos_error_more_than_zero,
				},
				discount: {
					max: $.validator.format(GBFi18n.pos_discount_error_max),
					min: GBFi18n.pos_error_more_than_zero,
				}
			}
		});
		orderItemModalFormValidator = validator;
		return orderItemModalFormValidator;
	}
	
	function getMaxDiscount () {
		const priceVal = + $('#orderItemEditorModal-Price').val();
		const totalVal = + $('#orderItemEditorModal-Total').val();
		const maxDiscount = priceVal * totalVal;
		return maxDiscount;
	}
	
	function getMaxTotal () {
		const maxTotal = + $('#orderItemEditorModal-Total').attr('max-total');
		return maxTotal;
	}
}

var orderManager = {
	currentSalesOrder : null,
	autoApplySalesRules : true,
	startOrder : function(customerId) {
		if (orderManager.currentSalesOrder === null) {
			// Create draft
			return orderService.createDraftOrder(customerId)
			.then(function(result) {
				orderManager.currentSalesOrder = result.data;
				return orderManager.prepareReturnAndRefund();
			})
			.then(function(result) {
				orderManager.currentSalesOrder = result.data;
				return result;
			});
		} else {
			if (customerId) {
				return orderManager.updateCustomer(customerId);
			} else {
				return Promise.resolve(0);
			}
		}
	},
	updateCustomer : function(customerId) {
		if (orderManager.currentSalesOrder && customerId) {
			let soId = orderManager.currentSalesOrder.salesOrderId;
			return orderService.updateCustomer(soId, customerId);
		} else {
			return Promise.resolve(0);
		}
	},
	prepareReturnAndRefund : function(salesOrderId) {
		var soId = salesOrderId || orderManager.currentSalesOrder.salesOrderId;
		return orderService.prepareReturnAndRefund(soId);
	},
	updateOrderItem : function(namePrefix) {
		// Ex. namePrefix = 'orderItems\\['+i+'\\]\\.';
		const orderItemId = $('input[name=' + namePrefix + 'orderItemId]').val();
		const price = $('input[name=' + namePrefix + 'price]').val();
		const total = $('input[name=' + namePrefix + 'total]').val();
		const discount = $('input[name=' + namePrefix + 'discount]').val();
		const status = $('select[name=' + namePrefix + 'status]').val();

		const ajaxData = {
			orderItemId : orderItemId,
			price : price,
			total : total,
			discount : discount,
			status : status,
			shouldApplySalesRules : this.autoApplySalesRules,
			shouldVerifyCoupons : true
		};
		return orderService.updateOrderItem(ajaxData)
		.then(function(result) {
			reloadItems(result);
		});
	},
	addOrderItem : function(data) {
		const ajaxData = $.extend({}, data, {shouldApplySalesRules: this.autoApplySalesRules});
		if (orderManager.currentSalesOrder === null) {
			// Check that there is a customer.
			var customerId = null;
			if (customerManager.currentCustomer && customerManager.currentCustomer.customerId) {
				customerId = customerManager.currentCustomer.customerId;
			}
			return orderManager.startOrder(customerId)
			.then(function(result) {
				return orderService.addOrderItem(ajaxData);
			});
		} else {
			return orderService.addOrderItem(ajaxData);
		}
	},
	checkout : function(data) {
		return couponManager.confirm()
		.then(function() {
			return orderService.checkout(data);
		});
	},
	getReloadItemsData : function() {
		return {data : {salesOrder : this.currentSalesOrder}};
	},
	hasOrderItemsNow : function () {
		return !!(this.currentSalesOrder && this.currentSalesOrder.sortedOrderItems && this.currentSalesOrder.sortedOrderItems.length);
	},
}

var orderService = {
	createDraftOrder : function(customerId) {
		let ajaxUrl = GBF.ctxPosAjax + '/SalesOrder/create.do';
		let ajaxData = { groupBuyId : groupBuyId };
		if (customerId) {
			ajaxData.customerId = customerId;
		}
		return $.get(ajaxUrl, ajaxData).promise();
	},
	updateCustomer : function(salesOrderId, customerId) {
		let ajaxUrl = GBF.ctxPosAjax + '/SalesOrder/bind.do';
		let ajaxData = {
			salesOrderId : salesOrderId,
			customerId : customerId,
		};
		return $.get(ajaxUrl, ajaxData).promise();
	},
	fetchDraftOrderList : function(ajaxData) { // Click cached sales order 
		let ajaxUrl = GBF.ctxPosAjax + '/SalesOrder/list.do';
		return $.get(ajaxUrl, ajaxData).promise();
	},
	fetchSalesOrderList : function(ajaxData) { 
		const ajaxUrl = GBF.ctxPosAjax + '/SalesOrder/list.do';
		return $.post(ajaxUrl, ajaxData).promise();
	},
	fetchOrderList : function(ajaxData) {
		const ajaxUrl = GBF.ctxPosAjax + '/SalesOrder/list.do';
		return $.get(ajaxUrl, ajaxData).promise();
	},
	prepareReturnAndRefund : function(salesOrderId) { // After create order.
		let ajaxUrl = baseUrl + '/ajax/ReturnRefund/prepare.do';
		let ajaxData = 'salesOrderId=' + salesOrderId;
		return $.get(ajaxUrl, ajaxData).promise();
	},
	applySalesRules : function(successHandler, errorHandler) {
		let ajaxUrl = baseUrl + '/ajax/ReturnRefund/applySalesRules.do';
		return $.post(ajaxUrl).promise();
	},
	cancelOrder : function(salesOrderId, successHandler, errorHandler) {
		// NOTE this order will keep in draft list in backend.
		let ajaxUrl = GBF.ctxPosAjax + '/SalesOrder/delete.do';
		let ajaxData = { salesOrderId : salesOrderId };
		return $.get(ajaxUrl, ajaxData).promise();
	},
	updateOrderItem : function(data) {
		let ajaxUrl = baseUrl + '/ajax/ReturnRefund/updateOrderItem.do';
		return $.get(ajaxUrl, data).promise();
	},
	addOrderItem : function(data) {
		var ajaxurl = (typeof baseUrl == 'undefined') ? '..' : baseUrl;
		ajaxurl += '/ajax/ReturnRefund/addOrderItem.do';
		return $.get(ajaxurl, data).promise();
	},
	getOrder : function(data) {
		var ajaxurl = GBF.ctxPosAjax + '/SalesOrder/get.do';
		return $.get(ajaxurl, data).promise();
	},
	checkout : function(ajaxData) {
		var ajaxurl = GBF.ctxPosAjax + '/SalesOrder/checkout.do';
		return $.post(ajaxurl, ajaxData).promise();
	},
	getPoints : function() {
		var ajaxurl = GBF.ctxPosAjax + '/ReturnRefund/getPoints.do';
		return $.post(ajaxurl).promise();
	},
	usePoints : function(points) {
		var ajaxurl = GBF.ctxPosAjax + '/ReturnRefund/usePoints.do';
		const data = {rpDiscount : points};
		return $.post(ajaxurl, data).promise();
	}
}

var makeDeleteButton = function($btn) {
	var loading = false;
	var button = $btn;
	function update() {
		if (loading) {
			$btn.html('<i class="fa-light fa-spinner glyphicon glyphicon-refresh glyphicon-refresh-animate"></i>');
			$btn.addClass('disabled');
		} else {
			$btn.html('<i class="fa-light fa-trash"></i>');
			$btn.removeClass('disabled');
		}
	}
	
	return {
		startLoading: function() {
			loading = true;
			update();
		},
		stopLoading: function() {
			loading = false;
			update();
		}
	};
};

var deleteCoupon = function(code) {
	const $btn = $(event.currentTarget);
	var deleteButton = makeDeleteButton($btn);
	deleteButton.startLoading();
	
	const soId = orderManager.currentSalesOrder.salesOrderId;
	const data = { code : code };
	const options = {
		ajaxData : data,
		successHandler : function(resp) {
			const salesOrder = resp.data.salesOrder;
			orderManager.currentSalesOrder = salesOrder;
			
			reloadItems();
			
			deleteButton.stopLoading();
		},
		errorHandler : function(resp) {
			const json = resp.responseJSON;
			modalShowDanger($('#myModal'), json.error);
			deleteButton.stopLoading();
		}
	};
	couponManager.remove(options);
}

var couponManager = {
	redeem : function(data) {
		return couponService.redeem(data.ajaxData)
		.then(data.successHandler, data.errorHandler);
	},
	remove : function(data) {
		return couponService.remove(data.ajaxData)
		.then(data.successHandler, data.errorHandler);
	},
	confirm : function() {
		var soId = orderManager.currentSalesOrder.salesOrderId;
		var ajaxData = { salesOrderId : soId };
		return couponService.confirm(ajaxData);
	},
	verify : function() {
		return couponService.verify();
	}
}

var couponService = {
	redeem : function(data) {
		const ajaxUrl = baseUrl + '/ajax/ReturnRefund/redeemCoupon.do';
		return $.post(ajaxUrl, data).promise();
	},
	remove : function(data) {
		const ajaxUrl = baseUrl + '/ajax/ReturnRefund/removeCoupon.do';
		return $.post(ajaxUrl, data).promise();
	},
	confirm : function(data) {
		const ajaxUrl = baseUrl + '/ajax/ReturnRefund/confirmCoupons.do';
		return $.post(ajaxUrl, data).promise();
	},
	verify : function() {
		const ajaxUrl = baseUrl + '/ajax/ReturnRefund/verifyCoupons.do';
		const ajaxData = {salesOrderId : orderManager.currentSalesOrder.salesOrderId};
		return $.post(ajaxUrl, ajaxData).promise();
	},
	getCommonCoupons : function(data) {
		const ajaxUrl = GBF.ctxPosAjax + '/Coupon/commonCoupons.do';
		const ajaxData = { groupBuyId : groupBuyId };
		return $.get(ajaxUrl, ajaxData).promise();
	}
}

var getMinTotalPriceOfOrderItemsInShoppingCart = function() {
	const oiList = posShoppingCartListView.selectedCells();
	var minPrice = 0;
	oiList.each(function(index, cell) {
		const cellIndex = cell.dataset.index;
		const namePrefix = 'orderItems\\[' + cellIndex + '\\]\\.';
		// Update discount input.
		const price = $('input[name=' + namePrefix + 'price]').val();
		const total = $('input[name=' + namePrefix + 'total]').val();
		const totalPrice = price * total;
		if (index === 0) {
			minPrice = totalPrice;
		} else {
			minPrice = Math.min(minPrice, totalPrice);	
		}
	});
	return minPrice;
}

var showQuickDiscountModal = function() {
	const minPrice = getMinTotalPriceOfOrderItemsInShoppingCart();
	const url = baseUrl + '/pos/SalesOrder/discountTags.do';
	const data = 'groupBuyId='+groupBuyId+'&maxDiscount='+minPrice;
	openForm(url, data);
}

var CollectionListView = function(options) {
	this.listViewSelector = options.listViewSelector;
	this.listCellViewSelector = options.listCellViewSelector;
}

CollectionListView.prototype = {
	selectedCells: function() {
		const cells = $(this.listViewSelector).find(this.listCellViewSelector + '.selected');
		return cells;
	},
	isSelectedAnyCells: function() {
		const anySelected = this.selectedCells().length > 0;
		return anySelected;
	},
	willSelectCell: function() {
		return true;
	}
}

var posShoppingCartListView = new CollectionListView({
	listViewSelector: '#ReturnRefundForm',
	listCellViewSelector: '.order-item-list-cell'
});

posShoppingCartListView.willSelectCell = function() {
	return $('#quickDiscountButtton').hasClass('d-none') == false;
}

var clickOnCell = function() {
	if (posShoppingCartListView.willSelectCell() === false) {
		return;
	}
	// Select cell.
	const cell = event.currentTarget;
	const isSelected = $(cell).hasClass('selected');
	$(cell).toggleClass('selected', !isSelected);
	
	// Update quick discount button state.
	const isDisabled = !posShoppingCartListView.isSelectedAnyCells();
	$('#quickDiscountButtton').toggleClass('disabled', isDisabled);
}

var registerNodeClassChange = function(node, classSel, callback) {
	const cb = function(mutationsList, observer) {
		for (var i = 0; i < mutationsList.length; i++) {
			var mutation = mutationsList[i];
			if (mutation.type === 'attributes') {
				if (mutation.attributeName === 'class') {
					var target = mutation.target;
					var hasClass = target.classList.contains(classSel);
					callback(hasClass);
				}
			}
		}
	};

	const observer = new MutationObserver(cb);
	const config = {
		attributes : true,
		childList : false,
		subtree : false
	};
	observer.observe(node, config);
	return observer;
}

var registerQuickDiscountButtonClassChangeEvent = function() {
	const qdButton = document.getElementById('quickDiscountButtton');
	return registerNodeClassChange(qdButton, 'd-none', function(hasClass) {
		if (hasClass === true) {
			// cancel select cells
			posShoppingCartListView.selectedCells().each(function() {
				var cell = $(this);
				if (cell.hasClass('selected')) {
					cell.removeClass('selected');
				}
			});
		}
	});
}

var showCounponModal = function() {
	if (orderManager.currentSalesOrder) {
		const salesOrderId = orderManager.currentSalesOrder.salesOrderId;
		const url = GBF.ctxPos + '/SalesOrder/displayCoupon.do';
		const data = 'salesOrderId='+salesOrderId;
		openForm(url, data);
		$('#myModal').one('shown.bs.modal', function() {
			couponListController.getCommonCoupons();
		});
	}
}

const couponListController = {
	getCommonCoupons : function() {
		const self = this;

		return couponService.getCommonCoupons()
			.then(function(resp) {
				// Render coupons.
				const coupons = resp.data;
				const couponsInUsed = orderManager.currentSalesOrder.salesOrderCoupons;
				self.renderCoupons(coupons, couponsInUsed);
			})
			.catch(function(resp) {
				console.log(resp);
			});
	},
	renderCoupons : function(coupons, couponsInUsed) {
		if (!coupons || coupons.length === 0) {
			$('#coupon_container').find('.list-group')
				.empty();
			return;
		}
		const self = this;
		const couponItemsToRender = this.mergeCoupons(coupons, couponsInUsed);
		const couponsHTML = couponItemsToRender.map(function(item, i) {
			return self.getCouponItemTemplate(item, i);
		}).join('');
		$('#coupon_container').find('.list-group')
			.empty()
			.append(couponsHTML);
	},
	mergeCoupons : function(coupons, couponsInUsed) {
		const self = this;
		const couponsToRender = coupons.map(function(coupon) {
			return self.copyCoupon(coupon, false);
		});
		if (couponsInUsed && couponsInUsed.length > 0) {
			couponsInUsed.forEach(function(usedCoupon) {
				// usedCoupon is a object ex. {discount: 100, coupon: {....}}
				const usedCode = usedCoupon.coupon.code;
				const existingIndex = couponsToRender.findIndex(function(coupon) {
					return coupon.code === usedCode;
				});
				
				if (existingIndex === -1) {
					couponsToRender.unshift(self.copyCoupon(usedCoupon.coupon, true));
				} else {
					couponsToRender[existingIndex].used = true;
				}
			});
			return couponsToRender;
		}
		return couponsToRender;
	},
	copyCoupon : function(coupon, used=false) {
		return {
			code: coupon.code,
			title: coupon.title,
			discount: this.discountForCoupon(coupon),
			dateEndString: coupon.dateEndString,
			dollarOrPercentage: coupon.dollarOrPercentage,
			couponId: coupon.couponId,
			category: coupon.category,
			expired: coupon.expired,
			used: used
		};
	},
	discountForCoupon : function(coupon) {
		if (coupon.category === 'MINIMUM_PRICE_MEET' 
			|| coupon.category === 'MINIMUM_PIECE_MEET'
			|| coupon.category === 'DISCOUNT_FOR_EVERY_MINIMUM_PURCHASE'
		) {
			if (coupon.dollarOrPercentage === 'DOLLAR') {
				return `折價 ${coupon.discount}元`;
			} else if (coupon.dollarOrPercentage === 'PERCENTAGE') {
				return formatDiscountPercentage(coupon.discount);
			}
		}
		return '';
	},
	getCouponItemTemplate : function(coupon, i) {
		const isExpired = coupon.expired;
		const activeClazz = isExpired ? 'inactive' : 'active';
		const expiryLabel = isExpired ? '已過期' : '有效期限: ' + coupon.dateEndString;
		const expiryIcon = isExpired ? 'fa-times-circle' : 'fa-check-circle';
		
		const buttonStatus = isExpired ? 'expired' : (coupon.used ? 'using' : 'available');
		const buttonLabel = isExpired ? '已過期' : (coupon.used ? '取消' : '使用');
		const buttonHTML = `
			<button class="coupon-use-button ${buttonStatus}">${buttonLabel}</button>
		`;

		const html = `
			<div class="coupon" data-code="${coupon.code}" data-coupon-id="${coupon.couponId}">
				<div class="coupon-main">
					<input type="hidden" name="coupons[${i}].code" value="${coupon.code}">
					<div class="coupon-code">${coupon.code}</div>
					<div class="coupon-title">${coupon.title}</div>
					<div class="coupon-expiry-date">
						<i class="fas ${expiryIcon} coupon-status-icon ${activeClazz}"></i>
						${expiryLabel}
					</div>
				</div>
				<div class="coupon-action">
					<div class="coupon-discount" style="color: #6ea8fe;">${coupon.discount}</div>
					${buttonHTML}
				</div>
			</div>`.trim();
		return html;
	}
}

var showSalesRulesModal = function() {
	const url = GBF.ctxPos + '/SalesRule/rules.do';
	const data = {groupBuyId: groupBuyId};
	openForm(url, data);
}

function formatDiscountPercentage(discount) {
	// convert string to number
	if (typeof discount === 'string') {
		if (!/^\d*\.?\d+$/.test(discount)) {
			return new Error('Invalid discount: ' + discount);
		}
		discount = parseFloat(discount);
	}
	if (typeof discount !== 'number' || isNaN(discount)) {
		return new Error('NaN discount: ' + discount);
	}
	
	// ensure discount is in a reasonable range (0-100)
	if (discount < 0 || discount > 100) {
	  return '';
	}
  
	// calculate discount rate (ex. 10 -> 9折, 15 -> 8.5折)
	const discountRate = 100 - discount;
	
	// remove tailing 0 (ex. 90 -> 9, 85 -> 8.5)
	const formattedRate = discountRate % 10 === 0 ? 
	  (discountRate / 10) : discountRate;
	
	return `${formattedRate} 折`;
}

var loginModal = {
	phoneNumberButtonClick : function() {
		const numberBtn = $(this);
		const number = numberBtn.data('num');
		const input = $('input[name=customer-telephone]');
		if (number === 'delete') {
			input.val(input.val().substring(0, input.val().length - 1)); // Remove last
		} else {
			input.val(input.val() + number); // Append numeber to input.
		}

		event.preventDefault();
		event.stopPropagation();
	},
	shown : function() {
		$('#loginMember').find('[name=customer-telephone]').focus();
	},
	hidden : function() {
		$('input[name=customer-telephone]').val('');
		$('#customerHelp').text('');
	}
}

function openEditCustomerRoyaltyProgram() {
	const customerId = customerManager.currentCustomer.customerId;
	customerRoyaltyProgramManager.showEditor({
		customerId: customerId,
		loadAjaxUrl: baseUrl + '/ajax/CustomerRoyaltyProgram/get.do?customerId=' + customerId,
	});
}

const customerService = {
	/** Get Customer details. */
	getCustomer: function(data) {
		return new Promise(function(resolve, reject) {
			const url = GBF.ctxPosAjax + '/Customer/get.do';
			const ajaxData = { telephone: data.telephone };
			$.get(url, ajaxData)
				.done(function(response) {
					resolve(response);
				})
				.fail(function(error) {
					reject(error);
				});
		});
	},
}

var customerManager = {
	currentCustomer : null,
	/**
	 * 獲取客戶信息。
	 * 
	 * @param {string} tel - 客戶電話號碼（可選）。如果未提供，將使用輸入框中的值。
	 * @param {boolean} getCustomerDirectly - 是否直接獲取客戶信息。預設為 false。
	 * 
	 * 此函數執行以下操作：
	 * 1. 檢查是否需要先緩存訂單
	 * 2. 如果需要，先執行訂單緩存
	 * 3. 調用 _getCustomer 方法獲取客戶信息
	 * 
	 * @throws {Error} 如果在緩存訂單過程中發生錯誤
	 * 
	 * @example
	 * customerManager.getCustomer('1234567890');
	 */
	getCustomer : function(tel, getCustomerDirectly=false) {
		let telephone = $('input[name=customer-telephone]').val();
		if (!telephone || !telephone.trim().length) {
			telephone = tel;
		}
		const ajaxData = { 'telephone' : telephone };
		if (getCustomerDirectly) {
			// 經由「取單」進入，直接獲取客戶信息。
			customerManager._getCustomer(ajaxData);
			return;
		}
		/** Before get customer, check if need to confirm caching order. */
		// 1. Caching order, then get customer.
		// 2. Get customer directly.
		const isLogin = $('#loginMember').find('.modal-footer').hasClass('d-none');
		const isSaveCustomerSalesOrderBeforeChange = $('#saveCustomerSalesOrderBeforeChange').is(':checked');
		if (!isLogin && isSaveCustomerSalesOrderBeforeChange) {
			confirmCachingOrder()
				.then(function() {
					customerManager._getCustomer(ajaxData);
				})
				.catch(function(data) {
					console.error('Order save error:', data);
				});
		} else {
			customerManager._getCustomer(ajaxData);
		}
	},
	_getCustomer : function(data) {
		return customerService.getCustomer(data)
			.then(function(response) {
				const customer = response.data;

				if (!customer) {
					// No this customer.
					$('#customerHelp').text('無此位會員');
					return;
				} else {
					$('#customerHelp').text('');
				}

				// Update current customer.
				customerManager.currentCustomer = customer;
				// Display customer pane
				customerManager.showCustomerPane(customer);

				// Update customer of salesOrder if there is a salesOrder.
				orderManager.updateCustomer(customer.customerId);

				// Enable buttons.
				$('.btn-customer-records').removeClass('disabled').removeClass('d-none');

				$('#loginMember').modal('hide');

				$('.column-customer').show();
			})
			.catch(function(data) {
				$('#customerHelp').text(data.responseJSON.error);
			});
	},
	logout : function() {
		if (!$('#saveCustomerSalesOrderBeforeLogoutBlock').hasClass('d-none')) {
			if ($('#saveCustomerSalesOrderBeforeLogout').is(':checked')) {
				// save current sales order
				confirmCachingOrder();
			}
		}

		cleanOrderAndCustomerData();
		$('#logoutCustomer').modal('hide');
		$('.column-customer').hide();
	},
	showCustomerPane : function(customer) {
		let customerPane = $('.customer-pane');

		// Make valid customer ID.
		let customerId = customer.customerId.toString();
		const maxDigitCount = 12;
		if (customerId.length < maxDigitCount) {
			let count = maxDigitCount - customerId.length;
			for (let i = 0; i < count; i++) {
				customerId = '0' + customerId;
			}
			customerId = 'EC' + customerId;
		}

		// Update pane.
		var firstname = customer.firstname;
		if (customer.customerRoyaltyProgram) {
			firstname += '<span class="text-info ml-1">('+customer.customerRoyaltyProgram.pointsName+'：'+customer.customerRoyaltyProgram.points+')</span>';
		}
		let customerCard = customerPane.find('.customer-membership-card');
		customerCard.find('.card-state').text('VIP');
		customerCard.find('.card-name').text('會員卡');
		customerCard.find('.card-number').text(customerId);
		customerPane.find('.customer-name').html(firstname);
		customerPane.find('.customer-phone-number').text(customer.telephone);
		customerPane.find('.customer-email').text(customer.email);

		// Show customer pane.	
		customerPane.removeClass('d-none');
		customerPane.addClass('d-flex');

		// Hide button.
		$('button.open-client-login-modal').addClass('d-none');
	},
	cleanCustomerPane : function() {
		// First clean all fields in customer pane.
		let customerPane = $('.customer-pane');
		customerPane.find('.client-name').text('');
		customerPane.find('.client-phone-number').text('');
		customerPane.find('.client-email').text('');

		let customerCard = customerPane.find('.customer-membership-card');
		customerCard.find('.card-state').text('');
		customerCard.find('.card-name').text('');
		customerCard.find('.card-number').text('');

		// Then hide customer-pane.
		customerPane.addClass('d-none');
		customerPane.removeClass('d-flex');

		// Finally, show customer button.
		$('button.open-client-login-modal').removeClass('d-none');
	},
}

function openLoginMemberModal() {
	loginMemberModalManager.setMode('login').modal('show');
}

function openChangeMemberModal() {
	loginMemberModalManager.setMode('change').modal('show');
}

const loginMemberModalManager = {
	needConfirmCaching : function() {
		const $modal = $('#loginMember');
		const $cacheCheckbox = $('#saveCustomerSalesOrderBeforeChange');
		const isLoginMemberModalFooterShown = !$modal.find('.modal-footer').hasClass('d-none');
		const isCaching = $cacheCheckbox.is(':checked');
		return isLoginMemberModalFooterShown && isCaching;	
	},
	updateQRCodeSrc : function() {
		const d = new Date();
		const src = `${GBF.ctxPosAjax}/Customer/registerQrCode.do?uuid=${uuid}&stam=${d.getTime()}`;
		$('#customerRegisterQRCodeImg').attr('src', src);
		return this;
	},
	setMode : function(mode) {
		// Validate mode.
        const validModes = ['login', 'change'];
        if (!validModes.includes(mode)) {
            throw new Error(`Invalid mode: ${mode}. Valid modes: ${validModes.join(', ')}`);
        }

		const $modal = $('#loginMember');
		const $title = $('#loginMemberModalTitle');
		const $cacheCheckbox = $('#saveCustomerSalesOrderBeforeChange');
		const $footer = $modal.find('.modal-footer');

		this.updateQRCodeSrc();

		if (mode === 'login') {
			$title.text('登入會員');
			$footer.addClass('d-none');
		} else if (mode === 'change') {
			$title.text('切換會員');
			if (orderManager.hasOrderItemsNow()) {
				$footer.removeClass('d-none');
			} else {
				$footer.addClass('d-none');
			}
		}
		return this;
	}, 
	modal : function(showOrHide) {
		if (!showOrHide) {
			return $('#loginMember');
		}
		$('#loginMember').modal(showOrHide);
		return this;
	},
}

const needConfirmCachingInLoginMemberModal = function() {
	return loginMemberModalManager.needConfirmCaching();
}

var showCustomerRegisterPage = function() {
	if (needConfirmCachingInLoginMemberModal()) {
		confirmCachingOrder()
			.then(function() {
				toastr.success('訂單已儲存');
				openFormL(GBF.ctxPosAjax + '/Customer/showLoginModal.do');
				loginMemberModalManager.modal('hide');
			})
			.catch(function(error) {
				console.error('Order save error:', error);
			});
	} else {
		openFormL(GBF.ctxPosAjax + '/Customer/showLoginModal.do');
		loginMemberModalManager.modal('hide');
	}
}

function cleanOrderAndCustomerData() {
    orderManager.currentSalesOrder = null;
    customerManager.currentCustomer = null;

    customerManager.cleanCustomerPane();
    cleanAllViews();
}

/**
 * 確認並緩存當前訂單。
 * 
 * 此函數執行以下操作：
 * 1. 提交當前的訂單表單（ReturnRefundForm）
 * 2. 確認優惠券
 * 3. 清理訂單和客戶數據
 * 4. 隱藏緩存訂單的模態框
 * 
 * @returns {Promise} 返回一個 Promise 對象
 *   - 如果操作成功，Promise 將被解析
 *   - 如果在過程中發生錯誤（如表單提交失敗或優惠券確認失敗），Promise 將被拒絕
 * 
 * @throws {Error} 如果在提交表單或確認優惠券時發生錯誤
 * 
 * @example
 * confirmCachingOrder()
 *   .then(() => {
 *     console.log('訂單已成功緩存');
 *   })
 *   .catch((error) => {
 *     console.error('緩存訂單時發生錯誤:', error);
 *   });
 */
function confirmCachingOrder() {
	return new Promise(function(resolve, reject) {
		var submitHandler = function() {
			cleanOrderAndCustomerData();
			$('#cacheOrder').modal('hide');
			resolve();
		};

		$('#ReturnRefundForm').ajaxForm({
			success: function(response) {
				couponManager.confirm()
				.then(submitHandler)
				.catch(function(error) {
					console.error('Coupon confirm error:', error);
					reject(error);
				});
			},
			error: function(error) {
				console.error('Order save error:', error);
				reject(error);
			}
		});
			
		$('#ReturnRefundForm').submit();
	});
}

var makePage = function() {
	var size = 20,
		number = 1,
		end = false,
		loading = false;
	return {
		nextPage: function() { number += 1; },
		prevPage: function() { number -= 1; },
		pageNumber: function() { return number; },
		setPageNumber: function(pageNum) { number = pageNum; },
		pageSize: function() { return size; },
		setPageSize: function(newSize) { size = newSize; },
		// Loading
		startPageLoading: function(enabled) { loading = true; },
		stopPageLoading: function(enabled) { loading = false; },
		isPageLoading: function() { return loading; },
		// End
		setPageEnded: function(ended) { end = ended; },
		isPageEnded: function() { return end; },
		// Reload
		reloadPage: function(isReload) {
			if (isReload) {
				number = 1;
				end = false;
			}
		}
	};
}

function cleanAllViews() {
	// Clean two bags.
	$('.item-display-window .card-body.bag-body').empty();
	$('#checkoutDetailsModal .card-body.bag-body').empty();

	// Disable checkout start button and cache order items button.
	$('.js-start-checkout').addClass('disabled');
	$('.js-cache-order-items').addClass('disabled');

	// Clean all price labels.
	$('.bag-amount').text('$0');
	$('.total-paid-text').text('$0');

	// Reset checkout inputs.
	$('input[name=grand-total]').val("0");
	$('input[name=total-paid]').val("0");

	$('textarea[name=note]').val("");
	$('textarea[name=staffNote]').val("");
	
	updateCheckoutButton(0, 0);
	updatePriceAndDiscount(0, 0);
}

var customerSalesOrderPage = {};

$('#cachedOrders').ready(function() {
	const scrollContent = $('.draft-order-list')[0];
	const scrollWindow = $(scrollContent).parent();
	$(scrollContent).on('scroll', function(e) {
		if (customerSalesOrderPage.isPageEnded() || customerSalesOrderPage.isPageLoading()) return;
		
		const contentScrollTop = scrollContent.scrollTop;
		const contentHeight = scrollContent.clientHeight;
		const currentContentScrollBottom = contentScrollTop + contentHeight;
		
		const bottom = scrollContent.scrollHeight;
		const range = 50;
		const fetchThresholder = bottom - range;
		
		// if scrollTop is closed to the edge, fetch new page.
		if (currentContentScrollBottom >= fetchThresholder) {
			customerSalesOrderPage.startPageLoading();
			customerSalesOrderPage.nextPage();
			cachedSalesOrderData.pageNumber = customerSalesOrderPage.pageNumber();
			orderService.fetchSalesOrderList(cachedSalesOrderData)
			.then(function(resp) {
				if (!resp.data || resp.data.length < 20) {
					customerSalesOrderPage.setPageEnded(true);
				}
				$('#cachedOrders').find('.draft-order-list').append(createDraftList(resp.data));
				customerSalesOrderPage.stopPageLoading();
			}, function(data) {
				customerSalesOrderPage.stopPageLoading();
				const err = data.responseJSON.error;
				$('#cachedOrders').find('.help').text(err);
			});
		}
	});
});

var openDraftOrderListModal = function() {
	const ajaxData = { groupBuyId: groupBuyId };
	openSalesOrdersModal(ajaxData, '取回訂單');
}

var cachedSalesOrderData = {};
var openSalesOrdersModal = function(ajaxData, title) {
	const modal = $('#cachedOrders');
	modal.find('.help').text('');
	modal.modal('show');

	// Show loading.
	const spinner = 
		'<div class="d-flex flex-fill h-100 align-items-center justify-content-center" id="cachedSalesOrderListModalSpinner">' +
		'<div class="spinner-border" style="width: 3rem; height: 3rem;" role="status">' +
		'<span class="sr-only">Loading...</span>' + 
		'</div>' +
		'</div>';
	modal.find('.draft-order-list').append(spinner);
	
	$('#cachedOrdersModalLabel').text(title);
	
	customerSalesOrderPage = new makePage();
	ajaxData.pageSize = customerSalesOrderPage.pageSize();
	ajaxData.pageNumber = customerSalesOrderPage.pageNumber();
	
	cachedSalesOrderData = ajaxData;
	
	orderService.fetchSalesOrderList(ajaxData)
	.then(function(resp) {
		$('#cachedSalesOrderListModalSpinner').remove();
		modal.find('.draft-order-list').html(createDraftList(resp.data));
	}, function(data) {
		$('#cachedSalesOrderListModalSpinner').remove();
		const err = data.responseJSON.error;
		modal.find('.help').text(err);
	});
}

var getCustomerSalesOrders = function(event, state) {
	const customerId = customerManager.currentCustomer.customerId;
	if (!customerId) return;
	
	var state = '';
	if ($(event.target).hasClass('btn-customer-records')) {
		state = 'COMPLETE';
	} else if ($(event.target).hasClass('btn-pending-order')) {
		state = 'DRAFT';
	}
	
	if (!state.length) return;

	const data = { 
		groupBuyId: groupBuyId, 
		customerId: customerId,
		customerFirstname: customerManager.currentCustomer.firstname,
		customerTelephone: customerManager.currentCustomer.telephone,
		stateString: state
	};
	const param = $.param(data);
	const url = GBF.ctxPos + '/SalesOrder/salesOrderList.do';
	openFormL(url, param);
}

/* Enter payment detail modal. */
var modalPaymentPrice = function() {
	let btn = $(this);
	let paymentMethod = btn.data('pay-type');
	let grandTotal = $('input[name=grand-total]').val();
	if (grandTotal == 0) {
		grandTotal = $('input[name=total-paid]').val();
	} else {
		// Update total paid
		$('input[name=total-paid]').val(grandTotal);

		$('.grand-total-text').text('$0');
		$('.total-paid-text').text('$' + grandTotal);
	}
	let card = '<div class="card pane-card mb-2 bg-success">'
			+ '<div class="card-body py-1 px-2">'
			+ '<div class="row payment-price-show-block">'
			+ '<div class="col-6">'
			+ '<p class="card-title text-white">' + btn.text() + '</p>'
			+ '</div>'
			+ '<div class="col-6">'
			+ '<p class="card-text text-right text-white bag-amount payment-price">' 
			+ grandTotal 
			+ '</p>' 
			+ '</div>' 
			+ '</div>'
			+ '<input type="hidden" name="payment-method" value="' + paymentMethod + '">'
			+ '</div>' 
			+ '</div>';

	let list = $('.payment-list');
	list.html(card);

	$('.js-finish-checkout').removeClass('disabled');

	if (false) { // TODO Not now
		let type = this.dataset.payType;
		let name = $(this).text();
		let modal = $('#paymentInputModal');
		modal.find('#paymentType').val(type);
		modal.find('#paymentTypeName').val(name);
		modal.modal('show');
	}
}

$.PaymentData = function() {};

$.PaymentData.prototype = {
	init : function(rawPayment) {
		// {"label":"銀行轉帳","value":"銀行轉帳,1"}
		this.rawValue = rawPayment.value;
		this.tag = rawPayment.label;
		this.key = rawPayment.value.split(',')[1];
		this.amount = 0;
		if (this.key === '256') {
			this.id = parseInt(this.key) + parseInt(Math.random() * 1000);
		} else {
			this.id = parseInt(this.key);
		}
	}
}

var checkoutPayment = {
	supportPayment : [],
	fetchSupportPayment: function (successHandler) {
		this.supportPayment = [];
		$.ajax({
			method: 'get',
			url: GBF.ctxPosAjax + '/Pos/getSupportPaymentMethods.do',
			data: { groupBuyId : groupBuyId },
			dataType: 'json',
			async: false,
			global: false,
			success: function(result) {
				if (result && result.length) {
					checkoutPayment.supportPayment = result.map(function ( pay ) {
						var data = new $.PaymentData();
						data.init( pay );
						return data; 
					});
					if (successHandler) {
						successHandler(checkoutPayment.supportPayment);
					}
				}
			}
		});
	},
	result: [],
	add: function (id, price) {
		var pay = this.get(id);
		pay.amount = price;
		this.result.push(pay);
	},
	remove: function (id) {
		if (!this.result || !this.result.length) {
			return;
		}
		this.result = this.result.filter(function (element) {
			return element.id !== parseInt(id);
		});
	},
	update: function (id, price, name) {
		if ( isNumber(price) === false ) {
			return;
		}
		if (price <= 0) {
			this.remove(id);
			return;
		}
		if (this.result.length === 0) {
			this.add(id, price);
		} else {
			var temp = this.result.find(function (element) {
				return (element.id === parseInt(id));
			});
			if (temp) {
				temp.amount = price;
			} else {
				this.add(id, price);
			}
		}
	},
	get: function (id) {
		var getById = function (array, id) {
			return array.find(function (element) {
				return element.id === parseInt(id);
			});
		};
		var temp = getById(this.result, id);
		if (temp) {
			return temp;
		}
		var cache = getById(this.supportPayment, id); 
		cache = $.extend(true, {}, cache); // Deep copy
		return cache;
	},
	reset: function () {
		this.result = [];
	},
	toDetails : function () {
		var details = this.result.map(function (element) {
			return { paymentMethodTag : element.tag, paymentMethod: element.key, amount: element.amount };
		});
		return details;
	}
}

function reloadPaymentList (data) {
	if (!data || data.length === 0) {
		$('#paid-payment-type-list').empty();
		return;
	}
	
	var html = '';
	for (var i = 0; i < data.length; i++) {
		var pay = data[i];
		var title = pay.tag;
		var id = pay.id;
		var amount = pay.amount;
		
		html +=
			'<div class="card pane-card mb-2 bg-danger" onclick="showPaymentEditorModal(this,' + id + ')">' +
			'<div class="card-body py-1 px-2">' +
			'<div class="row">' +
			'<div class="col-6">' +
			'<p class="card-title text-white">' + title + '</p>' +
			'</div><!-- /.Col-6 -->' +
			'<div class="col-6">' +
			'<p class="card-text text-right text-white mb-0 bag-amount paid-label">$' + amount + '</p>' +
			'</div><!-- /.Col-6 -->' +
			'</div><!-- /.Row -->' +
			'</div><!-- /.Card-Body -->' +
			'</div><!-- /.Card -->';
	}
	$('#paid-payment-type-list').html(html);
}

function reloadTotalPaidLabel(data) {
	var totalPaid = data.reduce(function (accu, curr) {
		return accu + curr.amount;
	}, 0);
	
	var oriGrandTotal = parseInt($('#checkoutV2Modal [name=grand-total]').val());
	
	var grandTotal = oriGrandTotal - totalPaid;
	
	// Update total-paid label and input
	$('#checkoutV2Modal .grand-total-text').text('$' + grandTotal);

	$('#checkoutV2Modal .total-paid-text').text('$' + totalPaid);
	$('#checkoutV2Modal [name=total-paid]').val(totalPaid);
}

function isNumber(obj) {
	return typeof(obj) === 'number' && !isNaN(obj);
}

function showPaymentEditorModal(element, id) {
	var pay = checkoutPayment.get(id);
	var modal = $('#paymentInputModal');
	modal.find('#paymentTypeTitle').text(pay.tag);
	modal.find('#paymentType').val(id);
	modal.find('#paymentTypeName').val(pay.tag);
	
	var totalPaid = checkoutPayment.result.reduce(function (accu, curr) {
		return accu + curr.amount;
	}, 0);
	
	var oriGrandTotal = parseInt($('#checkoutV2Modal [name=grand-total]').val());
	
	var balance = oriGrandTotal - totalPaid;
	
	var amount = (pay.amount === 0) ? balance : pay.amount;
	var max = pay.amount + balance;
	
	modal.find('#paymentPriceInput').val(amount);
	modal.find('#paymentPriceInput').attr('max', max);
	modal.modal('show');
}

function clearPaymentList() {
	$('.payment-list').html('');

	// Restore
	let grandTotal = $('input[name=grand-total]').val();
	let totalPaid = $('input[name=total-paid]').val();

	$('input[name=grand-total]').val(totalPaid);
	$('input[name=total-paid]').val(grandTotal);

	$('.grand-total-text').text('$' + totalPaid);
	$('.total-paid-text').text('$0');

	$('.js-finish-checkout').addClass('disabled');
}

$('#paymentInputModal').ready(function () {
	$('#paymentInputModal').on('shown.bs.modal', function() {
		$('#paymentInputModal').find('#paymentPriceInput').focus();
	});
	
	// Clean the price input after modal is hidden.
	$('#paymentInputModal').on('hidden.bs.modal', function() {
		$('#paymentInputModal').find('#paymentPriceInput').val('');
		
		// When modal hides, it will remove the class .modal-open from the 
		// body element. This class will make a long content modal 
		// scrollable(overflow-y: auto;), so it needs to be added after 
		// #paymentInputModal hided to keep #checkoutV2Modal is still scrollable.
		$('body').addClass('modal-open');
	});
	
	// Payment price modal
	// Use its input to create payment in the .payment-list div.
	let paymentPriceInputForm = document.getElementById('paymentPriceForm');
	paymentPriceInputForm.addEventListener('submit', function(event) {
		event.preventDefault();

		const FD = new FormData(paymentPriceInputForm);
		let price = parseInt(FD.get('paymentPrice'));
		let paymentType = FD.get('paymentType');
		let paymentTypeName = FD.get('paymentTypeName');
		
		checkoutPayment.update(paymentType, price, paymentTypeName); 
		reloadPaymentList(checkoutPayment.result);
		reloadTotalPaidLabel(checkoutPayment.result);
		
		$('#paymentInputModal').modal('hide');
	});
});

var updateAdminMenu = function(data) {
	$('.nav-item-usermenu-context').empty();
	
	var adminName;
	if (data && data.options && data.options.admin) {
		adminName = data.options.admin[0].value;
	}
	adminManager.getUserMenu(adminName);
}

var adminManager = {
	getUserMenu: function() {
		var p = adminService.getUserMenu();
		p.then(function(response) {
			if (response) {
				if (Array.isArray(response.menuItems) && response.menuItems.length) {
					var html = response.menuItems.reduce(function (accu, curr) {
						return accu + curr;
					}, '');
					if (html.trim().length) {
						$('.nav-item-usermenu-context').html(html);	
					}
				}
			}
		});
	}
}

var adminService = {
	getUserMenu: function(ajaxdata) {
		var ajaxurl = GBF.ctxPosAjax + '/Pos/getUserMenu.do';
		return Promise.resolve($.get(ajaxurl, ajaxdata));
	}
}

$(function() {
	$('.button-collapse-pos').sideNav({
		breakpoint : 20000,
	});
	
	adminManager.getUserMenu();

	$('button.js-customer-login').click(customerManager.getCustomer);
	$('button.js-customer-logout').click(customerManager.logout);

	$('button.btn-customer-records').click(getCustomerSalesOrders)

	$('body').on('click', '.btn-payment', modalPaymentPrice);

	$('#autoApplySalesRules').change(function() {
		const isAutoApplySalesRules = $(this).prop('checked');
		orderManager.autoApplySalesRules = isAutoApplySalesRules;
		
		$('#ReturnRefundForm').find('input[name$=".discount"]').each(function() {
			$(this).prop('readonly', isAutoApplySalesRules);
		});
		
		// Toggle quick discount button.
		const state = isAutoApplySalesRules;
		$('#quickDiscountButtton').toggleClass('d-none', state);
	});
	
	registerQuickDiscountButtonClassChangeEvent();
	
	checkoutStepper = new EPStepper('#checkout-stepper');
	checkoutStepper.onStepChange(function(activeStepIndex) {
		if (activeStepIndex === 1) {
			$('#checkoutV2Modal .modal-footer').hide();		
		} else {
			$('#checkoutV2Modal .modal-footer').show();
		}
	});

	// item-display-window change
	$('body').on(
			'DOMSubtreeModified',
			'.item-display-window',
			function() {
				let $this = $(this);
				let tBody = $this.find('table').find('tbody');
				let numberOfTr = tBody.children().length;

				// Update the buttons in .selected-items-function-bar
				// It uses the number of <tr> in <tbody> to specify the state of buttons.
				let bar = $('.selected-items-function-bar');
				if (numberOfTr > 1) {
					bar.find('.js-multiple-select-toggler.disabled')
							.removeClass('disabled');
					bar.find('.js-edit-salesperson.disabled').removeClass(
							'disabled');
					bar.find('.js-edit-price.disabled').removeClass(
							'disabled');
					bar.find('.js-clean-all-selected-items.disabled')
							.removeClass('disabled');
					//$('.js-start-checkout').removeClass('disabled');
				} else {
					bar.find('.js-multiple-select-toggler').addClass(
							'disabled');
					bar.find('.js-edit-salesperson').addClass('disabled');
					bar.find('.js-edit-price').addClass('disabled');
					bar.find('.js-clean-all-selected-items').addClass(
							'disabled');
					//$('.js-start-checkout').addClass('disabled');
				}
			});

	$('body').on('click', '.js-open-draft-orders', openDraftOrderListModal);

	filterManager.reload(groupBuyId);
	$('#filter-rules').change(filterManager.sysTagSelectChange);
	
	$('#pageSizeSelect').change(function() {
		filterManager.queryItems(true);
	})
	
	$('.js-filter-search-toggler').click(function() {
		const wrapper = $('.function-bar-wrapper');
		// Toggle filter and search mode.
		wrapper.toggleClass('filter-mode search-mode');
		// Trigger reload when it enters filter mode again.
		if (wrapper.hasClass('filter-mode')) {
			$('.product-display-scrollable-content').empty();
			filterManager.queryItems(true);
		}
	});
	
	$('.js-expand-toggler').click(function() {
		const $btn = $('.js-expand-toggler');
		const isExpand = $btn.hasClass('expand-state');
		$('.function-toolbar').toggleClass('hide', !isExpand);
		$('nav.navbar').toggleClass('hide', !isExpand);
		$('.product-display').toggleClass('expand', !isExpand);
		$btn.find('i').toggleClass('fa-expand fa-compress');
		$btn.toggleClass('expand-state', !isExpand);
	});
	
	updateDatalist('searchTitleHistory');
	updateDatalist('searchUidHistory');

	$('body').on('click', '.js-oi-editor-modal', showOrderItemEditorModal);
});

$('#searchForm').ready(function() {
	const scrollableContent = $('.product-display-scrollable-content');
	const searchTitleInput = $('#search-item-title');
	const searchUidInput = $('#search-item-uid');
	$('#searchForm').ajaxForm({
		beforeSubmit: function(formData, jqForm, options) {
			if (formData[0].name === 't' && formData[0].value.trim().length) {
				scrollableContent.empty();
				searchUidInput.val('');
				filterManager.queryItems(true);
			}
			return false;
		}
	});
	$('#searchForm').submit(function(event) {
		event.preventDefault();
		event.stopPropagation();
	});
	$('#searchUidForm').ajaxForm({
		beforeSubmit: function(formData, jqForm, options) {
			if (formData[0].name === 'uid' && formData[0].value.trim().length) {
				scrollableContent.empty();
				searchTitleInput.val('');
				filterManager.queryItems(true);
			}
			return false;
		}
	})
	$('#searchUidForm').submit(function(event) {
		event.preventDefault();
		event.stopPropagation();
	});
	document.addEventListener('ep.queryItemsByUid', function (eve) {
		const data = eve.detail;
		if (data.data.length === 1) {
			searchUidInput.val('');
			
			const hasOnlyOne = $('#new-products').find('.item-col-5').length === 1;
			if (hasOnlyOne) {
				// show modal
				$('#new-products').find('.item-col-5').find('a[onclick]').click();
				$('#myModal').one('hidden.bs.modal', function () {
					document.getElementById('search-item-uid').focus();
				});
			}
		}
	});
});

var enterPressed = false;
var enterTimeout;
$(document).on('keypress', function() {
	if (event.key === "Enter") {
		const isItemModalFocus = $('#myModal').hasClass('show') && $('#myModal').find('[name="popOrderItems[0].itemId"]').length === 1;
		if (isItemModalFocus && !enterPressed) {
			enterPressed = true;
			enterTimeout = setTimeout( function () {
				enterPressed = false;
			}, 500);
			$('#myModal').find('.btn-addShoppingCart').click();
		}
	}
});

var updateDatalist = function(id) {
	// Get stored array from cookies.
	const stored = Cookies.get(id);
	var storedAry = !!stored ? JSON.parse(stored) : [];
	if (!storedAry || !storedAry.length) return;
	// Update datalist.
	const datalistOptions = storedAry.reduce(function(accu, curr) {
		return accu + '<option value="' + curr + '">';
	}, '');
	$('#' + id).html(datalistOptions);
}

var updateCookies = function(key, value) {
	// Get stored array from cookies.
	const stored = Cookies.get(key);
	var storedAry = !!stored ? JSON.parse(stored) : [];
	// Store value in array.
	if (storedAry.includes(value)) {
		storedAry = storedAry.filter(elem => elem !== value);	
	}
	storedAry.unshift(value);
	// Not over 10 elements in array.
	if (storedAry.length > 10) {
		storedAry.pop();
	}
	// Stored result array in cookie.
	Cookies.set(key, JSON.stringify(storedAry));
}

var checkoutV2Modal = {
	isStateRadioChecked : function() {
		return ( $('#stateShipping').prop('checked') || $('#stateUnshipping').prop('checked') );
	},
	setStateRadioChecked : function() {
		if (!$('.plz-checked-shipping-state').hasClass('d-none')) {
			$('.plz-checked-shipping-state').addClass('d-none');
		}
	},
	resetShippingState : function() {
		$('#stateShipping').prop('checked', true);
		$('#checkoutV2Modal').find('input[name="state"]').val('SHIPPING');
	},
	isPaid : true,
	showModal : function() {
		var btn = $('.js-start-checkout');
		btn.spinning(true);
		
		$('#ReturnRefundForm').ajaxForm({
			success : function() {
				couponManager.confirm()
				.then(function() {
					return orderManager.prepareReturnAndRefund();	
				})
				.then(function(data) {
					reloadItems(data);
					// Show modal after all API calls.
					$('#checkoutV2Modal').modal('show');
					btn.spinning(false);
				});
			},
			error: function(data) {
				toastr.error(data.responseJSON.error);
				btn.spinning(false);
			}
		});

		// Send form.
		$('#ReturnRefundForm').submit();
	},
	show : function() {
		if (this.style.display === 'block') {
			// When the display of #checkoutV2Modal is block and 
			// this event handler is called, there must be another 
			// modal ovelays on it. Do nothing.
			return;
		}
		
		// fetch the price
		var salesOrder = orderManager.currentSalesOrder;
		
		var modal = $('#checkoutV2Modal');
		modal.find('.grand-total-text').text('$' + salesOrder.grandTotal);
		modal.find('.total-paid-text').text('$0');
		
		// Update inputs
		modal.find('input[name=grand-total]').val(salesOrder.grandTotal);
		modal.find('input[name=total-paid]').val("0");
		
		checkoutV2Modal.resetShippingState();
		
		// Default: rewarding points
		$('#rewardPoints').prop('checked', true);
		
		// When #checkoutV2Modal shows, try to get points.
		// In this case, #checkoutV2Modal.display might be an empty
		// string or 'none'.
		pointsManager.getPoints();
		
		if (!!customerManager.currentCustomer) {
			let customer = customerManager.currentCustomer;
			let firstname = customer.firstname;
			let telephone = customer.telephone;
			let email = customer.email;
			
			$('#customerFirstname').val(firstname);
			$('#customerTelephone').val(telephone);
			$('#customerEmail').val(email);
		}
		modal.find('.js-start-checkout').addClass('disabled');
		modal.find('.js-checkout-confirm').spinning(false);
	},
	hidden : function() {
		// Check display value in case this event handler is triggered
		// by #paymentInputModal hiding.
		if (this.style.display === 'none') {
			checkoutV2Modal.cleanAll();
		}
		$('.js-start-checkout').removeClass('disabled');
	},
	stateRadioChanged : function() {
		checkoutV2Modal.setStateRadioChecked();
		$('#checkoutV2Modal')
		.find('input[type=hidden][name=state]')
		.val(this.value);
	},
	paid : function() { // Deprecated.
		let modal = $('#checkoutV2Modal');
		let grandTotalInput = modal.find('input[name=grand-total]');
		let totalPaidInput = modal.find('input[name=total-paid]');
		let grandTotal = grandTotalInput.val();

		// Update total paid
		totalPaidInput.val(grandTotal);

		modal.find('.grand-total-text').text('$0');
		modal.find('.total-paid-text').text('$' + grandTotal);
	},
	cleanAll : function() {
		var modal = $('#checkoutV2Modal');
		
		// Reset price labels.
		modal.find('.grand-total-text').text('$0');
		modal.find('.total-paid-text').text('$0');
		
		// reset hidden inputs.
		modal.find('input[name=grand-total]').val('0');
		modal.find('input[name=total-paid]').val('0');
		
		$('#paid-payment-type-list').empty();
		
		checkoutPayment.reset();
		
		// Uncheck all 4 radio inputs.
		modal.find('input[type=radio]').prop('checked', false);
		
		// Unactive any active receipt label.
		$('input[name=receiptType]').closest('label').removeClass('active');
		
		// Checked first radio button.
		$('input[name=receiptType][value=1]').prop('checked', true);
		$('input[name=receiptType][value=1]').closest('label').addClass('active');
		
		// Hide all receipts blocks.
		$('#receipeType-barcode-section').hide();
		$('#receipeType-channel-section').hide();
		$('#receipeType-b2b-section').hide();
		$('#receiptTitle').val('');
		$('#receiptVatId').val('');
		$('#receiptCarrierNum').val('');
		$('#invoiceNumber').val('');

		// Hide 2 error messages.
		modal.find('.plz-checked-shipping-state').addClass('d-none');
		modal.find('.plz-checked-pay-method').addClass('d-none');
		
		$('#noteFormControlTextarea').val('');
		$('#staffNoteFormControlTextarea').val('');
		
		$('#customerFirstname').val('');
		$('#customerTelephone').val('');
		$('#customerEmail').val('');
		
		$('#paidCheckbox').prop('checked', true);
		this.isPaid = true;
	},
	validateTotalPaid: function () {
		// Decide to show alert.
		var modal = $('#checkoutV2Modal');
		var isValid = true;
		if (this.isPaid) {
			var grandTotal = parseInt(modal.find('[name=grand-total]').val());
			var totalPaid = parseInt(modal.find('[name=total-paid]').val());
			isValid = (grandTotal === totalPaid);
		}
		modal.find('.total-paid-invalidation').toggleClass('d-block', !isValid);
		return isValid;
	},
	validateReceipt: function() {
		var receiptType = parseInt($('#checkoutV2Modal').find('input[name=receiptType]:checked').val());
		if (receiptType === 2) { // for company
			var rt = document.getElementById('receiptTitle');
			var ri = document.getElementById('receiptVatId');
			const isValid = (rt.reportValidity() && ri.reportValidity());
			return isValid;
		} else {
			return true;
		}
	},
	validateReceiptCarrierNum: function () {
		const $receiptCarrierNumInput = $('#checkoutV2Modal').find('input[name=receiptCarrierNum]');
		if ($receiptCarrierNumInput.is(':visible')) {
			const num = $receiptCarrierNumInput.val();			
			const isValid = /^\/[0-9A-Z.+-]{7}$/.test( num );
			$receiptCarrierNumInput.siblings('.field-help')
			.toggleClass('text-danger', !isValid);
			return isValid;
		} else {
			return true;
		}
	},
	validate: function() {
		if (this.isStateRadioChecked() === false) {
			$('.plz-checked-shipping-state').removeClass('d-none');
			return false;
		}
		if (this.validateTotalPaid() === false ||
			this.validateReceipt() === false || 
			this.validateReceiptCarrierNum() === false) {
			return false;
		}
		return true;
	},
	checkout : function() {
		if (this.validate() === false) {
			return;
		}
		var modal = $('#checkoutV2Modal');
		var soId = orderManager.currentSalesOrder.salesOrderId;
		var state = modal.find('input[name=state]').val();
		var totalPaid = modal.find('input[name=total-paid]').val();
		var grandTotal = modal.find('input[name=grand-total]').val();
		var note = modal.find('textarea[name=note]').val();
		var staffNote = modal.find('textarea[name=staffNote]').val();
		var receiptType = modal.find('input[name=receiptType]:checked').val();
		var receiptTitle = modal.find('input[name=receiptTitle]').val();
		var receiptVatId = modal.find('input[name=receiptVatId]').val();
		var receiptCarrierNum = modal.find('input[name=receiptCarrierNum]').val();
		var invoiceNumber = modal.find('input[name=invoiceNumber]').val();
		var points = modal.find('input[name=points]').val();
		var isRewardPoints = $('#rewardPoints').prop('checked');
		var customerFirstname = $('#customerFirstname').val();
		var customerTelephone = $('#customerTelephone').val();
		var customerEmail = $('#customerEmail').val();
		var shippingState = modal.find('input[name=shippingStateRadio]:checked').val();
		//var salesOrderDate = $('#salesOrderCommitDateTimePicker').data().DateTimePicker.viewDate().valueOf(); // ms

		modal.find('.js-checkout-confirm').spinning(true);
		
		// Append payment details until checkout.
		var payMethod;
		var paidDetails;
		if (parseInt(totalPaid) === 0 && parseInt(grandTotal) === 0) {
			var defaultPay = checkoutPayment.supportPayment[0];
			payMethod = defaultPay.key;
			paidDetails = [{ paymentMethodTag : defaultPay.tag, 
							paymentMethod: defaultPay.key, 
							amount: 0 
							}];
		} else if (parseInt(totalPaid) === 0 && parseInt(grandTotal) > 0) {
			payMethod = '';
			paidDetails = [];
		} else {
			payMethod = checkoutPayment.result[0].key;
			paidDetails = checkoutPayment.toDetails();
		}

		var ajaxData = {
			salesOrderId : soId,
			paymentMethod : payMethod,
			//state : state,
			totalPaid : totalPaid,
			grandTotal : grandTotal,
			shippingAmount : '0',
			shippingState: shippingState,
			note : note,
			staffNote : staffNote,
			receiptType : receiptType,
			receiptTitle : receiptTitle,
			receiptVatId : receiptVatId,
			receiptCarrierNum : receiptCarrierNum,
			invoiceNumber : invoiceNumber,
			paidDetails : paidDetails,
			points : points,
			isRewardPoints : isRewardPoints,
			customerFirstname: customerFirstname,
			customerTelephone : customerTelephone,
			customerEmail : customerEmail,
		};

		const resultModal = $('#checkoutV2ResultModal');

		const successHandler = function (data) {
			modal.find('.js-checkout-confirm').spinning(false);
			modal.modal('hide');
			const salesOrderId = orderManager.currentSalesOrder.salesOrderId;
			const uuid = orderManager.currentSalesOrder.uuid;
			const customerId = orderManager.currentSalesOrder.customerId;

			cleanAllViews();
			checkoutV2Modal.cleanAll();

			// This order is done.
			orderManager.currentSalesOrder = null;

			// Prepare checkout result modal.
			const receiptTypeInt = parseInt(receiptType);
			const supportInvoice = receiptTypeInt === 1 || receiptTypeInt === 2 || !this.isPaid;
			$('#printInvoiceButton').prop('disabled', !supportInvoice);
			$('#issueInvoiceButton').prop('disabled', !supportInvoice);
			resultModal.find('.modal-title').text(GBFi18n.checkout_result_success_title);
			resultModal.find('.result').html('<div class="success-msg">' + data.error + '</div>');
			resultModal.data({ 'salesOrderId': salesOrderId, 'uuid': uuid, 'customerId': customerId });
			
			// Show result modal
			resultModal.modal('show');
		};

		const errorHandler = function (data) {
			modal.find('.js-checkout-confirm').spinning(false);
			// Show error.
			resultModal.find('.modal-title').text('失敗');
			resultModal.find('.result').html('<span class="text-danger">' + data.responseJSON.error + '</span>');
			resultModal.modal('show');
		};

		orderManager.checkout(ajaxData)
		.then(successHandler, errorHandler);
	}
}

var checkoutV2ResultModal = {
	showSalesOrderQRCode: function(uuid, customerId) {
		const result = $('#checkoutV2ResultModal').find('.modal-body .result');
		if (!customerId) {
			result.append('<div class="text-muted small font-weight-light">(欲產生訂單明細的 QRCode 需要會員 ID，請確認是否已經登入會員)</div>');
		} else {
			const url = GBF.ctxPosAjax + '/SalesOrder/details.do';
			const params = {'groupBuyId': groupBuyId, 'customerId': customerId, 'uuid': uuid};
			$.post(url, params)
			.done(function (data) {
				const pageUrl = data.data;
				$('#salesOrderDetailsPageLink')
				.attr('href', pageUrl)
				.append(' <i class="fa-solid fa-arrow-up-right-from-square"></i>');
			});

			const search = $.param(params);
			const qrcodeUrl = GBF.ctxPosAjax + '/SalesOrder/generateQRCode.do?' + search;
			const html = '' +
				'<div class="d-flex justify-content-center">' +
				'<figure class="figure">' +
				'<img class="img-fluid" src="' + qrcodeUrl + '" alt="消費者訂單明細頁面 QR Code">' +
				'<figcaption class="figure-caption">' +
				'<a class="" href="#" title="訂單明細連結" target="_blank" id="salesOrderDetailsPageLink">訂單明細連結</a>' +
				'</figcaption>' +
				'</figure>' +
				'</div>';
			result.append(html);
		}
	},
	showIssueInvoiceButton: function(salesOrderId) {
		if ($('#issueInvoiceButton').is(':disabled')) return;

		const url = GBF.ctxPosAjax + '/Invoice/isInvoiceIssued.do';
		const params = {'salesOrderId': salesOrderId};

		$.post(url, params)
		.done(function (data) {
			const isIssued = data.data;
			if (isIssued) {
				$('#issueInvoiceButton').hide();
				$('#printInvoiceButton').show();
			} else {
				$('#issueInvoiceButton').show();
				$('#printInvoiceButton').hide();
			}
		})
		.fail(function (data) {
			modal.find('.error-msg').text(data.responseJSON.error);
		});
	}
}

// For #checkoutV2ResultModal
$(document).ready(function () {
	const modal = $('#checkoutV2ResultModal');

	const issueBtn = $('#issueInvoiceButton');
	const printBtn = $('#printInvoiceButton');

	issueBtn.click(function () {
		issueBtn.spinning(true);
		const salesOrderId = modal.data('salesOrderId');
		const url = GBF.ctxPosAjax + '/Invoice/issueInvoice.do';
		const params = { salesOrderId: salesOrderId };
		$.post(url, params)
		.done(function (data) {
			toastr.success('已成功開立發票');
			printBtn.show();
			issueBtn.spinning(false).hide();
		})
		.fail(function (data) {
			modal.find('.error-msg').text(data.responseJSON.error);
			issueBtn.spinning(false);
		});
	});

	printBtn.click(function () {
		const salesOrderId = modal.data('salesOrderId');
		const search = $.param({ salesOrderId: salesOrderId });
		const url = GBF.ctxPosAjax + '/Invoice/print.do?' + search;
		window.open(url, '_blank');
	});

	modal
	.on('show.bs.modal', function () {
		// clear error message
		modal.find('.error-msg').text('');

		// hide all buttons about invoice function
		printBtn.hide();
		issueBtn.hide();

		// no uuid means checkout.do is failed
		const uuid = modal.data('uuid');
		if (!uuid) return;

		const customerId = modal.data('customerId');
		const salesOrderId = modal.data('salesOrderId');
		checkoutV2ResultModal.showSalesOrderQRCode(uuid, customerId);
		checkoutV2ResultModal.showIssueInvoiceButton(salesOrderId);
	})
	.on('hidden.bs.modal', function () {
		// clear all data
		$(this).removeData('uuid').removeData('salesOrderId');
		// ref to #paymentInputModal hidden.bs.modal
		$('body').addClass('modal-open');
	});

	if (paramSalesOrderUUID) {
		loadSalesOrder(paramSalesOrderUUID);
	}
	if (paramMode) {
		toggleEditSalesOrderMode(paramMode);
	}

	$('#logoutCustomer').on('show.bs.modal', function (e) {
		if (orderManager.hasOrderItemsNow()) {
			$('.logoutCustomer__message').text('目前該會員的購物車裡面已有商品，要先暫存訂單後再登出嗎？');
			$('#saveCustomerSalesOrderBeforeLogoutBlock').removeClass('d-none');
		} else {
			$('.logoutCustomer__message').text('確認要登出目前使用中的會員？');
			$('#saveCustomerSalesOrderBeforeLogoutBlock').addClass('d-none');
		}
	})

	// redeem coupon used in coupon mod
	$(document).on('click', '#coupon_container .coupon-use-button.available', function() {
		const $btn = $(this);
		const code = $btn.closest('.coupon').data('code');
		redeemCouponByCode(code, $btn);
	});
	$(document).on('click', '#coupon_container .coupon-use-button.using', function() {
		const $btn = $(this);
		const code = $btn.closest('.coupon').data('code');
		removeCoupon(code);
	});
});

const loadSalesOrder = function (salesOrderUUID) {
	if (salesOrderUUID.trim().length === 0) return;
	const soParam = { uuid: salesOrderUUID };
	getSalesOrder(soParam);
}

const toggleEditSalesOrderMode = function (editSalesOrderMode) {
	if (!editSalesOrderMode || editSalesOrderMode.trim().length === 0) return;
	$('#posManipulateSalesOrderBtnWrapper').addClass('d-none').removeClass('d-flex');
	$('#editSalesOrderBtnWrapper')
	.removeClass('d-none')
	.addClass('d-flex')
	.find('.js-update-edit-sales-order').click(function () {
		$('#ReturnRefundForm').submit();
	});
	$('#ReturnRefundForm').submit(function () {
		$(this).ajaxSubmit();
		return false;
	});
}

$.fn.extend({
	spinning: function(options) {
		if (typeof options === 'undefined' || options === null || options === true) {
			this.addClass('spinning disabled');
		} else {
			this.removeClass('spinning disabled');
		}
		return this;
	}
});

var handlePoints = function() {		
	var discount = parseInt( $('#rpDiscount').val() );
	if ( Number.isNaN(discount) || discount < 0 ) return;
	
	pointsManager.usePoints(discount);
	
	return false;
}

var pointsManager = (function() {
	var showPointTranscation = function(result) {
		let crp = result.data.crp;
		let pts = result.data.salesOrder.pointTransactions;
		let pt = pts.find(element => element.reason === 'USE_POINT');
		
		if (!pt) return;
		
		let usePoints = (pt.points < 0) ? Math.abs(pt.points) : pt.points;
		let amount = pt.amount;
		let pointName = crp.pointsName;
		let discountMessage = '折扣 $' + pt.amount;
		let usePointsMessage = '，使用 ' + usePoints + ' ' + crp.pointsName;
		let message = discountMessage + usePointsMessage;
		$('#points-result-error').parent().addClass('d-none');
		$('#points-result').parent().removeClass('d-none');
		$('#points-result').text(message);	
		$('input[name=points]').val(usePoints);
	},
	updatePointsInfo = function(result) {
		let crp = result.data.crp;
		let currentPoints = crp.pointsName + crp.points;
		let salesOrderPoints = crp.pointsName + crp.possibleRewards;
		let possibleDiscount = crp.possibleDiscount;
		
		let list = $('#checkout-stepper').find('.points-list');
		list.find('.points-current').text(currentPoints);
		list.find('.possible-rewards-points').text(salesOrderPoints);
		list.find('.possible-discount').text(possibleDiscount);	
	},
	fails = function(result) {
		$('#points-result').parent().addClass('d-none');
		$('#points-result-error').parent().removeClass('d-none');
		$('#points-result-error').text(result);
	},
	reset = function() {
		$('#points-result-error').parent().addClass('d-none');
		$('#points-result').parent().addClass('d-none');
		$('#points-result-error').text('');
		$('#points-result').text('');
		$('#checkout-stepper').find('input[name=points]').val('');
		$('#rpDiscount').val('');
		$('#checkout-stepper-hide-block').addClass('d-none');
		$('#checkout-stepper-hide-message').text('');
	},
	updateCheckoutResult = function(data) {
		let so = data.data.salesOrder;
		
		/* Reset some info in #checkoutV2Modal. */
		let modal = $('#checkoutV2Modal');
		// Reset display price text.
		modal.find('.grand-total-text').text('$' + so.grandTotal);
		modal.find('.total-paid-text').text('$0');
		
		// Reset checkout inputs.
		modal.find('input[name=grand-total]').val(so.grandTotal);
		modal.find('input[name=total-paid]').val('0');
		
		// Reset payment of checkout if the grand total changes.
		$('#paid-payment-type-list').empty();
		checkoutPayment.reset();
	};
	
	return {
		usePoints: function(discount) {
			reset();
			
			orderService.usePoints(discount)
			.then(function(result) {
				updatePointsInfo(result);
				showPointTranscation(result);
				updateCheckoutResult(result);
			}, function(error) {
				let message = error.responseJSON.error;
				fails(message);
			});
		},
		getPoints: function() {
			// Reset step 1.
			checkoutStepper.hideStepProgress();
			checkoutStepper.reset();
			reset();
			
			// Get customer points.
			orderService.getPoints()
			.then(function(result) {
				updatePointsInfo(result);
				showPointTranscation(result);				
				checkoutStepper.showStepProgress();
			}, function(error) {
				if (error.responseJSON.code === 303) {
					let message = error.responseJSON.error;
					$('#checkout-stepper-hide-block').removeClass('d-none');
					$('#checkout-stepper-hide-message').text(message);
				}
				// Directly show step 2.
				checkoutStepper.activeStep(2);
				// Hide the navigation of step 1 and progress bar.
				checkoutStepper.hideStepProgress();
				
			});
		}
	};
})();

$('#checkoutV2Modal').ready(function() {
	var modal = $('#checkoutV2Modal');
	modal.on('show.bs.modal', checkoutV2Modal.show);
	modal.on('hidden.bs.modal', checkoutV2Modal.hidden);
	
	$('input[type=radio][name=shippingStateRadio]')
		.change(checkoutV2Modal.stateRadioChanged);
	
	loadAllSupportPaymentType();
	
	$('#rewardPoints').change(function(event) {
		event.preventDefault();
		let val = $(this).prop('checked');
		$('.possible-rewards-points').toggleClass('d-none', !val);
		$('#no-rewards-points').toggleClass('d-none', val);
	});
	
	$('#paidCheckbox').prop('checked', true);
	checkoutV2Modal.isPaid = true;
	$('#paidCheckbox').click(function(event) {
		let val = $(this).prop('checked');
		checkoutV2Modal.isPaid = val;
	})
	
	$('#receiptCarrierNum').normalizeReceiptCarrierNum();
});

var EPStepper = function(selector) {
	const stepper = $(selector);
	const stepperSlides = stepper.find('[data-step]');
	const stepperSlideIndices = stepperSlides.toArray()
	.map(function(slide) {
		return parseInt(slide.dataset.step);
	})
	.sort(function(a, b) {
		return a - b; // a != b, but I don't avoid it.
	});
	
	const lastIndex = stepperSlideIndices.length - 1;
	const firstStepIndex = stepperSlideIndices[0];
	
	var activeStepIndex = firstStepIndex;
			
	var hideInactiveSteps = function() {
		stepperSlides.each(function(i, elem) {
			let stepIndex = parseInt(elem.dataset.step);
			let isActive = stepIndex === activeStepIndex;
			$(elem).toggleClass('active', isActive);	
		});
	};
		
	var getStep = function(stepIndex) {
		return stepper.find('[data-step=' + stepIndex + ']');
	};
	
	const progressSel = '.stepper-progress[data-target=\'' + selector + '\']'; 
	const progress = $(progressSel);
	var activeStepTitle = function() {
		if (!progress || !progress.length) return;
		
		const progressStep = progress.find('.stepper-step');
		if (!progressStep || !progressStep.length) return;
		progressStep.each(function(i, elem) {
			const stepIndex = i + 1;
			if ( stepIndex < activeStepIndex ) {
				$(elem).removeClass('active').addClass('done');
			} else if ( stepIndex === activeStepIndex ) {
				$(elem).removeClass('done').addClass('active');
			} else {
				$(elem).removeClass('active');
			}
		});
	}
	
	var onChange;
	var activeStep = function(stepIndex) {
		activeStepIndex = stepIndex; // record the index of active step.
		hideInactiveSteps();
		activeStepTitle();
		
		if (onChange) onChange(activeStepIndex); 
	};
	
	activeStep();
	
	return {
		nextStep: function() {
			activeStep(activeStepIndex + 1);
		},
		backStep: function() {
			activeStep(activeStepIndex - 1);
		},
		reset: function() {
			activeStep(firstStepIndex);
		},
		activeStep: function(index) {
			activeStep(index);
		},
		onStepChange: function(callback) {
			onChange = callback;
		},
		showStepProgress: function(hide) {
			progress.show();
		},
		hideStepProgress: function(hide) {
			progress.hide();
		}
	};
}

var checkoutStepper;

var activeCheckoutStep1 = function() {
	checkoutStepper.activeStep(1);
}

var activeCheckoutStep2 = function() {
	checkoutStepper.activeStep(2);
}

var checkoutStep1Next = function() {
	checkoutStepper.nextStep();
}

function loadAllSupportPaymentType() {
	checkoutPayment.fetchSupportPayment(function (array) {
		var colors = ['primary', 'secondary', 'success', 'danger', 'warning', 'info'];
		var buttons = '';
		for (var i = 0, j = 0; i < array.length; i++, j++) {
			(j >= colors.length) ? j = 0 : void(0);
			var pay = array[i];
			var payTitle = pay.tag;
			var payId = pay.id;
			buttons += '<button type="button" class="btn btn-' + colors[j] + ' btn-rounded" onclick="showPaymentEditorModal(this, ' + payId + ')">' + payTitle + '</button>'
		}
		if (buttons.length) {
			$('.payment-tag-list').html(buttons);	
		}
	});
}

var adminUserSignout = function() {
	var ajaxurl = GBF.ctxPosAjax + '/AdminUser/logout.do';
	$.get(ajaxurl).promise()
	.then(function(data) {
		if (data.code === 200) {
			location.reload();	
		}
	});
}

$('#loginMember').ready(function() {
	let modal = $(this);

	// login modal: enter phone number
	modal.find('.btn-phone-num').click(loginModal.phoneNumberButtonClick);

	modal.on('shown.bs.modal', loginModal.shown);
	modal.on('hidden.bs.modal', loginModal.hidden);
});

var filterManager = {
	reload : function(groupBuyId) {
		filterService.fetchGroupBuyItemSet(groupBuyId)
		.then(filterManager.addGroupBuyItemSetSelect, filterManager.handleError);
	},
	addGroupBuyItemSetSelect : function(data) {
		const dataArray = data.data;
		// Update select container.
		var html = '<select name="groupBuyItemSetId" class="form-control d-flex" id="groupBuyItemSetId">'
					;
		dataArray.forEach(function(c, i) {
			html += '<option value="'+c.groupBuyItemSetId+'">' + c.itemSet.title + '</option>';
		});
		html += '</select>';
		$('#buttons_gbis_container').html(html);
		
		$('#groupBuyItemSetId').change(function(event) {
			var selectvalue = $('#groupBuyItemSetId').val();
			if (Number.parseInt(selectvalue) <= -10000) { //allItems
				$('#buttons_tag_container').empty();
				$('#buttons_item_container').empty();
				filterManager.queryItems(true);
				return;
			}
			// Select other gbisId.
			$('#tag').html('<option value="">載入中...</option>');
			filterService.fetchFirstTag(selectvalue)
			.then(filterManager.addTagSelect, filterManager.handleError);
		}).trigger('change');
		
		// Bind change event of select.
		$('#groupBuyItemSetId').mousedown(function(event) {
			event.preventDefault();
			event.stopPropagation();
			
			const modal = $('#gbisSelectPanelModal');
			const modalBody = modal.find('.modal-body');
			if (modalBody.html().trim().length === 0) {
				modalBody.html(makeListGroupFromSelect('groupBuyItemSetId'));
				modalBody.find('.list-group-item').click(onClickGbisItem);
			} else {
				var selectedValue = $('#groupBuyItemSetId').val();
				modalBody.find('a.list-group-item[data-value=' + selectedValue + ']')
				.addClass('active').siblings().removeClass('active');
			}
			
			modal.modal('show');
		});
		
	},
	addTagSelect : function(dataArray) {
		// Update second tag container.
		var html = '<select name="itemSelectionTag" class="form-control d-flex" id="itemSelectionTag">';
		dataArray.forEach(function(c, i) {
			if (c.descr) {
				const tagInfo = JSON.parse(c.descr);
				const isOutOfStock = tagInfo.out_of_stock;
				const isOffline = tagInfo.offline;
				let attributes = 'value="' + c.value + '" ';
				if (isOutOfStock) {
					attributes += 'data-out-of-stock="' + isOutOfStock + '" ';
				}
				if (isOffline) {
					attributes += 'data-offline="' + isOffline + '" ';
				}
				html += '<option ' + attributes + '>' + c.label + '</option>';
			} else {
			html += '<option value="'+c.value+'">' + c.label + '</option>';
			}
		});
		html += '</select>'
		$('#buttons_tag_container').html(html);

		filterManager.addChangeEventToTagSelect();
	},
	addChangeEventToTagSelect : function() {
		$('#itemSelectionTag').off('change');
		$('#itemSelectionTag').change(function(e) {
			$('#buttons_item_container').empty();
			filterManager.queryItems(true);
		}).trigger('change');
		
		$('#itemSelectionTag').mousedown(function(event) {
			event.preventDefault();
			event.stopPropagation();
			
			const modal = $('#tagSelectPanelModal');
			const modalBody = modal.find('.modal-body'); 
			modalBody.html(makeListGroupFromSelect('itemSelectionTag'));
			modalBody.find('a.list-group-item').click(onClickTagItem);
			modal.modal('show');
		});
	},
	sysTagSelectChange : function() {
		filterManager.queryItems(true);
	},
	addItems : function(dataArray) {
		let result = '<div class="row mb-1">';
		for (let i = 0; i < dataArray.length; i++) {
			let item = dataArray[i];
			let imgSrc = item.imageUrl;
			/*
			if (imgSrc != null && imgSrc.length > 0) {
				if (imgSrc.startsWith('http')) {
					
				} else if (imgSrc.indexOf('/') > 0) {
					imgSrc = 'https://cdn.groupbuyforms.com/upload/images/' + imgSrc;
				} else {
					imgSrc = 'https://cdn.groupbuyforms.com/upload/images/unsort' + imgSrc;
				}
			} else {
				imgSrc = 'https://cdn.groupbuyforms.com/upload/images/unsort/logo512.png';
			}
			*/
			var priceCss = 'text-price';
			var stock = ' ';
			var onclickHandler = '';
			var quickAddBtn = '';
			var quickAddLoading = '';
			var border = '';
			var clazz = '';
			if (item.stockAndBackOrderTotalAvailable == 0) {
				stock += '<span class="badge badge-tag badge-oos">已售完</span>';
				onclickHandler += 'onclick="showItem(' + item.itemId + ')"';
				border += ' border-danger';
				priceCss = 'text-price-oos';
			} else {
				if (item.stockAndBackOrderTotalAvailable < 50) {
					let badgeClass = item.stockAndBackOrderTotalAvailable < 10 ? 'badge-stock-low' : 'badge-stock';
					stock += '<span class="badge badge-tag '+ badgeClass +'">' + item.stockAndBackOrderTotalAvailable + '</span>';
				}
				onclickHandler += 'onclick="showItem(' + item.itemId + ')"';
			}
			// Setup quick add button
			if ( item.itemType !== 'SPEC_MAIN' && 
				(item.stockAndBackOrderTotalAvailable > 0 && item.calculatedMaxOrderQuota > 0)) {
				const itemId = item.itemId;
				const price = item.price;
				onclickHandler += 'onclick="addQuicklyToShoppingCart(' + itemId + ', ' + price + ', 1, this)"';
				quickAddBtn += '<button class="btn-floating btn-quick-add-cart" type="button" arial="' + GBFi18n.pos_arial_quickAddShoppingCartBtn + '" onclick="addQuicklyToShoppingCart(' + itemId + ', ' + price + ', 1, this)"><i class="fa-light fa-cart-plus"></i></button>';
				quickAddLoading += '<div class="add-cart-processor" style="display: none;"><div class="spinner-border text-light add-cart-processor__spinner-border" role="status"><span class="sr-only">Loading...</span></div></div>';
			}

			result += '<div class="card-deck item-col-5 px-1 mx-0">'
					+ '<div class="card mx-0 card-item" id="item-' + item.itemId + '" data-item-id="' + item.itemId + '">'
					+ quickAddBtn
					+ '<div class="card-body p-0">'
					+ '<a ' + onclickHandler + '>'
					+ '<div class="img-container rounded-corner overflow-hidden h-100' + border + '">'
					+ quickAddLoading
					+ '<img src="' + imgSrc + '" class="img-fluid img-1by1">'
					+ '<div class="overlay item-title">' + item.shortNameDisplay + '</div>'
					+ '</div><!-- /.Img Container -->' + '</a>'
					+ '</div><!-- /.Card Body -->'
					+ '<div class="card-footer item-footer p-0 text-nowrap">'
					+ '<p class="mb-0 text-center ' + priceCss + '">' + item.formattedPrice + stock + '</p>'
					+ '</div><!-- /.Card Footer -->'
					+ '</div><!-- /.Card -->'
					+ '</div><!-- /.Card Deck -->';				
		}
		result += '</div>';
		$('.product-display-scrollable-content').html(result);
	},
	queryItems: function(isReload) {
		if (itemPage.isPageLoading()) return;
		
		itemPage.startPageLoading();
		itemPage.reloadPage(isReload);
		
		const pageSize = parseInt($('#pageSizeSelect').val());
		const pageNumber = itemPage.pageNumber();
		var data = {
			groupBuyId : groupBuyId,
			allItems : false,
			pageSize : pageSize,
			pageNumber : pageNumber
		};
		
		// Use class in function-bar-wrapper to determine the mode.
		const searchT = $('#search-item-title').val();
		const searchUid = $('#search-item-uid').val();
		const isSearchMode = $('.function-bar-wrapper').hasClass('search-mode') && 
							(!!searchT.trim().length || !!searchUid.trim().length);
		var seachingTitle = false, searchingUid = false;
		if (isSearchMode) {
			if (searchT.trim().length) {
				data.t = searchT;
				seachingTitle = true;
			} else {
				data.uid = searchUid;
				searchingUid = true;
			}
		} else { // filter mode
			const tag = $('#tag').val(); // TODO
			const selectTag = $('#itemSelectionTag').val();
			data.tag = selectTag;
			// Handle select#groupBuyItemSetId value.
			const gbisId = $('#groupBuyItemSetId').val();
			if (gbisId === '-10000') { // allItems
				data.allItems = true;
				data.groupBuyItemSetId = gbisId;
			} else {
				data.groupBuyItemSetId = gbisId;
			}
			// Handle filter rules value.
			const sysTag = $('#filter-rules').val();
			data.sysTagHot = (sysTag === 'sysTagHot');
			data.sysTagNew = (sysTag === 'sysTagNew');
			data.sysTagRec = (sysTag === 'sysTagRec');
			data.sysTagSale = (sysTag === 'sysTagSale');
		}
		
		filterService.fetchItemsList(data)
		.then(function(data) {
			itemPage.stopPageLoading();
			
			if (data.recordsTotal !== null && !isNaN(data.recordsTotal)) {
				// Update total result text.
				const total = data.recordsTotal;
				
				// Update pagination pane when reload page.
				$('#item-pagination-container').remove();
				$('.product-display-body').parent().append(pagination(pageSize, total, pageNumber));
				$('.product-display-scrollable-content').addClass('mb-5');
				
				if (isReload) {
					const resultMessage = 
						'<p class="search-result">' +
						'共 <span class="search-result-total">' + total + '</span> 筆 ' +
						'<i class="fa-light fa-angle-double-right"></i>' +
						'</p>';
					$('.item-search-text').html(resultMessage);
				}
			} else {
				$('.item-search-text').empty(); // Not show wrong total result.
				$('.product-display-scrollable-content').removeClass('mb-5');
				$('#item-pagination-container').remove();
			}
			
			// Show items.
			var dataResult = !data.data ? data : data.data;
			filterManager.addItems(dataResult);
			
			// Store and update search history. 
			if (isSearchMode && dataResult.length) {
				var key, val;
				if (seachingTitle) {
					key = 'searchTitleHistory';
					val = searchT;
				} else {
					key = 'searchUidHistory';
					val = searchUid;
				}
				updateCookies(key, val);
				updateDatalist(key);
			}
			if (searchingUid) {
				const event = new CustomEvent('ep.queryItemsByUid', { detail: data });
				document.dispatchEvent(event);
			}
		},
		function(data) {
			itemPage.stopPageLoading();
			filterManager.handleError(data);
		});
	},
	handleError: function(data) {
		const json = data.responseJSON;
		modalShowDanger($('#myModal'), json.error);
	}
}

var pagination = function(pageSize, totalCount, pageNumber) {
	if (totalCount === 0) return;
	const totalPage = Math.ceil(totalCount/pageSize);
	const visiblePageCount = 9;
	
	var pageItem = function(index, activePage) {
		if (index === activePage) {
			return '<li class="page-item active" data-page-index="' + index + '"><a class="page-link" onclick="turnPage(' + index + ')">' + index + '</a></li>';
		} else {
			return '<li class="page-item" data-page-index="' + index + '"><a class="page-link" onclick="turnPage(' + index + ')">' + index + '</a></li>';
		}
	};
	
	var startIndex, endIndex;
	if (totalPage <= visiblePageCount) {
		startIndex = 1;
		endIndex = totalPage;
	} else {
		if (pageNumber < 6) {
			startIndex = 1;
			endIndex = startIndex + visiblePageCount;
		} else if (pageNumber + 5 > totalPage) {
			startIndex = totalPage - visiblePageCount;
			endIndex = totalPage;
		} else {
			startIndex = Math.max(1, pageNumber - 4);
			endIndex = startIndex + visiblePageCount - 1;	
		}
	}
	
	var items = '';
	if (startIndex === 2) {
		items += pageItem(1, pageNumber);
	} else if (startIndex > 2) {
		items += pageItem(1, pageNumber);
		items += '<span class="pagination-dot">...</span>';
	}
	for (var i = startIndex; i < endIndex + 1; i++) {
		items += pageItem(i, pageNumber);
	}
	if (totalPage === endIndex + 1) {
		items += pageItem(totalPage, pageNumber);
	} else if (totalPage > endIndex + 1) {
		items += '<span class="pagination-dot">...</span>';
		items += pageItem(totalPage, pageNumber);
	}
	
	var html = 
		'<div class="product-pagination-container" id="item-pagination-container">' +
		'<div id="item-pagination" aria-label="Page navigation" data-current-page="' + pageNumber + '" data-total-page="' + totalPage + '">' +
		'<ul class="pagination pg-blue justify-content-center my-2">' +
		'<li class="page-item"><a class="page-link" data-page-index="prev" onclick="turnPage(\'prev\')"><i class="fa-light fa-angle-double-left"></i></a></li>' +
		items +
		'<li class="page-item"><a class="page-link" data-page-index="next" onclick="turnPage(\'next\')"><i class="fa-light fa-angle-double-right"></i></a></li>' +
		'</ul>' +
		'</div>' +
		'</div>';
	return html;
}

var turnPage = function(value) {
	const pagination =  document.getElementById('item-pagination');
	const currentPage = parseInt(pagination.dataset.currentPage);
	const totalPage = parseInt(pagination.dataset.totalPage);
	
	// update page
	if (value === 'prev') {
		if (currentPage === 1) return;
		itemPage.prevPage();
	} else if (value === 'next') {
		if (currentPage === totalPage) return;
		itemPage.nextPage();
	} else {
		itemPage.setPageNumber(parseInt(value));
	}
	
	// Update active page-item
	$(this).addClass('active').siblings().removeClass('active');
	
	// update #item-pagination data
	pagination.dataset.currentPage = itemPage.pageNumber();
	
	// call queryItem() as scroll event
	filterManager.queryItems(false); // false means load more.
}

var addQuicklyToShoppingCart = function(ii, p, t, triggerElem) {
	const cardElem = $(triggerElem).closest('.card');
	if (orderManager.currentSalesOrder && 
		orderManager.currentSalesOrder.sortedOrderItems && 
		orderManager.currentSalesOrder.sortedOrderItems.length > 0) {
		// Check whether to update order items or not
		const oiList = orderManager.currentSalesOrder.sortedOrderItems;
		const elem = oiList.find(function(oi) {
			return (oi.itemId == ii);
		});
		if (!!elem) {
			cardElem.addClass('disabled').find('.add-cart-processor').show();
			// Update order items
			const rrform = $('#ReturnRefundForm');
			const targetOI = rrform.find('[data-order-item-id="' + elem.orderItemId + '"]');
			const oiIndex = targetOI.data('index');
			const totalInput = targetOI.find('input[name="orderItems[' + oiIndex + '].total"]');
			const num = parseInt(totalInput.val(), 10) + t;
			totalInput.val(num).trigger('change', [triggerElem]);
			
			return;
		}
	}
	
	cardElem.addClass('disabled').find('.add-cart-processor').show();
	// Add to shopping cart
	var ajaxData = {
		uuid: uuid,
		itemId: ii,
		total: t,
		price: p,
		shouldApplySalesRules: orderManager.autoApplySalesRules
	};
	
	orderManager.addOrderItem(ajaxData)
	.then(function(response) {
		toastr.success(GBFi18n.add_shopping_cart_success);
		reloadItems(response);	
		cardElem.removeClass('disabled').find('.add-cart-processor').hide();
	},
	function(data) {
		const json = data.responseJSON;
		toastr.error(json.error);
		cardElem.removeClass('disabled').find('.add-cart-processor').hide();;
	});
}

var itemPage = new makePage();

var filterService = {
	fetchGroupBuyItemSet : function(groupBuyId) {
		const ajaxUrl = baseUrl + '/ajax/GroupBuyItemSet/list.do';
		const ajaxData = {
			'groupBuyId' : groupBuyId,
			'iDisplayLength' : 500,
			'iSortCol_0' : '0',
			'mDataProp_0' : 't.seqString',
			'sSortDir_0' : 'asc',
			'pos' : true
		};
		return $.get(ajaxUrl, ajaxData).promise();
	},
	fetchFirstTag : function(groupBuyItemSetId) {
		const ajaxUrl = baseUrl + '/ajax/Item/getFirstTags.do';
		const ajaxData = { 'groupBuyItemSetId' : groupBuyItemSetId, allItems:true };
		return $.get(ajaxUrl, ajaxData).promise();
	},
	fetchItemsList : function(data) {
		const ajaxUrl = GBF.ctxPosAjax + '/Item/itemList.do';
		return $.post(ajaxUrl, data).promise();
	}
}

// used in main, dont declare it in show_ajax.jsp
function removeOrderItem(index) {
	const namePrefix = 'orderItems\\[' + index + '\\]\\.';
	$('input[name=' + namePrefix + 'total]').val(0);	
	orderManager.updateOrderItem(namePrefix)
	.then(function(result) {
		toastr.success(GBFi18n.pos_shoppingCart_remove_success);
	}, function(error) {
		toastr.warning(error.responseJSON.error, GBFi18n.error_update);
	});	
}

var makeListGroupFromSelect = function(selectId) {
	var select = document.getElementById(selectId);
	var optionNodes = select.querySelectorAll('option');
	var selectedValue = select.value;
	var makeListGroupItem = function(option) {
		const value = option.value;
		const text = option.text;
		const dataset = option.dataset;
		const isOutOfStock = dataset.outOfStock === 'true';
		const isOffline = dataset.offline === 'true';
		const isWarning = Number.parseInt(value) <= -10000;
		const isActive = value === selectedValue;
		const classes = [
			'list-group-item',
			'list-group-item-action',
			'list-group-grid__item',
			'col-12', 'col-sm-6', 'col-md-4', 'col-lg-3',
			isWarning ? 'list-group-item-warning' : '',
			isActive ? 'active' : ''
		].filter(Boolean).join(' ');

		const badges = [
			isOutOfStock ? '<span class="badge badge-danger">缺貨</span>' : '',
			isOffline ? '<span class="badge badge-warning">下架</span>' : ''
		].filter(Boolean).join(' ');
		
		const attr = [
			'data-value="' + value + '"',
			isOffline ? 'data-offline="true"' : '',
			isOutOfStock ? 'data-out-of-stock="true"' : ''
		].filter(Boolean).join(' ');
		
		return '<a href="#" class="' + classes + '" ' + attr + '">' + text + badges + '</a>';
	};
	const optionNodesArray = Array.apply(null, optionNodes);
	var items = '<div class="list-group list-group-horizontal flex-wrap list-group-grid">';
	for (var i = 0; i < optionNodesArray.length; i++) {
		items += makeListGroupItem(optionNodesArray[i]); 
	}
	items += '</div>';
	return items;
}

var onClickGbisItem = function(event) {
	const value = event.currentTarget.dataset.value;
	$('#groupBuyItemSetId').val(value).trigger('change');
	
	$('#gbisSelectPanelModal').modal('hide');
	
	event.preventDefault();
	event.stopPropagation();
}

var onClickTagItem = function(event) {
	const value = event.currentTarget.dataset.value;
	$('#itemSelectionTag').val(value).trigger('change');
	
	$('#tagSelectPanelModal').modal('hide');
	
	event.preventDefault();
	event.stopPropagation();
}
var keepalive = function() {
	var ajaxurl = baseUrl + '/ajax/AdminUser/keepalive';
	jQuery.post( ajaxurl,
		function( data ) {

		}
	).fail(function(data) {
		if (data.responseJSON == null || data.responseJSON.code != 401) return;
		location.reload();
	});
}
setInterval(keepalive,120000);

var fetchPosList = function() {
	$.ajax({
		type: 'GET',
		url: GBF.ctxPosAjax + '/Pos/getPosList',
		data: '',
		async: true,
		success: function (json){
			var html = '';
			for (var i in json) {
					var pos = json[i];
					html += `<a class="dropdown-item" href="${GBF.ctx}/${pos.value}/pos">
					<i class="fa fa-home"></i> ${pos.label}</a>`;
			}
			$('.nav-item-pos .dropdown-menu').html(html);
		},
		error: function (response) {
			er = response.responseJSON.error;
			console.log(er);
		}
	});
}

fetchPosList();

$('body').on('change', 'input[name=receiptType]', function() {
	var rt = $(this).val();

	$('#receipeType-barcode-section').hide();
	$('#receipeType-channel-section').hide();
	$('#receipeType-b2b-section').hide();
	$('#receiptTitle').val('');
	$('#receiptVatId').val('');
	$('#receiptCarrierNum').val('');
	$('#invoiceNumber').val('');
	if (rt == -1) {
		$('#receipeType-channel-section').show();
	} else if (rt == 2) {
		$('#receipeType-b2b-section').show();
	} else if (rt == 3) {
		$('#receipeType-barcode-section').show();
	}
});