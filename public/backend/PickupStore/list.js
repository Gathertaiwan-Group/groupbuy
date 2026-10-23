var currentSettingId = null;
var currentSettingTitle = '';

$(document).ready(function() {
	// 1. 新增通路設定
	$('#addSettingForm').on('submit', function(e) {
		e.preventDefault();
		var titleVal = $('#title').val().trim();
		if (!titleVal) return;

		showLoading(true);
		$.ajax({
			url: ctx + '/ajax/PickupStore/saveSetting.do',
			type: 'POST',
			data: { title: titleVal },
			success: function(res) {
				showLoading(false);
				if (!res.code || res.code === 200) {
					location.reload();
				} else {
					alert('儲存失敗：' + (res.error || res.message || '未知錯誤'));
				}
			},
			error: function() {
				showLoading(false);
				alert('連線伺服器失敗');
			}
		});
	});

	// 2. 修改通路名稱
	$('.btn-edit-title').on('click', function(e) {
		e.stopPropagation();
		var id = $(this).data('id');
		var oldTitle = $(this).data('title');
		var newTitle = prompt('請輸入新的自取通路名稱：', oldTitle);
		if (newTitle === null) return;
		newTitle = newTitle.trim();
		if (!newTitle) {
			alert('通路名稱不得為空');
			return;
		}
		if (newTitle === oldTitle) return;

		showLoading(true);
		$.ajax({
			url: ctx + '/ajax/PickupStore/saveSetting.do',
			type: 'POST',
			data: {
				pickupStoreSettingId: id,
				title: newTitle
			},
			success: function(res) {
				showLoading(false);
				if (!res.code || res.code === 200) {
					location.reload();
				} else {
					alert('修改失敗：' + (res.error || res.message || '未知錯誤'));
				}
			},
			error: function() {
				showLoading(false);
				alert('連線伺服器失敗');
			}
		});
	});

	// 3. 點擊切換/選取設定
	$('#settingsTableBody').on('click', '.setting-item', function() {
		var id = $(this).data('id');
		var title = $(this).data('title');
		selectSetting(id, title);
	});

	// 4. 拖曳上傳與檔案預覽
	var dragArea = $('#dragDropArea');
	dragArea.on('click', function() {
		$('#fileInput').click();
	});

	dragArea.on('dragover', function(e) {
		e.preventDefault();
		dragArea.addClass('dragover');
	});

	dragArea.on('dragleave', function(e) {
		e.preventDefault();
		dragArea.removeClass('dragover');
	});

	dragArea.on('drop', function(e) {
		e.preventDefault();
		dragArea.removeClass('dragover');
		var files = e.originalEvent.dataTransfer.files;
		if (files.length > 0) {
			uploadFile(files[0]);
		}
	});

	$('#fileInput').on('change', function() {
		if (this.files.length > 0) {
			uploadFile(this.files[0]);
		}
	});

	// 5. 線上表格：新增一行
	$('#btnAddRow').on('click', function() {
		addRow({
			storeCode: '',
			storeName: '',
			address: '',
			postalCode: '',
			longitude: '',
			latitude: ''
		});
		reindexRows();
		$('html, body').animate({ scrollTop: $(document).height() }, 300);
	});

	// 6. 線上表格：刪除列
	$('#storesTableBody').on('click', '.btn-delete-row', function() {
		var tr = $(this).closest('tr');
		tr.fadeOut(300, function() {
			tr.remove();
			reindexRows();
		});
	});

	// 7. 即時必填檢核
	$('#storesTableBody').on('blur', 'input.required-field', function() {
		validateField($(this));
	});

	// 8. 儲存並同步門市資料
	$('#btnSaveStores').on('click', function() {
		if (!currentSettingId) return;
		var data = collectStoresData();
		if (data === null) {
			alert('表格中尚有欄位格式錯誤，請修正標紅處！');
			return;
		}
		if (!confirm('您確定要保存編輯內容並同步至外部定位資料庫嗎？這將覆蓋現有門市定位資料！')) {
			return;
		}
		showLoading(true);
		$.ajax({
			url: ctx + '/ajax/PickupStore/saveStores.do?pickupStoreSettingId=' + currentSettingId,
			type: 'POST',
			contentType: 'application/json',
			data: JSON.stringify(data),
			success: function(res) {
				showLoading(false);
				if (!res.code || res.code === 200) {
					alert('儲存成功！\n自取通路總門市數：' + res.data.totalStores + ' 間\n系統自動 Geocoding 定位數量：' + res.data.geocodedCount + ' 間');
					loadStores();
				} else {
					alert('儲存失敗：' + (res.error || res.message || '未知錯誤'));
				}
			},
			error: function() {
				showLoading(false);
				alert('連線伺服器失敗');
			}
		});
	});

	// 10. 確認開始匯入 (欄位對應)
	$('#btnConfirmImport').on('click', function() {
		if (!pendingUploadFile || !currentSettingId) return;

		var storeNameCol = $('#mapStoreName').val();
		var addressCol = $('#mapAddress').val();

		if (!storeNameCol || !addressCol) {
			alert('「門市名稱」與「詳細地址」為必填對應欄位！');
			return;
		}

		var storeCodeCol = $('#mapStoreCode').val();
		var postalCodeCol = $('#mapPostalCode').val();
		//var longitudeCol = $('#mapLongitude').val();
		//var latitudeCol = $('#mapLatitude').val();

		$('#mappingModal').modal('hide');

		var formData = new FormData();
		formData.append('upload', pendingUploadFile);
		formData.append('pickupStoreSettingId', currentSettingId);

		showLoading(true);
		$.ajax({
			url: ctx + '/ajax/PickupStore/previewFile.do' 
				+ '?storeCodeCol=' + storeCodeCol
				+ '&storeNameCol=' + storeNameCol
				+ '&addressCol=' + addressCol
				+ '&postalCodeCol=' + postalCodeCol,
			//	+ '&longitudeCol=' + longitudeCol
			//	+ '&latitudeCol=' + latitudeCol,
			type: 'POST',
			data: formData,
			processData: false,
			contentType: false,
			success: function(res) {
				showLoading(false);
				$('#fileInput').val('');
				pendingUploadFile = null;
				if (!res.code || res.code === 200) {
					var list = res.data;
					if (list.length === 0) {
						alert('匯入的檔案無效或為空。');
						return;
					}
					if (confirm('欄位對應解析成功，共找到 ' + list.length + ' 間門市。是否將其填充覆蓋至下方編輯表格？')) {
						var tbody = $('#storesTableBody');
						tbody.empty();
						list.forEach(function(item) {
							addRow(item);
						});
						reindexRows();
					}
				} else {
					alert('解析失敗：' + (res.error || res.message || '未知錯誤'));
				}
			},
			error: function() {
				showLoading(false);
				$('#fileInput').val('');
				pendingUploadFile = null;
				alert('檔案解析失敗，請確認檔案格式是否正確。');
			}
		});
	});

	// 9. 檢查是否有預選 ID (從 edit.do 跳轉或初始加載)
	if (preSelectedId) {
		var $row = $('#setting-row-' + preSelectedId);
		if ($row.length > 0) {
			$row.click();
			// 滾動到編輯器
			$('html, body').animate({ scrollTop: $('#editorContainer').offset().top - 20 }, 500);
		}
	}
});

// 切換選取通路
function selectSetting(id, title) {
	currentSettingId = id;
	currentSettingTitle = title;

	// UI 標記 active
	$('#settingsTableBody tr').removeClass('active-setting');
	$('#setting-row-' + id).addClass('active-setting');
	$('#settingsTableBody .active-badge').addClass('d-none');
	$('#setting-row-' + id + ' .active-badge').removeClass('d-none');

	// 切換容器顯示
	$('#emptyEditorPlaceholder').addClass('d-none');
	$('#editorContainer').removeClass('d-none');
	$('#editorHeaderTitle').html('<i class="fa fa-table mr-2"></i>在線門市編輯器 - ' + title);

	// 載入該通路的門市資料
	loadStores();
}

// 載入最新的自取門市清單
function loadStores() {
	if (!currentSettingId) return;
	showLoading(true);
	$.ajax({
		url: ctx + '/ajax/PickupStore/getStores.do?pickupStoreSettingId=' + currentSettingId,
		type: 'GET',
		success: function(res) {
			showLoading(false);
			if (!res.code || res.code === 200) {
				var list = res.data;
				var tbody = $('#storesTableBody');
				tbody.empty();
				list.forEach(function(item) {
					addRow(item);
				});
				reindexRows();
			} else {
				alert('載入資料失敗：' + (res.error || res.message || '未知錯誤'));
			}
		},
		error: function() {
			showLoading(false);
			alert('無法讀取門市資料');
		}
	});
}

// 動態新增一行表格
function addRow(item) {
	var tbody = $('#storesTableBody');
	var tr = $('<tr class="text-center"></tr>');

	var storeCodeVal = item.storeCode || '';
	var storeNameVal = item.storeName || '';
	var addressVal = item.address || '';
	var postalCodeVal = item.postalCode || '';
	var lonVal = item.longitude !== null && item.longitude !== undefined ? item.longitude : '';
	var latVal = item.latitude !== null && item.latitude !== undefined ? item.latitude : '';

	tr.append('<input type="hidden" class="store-lon" value="' + lonVal + '">');
	tr.append('<input type="hidden" class="store-lat" value="' + latVal + '">');
	tr.append('<td class="row-seq text-muted font-weight-bold"></td>');
	tr.append('<td><input type="text" class="form-control store-code" value="' + storeCodeVal + '" placeholder="系統自動產生"></td>');
	tr.append('<td><input type="text" class="form-control store-name required-field" value="' + storeNameVal + '" placeholder="請輸入門市名稱" required></td>');
	tr.append('<td><input type="text" class="form-control store-address required-field" value="' + addressVal + '" placeholder="請輸入詳細地址" required></td>');
	tr.append('<td><input type="text" class="form-control store-postal" value="' + postalCodeVal + '" placeholder="如 235"></td>');
	//tr.append('<td><input type="number" step="any" class="form-control store-lon" value="' + lonVal + '" placeholder="自動計算"></td>');
	//tr.append('<td><input type="number" step="any" class="form-control store-lat" value="' + latVal + '" placeholder="自動計算"></td>');
	tr.append('<td><button type="button" class="btn btn-outline-danger btn-sm p-1 btn-delete-row" title="刪除本列"><i class="fa fa-trash"></i></button></td>');

	tbody.append(tr);
}

// 重新計算表格序號
function reindexRows() {
	var idx = 1;
	$('#storesTableBody tr').each(function() {
		$(this).find('.row-seq').text(idx++);
	});
}

// 單個欄位驗證
function validateField(input) {
	var val = input.val().trim();
	var tr = input.closest('tr');
	if (!val) {
		tr.addClass('invalid-row');
		input.css('border-color', '#dc3545');
		return false;
	} else {
		input.css('border-color', '');
		var rowInvalid = false;
		tr.find('input.required-field').each(function() {
			if (!$(this).val().trim()) {
				rowInvalid = true;
			}
		});
		if (!rowInvalid) {
			tr.removeClass('invalid-row');
		}
		return true;
	}
}

// 收集與驗證表格資料
function collectStoresData() {
	var list = [];
	var hasError = false;

	$('#storesTableBody tr').each(function() {
		var tr = $(this);
		var storeCode = tr.find('.store-code').val().trim();
		var nameInput = tr.find('.store-name');
		var addrInput = tr.find('.store-address');
		var storeName = nameInput.val().trim();
		var address = addrInput.val().trim();
		var postalCode = tr.find('.store-postal').val().trim();
		var longitude = tr.find('.store-lon').val().trim();
		var latitude = tr.find('.store-lat').val().trim();

		if (!validateField(nameInput)) hasError = true;
		if (!validateField(addrInput)) hasError = true;

		list.push({
			storeCode: storeCode,
			storeName: storeName,
			address: address,
			postalCode: postalCode,
			longitude: longitude ? parseFloat(longitude) : null,
			latitude: latitude ? parseFloat(latitude) : null
		});
	});

	return hasError ? null : list;
}

// 全局暫存上傳的檔案物件
var pendingUploadFile = null;

// 檔案上傳預覽
function uploadFile(file) {
	if (!currentSettingId) return;
	pendingUploadFile = file;

	// 先呼叫 previewHeaders.do 取得欄位清單
	var formData = new FormData();
	formData.append('upload', file);
	formData.append('pickupStoreSettingId', currentSettingId);

	showLoading(true);
	$.ajax({
		url: ctx + '/ajax/PickupStore/previewHeaders.do',
		type: 'POST',
		data: formData,
		processData: false,
		contentType: false,
		success: function(res) {
			showLoading(false);
			if (!res.code || res.code === 200) {
				var headers = res.data;
				if (!headers || headers.length === 0) {
					alert('無法讀取檔案欄位標題，請確認檔案格式是否正確。');
					return;
				}
				
				// 填入 Modal 中的 Select 選項
				populateMappingSelects(headers);
				
				// 顯示欄位對應 Modal
				$('#mappingModal').modal('show');
			} else {
				alert('讀取欄位標題失敗：' + (res.error || res.message || '未知錯誤'));
			}
		},
		error: function() {
			showLoading(false);
			alert('上傳分析失敗，請確認檔案格式是否正確。');
		}
	});
}

function populateMappingSelects(headers) {
	var selects = [
		{ id: '#mapStoreName', keywords: ['名稱', '店名', 'name', 'title'] },
		{ id: '#mapAddress', keywords: ['地址', 'address', 'addr', 'location'] },
		{ id: '#mapStoreCode', keywords: ['代號', '代碼', 'code', 'id'], optional: true },
		{ id: '#mapPostalCode', keywords: ['郵遞', '區號', 'zip', 'postal'], optional: true }
	//	{ id: '#mapLongitude', keywords: ['經度', 'lon'], optional: true },
	//	{ id: '#mapLatitude', keywords: ['緯度', 'lat'], optional: true }
	];

	selects.forEach(function(sel) {
		var $select = $(sel.id);
		$select.empty();
		
		if (sel.optional) {
			$select.append('<option value="-1">-- 不對應 (留空) --</option>');
		} else {
			$select.append('<option value="">-- 請選擇對應欄位 --</option>');
		}

		headers.forEach(function(header, idx) {
			$select.append('<option value="' + idx + '">' + header + ' (欄位 ' + (idx + 1) + ')</option>');
		});

		// 自動對應邏輯
		var matchedIdx = -1;
		for (var i = 0; i < headers.length; i++) {
			var hLower = headers[i].toLowerCase();
			var matched = sel.keywords.some(function(kw) {
				return hLower.indexOf(kw) !== -1;
			});
			if (matched) {
				matchedIdx = i;
				break;
			}
		}

		if (matchedIdx !== -1) {
			$select.val(matchedIdx);
		} else if (sel.optional) {
			$select.val("-1");
		}
	});
}

// 刪除通路設定
function deleteSetting(id) {
	if (!confirm('您確定要刪除此自取通路設定嗎？這會同時移除前台此通路之自取門市定位！')) {
		return;
	}
	showLoading(true);
	$.ajax({
		url: ctx + '/ajax/PickupStore/deleteSetting.do',
		type: 'POST',
		data: { pickupStoreSettingId: id },
		success: function(res) {
			showLoading(false);
			if (!res.code || res.code === 200) {
				// 如果刪除的是當前選取的設定，清空並隱藏編輯器
				if (currentSettingId === id) {
					currentSettingId = null;
					currentSettingTitle = '';
					$('#editorContainer').addClass('d-none');
					$('#emptyEditorPlaceholder').removeClass('d-none');
				}
				$('#setting-row-' + id).fadeOut(300, function() {
					$(this).remove();
					if ($('#settingsTableBody tr').length === 0) {
						location.reload();
					}
				});
			} else {
				alert('刪除失敗：' + (res.error || res.message || '未知錯誤'));
			}
		},
		error: function() {
			showLoading(false);
			alert('連線伺服器失敗');
		}
	});
}

// 控制 loading 遮罩
function showLoading(show) {
	if (show) {
		$('#loadingOverlay').removeClass('d-none');
	} else {
		$('#loadingOverlay').addClass('d-none');
	}
}
