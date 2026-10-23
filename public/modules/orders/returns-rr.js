var returnManager = {
	init : function(formId, salesOrderId) {
		console.log('init2')
		this.formId = formId;
		this.salesOrderId = salesOrderId || '';
		return this;
	},
	setSalesOrder: function(salesOrder) {
		this.salesOrder = salesOrder;
		salesOrder.getItem = function(orderItemId) {
			var filter = salesOrder.sortedOrderItems.filter(o=>o.orderItemId==orderItemId);
			if (filter.length) return filter[0];
			return null;
		};
		salesOrder.getTotalPrice = function() {
			var t = salesOrder.sortedOrderItems.filter(o=>o.newTotal > 0)
			.reduce((acc, cur)=> {
				return acc + cur.newTotalPrice;
			}, 0);
			return t;
		}
	},
	updateInput : function($row, total, discount, totalPrice) {
			var id = $row.data('id');
			var item = this.salesOrder.getItem(id);
			
			var $total = $row.find('select[name*=total]');
			var $discount = $row.find('input[name*=discount]')
			var $totalPrice = $row.find('input[name*=totalPrice]');
			
			if (total == null) {
				total = $total.val();
			}
			if (discount == null && totalPrice == null) {
				if ($discount.val() != '0') {
					discount = $discount.val();
				}
				
				if ($totalPrice.val() != '0') {
					totalPrice = $totalPrice.val();
				}
			}
			var nTotal = parseInt(total);
			var nDiscount = parseFloat(discount);
			var nUnitPrice = item.price;
			var nTotalPrice = parseFloat(totalPrice);
			
			if (nTotal == 0) {
				nDiscount = '0';
				nTotalPrice = '0';
			} else if (discount != null) {
				nTotalPrice = nTotal * nUnitPrice - nDiscount;
			} else if (totalPrice != null) {
				//nUnitPrice = (nTotalPrice / nTotal).toFixed(2);
			} else {
				nDiscount = 0;
				nTotalPrice = nTotal * nUnitPrice;
			}
			$discount.val(nDiscount);
			$totalPrice.val(nTotalPrice);
			
			item.newTotal = nTotal;
			item.newDiscount = nDiscount;
			item.newTotalPrice = nTotalPrice;
			
			$('#allowance-totl-price').text(this.salesOrder.getTotalPrice());
	},
	prepareReturn: function() {
		var _this = this;
		
		_this.cardItem = $('#card-salesOrder-item');
		_this.cardItemSelect = $('#card-salesOrder-item-select');
		$(this.formId).on('click', '.btn[data-action]', function() {
			var action = $(this).data('action');
			switch (action) {
			case 'select-item':
				if ($('input[name=itemSelId]:checked').length) {
					$('#allowance-step-1').addClass('d-none');
					$('#allowance-step-2').removeClass('d-none');
					$('input[name=itemSelId]:checked').each(function(i,o) {
						var v = $(this).val();
						_this.cardItem.find('.row[data-id='+v+']').removeClass('d-none');
					});
				}
				break;
			}
		});
		
		$(this.formId).on('click', '.btn.arrow-right', function() {
			var $btn = $(this);
			var $row = $btn.closest('.row');
			var $discount = $row.find('input[name=discount]');
			_this.updateInput($row, null, $discount.val(), null);
		});
		
		$(this.formId).on('change', 'select[name*=total]', function() {
			var $row = $(this).closest('.row');
			_this.updateInput($row, $(this).val(), null, null);
		});
		
		$(this.formId).on('keyup', 'input[name*=discount]', function() {
			var $btn = $(this);
			var $row = $btn.closest('.row');
			var $totalPrice = $row.find('input[name*=totalPrice]');
			$totalPrice.val('');
		});
		
		/*
		$(this.formId).on('keyup', 'input[name*=totalPrice]', function() {
			var $btn = $(this);
			var $row = $btn.closest('.row');
			var $discount = $row.find('input[name*=discount]');
			$discount.val('');
		});
		*/
		
		jQuery.get(
			GBF.baseUrl+'/ajax/ReturnRefund/get',
			{
				'salesOrderId':_this.salesOrderId
			},
			function(data) {
				var json = data.data;
				if (json.sortedOrderItems && json.sortedOrderItems.length) {
					_this.buildReturnForm(json);
					_this.setSalesOrder(json);
				}
			}
		).fail(function(data) {
			json = data.responseJSON;
			modalShowDanger($(_this.formId), json.error);
		});
	},
	buildReturnForm : function(salesOrder) {
		var _this = this;
		console.log('j:%o', salesOrder);
		var html = '';
		var htmlSelect = '';
		salesOrder.sortedOrderItems.forEach(function(o,i){
			html += _this.buildOrderItemV2(o);
			htmlSelect += _this.buildOrderItemSelect(o);
		});
		_this.cardItem.find('.card-body').html(html);
		_this.cardItemSelect.find('.card-body').html(htmlSelect);
		
		$('#allowance-step-1').addClass('d-none');
		$('#allowance-step-2').removeClass('d-none');
	},
	buildOrderItem : function(item) {
		var totalSelect = `
			<select name="data[${item.orderItemId}][total]" class="form-control form-control-sm orderItem-total" required>
			<option value="0">數量</option>
		`
		for (var i = 1 ; i < item.total+1; i++ ){
			totalSelect += `<option value="${i}">${i}</option>`
		}
		totalSelect += '</select>';
		var html = `
			<div class="row py-3 d-none" data-id="${item.orderItemId}">
				<input type="hidden" name="data[${item.orderItemId}][orderItemId]" value="${item.orderItemId}">
				<div class="col-12 small">${item.title}</div>
				<div class="col-2 small" style="">原始單價</div>
				<div class="col-2 small" style="">原始數量</div>
				<div class="col-2 small" style="">原始折扣</div>
				<div class="col-2 small" style="">退貨數量</div>
				<div class="col-2 small" style="">退貨折扣</div>
				<div class="col-2 small" style="">退貨總價</div>
				<div class="col-2 small" style="">
					<input type="text" size="5" value="${item.price}" class="form-control form-control-sm" disabled>
				</div>
				<div class="col-2 small" style="">
					<input type="text" size="3"  value="${item.total}" class="form-control form-control-sm" disabled>
				</div>
				<div class="col-2 small" style="">
					<input type="text" size="5" value="${item.discount}" class="form-control form-control-sm" disabled>
				</div>
				<div class="col-2 small" style="">
					${totalSelect}
				</div>
				<div class="col-2 small" style="">
					<div class="input-group">
						<input type="text" size="5" name="data[${item.orderItemId}][discount]" class="input-group-prepend form-control form-control-sm orderItem-discount" value="0" required>
						<div class="input-group-append"><button type="button" class="btn btn-sm m-0 p-1 arrow-right"><i class="fa-solid fa-arrow-right"></i></button></div>
					</div>
				</div>
				<div class="col-2 small" style="">
					<div class="input-group">
						<input type="text" size="5" name="data[${item.orderItemId}][totalPrice]" class="input-group-append form-control form-control-sm orderItem-totalPrice" value="0" disabled>
					</div>
				</div>
				<div class="col-12 small help text-danger"></div>
			</div>
			<hr class="w-100 my-2">
		`
		return html;
	},
	buildOrderItemSelect : function(item) {
		var html = `
			<div class="form-group">
				<input type="checkbox" name="itemSelId" value="${item.orderItemId}" id="itemSelId${item.orderItemId}" class=" form-check-input">
				<label class="control-label" for="itemSelId${item.orderItemId}">${item.title}</label>
			</div>
		`
		return html;
	},
	buildOrderItemV2 : function(item) {
		var totalSelect = `
			<select name="data[${item.orderItemId}][total]" class="form-control form-control-sm orderItem-total" required>
			<option value="0">退貨數量</option>
		`
		for (var i = 1 ; i < item.total+1; i++ ){
			totalSelect += `<option value="${i}">${i}</option>`
		}
		totalSelect += '</select>';
		var html = `
			<div class="row py-3" data-id="${item.orderItemId}">
				<input type="hidden" name="data[${item.orderItemId}][orderItemId]" value="${item.orderItemId}">
				<div class="col-10 small">${item.title}</div>
				<div class="col-2 small" style="">
					${totalSelect}
				</div>
				<div class="col-12 small help text-danger"></div>
			</div>
			<hr class="w-100 my-2">
		`
		return html;
	}
}