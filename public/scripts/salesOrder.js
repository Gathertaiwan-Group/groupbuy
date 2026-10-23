var salesOrderManager = {
		idSrc:'salesOrderId',
		createEditor: function(dt, url, fields) {
			var _this = this;
			this.dt = dt;
			return new $.fn.dataTable.Editor( {
				ajax: {
					create: {
						type: 'POST',
						url: url,
						data: function ( d ) {
							var x = joinIds(_this.idSrc,dt, false);
							if (x.length) {
								d[_this.idSrc] = x;
							} else {
								d[_this.idSrc] = null;
							}
							return d;
						}
					},
				},
				fields: fields,
				formOptions:DataTableConfig.formOptions,
				i18n:DataTableConfig.i18n,
			} )
			.on( 'postSubmit', function (e,mode,action) {
				dt.ajax.reload(null, false);
			})
			.on( 'open', function (e,mode,action) {
				$('.DTE').closest('.modal-dialog').removeClass('modal-dialog-scrollable');
				$('.DTE_Form_Content').find('input:radio').each(function(i,obj) {$(obj).addClass('form-check-input')});
			})
			.buttons({label:'送出', className:'btn-primary', action: function () {this.submit();}})
		},
		removeEditor: function(url) {
			var _this = this;
			return new $.fn.dataTable.Editor( {
				ajax: {
					remove: {
						type: 'POST',
						url: url,
					},
				},
				i18n:DataTableConfig.i18n,
			} )
			.on( 'postSubmit', function (e,mode,action) {
				dt.ajax.reload(null, false);
			})
			.buttons({label:'送出', className:'btn-primary', action: function () {this.submit();}})
		},
		renewCVSPickup: function(dt) {
			var url = GBF.baseUrl + '/ajax/SalesOrder/renewCVSPickup';
			var fields = [
				DataTableConfig.field_textarea('訂單編號','uuids','','10','','可自行帶入額外訂單號碼,換行多筆'),
				DataTableConfig.field_checkbox_bool('列印訂單','print',0,'','重取條碼顯示列印畫面'),
			];
			var count = dt.rows( {selected: true}).data().count();
			var uuids='';
			if (count) {
				uuids = dt.rows( {selected: true}).data().map(o=>o.uuid).join('\n');
			};
			this.createEditor(dt, url, fields)
			.on( 'preSubmit', function ( e, data, action ) {
				var field = this.field('uuids');
				var val = field.val();
				if (!val) {
					field.error('需要至少一筆訂單編號')
					return false;
				} else if (val.split('\n').length > 100) {
					field.error('訂單上限為100筆')
					return false;
				}
			})
			.on( 'postSubmit', function (e,mode,action) {
				if (mode.code != 200) return;
				if (action.data[0].print == '1' && action.data[0].uuids.length > 10) {
					var x = action.data[0].uuids.split('\n').filter(u=>u.length).join(',');
					x = GBF.ctx + '/backend/SalesOrder/batchAction.do?batchAction=PRINT_C2C_ORDER_INFO&uuid='+x;
					window.open(x, '_blank');
				}
			})
			.title(soI18n('SalesOrder.action.renewCVSPickup'))
			.message(soI18n('SalesOrder.action.renewCVSPickup.confirm'))
			.create()
			.set('uuids', uuids);
		},
		markAsPrepareShipping: function(dt) {
			var exists = dt.rows( {selected: true}).data().filter(o=>o.state != 'PROCESSING' || o.status == 'PREPARE_SHIPPING').length;
			if (exists) {
				messagebox('error','僅能篩選階段為「處理中」且狀態不為「準備出貨中」之訂單','關閉')
				return
			}
			var url = GBF.baseUrl + '/ajax/ShippingRecord/markAsPrepareShipping';
			var fields = [
				{
					label:'出貨紀錄',
					name:'shippingRecord',
					type:'radio',
					def:'none',
					fieldInfo:'是否將訂單一並產生出貨紀錄以供後續匯出管理使用',
					options:[
						{label:'不使用出貨紀錄', value:'none'},
						{label:'加入既有出貨紀錄', value:'exists'},
						{label:'產生新出貨紀錄', value:'new'},
					]
				},
				DataTableConfig.field_hidden('salesOrderIds'),
				DataTableConfig.field_select2('出貨紀錄','shippingRecordId','','選擇', GBF.baseUrl + '/ajax/ShippingRecord/lookup'),
			];
			var count = dt.rows( {selected: true}).data().count();
			var salesOrderIds = dt.rows( {selected: true}).data().map(o=>o.salesOrderId).join(',');
			
			this.createEditor(dt, url, fields)
			.dependent('shippingRecord', function(val, data, callback) {
				var show = hide = [];
				switch (val) {
					case 'exists':
						show = ['shippingRecordId'];
						break;
					default:
						hide = ['shippingRecordId'];
				}
				return {show:show,hide:hide};
			})
			.title('設為準備出貨中')
			.message('將所選訂單狀態設為「準備出貨中」')
			.create()
			.set('salesOrderIds', salesOrderIds);
		},
		reauthCreditCardPeriod: function(id) {
			var url = GBF.baseUrl + '/ajax/SalesOrder/reauthCreditCardPeriod2';
			this.removeEditor(dt, url, fields)
			.title('重新授權')
			.message('重新授權失敗訂單?')
			.remove(id);
		},
		show:function(dt, opt) {
			if (opt) {
				this.opt = opt;
			}
			var count = dt.rows( {selected: true}).data().count();
			
			var msg = '';
			if (count) {
				msg = '已選取:'+count+'個商品。重新排序這些商品。';
			} else {
				msg = '未選擇任何商品。重新排序此品項內所有商品';
			}
			var cEditor = this.editor(dt);
			cEditor
			.title('重新排序')
			.message(msg)
			.buttons({label:'送出', className:'btn-primary', action: function () {this.submit();}})
			.create( false );
			cEditor
			.open();
		},
		editor:function(dt) {
			if (this._editor != null) return this._editor;
			var _this = this;
			this.dt = dt;
			this._editor = new $.fn.dataTable.Editor( {
				ajax: {
					create: {
						type: 'POST',
						url:  _this.opt.url,
						data: function ( d ) {
							var x = joinIds(_this.opt.idSrc,_this.dt, false);
							if (_this.opt.data) {
								Object.keys(_this.opt.data).forEach(function(key) {
									d[key] = _this.opt.data[key];
								});
							}
							if (x.length) {
								d[_this.opt.idSrc] = x;
							} else {
								d[_this.opt.idSrc] = null;
							}
							return d;
						}
					},
				},
				fields: [
					{
						label:'排序方式',
						name:'orderBy',
						type:'radio',
						def:'seq asc',
						options:[
							{label:'依目前順序', value:'seq asc'},
							{label:'依目前順序(反排)', value:'seq desc'},
							{label:'名稱(a->z)', value:'title asc'},
							{label:'創建日期(新到舊)', value:'date_created desc'},
							{label:'創建日期(舊到新)', value:'date_created asc'},
							{label:'價格(低到高)', value:'price asc'},
							{label:'價格(高到低)', value:'price desc'},
						]
					},
					DataTableConfig.field_input('起始排序','seq','10'),
					DataTableConfig.field_input('排序間隔','gap','10'),
				],
				formOptions:DataTableConfig.formOptions,
				i18n:DataTableConfig.i18n,
			} )
			.on( 'postSubmit', function (e,mode,action) {
				dt.ajax.reload(null, false);
			})
			.on( 'open', function (e,mode,action) {
				$('.DTE').closest('.modal-dialog').removeClass('modal-dialog-scrollable');
				$('.DTE_Form_Content').find('input:radio').each(function(i,obj) {$(obj).addClass('form-check-input')});
			});

			return this._editor;
		}
	};