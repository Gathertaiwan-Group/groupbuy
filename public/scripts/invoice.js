var invoiceManager = {
	init : function(formId, invoiceId) {
		console.log('init2')
		this.formId = formId;
		this.invoiceId = invoiceId || '';
		return this;
	},
	setInvoice: function(invoice) {
		this.invoice = invoice;
		invoice.getItem = function(itemId) {
			var filter = invoice.preparedInvoiceItems.filter(o=>o.invoiceItemId==itemId);
			if (filter.length) return filter[0];
			return null;
		};
		invoice.getTotalPrice = function() {
			var t = invoice.preparedInvoiceItems.filter(o=>o.newTotal > 0)
			.reduce((acc, cur)=> {
				return acc + cur.newTotalPrice;
			}, 0);
			return t;
		}
	},
	updateInput : function($row, total, unitPrice, totalPrice) {
			var id = $row.data('id');
			var item = this.invoice.getItem(id);
			
			var $total = $row.find('select[name*=total]');
			var $unitPrice = $row.find('input[name*=unitPrice]')
			var $totalPrice = $row.find('input[name*=totalPrice]');
			
			if (total == null) {
				total = $total.val();
			}
			if (unitPrice == null && totalPrice == null) {
				if ($unitPrice.val() != '0') {
					unitPrice = $unitPrice.val();
				}
				
				if ($totalPrice.val() != '0') {
					totalPrice = $totalPrice.val();
				}
			}
			var nTotal = parseInt(total);
			var nUnitPrice = parseFloat(unitPrice);
			var nTotalPrice = parseFloat(totalPrice);
			
			if (nTotal == 0) {
				nUnitPrice = '0';
				nTotalPrice = '0';
			} else if (unitPrice != null) {
				nTotalPrice = nTotal * nUnitPrice;
			} else if (totalPrice != null) {
				nUnitPrice = (nTotalPrice / nTotal).toFixed(2);
			} else {
				nUnitPrice = item.unitPrice;
				nTotalPrice = item.unitPrice * nTotal;
			}
			$unitPrice.val(nUnitPrice);
			$totalPrice.val(nTotalPrice);
			
			item.newTotal = nTotal;
			item.newUnitPrice = nUnitPrice;
			item.newTotalPrice = nTotalPrice;
			
			$('#allowance-totl-price').text(this.invoice.getTotalPrice());
	},
	prepareAllowance : function() {
		var _this = this;
		
		_this.cardItem = $('#card-invoice-item');
		_this.cardItemSelect = $('#card-invoice-item-select');
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
			var $unitPrice = $row.find('input[name=unitPrice]');
			_this.updateInput($row, null, $unitPrice.val(), null);
		});
		
		$(this.formId).on('click', '.btn.arrow-left', function() {
			var $btn = $(this);
			var $row = $btn.closest('.row');
			var $totalPrice = $row.find('input[name*=totalPrice]');
			_this.updateInput($row, null, null, $totalPrice.val());
		});
		
		$(this.formId).on('change', 'select[name*=total]', function() {
			var $row = $(this).closest('.row');
			_this.updateInput($row, $(this).val(), null, null);
		});
		
		$(this.formId).on('keyup', 'input[name*=unitPrice]', function() {
			var $btn = $(this);
			var $row = $btn.closest('.row');
			var $totalPrice = $row.find('input[name*=totalPrice]');
			$totalPrice.val('');
		});
		
		$(this.formId).on('keyup', 'input[name*=totalPrice]', function() {
			var $btn = $(this);
			var $row = $btn.closest('.row');
			var $unitPrice = $row.find('input[name*=unitPrice]');
			$unitPrice.val('');
		});
		
		jQuery.get(
			GBF.baseUrl+'/ajax/Invoice/get',
			{
				'invoiceId':_this.invoiceId
			},
			function(data) {
				var json = data.data;
				var allowancedItems = null;
				if (data.options && data.options.allowancedItems) {
					allowancedItems = data.options.allowancedItems;
				}
				if (json.preparedInvoiceItems && json.preparedInvoiceItems.length) {
					_this.buildAllowanceForm(json, allowancedItems);
					_this.setInvoice(json);
				} else {
					modalShowDanger($(_this.formId), '此發票無法折讓。僅限2022/11/02之後預約發票有折讓功能')	
				}
			}
		).fail(function(data) {
			json = data.responseJSON;
			modalShowDanger($(_this.formId), json.error);
		});
	},
	buildAllowanceForm : function(invoice, allowancedItems) {
		var _this = this;
		console.log('j:%o', invoice);
		var html = '';
		var htmlSelect = '';
		invoice.preparedInvoiceItems.forEach(function(o,i){
			html += _this.buildInvoiceItem(o);
			htmlSelect += _this.buildInvoiceItemSelect(o);
		});
		_this.cardItem.find('.card-body').html(html);
		_this.cardItemSelect.find('.card-body').html(htmlSelect);
		
		if (allowancedItems) {
			var allowancedItemsHeml = '';
			allowancedItems.forEach(function(o,i){
				allowancedItemsHeml += _this.buildAllowancedItem(o);
			});
			
			$('#allowance-step-0').removeClass('d-none');
			$('#card-allowance-item .card-body').html(allowancedItemsHeml);
		}
	},
	buildAllowancedItem : function(item) {
		var html = `
			<div class="row py-3">
				<div class="col-12 small">${item.name}</div>
				<div class="col-12 small">$${item.unitPrice} x ${item.total} :: $${item.totalPrice}</div>
			</div>
		`
		return html
	},
	buildInvoiceItem : function(item) {
		var totalSelect = `
			<select name="data[${item.invoiceItemId}][total]" class="form-control form-control-sm invoiceItem-total" required>
			<option value="0">數量</option>
		`
		for (var i = 1 ; i < item.total+1; i++ ){
			totalSelect += `<option value="${i}">${i}</option>`
		}
		totalSelect += '</select>';
		var html = `
			<div class="row py-3 d-none" data-id="${item.invoiceItemId}">
				<input type="hidden" name="data[${item.invoiceItemId}][invoiceItemId]" value="${item.invoiceItemId}">
				<div class="col-12 small">${item.name}</div>
				<div class="col-2 small" style="">原始單價</div>
				<div class="col-2 small" style="">原始數量</div>
				<div class="col-2 small" style="">原始總價</div>
				<div class="col-2 small" style="">折讓數量</div>
				<div class="col-2 small" style="">折讓單價</div>
				<div class="col-2 small" style="">折讓總價</div>
				<div class="col-2 small" style="">
					<input type="text" size="5" value="${item.unitPrice}" class="form-control form-control-sm" disabled>
				</div>
				<div class="col-2 small" style="">
					<input type="text" size="3"  value="${item.total}" class="form-control form-control-sm" disabled>
				</div>
				<div class="col-2 small" style="">
					<input type="text" size="5" value="${item.totalPrice}" class="form-control form-control-sm" disabled>
				</div>
				<div class="col-2 small" style="">
					${totalSelect}
				</div>
				<div class="col-2 small" style="">
					<div class="input-group">
						<input type="text" size="5" name="data[${item.invoiceItemId}][unitPrice]" class="input-group-prepend form-control form-control-sm invoiceItem-unitPrice" value="0" required>
						<div class="input-group-append"><button type="button" class="btn btn-sm m-0 p-1 arrow-right"><i class="fa-solid fa-arrow-right"></i></button></div>
					</div>
				</div>
				<div class="col-2 small" style="">
					<div class="input-group">
						<div class="input-group-prepend"><button type="button" class="btn btn-sm m-0 p-1 arrow-left"><i class="fa-solid fa-arrow-left"></i></button></div>
						<input type="text" size="5" name="data[${item.invoiceItemId}][totalPrice]" class="input-group-append form-control form-control-sm invoiceItem-totalPrice" value="0" required>
					</div>
				</div>
				<div class="col-12 small help text-danger"></div>
			</div>
			<hr class="w-100 my-2">
		`
		return html;
	},
	buildInvoiceItemSelect : function(item) {
		var html = `
			<div class="form-group">
				<input type="checkbox" name="itemSelId" value="${item.invoiceItemId}" id="itemSelId${item.invoiceItemId}" class=" form-check-input">
				<label class="control-label" for="itemSelId${item.invoiceItemId}">${item.name}(單價:${item.unitPrice})</label>
			</div>
		`
		return html;
	},
	showStatus : function() {
		$.ajax({
			type:'GET',
			url:GBF.baseUrl + '/ajax/Invoice/status',
			data:{
				
			},
			async:true,
		})
		.done(function(json) {
			var status = json.data;
			var html = `
				<ul class="list-group">
					<li class="list-group-item d-flex justify-content-between align-items-center">
						24小時內開立數量 <span class="badge badge-primary badge-pill">${status.sentIn24Hours}</span>
					</li>
					<li class="list-group-item d-flex justify-content-between align-items-center">
						預約數量 <span class="badge badge-primary badge-pill">${status.willSend}</span>
					</li>
					<li class="list-group-item d-flex justify-content-between align-items-center">
						失敗數量 <span class="badge badge-danger badge-pill">${status.failed}</span>
					</li>
				</ul>
			`
			$('#invoiceStatusCard .card-body').html(html);
		})
		.fail(function(jqXHR, textStatus, errorThrown) {
			callback('');
			}
		);
	},
	issueBySalesOrderId : function(salesOrderId) {
		if (!confirm('確定要開立電子發票?')) return;
		jQuery.post(
			GBF.baseUrl + '/ajax/Invoice/issueInvoice',
			{
				'salesOrderId':salesOrderId
			},
			function(data) {
				displayAlertSuccess(data.error);
				table.ajax.reload(null, false);
			}
			).fail(function(data) {
				json = data.responseJSON;
				displayAlertWarning(json.error);
			}
		);
	}
}