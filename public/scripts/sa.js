let sa = (function() {
	let obj = null;
	if (obj) return obj;
	obj = {
		label : {
			title: '貼標籤'
			,
			message: {
				step1: '將表單貼上標籤，後續可做相關分析。<br>先透過篩選關鍵字與日期，篩選出想貼標籤的表單',
				step2: '輸入想貼上的標題，可透過空格或是英文半形逗點一次貼上多個標籤',
				filtered: '找到{0}個符合篩選條件的表單',
				tagged: '總共貼上{0}個標籤',
			},
			error: {
				required :'欄位不可為空白',
				date: '格式為YYYY-MM, 例如：2023-06',
				dateInRange: '日期區間最多為一年',
			}
		},
		init : function() {
			var _this = this;
			$('#card-emss').on(
				'click',
				'a[type="button"][data-type="emss-payment"]',
				(e)=>{
					var month = $(e.currentTarget).data('month');
					$tr = $('#emss-payment-'+month);
					if ($tr.hasClass('show')) {
						$tr.collapse('hide');
					} else {
						_this.fetchEmssPayment(month);
					}
				}
			);
			$('#card-emss').on(
				'click',
				'a[type="button"][data-type="emss-groupBuy"]',
				(e)=>{
					var month = $(e.currentTarget).data('month');
					$tr = $('#emss-groupBuy-'+month);
					if ($tr.hasClass('show')) {
						$tr.collapse('hide');
					} else {
						_this.fetchEmssGroupBuy(month);
					}
				}
			);
			return _this;
		},
		load : function() {
			var _this = this;
			$.ajax({
				type: 'GET',
				url: GBF.baseUrl+'/ajax/SalesAnalysis/statistics',
				data: {
	
				},
				async: true,
			})
			.done(function(data) {
				var ct = data.data;
				_this.render(data.data);
			})
			.fail(function(data) {

			})
			.always(function(x) {
				
			})
		},
		render : function(data) {
			if (data.amount)
				$('#card-daily-amount .number1').html(data.amount.toLocaleString());
			if (data.total)
				$('#card-daily-total .number1').html(data.total.toLocaleString());
			if (data.amountY)
				$('#card-daily-amount .number2').html(data.amountY.toLocaleString());
			if (data.totalY)
					$('#card-daily-total .number2').html(data.totalY.toLocaleString());
			$gbBody = $('#card-groupBuy tbody');
			
			
			var gbDateUpdated = '';
			var gb = data.gbds.reduce((a,c)=>{
				if (c.dateModifiedString > gbDateUpdated) {
					gbDateUpdated = c.dateModifiedString;
				}
				var ahref = GBF.ctx + '/backend/GroupBuyDailyStatistics/list?groupBuyId='+c.groupBuyId;
				return a + `<tr>
					<td class="td-title"><span class="title">${c.title}</span><a href="${ahref}" target="_blank"><i class="fa-light fa-calendar mr-1"></i><span class="uid">ID: ${c.groupBuyId}</span></a></td>
					<td class="td-count">${c.countSales} / ${c.countSalesPaid}</td>
					<td class="td-amount">${c.amountSales.toLocaleString()} / ${c.amountSalesPaid.toLocaleString()}</td>
					</tr>`
			},'');
			var gbY = data.gbdsY.reduce((a,c)=>{
				return a + `<tr>
					<td class="td-title"><span class="title">${c.title}</span><span class="uid">ID: ${c.groupBuyId}</span></td>
					<td class="td-count">${c.countSales} / ${c.countSalesPaid}</td>
					<td class="td-amount">${c.amountSales.toLocaleString()} / ${c.amountSalesPaid.toLocaleString()}</td>
					</tr>`
			},'');
			var it = data.idss.reduce((a,c)=>{
				var title = c.uid ? c.title : '其他<無商品代碼>' 
				return a + `<tr>
					<td class="td-title"><span class="title">${title}</span><span class="uid">${c.uid}</span></td>
					<td class="td-count">${c.countSales} / ${c.countSalesPaid}</td>
					<td class="td-amount">${c.amountSales.toLocaleString()} / ${c.amountSalesPaid.toLocaleString()}</td>
					</tr>`
			},'');
			var itY = data.idssY.reduce((a,c)=>{
				var title = c.uid ? c.title : '其他<無商品代碼>' 
				return a + `<tr>
					<td class="td-title"><span class="title">${title}</span><span class="uid">${c.uid}</span></td>
					<td class="td-count">${c.countSales} / ${c.countSalesPaid}</td>
					<td class="td-amount">${c.amountSales.toLocaleString()} / ${c.amountSalesPaid.toLocaleString()}</td>
					</tr>`
			},'');
			
			var emssDateUpdated = '';
			var emss = data.emss.reduce((a,c)=>{
				if (!emssDateUpdated) emssDateUpdated = c.dateModifiedString;
				var title = c.datePaidString;
				var t1 = c.amountTotal.toLocaleString() + ' (' + c.amountSales.toLocaleString() + '/' + c.amountAdvance.toLocaleString() + ')';
				var t2 = c.countTotal + ' (' + c.countSales + '/' + c.countAdvance + ')';
				return a + `<tr>
					<td class="td-title">${title} 
						<a type="button" class="btn-floating btn-sm btn-parimary" data-month="${title}" data-type="emss-payment"><i class=" fas fa-plus"></i></a>
						<a type="button" class="btn-floating btn-sm btn-parimary" data-month="${title}" data-type="emss-groupBuy"><i class=" fas fa-home"></i></a>
					</td>
					<td class="td-count">${t2}</td>
					<td class="td-amount">${t1}</td>
					</tr>
					<tr class="emss-payment collapse" id="emss-payment-${title}"><td colspan=3><div class="">xxx</div></td></tr>
					<tr class="emss-groupBuy collapse" id="emss-groupBuy-${title}"><td colspan=3><div class="">xxx</div></td></tr>`
			},'');
			$('#card-groupBuy tbody').html(gb);
			$('#card-groupBuyY tbody').html(gbY);
			$('#card-item tbody').html(it);
			$('#card-itemY tbody').html(itY);
			$('#card-emss tbody').html(emss);
			$('#card-emss .dateUpdated').html(emssDateUpdated);
			$('#card-groupBuy .dateUpdated').html(gbDateUpdated);
		},
		fetchEmssPayment : function(month) {
			var _this = this;
			$.ajax({
				type: 'GET',
				url: GBF.baseUrl+'/ajax/ErpMonthlyPaymentStatistics/statistics',
				data: {
					month:month
				},
				async: true,
			})
			.done(function(data) {
				var ct = data.data;
				_this.renderPayment(month, data.data);
			})
			.fail(function(data) {

			})
			.always(function(x) {
				
			})
		},
		renderPayment : function(month, data) {
		
			$tr = $('#emss-payment-'+month);
			$td = $tr.find('td');
			var table = '<table class="w-100 table-payment">';
			var gb = data.reduce((a,c)=>{
				var title = c.paymentMethodName;
				var t1 = c.amountTotal.toLocaleString() + ' (' + c.amountSales.toLocaleString() + '/' + c.amountAdvance.toLocaleString() + ')';
				var t2 = c.countTotal + ' (' + c.countSales + '/' + c.countAdvance + ')';
				return a + `<tr>
					<td class="td-title"><span class="title">${title}</span></td>
					<td class="td-count">${t2}</td>
					<td class="td-amount">${t1}</td>
					</tr>`
			},'');
			table += gb + '</table>';
			$td.html(table);
			$tr.collapse('show');
		},
		fetchEmssGroupBuy : function(month) {
			var _this = this;
			$.ajax({
				type: 'GET',
				url: GBF.baseUrl+'/ajax/GroupBuyErpMonthlyStatistics/statistics',
				data: {
					month:month
				},
				async: true,
			})
			.done(function(data) {
				var ct = data.data;
				_this.renderEmssGroupBuy(month, data.data);
			})
			.fail(function(data) {

			})
			.always(function(x) {
				
			})
		},
		renderEmssGroupBuy : function(month, data) {
		
			$tr = $('#emss-groupBuy-'+month);
			$td = $tr.find('td');
			var table = '<table class="w-100 table-groupBuy">';
			var gb = data.reduce((a,c)=>{
				var title = c.groupBuyId;
				var t1 = c.amountTotal.toLocaleString() + ' (' + c.amountSales.toLocaleString() + '/' + c.amountAdvance.toLocaleString() + ')';
				var t2 = c.countTotal + ' (' + c.countSales + '/' + c.countAdvance + ')';
				return a + `
					<tr>
					<td class="td-title"><span class="title">${title}</span></td>
					<td class="td-count">${t2}</td>
					<td class="td-amount">${t1}</td>
					</tr>
					<tr><td colspan=3 class="subtitle">${c.title}</td></tr>
					`
			},'');
			table += gb + '</table>';
			$td.html(table);
			$tr.collapse('show');
		}
	};
	
	return obj.init();
})();