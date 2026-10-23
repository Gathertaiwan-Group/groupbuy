
var smsManager = {
		idSrc:'groupBuyId',
		createEditor: function(dt, url, fields) {
			var _this = this;
			this.dt = dt;
			return new $.fn.dataTable.Editor( {
				ajax: {
					create: {
						type: 'POST',
						url: url,
						data: function ( d ) {
							return d.data[0];
						}
					},
				},
				fields: fields,
				formOptions:DataTableConfig.formOptions,
				i18n:DataTableConfig.i18n,
			} )
			.on( 'preSubmit', function ( e, data, action ) {
				var keyField = this.field(_this.keyColumn); 
				var bodyField = this.field('body');
				var confirmField = this.field('confirm');
				var val = keyField.val();
				var MAX = 100;
				var valid = true;
				if (!val) {
					keyField.error('需要至少一個發送對象')
					valid = false;
				} else if (val.split('\n').length > MAX) {
					keyField.error('單次上限為100筆')
					valid = false;
				}
				if (!bodyField.val()) {
					bodyField.error('簡訊內容不可為空白')
					valid = false;
				}
				if (confirmField.val() != '1') {
					confirmField.error('須先勾選同意')
					valid = false;
				}
				
				if (!valid) {
					return false;
				} else {
					btnStartLoading($('.DTE_Form_Buttons .btn.btn-primary'))
				}
				//data[_this.keyColumn] = data.data[0][_this.keyColumn];
				//data.body = data.data[0].body;
				//data.confirm = data.data[0].confirm;
				//data.groupBuyId = data.data[0].groupBuyId;
				//data['data'] = null;//
				return true;
			})
			.on( 'postSubmit', function (e,mode,action) {
				btnStopLoading($('.DTE_Form_Buttons .btn.btn-primary'))
				if (mode.code == 200) {
					this.set(_this.keyColumn, '');
					if (_this.dt) {
						_this.dt.ajax.reload(null, false);
					}
				}
			})
			.on( 'open', function (e,mode,action) {
				$('.DTE').closest('.modal-dialog').removeClass('modal-dialog-scrollable');
				$('.DTE_Form_Content').find('input:radio').each(function(i,obj) {$(obj).addClass('form-check-input')});
				$('#DTE_Field_body').on('keyup', function(e) {
					_this.check_words('#DTE_Field_body');
				});
				_this.getBalance();
			})
			.buttons([
					{label:'送出', className:'btn-primary', action: function () {this.submit();}},
					{label:'關閉', className:'btn-default', action: function () {this.close();}}
					]);
		},
		isKeyFieldTelephone : function() {
			return this.keyColumn == 'telephone';
		},
		prepareSms: function(url, dt, keyColumn) {
			url = url || GBF.baseUrl + '/ajax/Sms/sendSMS';
			keyColumn = keyColumn || 'telephone';
			var _this = this;
			_this.keyColumn = keyColumn;
			var fields = [
				DataTableConfig.field_textarea('簡訊內容','body','','10'),
				DataTableConfig.field_checkbox_bool('同意','confirm', 0, '', '打勾代表了解並同意發送簡訊需支付簡訊費用（1點=1.2元）'),
				DataTableConfig.field_hidden('groupBuyId')
			];
			var keyField;
			if (_this.isKeyFieldTelephone()) {
				keyField = DataTableConfig.field_textarea('電話號碼','telephone','','10','','換行多筆, 單次上限為100筆電話號碼');
			} else {
				keyField = DataTableConfig.field_textarea('對象',keyColumn,'','10','','單次上限為100筆');
			}
			fields.unshift(keyField);
			var message = `<p>簡訊訊息請勿包含以下關鍵字以免被電信公司阻擋：
							<br><span class="text-danger ml-1">LINE</span>,<span class="text-danger ml-1">銀行</span></p>
							<p>依國家通訊傳播委員會(NCC)要求，發送帶有網址(網域)的簡訊，皆需符合為企業申請專屬的網址或網域，否則將無法發送
        					<br>目前只能包含以下開頭網址：<span class="text-danger ml-1">https://gbf.tw</span></p>
							<div class="sms-balance-block">可用簡訊餘額點數：<h4 class="sms-balance text-danger d-inline"></h4>點</div>
						`;
			
			var keyColumnValues = '';
			var groupBuyId = 0;
			
			if (dt) {
				var count = dt.rows( {selected: true}).data().count();
				if (count > 100) {
					messagebox('','單次發送上限最多100筆', '關閉')
					return;
				}
				if (count) {
					keyColumnValues = dt.rows( {selected: true}).data().map(o=>o[keyColumn]).join('\n');
					groupBuyId = dt.rows( {selected: true}).data()[0].groupBuyId;
				};
			}
			
			var editor = this.createEditor(dt, url, fields)
			editor.title('發送簡訊')
			.message(message)
			.create()
			.set('groupBuyId', groupBuyId)
			.set(keyColumn, keyColumnValues);
					
			if (!_this.isKeyFieldTelephone()) {
				editor.field(keyColumn).disable();
			}
			
		},
		getBalance : function() {
			$.ajax({
				url: GBF.baseUrl + '/ajax/Sms/getBalance',
				dataType: 'json',
				success: function(json) {
					var b = json.data;
					$('.sms-balance').text(b);
				},
				error: function (xhr, ajaxOptions, thrownError) {
					alert(xhr.status + " "+ thrownError);
				}
			});
		},
		checkchinese :function(str) {
			var strlen=str.length;
			if(strlen>0){
				var oldstrlen=str.length
				for(var i=0;i<strlen;i++) {
					var c = escape(str.charAt(i));
					if( c.charAt(0) == '%') {
		      		var cc = c.charAt(1);//IE~u,NS~A
		      		if(cc =='A' ||cc =='u'){ return true; }
		      		}
		    	}
		 		return false; 
		 	} else { return false; }
		},
		check_words : function(selector){
			var data=$(selector).val();	
			var msg_length=data.length;
			var cost;
			
			var isChinese = this.checkchinese(data);
			if(isChinese){
				if (msg_length <= (70-3)){
					cost = 1;
				} else {			
					cost = Math.ceil(msg_length/ (67-3));
				}				  
		  	}
			else{ 
				if (msg_length <= (160-3)){
					cost = 1;
				} else {			
					cost = Math.ceil(msg_length/ (153-3));
				}			
			}
			if (cost>1){
				var showwords="<font color=blue>***您共輸入了</font><font color=red>"+msg_length+"</font><font color=blue>字,每則將使用</font><font color=red>"+cost+"</font><font color=blue>點***</font>";
			}else {
				var showwords="<font color=blue>***您共輸入了</font><font color=red>"+msg_length+"</font><font color=blue>字,每則將使用</font><font color=red>"+cost+"</font><font color=blue>點***</font>";
			}
			$showWords = $('#show_words');
			if (!$showWords.length) {
				$showWords = $(selector).after('<div id="show_words"></div>');
			}
			$showWords.html(showwords);
		}
	};