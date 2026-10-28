/*
 * 加退換商品「原單操作」（修改訂單內容；/backend/ReturnRefund/displayReturnAndRefund）。
 * orders 模組自寫：原站畫面未擷取，依本系統後端契約（lib/modules/orders/returns.ts）推導。
 *   POST /ajax/ReturnRefund/prepare            salesOrderId → {data: rr}（建立本次編輯草稿）
 *   POST /ajax/ReturnRefund/updateOrderItem    orderItemId、total、price、discount、status → {data: rr}（rr.updatedOrderItems＝異動列，含組合子項）
 *   POST /ajax/ReturnRefund/addOrderItem       itemId、groupBuyItemSetId → {data: rr}（rr.updatedOrderItems＝新增列，orderItemId < 0）
 *   POST /ajax/ReturnRefund/applySalesRules    → {data: rr}（整頁重繪）
 *   GET  /ajax/Lookup/groupBuyItemSet?groupBuyId=   團購品項（select2）
 *   GET  /ajax/ReturnRefund/itemTags|itemOptions?groupBuyItemSetId=&tag=   → [{value,label}]
 *   GET  /ajax/ReturnRefund/isTypeBundleConfigable  → {data:{isConfigurable}}
 *   POST /ajax/ReturnRefund/returnAndRefund    orderItems[i].*、shippingAmount、grandTotal、option*、grandTotalToPay → {code:200, error:訊息}
 * rr = {salesOrder:{salesOrderId, uuid, shippingAmount, paid, payByVirtualBank, paymentMethodCVSPickup, sortedOrderItems[]},
 *       oriGrandTotal, newGrandTotal, aliasId(團購 id), updatedOrderItems[], salesReturnRecords[{title, returnTotal, salesTotal}]}
 */
(function ($, window) {
	'use strict';

	var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

	function esc(v) {
		return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
			return ESC[c];
		});
	}

	function safeMsg(v) {
		return esc(v).replace(/&lt;br\s*\/?&gt;/gi, '<br>');
	}

	function num(v) {
		var n = Number(String(v === null || v === undefined ? '' : v).replace(/,/g, ''));
		return isNaN(n) ? 0 : n;
	}

	function round2(v) {
		return Math.round(v * 100) / 100;
	}

	function money(v) {
		return round2(num(v)).toLocaleString();
	}

	function lineAmount(it) {
		return round2(num(it.price) * num(it.total) - num(it.discount));
	}

	function errorOf(xhr, fallback) {
		var j = xhr && xhr.responseJSON;
		if (j && (j.error || j.message)) return j.error || j.message;
		return fallback || '系統忙碌中，請稍後再試（HTTP ' + (xhr ? xhr.status : '') + '）';
	}

	function reloadTables() {
		if (window.RRWizard && window.RRWizard.reloadTables) return window.RRWizard.reloadTables();
		if (!$.fn.dataTable || !$.fn.dataTable.tables) return;
		$.each($.fn.dataTable.tables(), function (i, node) {
			var api = $(node).DataTable();
			var s = api.settings()[0];
			if (s && (s.ajax || s.sAjaxSource)) {
				try {
					api.ajax.reload(null, false);
				} catch (e) {
					/* 略過 */
				}
			}
		});
	}

	var RREdit = {
		/** o: {baseUrl, salesOrderId, formId} */
		init: function (o) {
			var $form = $('#' + o.formId);
			var $tbody = $form.find('tbody.rr-edit-items');
			var $submit = $form.find('[type=submit]');
			var st = { rr: null, orig: {}, seq: 0, shippingOrig: 0, grandDirty: false, payDirty: false };

			function url(path) {
				return o.baseUrl + '/ajax/ReturnRefund/' + path + '.do';
			}

			function call(path, data) {
				return $.ajax({ type: 'POST', url: url(path), data: data, dataType: 'json' });
			}

			function fail(xhr) {
				modalShowDanger($form, safeMsg(errorOf(xhr)));
			}

			function hidden(name, value) {
				return '<input type="hidden" name="' + name + '" value="' + esc(value === null || value === undefined ? '' : value) + '">';
			}

			function rowHtml(it) {
				var i = st.seq++;
				var name = function (k) {
					return 'orderItems[' + i + '].' + k;
				};
				var child = !!it.bundleChild;
				var ro = child ? ' readonly' : '';
				var org = st.orig[it.orderItemId];
				var status = it.status === 'BACKORDER' ? 'BACKORDER' : 'UNSHIPPING';
				var statusCell = child
					? hidden(name('status'), status) + (status === 'BACKORDER' ? '預購' : '現貨')
					: '<select name="' +
						name('status') +
						'" class="custom-select custom-select-sm rr-field">' +
						'<option value="UNSHIPPING"' +
						(status === 'UNSHIPPING' ? ' selected' : '') +
						'>現貨</option>' +
						'<option value="BACKORDER"' +
						(status === 'BACKORDER' ? ' selected' : '') +
						'>預購</option></select>';
				return (
					'<tr data-id="' +
					esc(it.orderItemId) +
					'"' +
					(child ? ' class="rr-child"' : '') +
					'>' +
					'<td' +
					(child ? ' class="pl-4"' : '') +
					'>' +
					hidden(name('orderItemId'), it.orderItemId) +
					hidden(name('itemId'), it.itemId) +
					hidden(name('groupBuyItemSetId'), it.groupBuyItemSetId) +
					(child ? '<span class="grey-text mr-1">└</span>' : '') +
					(Number(it.orderItemId) < 0 ? '<span class="badge badge-warning z-depth-0 mr-1">新增</span>' : '') +
					(it.bundleRoot ? '<span class="badge badge-default z-depth-0 mr-1">組合</span>' : '') +
					esc(it.title) +
					(it.note ? '<div class="small grey-text">' + esc(it.note) + '</div>' : '') +
					'</td>' +
					'<td>' +
					statusCell +
					'</td>' +
					'<td><input type="text" inputmode="decimal" autocomplete="off" name="' +
					name('price') +
					'" value="' +
					esc(it.price) +
					'" class="form-control form-control-sm text-right rr-field" data-label="單價"' +
					ro +
					'></td>' +
					'<td><input type="text" inputmode="numeric" autocomplete="off" name="' +
					name('total') +
					'" value="' +
					esc(it.total) +
					'" class="form-control form-control-sm text-right rr-field" data-label="數量"' +
					ro +
					'></td>' +
					'<td><input type="text" inputmode="decimal" autocomplete="off" name="' +
					name('discount') +
					'" value="' +
					esc(it.discount) +
					'" class="form-control form-control-sm text-right rr-field" data-label="折價"' +
					ro +
					'></td>' +
					'<td class="text-right rr-amount">' +
					money(lineAmount(it)) +
					'</td>' +
					'<td class="text-right small grey-text">' +
					(org ? org.total + ' / ' + money(org.amount) : '—') +
					'</td>' +
					'</tr>'
				);
			}

			function renderItems(items) {
				st.seq = 0;
				$tbody.html(
					items.length
						? $.map(items, rowHtml).join('')
						: '<tr class="rr-empty"><td colspan="7" class="text-center grey-text">此訂單沒有商品，請由下方加購商品</td></tr>',
				);
			}

			function field(tr, key) {
				return tr.find('[name$=".' + key + '"]');
			}

			/** 依伺服器回傳的異動列更新畫面（既有列改值、新列附加） */
			function applyUpdated(list) {
				$.each(list || [], function (i, it) {
					var tr = $tbody.find('tr[data-id="' + it.orderItemId + '"]');
					if (!tr.length) {
						$tbody.find('tr.rr-empty').remove();
						$tbody.append(rowHtml(it));
						return;
					}
					field(tr, 'price').val(it.price);
					field(tr, 'total').val(it.total);
					field(tr, 'discount').val(it.discount);
					field(tr, 'status').val(it.status === 'BACKORDER' ? 'BACKORDER' : 'UNSHIPPING');
					tr.find('.rr-amount').text(money(lineAmount(it)));
				});
			}

			function renderSummary() {
				var rr = st.rr;
				if (!rr) return;
				var ori = num(rr.oriGrandTotal);
				var itemsTotal = rr.newGrandTotal === null || rr.newGrandTotal === undefined ? ori : num(rr.newGrandTotal);
				var ship = num($form.find('[name=shippingAmount]').val());
				if (!st.grandDirty) $form.find('[name=grandTotal]').val(round2(itemsTotal + ship - st.shippingOrig));
				var diff = round2(num($form.find('[name=grandTotal]').val()) - ori);
				$form.find('.rr-ori-grand').text(money(ori));
				$form.find('.rr-items-diff').text(money(itemsTotal - ori));
				$form
					.find('.rr-diff')
					.text(diff > 0 ? '須補收 ' + money(diff) + ' 元' : diff < 0 ? '須退款 ' + money(-diff) + ' 元' : '無差額')
					.toggleClass('text-danger', diff !== 0);
				if (!st.payDirty) $form.find('[name=grandTotalToPay]').val(Math.max(diff, 0));
				var recs = rr.salesReturnRecords || [];
				$form.find('tbody.rr-records').html(
					recs.length
						? $.map(recs, function (r) {
								return (
									'<tr><td>' +
									esc(r.title) +
									'</td><td class="text-right">' +
									esc(r.returnTotal) +
									'</td><td class="text-right">' +
									esc(r.salesTotal) +
									'</td></tr>'
								);
							}).join('')
						: '<tr><td colspan="3" class="text-center grey-text">尚無異動</td></tr>',
				);
			}

			function applyRr(rr, rerender) {
				st.rr = rr;
				if (rerender) renderItems(rr.salesOrder.sortedOrderItems || []);
				else applyUpdated(rr.updatedOrderItems);
				renderSummary();
			}

			// 1) 建立草稿並載入訂單商品
			call('prepare', { salesOrderId: o.salesOrderId })
				.done(function (json) {
					var rr = json.data;
					var so = rr.salesOrder;
					$.each(so.sortedOrderItems || [], function (i, it) {
						st.orig[it.orderItemId] = { total: it.total, amount: lineAmount(it) };
					});
					st.shippingOrig = num(so.shippingAmount);
					$form.find('.rr-uuid').text(so.uuid);
					$form.find('[name=shippingAmount]').val(so.shippingAmount);
					$form.find('.rr-opt-pay').toggle(!!so.paid);
					$form.find('.rr-opt-virtual').toggle(!!so.payByVirtualBank && !so.paid);
					$form.find('.rr-opt-cvs').toggle(!!so.paymentMethodCVSPickup);
					if (rr.aliasId) initAddItem(rr.aliasId);
					else $form.find('#rrAddSection').hide();
					applyRr(rr, true);
					$submit.prop('disabled', false);
				})
				.fail(function (xhr) {
					$tbody.html('<tr><td colspan="7" class="text-danger">' + safeMsg(errorOf(xhr, '無法載入訂單')) + '</td></tr>');
					$form.find('#rrAddSection, .rr-after-items').hide();
					fail(xhr);
				});

			// 2) 修改單價／數量／折價／現貨預購 → 即時試算
			$tbody.on('change', '.rr-field', function () {
				var tr = $(this).closest('tr');
				if (tr.hasClass('rr-child')) return;
				var bad = null;
				tr.find('input.rr-field').each(function () {
					var v = $.trim($(this).val());
					var label = $(this).attr('data-label');
					var ok = label === '數量' ? /^\d+$/.test(v) : /^\d+(\.\d+)?$/.test(v);
					if (!ok) bad = label + '格式錯誤（須為 0 以上的' + (label === '數量' ? '整數' : '數字') + '）';
				});
				if (bad) {
					modalShowDanger($form, esc(bad));
					return;
				}
				call('updateOrderItem', {
					orderItemId: tr.attr('data-id'),
					total: $.trim(field(tr, 'total').val()),
					price: $.trim(field(tr, 'price').val()),
					discount: $.trim(field(tr, 'discount').val()),
					status: field(tr, 'status').val(),
				})
					.done(function (json) {
						$form.find('.modal-message').empty().hide();
						applyRr(json.data, false);
					})
					.fail(fail);
			});

			// 3) 加購商品：品項（select2）→ 分類 → 商品 → 加入
			function fillSelect($sel, list) {
				$sel.html(
					$.map(list || [], function (x) {
						return '<option value="' + esc(x.value) + '">' + esc(x.label) + '</option>';
					}).join(''),
				);
			}

			function initAddItem(groupBuyId) {
				var $set = $form.find('#rrAddSet');
				var $tag = $form.find('#rrAddTag');
				var $item = $form.find('#rrAddItem');
				var loadItems = function () {
					var gbis = $set.val();
					if (!gbis) return fillSelect($item, []);
					$.getJSON(url('itemOptions'), { groupBuyItemSetId: gbis, tag: $tag.val() || '' })
						.done(function (list) {
							fillSelect($item, list);
						})
						.fail(fail);
				};
				$set.select2({
					width: '100%',
					placeholder: '選擇品項',
					language: 'zh-TW',
					dropdownParent: $form.closest('.modal').length ? $form.closest('.modal') : $(document.body),
					ajax: {
						url: o.baseUrl + '/ajax/Lookup/groupBuyItemSet',
						dataType: 'json',
						delay: 250,
						data: function (p) {
							return { groupBuyId: groupBuyId, term: p.term || '', page: p.page || 1 };
						},
					},
				});
				$set.on('change', function () {
					fillSelect($tag, []);
					fillSelect($item, []);
					if (!$set.val()) return;
					$.getJSON(url('itemTags'), { groupBuyItemSetId: $set.val() })
						.done(function (list) {
							fillSelect($tag, list);
							loadItems();
						})
						.fail(fail);
				});
				$tag.on('change', loadItems);
				$form.on('click', '#rrAddItemBtn', function () {
					var itemId = $item.val();
					var gbis = $set.val();
					if (!itemId) {
						modalShowDanger($form, '請選擇商品');
						return;
					}
					$.getJSON(url('isTypeBundleConfigable'), { itemId: itemId, groupBuyItemSetId: gbis })
						.done(function (j) {
							if (j && j.data && j.data.isConfigurable) {
								modalShowDanger($form, '此商品需選擇組合內容，無法在此直接加入');
								return;
							}
							call('addOrderItem', { itemId: itemId, groupBuyItemSetId: gbis })
								.done(function (json) {
									$form.find('.modal-message').empty().hide();
									applyRr(json.data, false);
								})
								.fail(fail);
						})
						.fail(fail);
				});
			}

			// 4) 重新套用優惠（PARITY #58：後端以正式優惠引擎 evaluatePricing 重算各列折價與折扣合計，整頁重繪；送出時一併寫回）
			$form.on('click', '#rrApplySalesRules', function () {
				call('applySalesRules', { salesOrderId: o.salesOrderId })
					.done(function (json) {
						applyRr(json.data, true);
						modalShowSuccess($form, $('<div>').text(json.message || '已重新計算優惠').html());
					})
					.fail(fail);
			});

			// 5) 金額
			$form.find('[name=shippingAmount]').on('input change', renderSummary);
			$form.find('[name=grandTotal]').on('input', function () {
				st.grandDirty = true;
				renderSummary();
			});
			$form.find('[name=grandTotalToPay]').on('input', function () {
				st.payDirty = true;
			});

			// 6) 送出前檢查（必須在 initAjaxForm 之前綁定）
			$form.on('submit', function (e) {
				var errors = [];
				$tbody.find('input.rr-field').each(function () {
					var v = $.trim($(this).val());
					var label = $(this).attr('data-label');
					var ok = label === '數量' ? /^\d+$/.test(v) : /^\d+(\.\d+)?$/.test(v);
					if (!ok) {
						var title = $.trim($(this).closest('tr').find('td:first').text());
						errors.push('「' + esc(title) + '」' + label + '格式錯誤');
					}
				});
				$.each(['shippingAmount', 'grandTotal'], function (i, k) {
					var v = $.trim($form.find('[name=' + k + ']').val());
					if (v !== '' && !/^\d+(\.\d+)?$/.test(v)) errors.push((k === 'shippingAmount' ? '運費' : '退換後訂單金額') + '格式錯誤');
				});
				if ($form.find('[name=optionCreateSalesOrder]').prop('checked')) {
					var pay = $.trim($form.find('[name=grandTotalToPay]').val());
					if (!/^\d+(\.\d+)?$/.test(pay) || num(pay) <= 0) errors.push('請輸入新訂單支付差額金額');
				}
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
					modalShowSuccess($form, safeMsg(json.error || json.message || '已更新訂單'));
					$form.find('.modal-body').find('input, select, textarea, button').not('.close').prop('disabled', true);
					$submit.hide();
					reloadTables();
				},
				function (json) {
					modalShowDanger($form, safeMsg((json && (json.error || json.message)) || '送出失敗'));
				},
			);
		},
	};

	window.RREdit = RREdit;
})(jQuery, window);
