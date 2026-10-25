/**
 * 團購排程管理系統 (Group Buy Scheduler Pro) 模組化 JavaScript (4 步驟嚮導)
 */
var GroupBuyScheduler = (function ($) {
	'use strict';

	var currentStep = 1;
	var selectedItemsCache = [];
	var table = null;
	var opts = {
		ctx: '',
		gba: '',
		foreignId: '',
		entity: 'GroupBuyItemSet'
	};

	function action(action, entity, batchConfigAvailable, parentItemRelated) {
		return {
			action: action,
			entity: entity,
			batchConfigAvailable: batchConfigAvailable,
			parentItemRelated: parentItemRelated
		};
	}

	var ACTION_CONFIGS = {
		'ITEM_SET_ONLINE': action('ITEM_SET_ONLINE', 'GroupBuyItemSet', false, false),
		'ITEM_SET_OFFLINE': action('ITEM_SET_OFFLINE', 'GroupBuyItemSet', false, false),
		'ITEM_SET_ALL_ITEMS_PRICE': action('ITEM_SET_ALL_ITEMS_PRICE', 'GroupBuyItemSet', true, true),
		'ITEM_ONLINE': action('ITEM_ONLINE', 'Item', false, true),
		'ITEM_OFFLINE': action('ITEM_OFFLINE', 'Item', false, true),
		'ITEM_PRICE': action('ITEM_PRICE', 'Item', true, true)
	};

	function getSelectedActionConfig() {
		var actKey = $('input[name="selectedActionRadio"]:checked').val() || 'ITEM_SET_ONLINE';
		return ACTION_CONFIGS[actKey] || ACTION_CONFIGS['ITEM_SET_ONLINE'];
	}

	function showCreateView() {
		resetCreateWizardForm();
		$('#schedulerListContainer').slideUp(200, function() {
			$('#schedulerCreateContainer').slideDown(200);
		});
	}

	function hideCreateView() {
		$('#schedulerCreateContainer').slideUp(200, function() {
			$('#schedulerListContainer').slideDown(200);
			if (table) {
				table.ajax.reload(null, false);
			}
			loadSchedulerSummary();
		});
	}

	function resetCreateWizardForm() {
		currentStep = 1;
		selectedItemsCache = [];

		$('input[name="selectedActionRadio"][value="ITEM_SET_ONLINE"]').prop('checked', true);
		$('.entity-card-option').removeClass('active');
		$('#lblActGBISOnline').addClass('active');

		var select = $('#entityIdSelect');
		if (select.data('select2')) {
			select.select2('destroy');
		}
		select.empty();
		$('input[name="entityTitles"]').remove();

		$('input[name="configMode"][value="unified"]').prop('checked', true);
		$('#newPriceInput').val('');
		$('#itemizedTableBody').empty();
		$('#syncParentChildSwitch').prop('checked', true).prop('disabled', true);
		setQuickTime(10, 'm');

		$('#entity').val('GroupBuyItemSet');
		$('#action').val('UPDATE');
		$('#field').val('online');
		$('#fieldValue').val('1');
		$('#batchConfigsInput').val('');

		updateStepUI();
	}

	function setQuickTime(amount, unit) {
		var now = moment();
		if (unit === 'm') now.add(amount, 'minutes');
		else if (unit === 'h') now.add(amount, 'hours');
		var fmtTime = now.format('YYYY-MM-DD HH:mm:ss');
		$('#dateScheduleInput').val(fmtTime);
		$('.itemized-time-input').val(fmtTime);
	}

	function setQuickTimeMidnight() {
		var tomorrow = moment().add(1, 'days').startOf('day');
		var fmtTime = tomorrow.format('YYYY-MM-DD HH:mm:ss');
		$('#dateScheduleInput').val(fmtTime);
		$('.itemized-time-input').val(fmtTime);
	}

	function updateStepUI() {
		for (var i = 1; i <= 4; i++) {
			var indicator = $('#stepIndicator' + i);
			indicator.removeClass('active completed disabled');
			if (i === currentStep) {
				$('#wizardStep' + i).removeClass('d-none');
				indicator.addClass('active');
			} else {
				$('#wizardStep' + i).addClass('d-none');
				if (i < currentStep) {
					indicator.addClass('completed');
				} else {
					indicator.addClass('disabled');
				}
			}
		}

		$('#btnPrevStep').prop('disabled', currentStep === 1);
		if (currentStep === 4) {
			$('#btnNextStep').addClass('d-none');
			$('#btnSubmitForm').removeClass('d-none');
			renderPreview();
		} else {
			$('#btnNextStep').removeClass('d-none');
			$('#btnSubmitForm').addClass('d-none');
		}
	}

	function navigateStep(direction) {
		if (direction === 1) {
			if (currentStep === 1) {
				var actRadio = $('input[name="selectedActionRadio"]:checked').val();
				if (!actRadio) {
					alert('請選擇欲執行的排程動作！');
					return;
				}
			}
			if (currentStep === 2) {
				var selVals = $('#entityIdSelect').val();
				if (!selVals || selVals.length === 0) {
					alert('請先搜尋並選擇至少一個排程目標項目！');
					return;
				}
				var cfg = getSelectedActionConfig();
				if (cfg.action === 'ITEM_SET_ALL_ITEMS_PRICE') {
					expandItemSetAllItemsPriceToItems();
					return;
				}
			}
			if (currentStep === 3) {
				var cfg = getSelectedActionConfig();
				var configMode = $('input[name="configMode"]:checked').val();
				if (cfg.batchConfigAvailable) {
					if (configMode === 'unified') {
						var uPrice = $.trim($('#newPriceInput').val());
						if (uPrice === '' || isNaN(uPrice) || parseFloat(uPrice) < 0) {
							alert('請輸入有效的統一定價金額！');
							$('#newPriceInput').focus();
							return;
						}
						if (!$.trim($('#dateScheduleInput').val())) {
							alert('請設定預定生效時間！');
							$('#dateScheduleInput').focus();
							return;
						}
					} else if (configMode === 'itemized' && selectedItemsCache.length > 1) {
						var invalidFound = false;
						var invalidMsg = '';
						$('#itemizedTableBody tr').each(function() {
							var priceInput = $(this).find('.itemized-price-input');
							var timeInput = $(this).find('.itemized-time-input');
							var pVal = $.trim(priceInput.val());
							var tVal = $.trim(timeInput.val());
							var title = priceInput.data('title') || '未知商品';

							if (pVal === '' || isNaN(pVal) || parseFloat(pVal) < 0) {
								invalidFound = true;
								invalidMsg = '商品【' + title + '】的新價格尚未填寫或數值錯誤！';
								priceInput.focus();
								return false;
							}
							if (tVal === '') {
								invalidFound = true;
								invalidMsg = '商品【' + title + '】的生效時間尚未填寫！';
								timeInput.focus();
								return false;
							}
						});
						if (invalidFound) {
							alert(invalidMsg);
							return;
						}
					}
				} else {
					if (!$.trim($('#dateScheduleInput').val())) {
						alert('請設定預定生效時間！');
						$('#dateScheduleInput').focus();
						return;
					}
				}
			}
		}

		currentStep += direction;
		if (currentStep < 1) currentStep = 1;
		if (currentStep > 4) currentStep = 4;

		if (currentStep === 2) {
			initSelect2Picker();
		}
		if (currentStep === 3) {
			renderStep3Content();
		}
		updateStepUI();
	}

	function expandItemSetAllItemsPriceToItems() {
		var gbisList = selectedItemsCache;
		if (!gbisList || gbisList.length === 0) {
			alert('請選擇欲設定價格的團購品項！');
			return;
		}

		$('#btnNextStep').prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin mr-1"></i>讀取商品中...');

		var fetchPromises = gbisList.map(function(gbis) {
			var targetItemSetId = gbis.itemSetId || gbis.id;
			return $.ajax({
				url: opts.ctx + '/' + opts.gba + '/ajax/Lookup/item.do',
				dataType: 'json',
				data: {
					groupBuyId: opts.foreignId,
					itemSetId: targetItemSetId,
					c: 'false',
					isFetchAll: 'true'
				}
			});
		});

		$.when.apply($, fetchPromises).done(function() {
			var fetchedItems = [];
			var responses = (gbisList.length === 1) ? [arguments] : Array.prototype.slice.call(arguments);

			responses.forEach(function(respArr) {
				var data = respArr[0];
				if (data && data.results && data.results.length > 0) {
					data.results.forEach(function(itm) {
						if (!fetchedItems.some(function(x) { return String(x.id) === String(itm.id); })) {
							fetchedItems.push({
								id: itm.id,
								text: itm.text || itm.title,
								title: itm.title
							});
						}
					});
				}
			});

			$('#btnNextStep').prop('disabled', false).html('下一步 <i class="fa-solid fa-arrow-right ml-1"></i>');

			if (fetchedItems.length === 0) {
				alert('所選團購品項下未包含任何商品！');
				return;
			}

			selectedItemsCache = fetchedItems;

			var select = $('#entityIdSelect');
			select.empty();
			fetchedItems.forEach(function(itm) {
				var option = new Option(itm.text, itm.id, true, true);
				select.append(option);
			});
			select.trigger('change');

			$('input[name="selectedActionRadio"][value="ITEM_PRICE"]').prop('checked', true);
			$('.entity-card-option').removeClass('active');
			$('#lblActItemPrice').addClass('active');

			$('#entity').val('Item');
			$('#action').val('UPDATE');
			$('#field').val('price');

			currentStep = 3;
			renderStep3Content();
			updateStepUI();
		}).fail(function() {
			$('#btnNextStep').prop('disabled', false).html('下一步 <i class="fa-solid fa-arrow-right ml-1"></i>');
			alert('讀取商品失敗，請稍後重試。');
		});
	}

	function initSelect2Picker() {
		var cfg = getSelectedActionConfig();
		var entityType = cfg.entity;
		$('#entity').val(entityType);

		var select = $('#entityIdSelect');
		if (select.data('select2')) {
			select.select2('destroy');
		}
		select.empty();
		selectedItemsCache = [];

		if (entityType === 'GroupBuyItemSet') {
			$('#targetSelectLabel').text('2. 搜尋與選取團購品項');
			$('#targetSelectHint').text('可在搜尋框輸入關鍵字查找品項，支援選取多個項目進行批次排程。');
		} else {
			$('#targetSelectLabel').text('2. 搜尋與選取單一商品');
			$('#targetSelectHint').text('可在搜尋框輸入關鍵字查找單一商品，支援選取多個項目進行批次或個體化排程。');
		}

		var ajaxUrl = (entityType === 'GroupBuyItemSet')
			? opts.ctx + '/' + opts.gba + '/ajax/Lookup/groupBuyItemSet.do'
			: opts.ctx + '/' + opts.gba + '/ajax/Lookup/item.do';

		select.select2({
			placeholder: entityType === 'GroupBuyItemSet' ? '搜尋並選擇品項 (可多選)...' : '搜尋並選擇單一商品 (可多選)...',
			allowClear: true,
			dropdownParent: $('#schedulerCreateContainer'),
			ajax: {
				url: ajaxUrl,
				dataType: 'json',
				delay: 250,
				data: function (params) {
					return {
						q: params.term,
						groupBuyId: opts.foreignId,
						page: params.page || 1
					};
				},
				processResults: function (data) {
					var results = [];
					if (data && data.results) {
						results = data.results.map(function(obj) {
							return {
								id: obj.id,
								text: obj.text || obj.title,
								itemSetId: obj.itemSetId || obj.id
							};
						});
					}
					return { results: results };
				}
			}
		});

		select.on('change', function() {
			selectedItemsCache = select.select2('data') || [];
		});
	}

	function renderStep3Content() {
		var cfg = getSelectedActionConfig();
		var act = cfg.action;

		if (cfg.batchConfigAvailable && selectedItemsCache.length > 1) {
			$('#configModeToggleGroup').removeClass('d-none');
		} else {
			$('#configModeToggleGroup').addClass('d-none');
			$('input[name="configMode"][value="unified"]').prop('checked', true);
		}

		var configMode = $('input[name="configMode"]:checked').val();

		if (cfg.batchConfigAvailable) {
			$('#statusPreviewGroup').addClass('d-none');
			if (configMode === 'itemized' && selectedItemsCache.length > 1) {
				$('#priceInputGroup').addClass('d-none');
				$('#itemizedConfigGroup').removeClass('d-none');
				$('#unifiedTimeGroup').addClass('d-none');
			} else {
				$('#priceInputGroup').removeClass('d-none');
				$('#itemizedConfigGroup').addClass('d-none');
				$('#unifiedTimeGroup').removeClass('d-none');
			}
		} else {
			$('#statusPreviewGroup').removeClass('d-none');
			$('#priceInputGroup').addClass('d-none');
			$('#itemizedConfigGroup').addClass('d-none');
			$('#unifiedTimeGroup').removeClass('d-none');

			var statusHtml = '';
			if (act === 'ITEM_SET_ONLINE' || act === 'ITEM_ONLINE') {
				statusHtml = '<div class="d-flex align-items-center"><span class="badge badge-success px-3 py-2 font-weight-bold text-uppercase mr-2"><i class="fa-solid fa-arrow-up-from-bracket mr-1"></i>上架</span><span class="text-dark font-weight-bold">將指定目標開啟上架狀態</span></div>';
			} else {
				statusHtml = '<div class="d-flex align-items-center"><span class="badge badge-secondary px-3 py-2 font-weight-bold text-uppercase mr-2"><i class="fa-solid fa-arrow-down-to-bracket mr-1"></i>下架</span><span class="text-dark font-weight-bold">將指定目標設定為下架狀態</span></div>';
			}
			$('#statusBadgeContainer').html(statusHtml);
		}

		if (cfg.parentItemRelated) {
			$('#syncParentGroup').removeClass('d-none');
			$('#syncParentChildSwitch').prop('disabled', false);
		} else {
			$('#syncParentGroup').addClass('d-none');
			$('#syncParentChildSwitch').prop('disabled', true);
		}

		if (act === 'ITEM_SET_ONLINE' || act === 'ITEM_ONLINE') {
			$('#field').val('online');
			$('#fieldValue').val('1');
			$('#action').val('UPDATE');
		} else if (act === 'ITEM_SET_OFFLINE' || act === 'ITEM_OFFLINE') {
			$('#field').val('online');
			$('#fieldValue').val('0');
			$('#action').val('UPDATE');
		} else if (act === 'ITEM_PRICE') {
			$('#field').val('price');
			$('#fieldValue').val($('#newPriceInput').val() || '0');
			$('#action').val('UPDATE');
		}

		renderItemizedTable();
	}

	function renderItemizedTable() {
		var tbody = $('#itemizedTableBody');
		tbody.empty();

		var defTime = $('#dateScheduleInput').val() || moment().add(10, 'minutes').format('YYYY-MM-DD HH:mm:ss');

		selectedItemsCache.forEach(function(item) {
			var tr = '<tr>' +
				'<td class="align-middle font-weight-bold text-dark">' + item.text + '</td>' +
				'<td><input type="number" class="form-control form-control-sm itemized-price-input" data-id="' + item.id + '" data-title="' + item.text + '" placeholder="目標新價格" min="0" step="1"></td>' +
				'<td><input type="text" class="form-control form-control-sm itemized-time-input" data-id="' + item.id + '" value="' + defTime + '"></td>' +
				'</tr>';
			tbody.append(tr);
		});
	}

	function buildBatchConfigsJSON() {
		var cfg = getSelectedActionConfig();
		var configMode = $('input[name="configMode"]:checked').val();
		var act = cfg.action;
		var fieldName = (act === 'ITEM_SET_ONLINE' || act === 'ITEM_SET_OFFLINE' || act === 'ITEM_ONLINE' || act === 'ITEM_OFFLINE') ? 'online' : 'price';
		var syncChecked = (cfg.parentItemRelated && $('#syncParentChildSwitch').is(':checked')) ? 'true' : null;
		var defTime = $('#dateScheduleInput').val();

		if (selectedItemsCache && selectedItemsCache.length > 0) {
			var batchList = [];
			if (configMode === 'itemized' && cfg.batchConfigAvailable && selectedItemsCache.length > 1) {
				$('#itemizedTableBody tr').each(function() {
					var priceInput = $(this).find('.itemized-price-input');
					var timeInput = $(this).find('.itemized-time-input');
					var entityId = priceInput.data('id');
					var title = priceInput.data('title');
					var val = priceInput.val() || $('#newPriceInput').val() || '0';
					var scheduleTime = timeInput.val() || defTime;

					var itemObj = {
						entityId: entityId,
						title: title,
						field: fieldName,
						value: val,
						dateSchedule: scheduleTime
					};
					if (syncChecked !== null) {
						itemObj.syncParentChild = syncChecked;
					}
					batchList.push(itemObj);
				});
			} else {
				var unifiedValue = '1';
				if (fieldName === 'price') {
					unifiedValue = $('#newPriceInput').val() || '0';
				} else if (act === 'ITEM_SET_OFFLINE' || act === 'ITEM_OFFLINE') {
					unifiedValue = '0';
				}

				selectedItemsCache.forEach(function(item) {
					var itemObj = {
						entityId: item.id,
						title: item.text || item.title || ('#' + item.id),
						field: fieldName,
						value: unifiedValue,
						dateSchedule: defTime
					};
					if (syncChecked !== null) {
						itemObj.syncParentChild = syncChecked;
					}
					batchList.push(itemObj);
				});
			}
			return JSON.stringify(batchList);
		}
		return '';
	}

	function renderPreview() {
		var cfg = getSelectedActionConfig();
		var entityType = $('#entity').val();
		var actText = $('input[name="selectedActionRadio"]:checked').closest('.entity-card-option').find('.entity-card-title').text();
		var timeText = $('#dateScheduleInput').val();
		var configMode = $('input[name="configMode"]:checked').val();

		$('#prevTargetText').text('[' + entityType + '] 共選擇 ' + selectedItemsCache.length + ' 項');
		$('#prevActionText').text(actText);
		$('#prevTimeText').text(timeText);

		$('input[name="entityTitles"]').remove();
		selectedItemsCache.forEach(function(item) {
			var escapedText = String(item.text).replace(/"/g, '&quot;');
			$('#SchedulerForm').append('<input type="hidden" name="entityTitles" value="' + escapedText + '" />');
		});

		var html = '<ul class="pl-3 mb-0 text-monospace small">';
		var batchJsonStr = buildBatchConfigsJSON();
		$('#batchConfigsInput').val(batchJsonStr);

		if (batchJsonStr && configMode === 'itemized') {
			var list = JSON.parse(batchJsonStr);
			list.forEach(function(c) {
				html += '<li>' + c.title + ' ➔ NT$ ' + c.value + ' (生效時間: ' + c.dateSchedule + ')</li>';
			});
		} else {
			var uPrice = $('#newPriceInput').val() || '0';
			selectedItemsCache.forEach(function(item) {
				if (cfg.batchConfigAvailable) {
					html += '<li>' + item.text + ' ➔ NT$ ' + uPrice + '</li>';
				} else if (cfg.action === 'ITEM_SET_ONLINE' || cfg.action === 'ITEM_ONLINE') {
					html += '<li>' + item.text + ' ➔ 上架 (ONLINE)</li>';
				} else if (cfg.action === 'ITEM_SET_OFFLINE' || cfg.action === 'ITEM_OFFLINE') {
					html += '<li>' + item.text + ' ➔ 下架 (OFFLINE)</li>';
				} else {
					html += '<li>' + item.text + '</li>';
				}
			});
		}
		html += '</ul>';

		if (cfg.parentItemRelated && $('#syncParentChildSwitch').is(':checked')) {
			html += '<div class="text-warning mt-2 small font-weight-bold"><i class="fa-solid fa-bolt mr-1"></i>已開啟開團中主/子商品同步變更</div>';
		}

		$('#prevDetailsText').html(html);
	}

	function runSchedulerTest(schedulerId) {
		if (!confirm('確定要【立即執行】此排程嗎？這將會立即變更資料庫狀態與價格。')) return;
		$.post(opts.ctx + '/' + opts.gba + '/ajax/Scheduler/testSc.do', { schedulerId: schedulerId }, function(res) {
			if (res.code === 200 || res.code === 0) {
				alert('排程已成功立即執行！');
				if (table) table.ajax.reload(null, false);
				loadSchedulerSummary();
			} else {
				alert('執行失敗：' + (res.message || res.error || '未知錯誤'));
			}
		}, 'json').fail(function() {
			alert('網路請求失敗');
		});
	}

	function deleteScheduler(id) {
		if (!confirm('確定要刪除此排程設定嗎？')) return;
		$.post(opts.ctx + '/' + opts.gba + '/ajax/Scheduler/delete.do', { schedulerId: id }, function(res) {
			if (res.code === 200 || res.code === 0) {
				if (table) table.ajax.reload(null, false);
				loadSchedulerSummary();
			} else {
				alert('刪除失敗：' + (res.message || res.error || '未知錯誤'));
			}
		}, 'json');
	}

	function loadSchedulerSummary() {
		$.get(opts.ctx + '/' + opts.gba + '/ajax/Scheduler/summary.do', { foreignId: opts.foreignId }, function(res) {
			if (res && res.data) {
				$('#statPendingCount').text(res.data.pendingCount || 0);
				$('#statOnlineCount').text(res.data.onlineCount || 0);
				$('#statPriceCount').text(res.data.priceCount || 0);
				$('#statCompletedCount').text(res.data.completedTodayCount || 0);
			}
		}, 'json');
	}

	function init(options) {
		$.extend(opts, options);

		setQuickTime(10, 'm');

		$('input[name="selectedActionRadio"]').on('change', function() {
			$('.entity-card-option').removeClass('active');
			$(this).closest('.entity-card-option').addClass('active');
		});

		$('input[name="configMode"]').on('change', function() {
			renderStep3Content();
		});

		$('#newPriceInput').on('input change', function() {
			renderStep3Content();
		});

		if (typeof initAjaxForm === 'function') {
			initAjaxForm('SchedulerForm', function(json) {
				alert('排程設定新增成功！');
				loadSchedulerSummary();
				resetCreateWizardForm();
				hideCreateView();
			}, function(json) {
				alert('儲存失敗：' + (json.message || json.error || '未知錯誤'));
			});
		}

		var tableName = '#example';
		var currentEntity = opts.entity || 'GroupBuyItemSet';

		$('.pro-switch-btn').on('click', function() {
			$('.pro-switch-btn').removeClass('active');
			$(this).addClass('active');
			currentEntity = $(this).data('value');
			var newUrl = opts.ctx + '/' + opts.gba + '/ajax/Scheduler/list.do?entity=' + currentEntity + '&foreignId=' + opts.foreignId + '&iDisplayLength=100';
			if (table) table.ajax.url(newUrl).load();
		});

		loadSchedulerSummary();

		table = $(tableName).DataTable({
			dom: 'frtip',
			scrollX: true,
			ajax: opts.ctx + '/' + opts.gba + '/ajax/Scheduler/list.do?entity=' + opts.entity + '&foreignId=' + opts.foreignId + '&iDisplayLength=100',
			language: (typeof DataTableConfig !== 'undefined') ? DataTableConfig.i18n : {},
			columns: [
				{
					data: null,
					defaultContent: '',
					className: 'select-checkbox',
					orderable: false
				},
				{ 
					data: 'extraData.title',
					render: function(data, type, row) {
						var title = data || ('ID: #' + row.entityId);
						var icon = (row.entity === 'GroupBuyItemSet') ? '<i class="fa-solid fa-layer-group text-primary mr-2"></i>' : '<i class="fa-solid fa-box text-info mr-2"></i>';
						return '<div class="d-flex align-items-center">' + icon + '<div><div class="font-weight-bold text-dark">' + title + '</div><small class="text-muted">ID: #' + row.entityId + '</small></div></div>';
					}
				},
				{ 
					data: null,
					render: function(data, type, row) {
						var fv = (row.extraData && row.extraData.fieldValues && row.extraData.fieldValues.length > 0) ? row.extraData.fieldValues[0] : null;
						var field = fv ? fv.field : '';
						if (field === 'online') {
							var isOnline = fv.value === '1' || fv.value === 'ONLINE';
							return isOnline 
								? '<span class="badge badge-success px-3 py-2 font-weight-bold"><i class="fa-solid fa-arrow-up mr-1"></i>組合/單品上架</span>'
								: '<span class="badge badge-secondary px-3 py-2 font-weight-bold"><i class="fa-solid fa-arrow-down mr-1"></i>組合/單品下架</span>';
						} else if (field === 'price') {
							return '<span class="badge badge-primary px-3 py-2 font-weight-bold"><i class="fa-solid fa-tag mr-1"></i>單品改價</span>';
						} else if (field === 'set_all_items_price') {
							return '<span class="badge badge-warning px-3 py-2 text-dark font-weight-bold"><i class="fa-solid fa-tags mr-1"></i>組合全品項改價</span>';
						}
						return '<span class="badge badge-info px-3 py-2 font-weight-bold">' + (row.action || 'UPDATE') + '</span>';
					}
				},
				{ 
					data: 'dateScheduleString',
					render: function(data) {
						return '<span class="text-dark font-weight-bold"><i class="fa-regular fa-clock text-primary mr-1"></i>' + (data || '-') + '</span>';
					}
				},
				{ 
					data: null, 
					render: function ( data, type, row ) {
						var html = '';
						if (row.extraData && row.extraData.fieldValues) {
							for (var i in row.extraData.fieldValues) {
								var fv = row.extraData.fieldValues[i];
								var fName = fv.fieldString || fv.field;
								var fVal = fv.valueString || fv.value;
								if (fName === 'online') {
									html += '<span class="badge badge-light border p-2 text-dark">狀態變更: ' + (fVal === '1' ? '[下架] ➔ [上架]' : '[上架] ➔ [下架]') + '</span>';
								} else if (fName === 'price' || fName === 'set_all_items_price') {
									html += '<span class="badge badge-light border p-2 text-dark">目標價格 ➔ NT$ ' + fVal + '</span>';
								} else {
									html += '<span class="badge badge-light border p-2 text-dark">' + fName + ': ' + fVal + '</span>';
								}
							}
						}
						return html || '-';
					} 
				},
				{
					data: null,
					orderable: false,
					className: 'text-right',
					render: function(data, type, row) {
						return '<button type="button" class="btn btn-sm btn-outline-primary border-0 mr-1" title="立即觸發執行排程" onclick="GroupBuyScheduler.runSchedulerTest(' + row.schedulerId + ')"><i class="fa-solid fa-bolt"></i> 立即執行</button>' +
							'<button type="button" class="btn btn-sm btn-outline-danger border-0" title="刪除排程" onclick="GroupBuyScheduler.deleteScheduler(' + row.schedulerId + ')"><i class="fa-solid fa-trash"></i></button>';
					}
				}
			],
			order: [[ 3, "asc" ]],
			select: (typeof DataTableConfig !== 'undefined') ? DataTableConfig.selectOptionsOS : {},
			initComplete: function () {
				$(".dataTables_scrollBody").floatingScroll();
			}
		});
	}

	return {
		init: init,
		showCreateView: showCreateView,
		hideCreateView: hideCreateView,
		resetCreateWizardForm: resetCreateWizardForm,
		navigateStep: navigateStep,
		setQuickTime: setQuickTime,
		setQuickTimeMidnight: setQuickTimeMidnight,
		runSchedulerTest: runSchedulerTest,
		deleteScheduler: deleteScheduler,
		loadSchedulerSummary: loadSchedulerSummary
	};

})(jQuery);
