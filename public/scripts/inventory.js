
// 【本系統修補】HTML 跳脫：倉庫名稱、商品名稱/代碼、訂單清單等使用者可編輯的值插入 HTML 前先跳脫
var _invEsc = function (s) { return $('<div>').text(s == null ? '' : String(s)).html(); };

var inventoryManager = {
	init:function(itemId) {
		this.itemId = itemId || '';
		this.items = {};
		this._initTable();
		this._initListener();
		return this;
	},
	_initTable:function() {
		var _this = this;
		var tableName = '#invTable';
		var table = $(tableName).DataTable( {
			dom: 'Brtip',
			serverSide:true,
			processing:true,
			scrollX:true,
			"lengthMenu": [10, 25, 50],
			ajax: {
				type: "POST",
				url:GBF.baseUrl+'/ajax/Item/getWarehouseItems',
				data: function ( d ) {
					d.itemId = _this.itemId;
					d.uid = _this.uid;
					//d.items = _this.items;
					return d;
				}
			},
			language:DataTableConfig.i18n,
			columns:[
				DataTableConfig.data_input('title'),
				DataTableConfig.data_input('uid'),
				DataTableConfig.data_input('stock'),
				DataTableConfig.data_input('stockAvailable'),
				{
					sortable:false,
					render: function ( data, type, row ) {
						var html = `
						<button type="button" class="btn btn-sm btn-default btn-row-details p-2 m-0">檢視庫存</button>
						`
						return html;
					}
				}
			],
			"order": [[ 1, "desc" ]],
			'sort':false,
			select: true,
			buttons:[
			],
			initComplete: function () {
				//DataTableConfig.initFooterSearch(this, [0,1],[16,16]);
				//setTimeout(()=>{ table.columns.adjust().draw()},1000);
			},
			drawCallback: function (settings) {
			//	$(".dataTables_scrollBody").floatingScroll();
			}
		} );
		_this.table = table;
		
		$(tableName +' tbody').on('click', 'button.btn-row-details', function (e) {
			var $btn = $(this);
			e.stopPropagation();
			var tr = $(this).closest('tr');
			var row = table.row( tr );
			lw = tableName + '_wrapper .DTFC_LeftWrapper';
			if ( row.child.isShown() ) {
				// This row is already open - close it
				row.child.hide();
				tr.removeClass('shown');
			}
			else {
				// Open this row
				//row.child( format(row.data()) ).show();
				tr.addClass('shown')
				_this.showDetail($btn, row);
			}
			if ($(lw).length > 0) { 
				shouldHide = $(tableName +' tbody').find('.child-row').length > 0;
				$(lw).prop('shouldHide', shouldHide);
				$.fn.DataTable.FixedColumns.onSizeChanged();
			}
		} );
	},
	_initListener : function() {
		var _this = this;
		$('#ItemForm')
		.on('change','input[name=itemIdTo]',function() {
			var $inv = $(this).closest('.inventory');
			var invItemId = $inv.data('id');
			var itemId = $(this).val();
			_this.items[invItemId]['warehouseItemId'] = itemId;
			var $row = $(this).closest('.row');
			$inv.find('.row').removeClass('yellow');
			$row.addClass('yellow');
			$inv.find('input[name=itemIdSelect]')
			.prop('disabled',false)
			.prop('checked',false)
			
			$inv.find('input[name=itemIdSelect][value='+itemId+']')
			.prop('disabled',true)
			.prop('checked',true)
			.change();
			$inv.find('.invWarehouseTip').text($row.find('.warehouse').text());
			var d = _this.tableUpload.row((idx, data) => data.itemId==invItemId).data();
			
			var oriStock = parseInt($row.find('.col-stock').text());
			var n = oriStock + (d.stockCounting-d.stock);
			n = Math.max(0, n);
			$inv.find('input[name=stock]').val(n);
			
			
			var oriStockBackOrder = parseInt($row.find('.col-stockBackOrder').text());
			n = oriStockBackOrder + (d.stockBackOrderCounting-d.stockBackOrder);
			n = Math.max(0, n);
			$inv.find('input[name=stockBackOrder]').val(n);
		})
		.on('change','input[name=itemIdSelect]',function() {
			var checked = $(this).prop('checked');
			var $inv = $(this).closest('.inventory');
			
			var input = $inv.find('input[type=checkbox][name=itemIdSelect]:checked');
			var s = 0;
			var sa = 0;
			var sbo = 0;
			var sboa = 0;
			input.each((i,o)=>{
				var $row = $(o).closest('.row-warehouseItem');
				s += parseInt($row.data('stock'));
				sa += parseInt($row.data('stockAvailable'));
				sbo += parseInt($row.data('stockBackOrder'));
				sboa += parseInt($row.data('stockBackOrderAvailable'));
			})
			$inv.find('.col-selSumStock').text(s);
			$inv.find('.col-selSumStockAvailable').text(sa);
			$inv.data('selSumStock', s);
			$inv.data('selSumStockAvailable', sa);
			
			$inv.find('.col-selSumStockBackOrder').text(sbo);
			$inv.find('.col-selSumStockBackOrderAvailable').text(sboa);
			$inv.data('selSumStockBackOrder', sbo);
			$inv.data('selSumStockBackOrderAvailable', sboa);
		})
		.on('click','input[name=itemIdSelectAll]',function() {
			var checked = $(this).prop('checked');
			var $inv = $(this).closest('.inventory');
			 $inv.find('input[type=checkbox][name=itemIdSelect]:enabled').prop('checked', checked).change();
		})
		.on('click','button.btn-confirmInvCancel',function() {
			$(this)
			.addClass('d-none')
			.prev('button.btn-confirmInv')
			.removeClass('btn-warning')
			.addClass('btn-primary')
			.text('確定')
			.data('confirmed', false)
		})
		.on('click','button.btn-confirmInv',function() {
			var $btn = $(this);
			var $inv = $(this).closest('.inventory');
			var invItemId = $inv.data('id');
			var name = $btn.data('name');
			var valid = _this._validStockInput(invItemId, name);
			if (!valid) {
				_this._updateConfirmInvDescr(invItemId, name);
				return;
			}
		
			var confirmed = $(this).data('confirmed');
			if (!confirmed) {
				$(this)
				.data('confirmed', true)
				.removeClass('btn-primary')
				.addClass('btn-warning')
				.text('確認送出?')
				var $inv = $(this).closest('.inventory'); 
				var id = $inv.data('id');
				_this._updateConfirmInvDescr(id, name);
				$(this).next('button.btn-confirmInvCancel').removeClass('d-none');
			} else {
				_this.stockEntry($inv, $btn, name);
			}
		})
		.on('click','button[data-action]',function() {
			var $btn = $(this);
			var $inv = $(this).closest('.inventory');
			var id = $inv.data('id');
			var input = $inv.find('input[type=checkbox][name=itemIdSelect]:checked');
			if (!input.length) return;
			btnStartLoading($btn);
		
			var ids = [];
			input.each((i,o)=>{
				var $row = $(o).closest('.row-warehouseItem');
				if ($row.data('archived')) return;
				ids.push($(o).val());
			})
			
			var idString = ids.join(',');
			_this.archiveAndSync(id, idString, (json)=>{
				btnStopLoading($btn);
				//$btn.text('已盤點');
				//$btn.prop('disabled', true);
			});
		})
		.on('click','button.btn-showUnacrhivedOrder',function() {
			var $btn = $(this);
			var $inv = $(this).closest('.row-warehouseItem');
			var id = $inv.data('id');
			var backOrder = $btn.data('backOrder');
			_this.queryUnarchivedOrders(id, $btn, backOrder);
		})
		
		$('body')
		.on('click','button.btn-cancelOrder',function() {
			var $btn = $(this);
			var uuid = $btn.data('uuid');
			_this.cancelOrder(uuid, $btn);
		})
		.on('click','button.btn-markArchived',function() {
			var $btn = $(this);
			var uuid = $btn.data('uuid');
			_this.markArchived(uuid, $btn);
		})
	
	},
	updateInv : function($inv, json) {
		json.forEach((o,i)=>{
			$w = $inv.find('.row-warehouseItem[data-id='+o.itemId+']');
		//	$w.find('sum
		});
		/*
		_this.items[id+'']['json'] = json;
		row.child( _this.buildDetail(data, json) ).show();
		//$('input[name=itemId]').change();
		$('input[name=itemId][data-id='+data.itemId+']').prop('checked',true).change();
		btnStopLoading($btn);
		*/
	},
	_updateUploadTableRow : function(itemId, stock, stockAvailable, stockBackOrder, stockBackOrderAvailable) {
		var r = inventoryManager.tableUpload.row((idx, data) => data.itemId==itemId);
		var d = r.data();
		d.stock = stock;
		d.stockAvailable = stockAvailable;
		d.stockBackOrder = stockBackOrder;
		d.stockBackOrderAvailable = stockBackOrderAvailable;
		var scrollTop = document.documentElement.scrollTop || document.body.scrollTop;
		r.data(d).draw(false);
		document.documentElement.scrollTop = document.body.scrollTop = scrollTop;
	},
	_updateSumStock : function($inv) {
		var id = $inv.data('id');
		var sumStock = 0;
		var sumStockAvailable = 0;
		var selSumStock = 0;
		var selSumStockAvailable = 0;
	
		var sumStockBackOrder = 0;
		var sumStockBackOrderAvailable = 0;
		var selSumStockBackOrder = 0;
		var selSumStockBackOrderAvailable = 0;
		
		$inv.find('.row-warehouseItem').each((i,o) => {
			var stock = parseInt($(o).data('stock'));
			var stockAvailable = parseInt($(o).data('stockAvailable'));
			sumStock += stock;
			sumStockAvailable += stockAvailable;
			
			var stockBackOrder = parseInt($(o).data('stockBackOrder'));
			var stockBackOrderAvailable = parseInt($(o).data('stockBackOrderAvailable'));
			sumStockBackOrder += stockBackOrder;
			sumStockBackOrderAvailable += stockBackOrderAvailable;
			
			if ($(o).find('input[name=itemIdSelect]:checked').length) {
				selSumStock += stock;
				selSumStockAvailable += stockAvailable;
				
				selSumStockBackOrder += stockBackOrder;
				selSumStockBackOrderAvailable += stockBackOrderAvailable;
			}
		});
		$inv.find('.col-sumStock').text(sumStock);
		$inv.find('.col-sumStockAvailable').text(sumStockAvailable);
		$inv.find('.col-selSumStock').text(selSumStock);
		$inv.find('.col-selSumStockAvailable').text(selSumStockAvailable);
		
		$inv.find('.col-sumStockBackOrder').text(sumStockBackOrder);
		$inv.find('.col-sumStockBackOrderAvailable').text(sumStockBackOrderAvailable);
		$inv.find('.col-selSumStockBackOrder').text(selSumStockBackOrder);
		$inv.find('.col-selSumStockBackOrderAvailable').text(selSumStockBackOrderAvailable);
		
		this._updateUploadTableRow(id, sumStock, sumStockAvailable, sumStockBackOrder, sumStockBackOrderAvailable);
	},
	_buildDetail : function(data, json) {
		var id = data.itemId;
		var html = `
			<div class="container mt-1 small inventory" data-id="${id}">
			<div class="row">
			<div class="col-1">入庫</div>
			<div class="col-1">選擇</div>
			<div class="col-4">倉儲</div>
			<div class="col-1">現貨</div>
			<div class="col-2">可售</div>
			<div class="col-1">預購</div>
			<div class="col-2">可售</div>
			</div>
			`
		var sa = 0;
		var s = 0;
		var sboa = 0;
		var sbo = 0;
		json.forEach((o,i)=>{
			var same = id == o.itemId;
			var showUnarchivedBtn = '';
			var showUnarchivedBtnBO = '';
			if (o.stock-o.stockAvailable != 0) {
				showUnarchivedBtn = `
					<button type="button" class="btn btn-showUnacrhivedOrder" data-id="${o.itemId}">
						<i class="fa-light fa-list"></i>
					</button>
					`
			}
			if (o.stockBackOrder-o.stockBackOrderAvailable != 0) {
				showUnarchivedBtnBO = `
					<button type="button" class="btn btn-showUnacrhivedOrder" data-id="${o.itemId}" data-back-order="true">
						<i class="fa-light fa-list"></i>
					</button>
					`
			}
			html += `
			<div class="row row-warehouseItem border-top" data-id="${o.itemId}" data-stock="${o.stock}" data-stock-available="${o.stockAvailable}" data-stock-back-order="${o.stockBackOrder}" data-stock-back-order-available="${o.stockBackOrderAvailable}">
			<div class="col-1">
			<input class="form-check-input" id="itemIdTo_${o.itemId}" name="itemIdTo" type="radio" value="${o.itemId}" >
			<label class="form-check-label" for="itemIdTo_${o.itemId}"> </label>
			</div>
			<div class="col-1">
			<input class="form-check-input small" id="itemIdSelect_${o.itemId}" name="itemIdSelect" type="checkbox" value="${o.itemId}">
			<label class="form-check-label red-text" for="itemIdSelect_${o.itemId}"> </label>
			</div>
			<div class="col-4"><span class="warehouse">${_invEsc(o.warehouseName)} (${o.itemId})</span></div>
			<div class="col-1 col-stock">${o.stock}</div>
			<div class="col-2 col-stockAvailable">${o.stockAvailable} ${showUnarchivedBtn}</div>
			<div class="col-1 col-stockBackOrder">${o.stockBackOrder}</div>
			<div class="col-2 col-stockBackOrderAvailable">${o.stockBackOrderAvailable} ${showUnarchivedBtnBO}</div>
			</div>
			`
			sa += o.stockAvailable;
			s += o.stock;
			sboa += o.stockBackOrderAvailable;
			sbo += o.stockBackOrder;
		})
		
		html += ` 
			<div class="row border-top pt-1 row-sum">
			<div class="col-2"></div>
			<div class="col-4">總庫存</div>
			<div class="col-1 col-sumStock">${s}</div>
			<div class="col-2 col-sumStockAvailable">${sa}</div>
			<div class="col-1 col-sumStockBackOrder">${sbo}</div>
			<div class="col-2 col-sumStockBackOrderAvailable">${sboa}</div>
			<div class="col-2"></div>
			<div class="col-4">選取總庫存</div>
			<div class="col-1 col-selSumStock">0</div>
			<div class="col-2 col-selSumStockAvailable">0</div>
			<div class="col-1 col-selSumStockBackOrder">0</div>
			<div class="col-2 col-selSumStockBackOrderAvailable">0</div>
			</div>
			`
			
		html += `
			<div class="row">
			<div class="col-1"></div>
			<div class="col-9">
			<input class="form-check-input" id="itemIdSelectAll_${id}" name="itemIdSelectAll" type="checkbox">
			<label class="form-check-label" for="itemIdSelectAll_${id}">全選</label>
			</div>
			<div class="col-2">
			<button type="button" data-id="${id}" class="btn btn-warning btn-sm px-2 py-1 m-0" data-action="countInv">盤點所選倉庫</button>
			</div>
			</div>'
			`
			
		html += `
			<div class="row">
				<div class="col-12">
					<div class="input-group input-group-inventory py-0">
						<div class="input-group-prepend">
							<div class="input-group-text md-addon">盤點現貨數量:<span class="invWarehouseTip"></span></div>
						</div>
						<input type="text" name="stock" class="form-control item-stock" placeholder="輸入新的所選總庫存數量" autocomplete="off">
						<div class="input-group-append">
							<button type="button" class="btn btn-sm btn-primary m-0 p-2 btn-confirmInv" data-id="${id}" data-name="stock">確認</button>
							<button type="button" class="btn btn-sm btn-default m-0 p-2 btn-confirmInvCancel d-none" data-id="${id}" data-name="stock">取消</button>
						</div>
					</div>
				</div>
				<div class="col-12 confirmInvDescr"></div>
			</div>
			<div class="row mt-1">
				<div class="col-12">
					<div class="input-group input-group-inventory py-0">
						<div class="input-group-prepend">
							<div class="input-group-text md-addon bg-success text-white">盤點預購數量:<span class="invWarehouseTip"></span></div>
						</div>
						<input type="text" name="stockBackOrder" class="form-control item-stock" placeholder="輸入新的所選總庫存數量" autocomplete="off">
						<div class="input-group-append">
							<button type="button" class="btn btn-sm btn-primary m-0 p-2 btn-confirmInv" data-id="${id}" data-name="stockBackOrder">確認</button>
							<button type="button" class="btn btn-sm btn-default m-0 p-2 btn-confirmInvCancel d-none" data-id="${id}" data-name="stockBackOrder">取消</button>
						</div>
					</div>
				</div>
				<div class="col-12 confirmInvDescrBackOrder"></div>
			</div>
		`
		html += '</div>';
		return html;
	},
	showDetail : function($btn, row) {
		var _this = this;
		var data = row.data();
		btnStartLoading($btn);
		this.queryInv(data.itemId, json => {
			_this.items[data.itemId+''] = {json:json};
			row.child( _this._buildDetail(data, json) ).show();
			//$('input[name=itemId]').change();
			$inv = $('.inventory[data-id='+data.itemId+']');
			$inv.find('input[name=itemIdTo][value='+data.itemId+']').prop('checked',true).change();
			btnStopLoading($btn);
		});
	},
	queryInv : function(id, callback) {
		var _this = this;
		jQuery.post(
			GBF.baseUrl+'/ajax/Item/queryInv',
			{
				'itemId':id
			},
			function(data) {
				json = data.data;
				callback(json);
			}
		).fail(function(data) {
			json = data.responseJSON;
			$('#ItemForm .modal-message').show();
			$('#ItemForm .modal-message-alert-text').html(json.error);
		});
	},
	stockEntry : function($inv, $caller, name='stock') {
		btnStartLoading($caller);
		var _this = this;
		var id = $inv.data('id');
		var info = _this._stockEntryInfo($inv, name);
		jQuery.post(
			GBF.baseUrl+'/ajax/Item/addStock',
			{
				'itemId':info.toWareHouseItemId,
				'stock':info.incStock,
				'name':name,
				'expected':info.oriStock
			},
			function(data) {
				json = data.data;
				_this.refreshInventory(id, json);
			}
		).fail(function(data) {
			json = data.responseJSON;
			$('#ItemForm .modal-message').show();
			$('#ItemForm .modal-message-alert-text').html(json.error);
		}).always(function() {
			btnStopLoading($caller);
			$caller
			.removeClass('btn-warning')
			.addClass('btn-primary')
			.text('確定')
			.data('confirmed', false)
			.next('button.btn-confirmInvCancel')
			.addClass('d-none')
		})
	},
	_validStockInput : function(id, name) {
		var suffix = (name == 'stockBackOrder') ? 'BackOrder' : '';
		var $inv = $('.inventory[data-id='+id+']');
		var $stock = $inv.find('input[name='+name+']');
		var err = !$stock.val();
		var minStock = this._toWareHouseItemMinStock($inv, suffix);
		
		var stock = 0;
		if (!err) {
			stock = parseInt($stock.val());
			err = stock < minStock;
		}
		return !err;
	},
	_toWareHouseItemMinStock : function($inv, suffix='') {
		var $toWareHouseItem = $inv.find('input[name=itemIdTo]:checked');
		var $row = $toWareHouseItem.closest('.row');
		var $selSumStock = $inv.find('.col-selSumStock' + suffix);
		var stockAvailable = parseInt($row.data('stock'+suffix+'Available'));
		var selSumStock = parseInt($selSumStock.text());
		var min = selSumStock - stockAvailable;
		return min;
	}, 
	_stockEntryInfo : function($inv, name='stock') {
		var suffix = (name == 'stockBackOrder') ? 'BackOrder' : '';
		var _this = this;
		var id = $inv.data('id');
		var $toWareHouseItem = $inv.find('input[name=itemIdTo]:checked');
		var toWareHouseItemId = $toWareHouseItem.val();
		var $descr = $inv.find('.confirmInvDescr' + suffix);
		var $selSumStock = $inv.find('.col-selSumStock' + suffix);
		var $selSumStockAvailable = $inv.find('.col-selSumStock'+suffix+'Available');
		var $stock = $inv.find('input[name='+name+']');
		var selSumStock = parseInt($selSumStock.text());
		var selSumStockAvailable = parseInt($selSumStockAvailable.text());
		var html = '';
		var valid = _this._validStockInput(id, name);
		var stock = -1;
		var minStock = _this._toWareHouseItemMinStock($inv, suffix);
		if (!valid) {
		} else {
			stock = parseInt($stock.val());
			var incStock = stock - selSumStock;
			var oriStock = parseInt($toWareHouseItem
							.closest('.row-warehouseItem').data('stock' + suffix));
			var newStock = oriStock + incStock;
			if (stock < minStock) {
				valid = false;
			}
		}
		var info = {
			toWareHouseItemId : $toWareHouseItem.val(),
			incStock : incStock,
			selSumStock : selSumStock,
			newSelSumtock : stock,
			oriStock : oriStock,
			newStock : newStock,
			minStock : minStock,
			valid : valid
		}
		
		return info;
	},
	_updateConfirmInvDescr : function(id, name) {
		var suffix = (name == 'stockBackOrder') ? 'BackOrder' : '';
		var _this = this;
		var $inv = $('.inventory[data-id='+id+']');
		var $descr = $inv.find('.confirmInvDescr' + suffix);
		var html = '';
		var info = _this._stockEntryInfo($inv, name);
		if (!info.valid) {
			html = `
				盤點數量不得少於當前庫存${info.minStock}
			`
		} else {
			var lbInc = info.incStock >=0 ? '增加' : '減少'
			html = `
				該倉庫存將${lbInc}${info.incStock}，由${info.oriStock}${lbInc}至${info.newStock}
				<br>所選總庫存將由${info.selSumStock}${lbInc}至${info.newSelSumtock}
			`
		}
		
		$descr.html(html);
	},
	archiveAndSync : function(id, ids, callback) {
		var _this = this;
		jQuery.post(
			GBF.baseUrl+'/ajax/Item/archiveAndSync',
			{
				'itemId':ids
			},
			function(data) {
				var json = data.data;
				callback(json);
				_this.refreshInventory(id, json, true);
			}
		).fail(function(data) {
			var json = data.responseJSON;
			$('#ItemForm .modal-message').show();
			$('#ItemForm .modal-message-alert-text').html(json.error);
		});
	},
	refreshInventory : function(id, json, forArchive = false) {
		 if (!json) return;
		$inv = $('.inventory[data-id='+id+']');
		json.forEach((o,i)=>{
			$row = $inv.find('.row-warehouseItem[data-id='+o.itemId+']');
			$row.data('stock', o.stock);
			$row.data('stockAvailable', o.stockAvailable);
			$row.find('.col-stock').text(o.stock);
			$row.find('.col-stockAvailable').text(o.stockAvailable);
			
			$row.data('stockBackOrder', o.stockBackOrder);
			$row.data('stockBackOrderAvailable', o.stockBackOrderAvailable);
			$row.find('.col-stockBackOrder').text(o.stockBackOrder);
			$row.find('.col-stockBackOrderAvailable').text(o.stockBackOrderAvailable);
			
			if (forArchive) {
				$row.data('archived', true);
				$row.find('label[for=itemIdSelect_'+o.itemId+']').text('已盤');
			}
		});
		this._updateSumStock($inv);
	},
	showUplaodEditor : function() {
		this._createUploadEditor()
		.title('匯入檔案')
		.message('上限1000個商品<br>EXCEL第一行須為標頭，且資料至少包含商品代碼及庫存數量兩欄')
		.buttons([
			{label:'上傳', className:'btn-primary', tabIndex:0, action: function () {this.submit();}},
			{label:'關閉', className:'btn-default', tabIndex:1, action: function () {this.close();}}
		])
		.create({
			onComplete:'none'
		})
		.hide()
		.show('uploadFile')
	},
	_createUploadEditor : function() {
		if (this.uploadEditor) return this.uploadEditor;
		var _this = this;
		this.uploadEditor = new $.fn.dataTable.Editor( {
			ajax: GBF.baseUrl + '/ajax/wms/WarehouseInventory/loadItems',
			idSrc: 'itemId',
			fields: [
				DataTableConfig.field_upload('上傳庫存檔案','uploadFile', GBF.baseUrl + '/ajax/wms/WarehouseInventory/uploadFileForLoadItems'),
				DataTableConfig.field_select('商品代碼欄位','uidCol','','必選'),
				DataTableConfig.field_select('庫存數量欄位','stockCol','','必選'),
				DataTableConfig.field_select('預購庫存數量欄位','stockBackOrderCol','','可不選'),
			],
			formOptions:{
				onComplete:'none'
			}
		} )
		.on( 'uploadXhrSuccess', function ( e, fieldName, json ) {
			var editor = this;
			/* var fields = [
				'reasonCol',
				'pointsCol',
				'amountCol',
			] */
			var data = json.data;
			if (data == null) return;
			
			var fields = editor.order();
			for (var i= 0; i < fields.length; i++) {
				if (!fields[i].endsWith('Col')) continue;
				var field = editor.field( fields[i] );
				field.update(data);
			}

			editor.show();
		} )
		.on( 'preSubmit', function ( e, data, action ) {
			if ( action == 'remove' ) return;
			var fields = [
				'uidCol',
				'stockCol',
			];
			for (var i = 0; i < fields.length; i++) {
				var field = this.field(fields[i]);
				if (!field.val()) {
					field.error('需要選擇一個欄位');
				}
			}
			if (this.inError()) return false;
		})
		.on( 'postSubmit', function (e, json, data, action, xhr) {
			if (json.data) {
				_this.items = json.data;
			}
			var total = json.data ? json.data.length : 0;
			this.error('已匯入:'+total+'個商品');
			_this.getTableUpload().rows.add(_this.items).draw();
			_this.getTableUpload().columns.adjust().draw();
		} );
		
		return _this.uploadEditor;
	},
	getTableUpload : function() {
		var _this = this;
		if (_this.tableUpload) return _this.tableUpload;
		
		var tableName = '#invTableUpload';
		var table = $(tableName).DataTable( {
			dom: 'Brtip',
			//serverSide:true,
			//processing:true,
			scrollX:true,
			"lengthMenu": [1000],
			language:DataTableConfig.i18n,
			columns:[
				{
					data:'title',
					render: function ( data, type, row, meta ) {
						var title = !data ? '<span class="text-warning">商品不存在</span>' : _invEsc(data);
						return `
							<span class="col-title">${title}</span><span class="col-uid">${_invEsc(row.uid)}</span>'
							`
					}
				},
				{
					data:'stockCounting',
					render: function ( data, type, row, meta ) {
					
						var stockD = '';
						var stockBOD = '';
						
						var d = row.stockCounting - row.stock;
						var d2 = row.stockBackOrderCounting - row.stockBackOrder;
						
						if (d) {
							stockD = '<span class="stockDiff">差異:' + d + '</span>'
						}
						if (d2) {
							stockBOD = '<span class="stockDiff">差異:' + d2 + '</span>'
						}
						
						var html = `
							現貨:${row.stockCounting} ${stockD}
							預購:${row.stockBackOrderCounting} ${stockBOD}
						`
						
						return html;
					}
				},
				{
					data:'stock',
					render: function ( data, type, row, meta ) {
						var extra = '';
						var extraBO = '';
						if (row.stockCounting && row.stockCounting == row.stock) {
							extra = '<i class="fa-light fa-check ml-1 text-success"></i>';
						}
						if (row.stockBackOrderCounting && row.stockBackOrderCounting == row.stockBackOrder) {
							extraBO = '<i class="fa-light fa-check ml-1 text-success"></i>';
						}
						
						var stockD = '';
						var stockBOD = '';
						stockD = '<span class="stockAvailable">可售:' + row.stockAvailable + '</span>'
						stockBOD = '<span class="stockAvailable">可售:' + row.stockBackOrderAvailable + '</span>'
						var html = `
							現貨:${row.stock}${extra} ${stockD}
							預購:${row.stockBackOrder}${extraBO}${stockBOD}
						`
						
						return html;
					}
				},
				{
					sortable:false,
					render: function ( data, type, row ) {
						if (!row.title) return '';
						var html = `
						<button type="button" class="btn btn-sm btn-default btn-row-details p-2 m-0">檢視庫存</button>
						`
						return html;
					}
				}
			],
			"order": [[ 1, "desc" ]],
			'sort':false,
			select: false,
			buttons:[
				{
					text: '匯出',
					action: function ( e, dt, node, config ) {
						_this.download(dt, 'uid' ,node);
					}
				},
			],
			initComplete: function () {
				//DataTableConfig.initFooterSearch(this, [0,1],[16,16]);
				//setTimeout(()=>{ table.columns.adjust().draw()},1000);
			},
			drawCallback: function (settings) {
			//	$(".dataTables_scrollBody").floatingScroll();
			}
		} );
		_this.tableUpload = table;
		
		$(tableName +' tbody').on('click', 'button.btn-row-details', function (e) {
			var $btn = $(this);
			e.stopPropagation();
			var tr = $(this).closest('tr');
			var row = table.row( tr );
			lw = tableName + '_wrapper .DTFC_LeftWrapper';
			if ( row.child.isShown() ) {
				// This row is already open - close it
				row.child.hide();
				tr.removeClass('shown');
			}
			else {
				// Open this row
				//row.child( format(row.data()) ).show();
				tr.addClass('shown')
				_this.showDetail($btn, row);
			}
			if ($(lw).length > 0) { 
				shouldHide = $(tableName +' tbody').find('.child-row').length > 0;
				$(lw).prop('shouldHide', shouldHide);
				$.fn.DataTable.FixedColumns.onSizeChanged();
			}
		} );
		
		return table;
	},
	addToTable : function(uid) {
		if (!uid) return;
		uid = uid.join ? uid.join() : uid;
		var _this = this;
		jQuery.post(
			GBF.baseUrl+'/ajax/wms/WarehouseInventory/loadItems',
			{
				'uid':uid
			},
			function(data) {
				var json = data.data;
				_this.getTableUpload().rows.add(json).draw();
				_this.getTableUpload().columns.adjust().draw()
			}
		).fail(function(data) {
			var json = data.responseJSON;
			$('#ItemForm .modal-message').show();
			$('#ItemForm .modal-message-alert-text').html(json.error);
		});
	},
	clean : function() {
		this.uid = '';
		this.items = {};
		this.getTableUpload().clear().draw();
	},
	queryUnarchivedOrders : function(itemId, $btn, backOrder) {
		btnStartLoading($btn);
		var _this = this;
		jQuery.get(
			GBF.baseUrl+'/ajax/wms/WarehouseInventory/queryUnarchivedOrders',
			{
				'itemId':itemId,
				'backOrder':backOrder
			},
			function(data) {
				if (data && data.data) {
					var html = data.data.map(function (obj) {
						return `
							<li class="list-group-item">${_invEsc(obj.label)}
							<div class="btn-group">
							<button class="btn btn-warning btn-cancelOrder" data-uuid="${obj.value}">取消訂單</button>
							<button class="btn btn-default btn-markArchived" data-uuid="${obj.value}">設為已盤點</button>
							</div>
							</li>`
	 				}).join('');
					html = `<ul class="list-group">${html}</ul>`
					messagebox('', html, 'OK');
				}
			}
		).fail(function(data) {
			var json = data.responseJSON;
			$('#ItemForm .modal-message').show();
			$('#ItemForm .modal-message-alert-text').html(json.error);
		}).always(function() {
			btnStopLoading($btn);
		})
	},
	cancelOrder : function(uuid, $btn) {
		btnStartLoading($btn);
		var _this = this;
		jQuery.post(
			GBF.baseUrl+'/ajax/SalesOrder/cancelOrder',
			{
				'salesOrderId':uuid
			},
			function(data) {
				$btn.parent().html('已取消')
			}
		).fail(function(data) {
			var json = data.responseJSON;
			$('#ItemForm .modal-message').show();
			$('#ItemForm .modal-message-alert-text').html(json.error);
		}).always(function() {
			btnStopLoading($btn);
		})
	},
	markArchived : function(uuid, $btn) {
		btnStartLoading($btn);
		var _this = this;
		jQuery.post(
			GBF.baseUrl+'/ajax/wms/WarehouseInventory/markArchived',
			{
				'salesOrderId':uuid
			},
			function(data) {
				$btn.parent().html('已盤點')
			}
		).fail(function(data) {
			var json = data.responseJSON;
			$('#ItemForm .modal-message').show();
			$('#ItemForm .modal-message-alert-text').html(json.error);
		}).always(function() {
			btnStopLoading($btn);
		})
	},
	download : function(dt, idSelector, $btn) {
		var dd = '';
		dt.data().each(function(obj,index) {
			if (index == 0) {
				dd += obj[idSelector];
			} else {
			  dd += "," + obj[idSelector];
			}
		})
		var $form = $('#downloadForm');
		$form.find('[name=uids]').val(dd);
		
		btnStartLoading($btn);
		
		const form = document.getElementById('downloadForm');
		const myFormData = new FormData(form);
		const formDataObj = Object.fromEntries(myFormData.entries());
		// data string
		//const data = JSON.stringify(Object.fromEntries(myFormData));
		
		$.fileDownload($form.prop('action'), {
			httpMethod: "POST",
			data: formDataObj
		})
		.done(function () { 
			btnStopLoading($btn);
		})
		.fail(function (responseHtml, url) { 
		    exportFile._editor.close();
			messagebox('error',responseHtml,'OK')
	
			//alert('下載失敗');
			btnStopLoading($btn);
		});
	}
}

/*
$('.btn-checkInv').click(function() {
	var $btn = $(this);
	btnStartLoading($btn);
	var id = $btn.data('id')
	queryInv(id, json=> {
		btnStopLoading($btn);
	})
});

*/
