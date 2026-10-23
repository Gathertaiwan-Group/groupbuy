/* 原站 /scripts/createWizard.js 原樣搬移；僅改：上傳端點（原站外部主機 → 本站 /json/uploadImage/vcf）與圖片前綴（→ /upload/images/）。 */
/**
 * Item Create Wizard JS Module
 * Path: web/scripts/createWizard.js
 */
$(document).ready(function() {
	var config = $.extend({
		uploadFromUrlEndpoint: GBF.baseUrl + '/ajax/Item/uploadFromUrl.do',
		saveEndpoint: GBF.baseUrl + '/ajax/Item/save'
	}, window.CreateWizardConfig || {});
	var groupBuyId = config.groupBuyId || '';
	var itemSetId = config.itemSetId || '';
	var gba = config.gba || '';

	var $urlInput = $('#createWizardInput');
	var $uploadBtn = $('#createWizardUploadBtn');
	var $step1 = $('#createWizardStep1');
	var $step2 = $('#createWizardStep2');
	var $skeleton = $('#createWizardSkeleton');
	var $error = $('#createWizardError');
	var $stepIndicators = $('[data-cw-step]');
	var $stepLine = $('[data-cw-step-line="1"]');
	var $productList = $('#createWizardProductList');
	var tpl = document.getElementById('createWizardProductTpl');
	var $addProductBtn = $('#createWizardAddProductBtn');
	var $createBtn = $('#createWizardCreateBtn');
	var $progressFill = $('#createWizardProgressFill');
	var $progressNum = $('#createWizardProgressNum');
	var $resultCount = $('#createWizardResultCount');
	var $step0 = $('#createWizardStep0');
	var $stepsBar = $('#createWizardSteps');
	var $resultLabel = $('#createWizardResultLabel');
	var $modalTitle = $('#createWizardModalTitle');
	var $itemSetWrap = $('#createWizardItemSetWrap');
	var $itemSetSelect = $('#createWizardItemSetSelect');
	var $itemSetError = $('#createWizardItemSetError');
	var $addOptions = $('#createWizardAddOptions');
	var $step2UrlInput = $('#cwStep2UrlInput');
	var $step2UrlBtn = $('#cwStep2UrlBtn');
	var $step2Error = $('#cwStep2Error');
	var $step2ManualBtn = $('#cwStep2ManualBtn');
	var $step2OptionsClose = $('#cwStep2OptionsClose');

	// Lock #myModal to static backdrop so clicking outside will NOT close the modal
	$('#myModal').attr('data-backdrop', 'static').attr('data-keyboard', 'false');
	$('#myModal').off('click.preventOutsideClose').on('click.preventOutsideClose', function(e) {
		if (e.target === this || $(e.target).hasClass('modal')) {
			e.stopPropagation();
			return false;
		}
	});

	// Lightbox close listener for full description image preview
	$(document).off('click.cwLightboxClose').on('click.cwLightboxClose', '#cwImageLightbox .cw-lightbox-close, #cwImageLightbox .cw-lightbox-backdrop', function() {
		$('#cwImageLightbox').removeClass('is-active').attr('aria-hidden', 'true');
	});
	$(document).off('keydown.cwLightboxEsc').on('keydown.cwLightboxEsc', function(e) {
		if (e.key === 'Escape' && $('#cwImageLightbox').hasClass('is-active')) {
			$('#cwImageLightbox').removeClass('is-active').attr('aria-hidden', 'true');
		}
	});

	var I18N = $.extend({
		fieldImage: '圖片網址',
		fieldTitle: '商品名稱',
		fieldPrice: '售價',
		fieldStock: '庫存',
		fieldBackorder: '預購庫存',
		actionSell: '販售',
		actionAddSpec: '新增規格',
		actionAddSpecOptional: '新增規格 (選填)',
		actionAddSpecGroup: '新增規格群組',
		actionRemoveSpec: '刪除規格',
		actionDelete: '刪除',
		actionAllDoneSummary: '已成功新增全部 {0} 項商品',
		actionPartialDoneSummary: '已成功新增 {0}/{1} 項商品（{2} 項失敗）',
		missingSpec: '未填規格',
		placeholderUntitled: '未命名商品',
		placeholderNoPrice: '未設定價格',
		specLimitHint: '最多支援 3 個規格群組 (如：顏色、尺寸)。',
		specComboPreview: '規格組合預覽',
		specNameFormat: '商品名稱組合格式',
		specNameFormatHint: ' {title} 代表原商品名稱，{0} 代表第一個規格選項',
		specTitlePlaceholder: '規格名稱 (例如: 顏色)',
		specChipHint: '輸入規格選項後按 Enter 或逗點',
		specChipPlaceholderAdd: '輸入下一個選項',
		specChipPlaceholderStart: '輸入選項 (例如: 紅色)',
		specComboSummary: '已勾選 {0} 個組合',
		specComboSummaryExcluded: '(已排除 {0} 個)',
		resultSummary: '共 {0} 個商品項目',
		statusDone: '已建立',
		statusFailed: '失敗',
		stockCurrentLabel: '現貨',
		stockBackorderLabel: '預購',
		metaManual: '手動新增',
		metaParsedSuffix: '抓取商品',
		titleGeneric: '新增商品',
		titleUrlMode: '網址自動抓取商品',
		resultManualLabel: '新增商品項目',
		uploadHint: '拖曳圖片到此處，或點擊選擇檔案上傳',
		uploadPlaceholder: '貼上圖片網址或上傳檔案',
		errorNotImage: '請上傳有效的圖片檔案',
		errorTooLarge: '圖片大小不能超過 2MB',
		errorUploadFailed: '圖片上傳失敗，請重新嘗試',
		errorEmptyUrl: '請輸入商品網址',
		descrImagesTitle: '產品說明圖',
		descrImagesPasteHint: '拖曳圖片到此處、點擊選檔、或直接貼上 HTML 內文/圖片',
		selectItemSet: '請選擇商品組合',
		errorRequireItemSet: '請先選擇商品組合',
		actionEditItem: '編輯內容',
		actionCollapseEdit: '收合編輯',
		actionCreateItems: '建立商品'
	}, config.i18n || {});

	function ensureItemSet() {
		if (!itemSetId) {
			if ($itemSetWrap.length) {
				$itemSetWrap.addClass('has-error').show();
				$itemSetError.text(I18N.errorRequireItemSet || '請先選擇商品組合').show();
				if ($.fn.select2 && $itemSetSelect.data('select2')) {
					$itemSetSelect.select2('open');
				} else {
					$itemSetSelect.focus();
				}
			} else {
				alert(I18N.errorRequireItemSet || '請先選擇商品組合');
			}
			return false;
		}
		return true;
	}

	if (!itemSetId && $itemSetSelect.length) {
		$itemSetWrap.show();
		if ($.fn.select2) {
			$itemSetSelect.select2({
				width: '100%',
				placeholder: I18N.selectItemSet || '請選擇商品組合',
				allowClear: true,
				dropdownParent: $('#myModal'),
				ajax: {
					delay: 250,
					url: GBF.baseUrl + '/ajax/Lookup/itemSet?groupBuyId=' + groupBuyId,
					dataType: 'json',
					data: function(params) {
						return { q: params.term || '' };
					},
					processResults: function(data) {
						if (Array.isArray(data)) {
							return { results: data };
						}
						return data || { results: [] };
					}
				}
			}).on('change', function() {
				var val = $(this).val();
				itemSetId = val || '';
				if (itemSetId) {
					$itemSetError.hide();
					$itemSetWrap.removeClass('has-error');
				}
			});
		}
	}

	// substitutes {0}, {1}, ... in an I18N template string
	function fmt(str, args) {
		args.forEach(function(v, i) { str = str.split('{' + i + '}').join(v); });
		return str;
	}

	var UPLOAD_URL = '/json/uploadImage/vcf';
	var IMAGE_BASE = '/upload/images/';
	var MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

	function validateImageFile(file) {
		if (!file.type || file.type.indexOf('image/') !== 0) return I18N.errorNotImage;
		if (file.size > MAX_UPLOAD_BYTES) return I18N.errorTooLarge;
		return null;
	}

	// callback(err, url) — same callback shape as createOneItem below
	function uploadImageFile(file, callback) {
		var form = new FormData();
		form.append('upload', file);
		form.append('action', 'upload');
		form.append('uploadField', 'image');
		$.ajax({
			type: 'POST',
			url: UPLOAD_URL,
			data: form,
			processData: false,
			contentType: false,
			success: function(response) {
				if (typeof response === 'string') {
					try { response = JSON.parse(response); } catch (e) { response = null; }
				}
				var id = response && response.upload && response.upload.id;
				if (!id) {
					callback(typeof (response || {}).error === 'string' ? response.error : I18N.errorUploadFailed);
					return;
				}
				callback(null, /^https?:\/\//i.test(id) ? id : IMAGE_BASE + id);
			},
			error: function() {
				callback(I18N.errorUploadFailed);
			}
		});
	}

	function showUploadError(zoneEl, message) {
		var card = zoneEl.closest('.cw-product-card');
		if (!card) return;
		var old = card.querySelector('.cw-upload-error');
		if (old) old.remove();
		var box = document.createElement('div');
		box.className = 'cw-upload-error';
		box.textContent = message;
		card.appendChild(box);
		setTimeout(function() { box.remove(); }, 3000);
	}

	function uploadIntoInput(file, inputEl, zoneEl) {
		var invalid = validateImageFile(file);
		if (invalid) {
			showUploadError(zoneEl, invalid);
			return;
		}
		zoneEl.classList.add('is-uploading');
		uploadImageFile(file, function(err, url) {
			zoneEl.classList.remove('is-uploading');
			if (err) {
				showUploadError(zoneEl, err);
				return;
			}
			inputEl.value = url;
			inputEl.dispatchEvent(new Event('input', { bubbles: true }));
		});
	}

	var UPLOAD_ZONES = '.cw-product-thumb, .cw-combo-image-input';

	function inputForZone(zoneEl) {
		var card = zoneEl.closest('.cw-product-card');
		if (!card || card.classList.contains('is-created')) return null;
		if (!zoneEl.classList.contains('cw-combo-image-input')) {
			return card.querySelector('.cw-image-input');
		}
		var row = zoneEl.closest('.cw-combo-row');
		return (row && row.classList.contains('is-created')) ? null : zoneEl;
	}

	var fieldIdSeq = 0;
	function assignFieldId(input) {
		if (!input.id) input.id = 'cwField' + (++fieldIdSeq);
		return input.id;
	}
	function labelField(fieldEl) {
		var label = fieldEl.querySelector('label');
		var input = fieldEl.querySelector('input');
		if (label && input) label.htmlFor = assignFieldId(input);
	}
	function labelMiniFields(scopeEl) {
		Array.prototype.slice.call(scopeEl.querySelectorAll('.cw-mini-field')).forEach(labelField);
	}

	function cartesian(arrays) {
		return arrays.reduce(function(acc, arr) {
			var next = [];
			acc.forEach(function(a) { arr.forEach(function(v) { next.push(a.concat([v])); }); });
			return next;
		}, [[]]);
	}

	function applyNameFormat(format, titleVal, comboValues) {
		var out = format.split('{title}').join(titleVal);
		comboValues.forEach(function(v, i) {
			out = out.split('{' + i + '}').join(v);
		});
		return out;
	}

	// tag format: title#value$TspecTitle#value$TspecTitle
	function buildTag(titleVal, comboValues, specTitles) {
		var parts = [$.trim(titleVal || '')];
		comboValues.forEach(function(v, i) {
			parts.push($.trim(v || '') + '$T' + $.trim(specTitles[i] || ''));
		});
		return parts.join('#');
	}

	function createChipField(container, onChange) {
		var values = [];
		var input = document.createElement('input');
		input.type = 'text';
		input.className = 'cw-chip-input';
		assignFieldId(input);
		input.setAttribute('aria-label', I18N.specChipHint);
		container.appendChild(input);

		function render() {
			container.querySelectorAll('.cw-chip').forEach(function(c) { c.remove(); });
			values.forEach(function(v, idx) {
				var chip = document.createElement('span');
				chip.className = 'cw-chip';
				var label = document.createElement('span');
				label.textContent = v;
				var remove = document.createElement('button');
				remove.type = 'button';
				remove.textContent = 'x';
				remove.addEventListener('click', function(e) {
					e.stopPropagation();
					values.splice(idx, 1);
					render();
					onChange(values);
				});
				chip.appendChild(label);
				chip.appendChild(remove);
				container.insertBefore(chip, input);
			});
			input.placeholder = values.length ? I18N.specChipPlaceholderAdd : I18N.specChipPlaceholderStart;
		}

		function addFromInput() {
			var added = false;
			input.value.split(',').forEach(function(part) {
				var v = part.trim();
				if (v.length && values.indexOf(v) < 0) { values.push(v); added = true; }
			});
			input.value = '';
			if (added) { render(); onChange(values); }
		}

		input.addEventListener('keydown', function(e) {
			if (e.key === 'Enter' || e.key === ',') {
				e.preventDefault();
				addFromInput();
			} else if (e.key === 'Backspace' && !input.value.length && values.length) {
				values.pop();
				render();
				onChange(values);
			}
		});
		input.addEventListener('blur', addFromInput);
		container.addEventListener('click', function() { input.focus(); });

		render();
		return { getValues: function() { return values.slice(); } };
	}

	function updateGlobalCount() {
		var cards = Array.prototype.slice.call(productList0().querySelectorAll('.cw-product-card'));
		var total = cards.reduce(function(sum, c) {
			return sum + parseInt(c.dataset.leafCount || '1', 10);
		}, 0);
		$resultCount.text(fmt(I18N.resultSummary, [total]));
		$progressNum.text('0 / ' + total);
		$progressFill.css('width', '0%');
	}

	function productList0() { return $productList.get(0); }

	function initSpecEditor(cardEl, opts) {
		var detected = !!(opts && opts.detected);
		var zone = cardEl.querySelector('.cw-spec-zone');
		zone.innerHTML =
			'<div class="cw-spec-trigger">' +
				(detected ? '<span class="cw-missing-badge">' + I18N.missingSpec + '</span>' : '') +
				'<button type="button" class="cw-btn-outline-spec">' +
					'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>' +
					(detected ? I18N.actionAddSpec : I18N.actionAddSpecOptional) +
				'</button>' +
			'</div>' +
			'<div class="cw-spec-editor">' +
				'<div class="cw-spec-groups"></div>' +
				'<button type="button" class="cw-btn-add-spec">' + I18N.actionAddSpecGroup + '</button>' +
				'<p class="cw-spec-limit-hint">' + I18N.specLimitHint + '</p>' +
				'<div class="cw-combo-section" hidden>' +
					'<div class="cw-combo-summary"><span>' + I18N.specComboPreview + '</span><span class="cw-combo-summary-text"></span></div>' +
					'<div class="cw-name-format-row">' +
						'<label>' + I18N.specNameFormat + '<span class="cw-name-format-hint">' + I18N.specNameFormatHint + '</span></label>' +
						'<input type="text" class="cw-name-format-input" />' +
					'</div>' +
					'<div class="cw-combo-table"></div>' +
				'</div>' +
			'</div>';

		var groups = [];
		var trigger = zone.querySelector('.cw-btn-outline-spec');
		var groupsWrap = zone.querySelector('.cw-spec-groups');
		var addGroupBtn = zone.querySelector('.cw-btn-add-spec');
		var comboSection = zone.querySelector('.cw-combo-section');
		var comboSummary = zone.querySelector('.cw-combo-summary-text');
		var comboTable = zone.querySelector('.cw-combo-table');
		var nameFormatInput = zone.querySelector('.cw-name-format-input');
		var titleInput = cardEl.querySelector('.cw-title-input');
		labelField(zone.querySelector('.cw-name-format-row'));

		function defaultNameFormat(n) {
			var f = '{title}';
			for (var i = 0; i < n; i++) f += ' {' + i + '}';
			return f;
		}
		nameFormatInput.addEventListener('input', function() {
			nameFormatInput.dataset.dirty = '1';
			renderCombos();
		});
		titleInput.addEventListener('input', renderCombos);

		trigger.addEventListener('click', function() {
			cardEl.classList.add('spec-open');
			if (!groups.length) addGroup();
		});

		function addGroup() {
			if (groups.length >= 3) return;
			var wrap = document.createElement('div');
			wrap.className = 'cw-spec-group';
			wrap.innerHTML =
				'<div class="cw-spec-group-head">' +
					'<input type="text" class="cw-spec-title" placeholder="' + I18N.specTitlePlaceholder + '" />' +
					'<button type="button" class="cw-spec-remove" title="' + I18N.actionRemoveSpec + '">' +
						'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>' +
					'</button>' +
				'</div>' +
				'<div class="cw-chip-field"></div>' +
				'<div class="cw-chip-hint">' + I18N.specChipHint + '</div>';
			groupsWrap.appendChild(wrap);

			var api = createChipField(wrap.querySelector('.cw-chip-field'), renderCombos);
			var group = { api: api, el: wrap };
			groups.push(group);
			var specTitleInput = wrap.querySelector('.cw-spec-title');
			assignFieldId(specTitleInput);
			specTitleInput.setAttribute('aria-label', I18N.specTitlePlaceholder);
			specTitleInput.addEventListener('input', renderCombos);
			wrap.querySelector('.cw-spec-remove').addEventListener('click', function() {
				var i = groups.indexOf(group);
				if (i >= 0) { groups.splice(i, 1); wrap.remove(); renderCombos(); }
				addGroupBtn.disabled = groups.length >= 3;
			});
			addGroupBtn.disabled = groups.length >= 3;
			renderCombos();
		}
		addGroupBtn.addEventListener('click', addGroup);

		function updateComboSummary() {
			var rows = Array.prototype.slice.call(comboTable.querySelectorAll('.cw-combo-row'));
			var included = rows.filter(function(r) { return !r.classList.contains('is-excluded'); });
			comboSummary.innerHTML = included.length
				? fmt(I18N.specComboSummary, ['<b>' + included.length + '</b>']) + (included.length < rows.length ? ' ' + fmt(I18N.specComboSummaryExcluded, [rows.length - included.length]) : '')
				: '';
			cardEl.dataset.leafCount = included.length || 1;
			updateGlobalCount();
		}

		function renderCombos() {
			var active = groups.filter(function(g) { return g.api.getValues().length > 0; });
			comboTable.innerHTML = '';
			if (!active.length) {
				comboSection.hidden = true;
				cardEl.dataset.leafCount = 1;
				updateGlobalCount();
				return;
			}
			comboSection.hidden = false;
			if (nameFormatInput.dataset.dirty !== '1') {
				nameFormatInput.value = defaultNameFormat(active.length);
			}
			var format = nameFormatInput.value || defaultNameFormat(active.length);
			var titleVal = titleInput.value;
			var priceVal = cardEl.querySelector('.cw-price-input').value;
			var stockVal = cardEl.querySelector('.cw-stock-input').value;
			var backorderVal = cardEl.querySelector('.cw-backorder-input').value;
			var imageVal = cardEl.querySelector('.cw-image-input').value;
			var specTitles = active.map(function(g) { return g.el.querySelector('.cw-spec-title').value; });
			var combos = cartesian(active.map(function(g) { return g.api.getValues(); }));
			combos.forEach(function(combo) {
				var name = applyNameFormat(format, titleVal, combo);
				var row = document.createElement('div');
				row.className = 'cw-combo-row';
				row.innerHTML =
					'<div class="cw-combo-row-top">' +
						'<span class="cw-combo-check"></span>' +
						'<span class="cw-combo-name"></span>' +
						'<label class="cw-combo-include"><input type="checkbox" checked> ' + I18N.actionSell + '</label>' +
					'</div>' +
					'<div class="cw-combo-row-fields">' +
						'<div class="cw-mini-field"><label>' + I18N.fieldImage + '</label><div class="cw-combo-image-wrap"><input type="text" class="cw-combo-image-input" placeholder="' + I18N.uploadPlaceholder + '" /><button type="button" class="cw-combo-upload-btn" title="' + I18N.uploadHint + '"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 8l5-5 5 5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg></button></div></div>' +
						'<div class="cw-field-row">' +
							'<div class="cw-mini-field"><label>' + I18N.fieldPrice + '</label><div class="cw-mini-field-prefix"><span>NT$</span><input type="text" class="cw-combo-price-input" inputmode="numeric" /></div></div>' +
							'<div class="cw-mini-field"><label>' + I18N.fieldStock + '</label><input type="text" class="cw-combo-stock-input" inputmode="numeric" /></div>' +
							'<div class="cw-mini-field"><label>' + I18N.fieldBackorder + '</label><input type="text" class="cw-combo-backorder-input" inputmode="numeric" /></div>' +
						'</div>' +
					'</div>';
				labelMiniFields(row);
				assignFieldId(row.querySelector('.cw-combo-include input'));
				row.querySelector('.cw-combo-name').textContent = name;
				row.querySelector('.cw-combo-image-input').value = imageVal;
				row.querySelector('.cw-combo-price-input').value = priceVal;
				row.querySelector('.cw-combo-stock-input').value = stockVal;
				row.querySelector('.cw-combo-backorder-input').value = backorderVal;
				row.dataset.comboName = name;
				row.dataset.comboTag = buildTag(titleVal, combo, specTitles);
				row.querySelector('.cw-combo-include input').addEventListener('change', function(e) {
					row.classList.toggle('is-excluded', !e.target.checked);
					updateComboSummary();
				});
				comboTable.appendChild(row);
			});
			updateComboSummary();
		}
	}

	function bindCardFields(cardEl) {
		labelMiniFields(cardEl);
		var titleInputEl = cardEl.querySelector('.cw-title-input');
		var priceInputEl = cardEl.querySelector('.cw-price-input');
		var stockInputEl = cardEl.querySelector('.cw-stock-input');
		var backorderInputEl = cardEl.querySelector('.cw-backorder-input');
		var imageInputEl = cardEl.querySelector('.cw-image-input');
		var titleDisplayEl = cardEl.querySelector('.cw-product-title');
		var priceDisplayEl = cardEl.querySelector('.cw-product-price');
		var stockDisplayEl = cardEl.querySelector('.cw-product-stock');
		var thumbEl = cardEl.querySelector('.cw-product-thumb');
		var imgEl = cardEl.querySelector('.cw-product-thumb img');

		function syncAll() {
			titleDisplayEl.textContent = titleInputEl.value || I18N.placeholderUntitled;
			priceDisplayEl.textContent = priceInputEl.value ? ('NT$' + priceInputEl.value) : I18N.placeholderNoPrice;
			stockDisplayEl.textContent = I18N.stockCurrentLabel + ' ' + (stockInputEl.value || '0') + ' / ' + I18N.stockBackorderLabel + ' ' + (backorderInputEl.value || '0');
			var url = imageInputEl.value.trim();
			if (url.length) {
				imgEl.src = url;
				thumbEl.title = url;
			} else {
				imgEl.removeAttribute('src');
				thumbEl.title = I18N.uploadHint;
			}
			thumbEl.classList.toggle('has-image', url.length > 0);
			cardEl.classList.remove('cw-invalid');
		}
		imgEl.addEventListener('error', function() {
			thumbEl.classList.remove('has-image');
		});
		titleInputEl.addEventListener('input', syncAll);
		priceInputEl.addEventListener('input', syncAll);
		stockInputEl.addEventListener('input', syncAll);
		backorderInputEl.addEventListener('input', syncAll);
		imageInputEl.addEventListener('input', syncAll);
		cardEl.querySelector('.cw-thumb-edit-badge').addEventListener('click', function() {
			cardEl.classList.add('is-editing');
			imageInputEl.focus();
		});
		syncAll();
	}

	function updateEditToggleLabel($card) {
		var isEditing = $card.hasClass('is-editing');
		$card.find('.cw-edit-toggle-label').text(isEditing ? (I18N.actionCollapseEdit || '收合編輯') : (I18N.actionEditItem || '編輯內容'));
	}

	$productList.on('click', '.cw-edit-toggle', function(e) {
		e.stopPropagation();
		var $card = $(this).closest('.cw-product-card');
		$card.toggleClass('is-editing');
		updateEditToggleLabel($card);
	});

	$productList.on('click', '.cw-product-title, .cw-product-subline', function(e) {
		if ($(e.target).closest('button, input, a').length) return;
		var $card = $(this).closest('.cw-product-card');
		if ($card.hasClass('is-created')) return;
		$card.toggleClass('is-editing');
		updateEditToggleLabel($card);
	});

	$productList.on('click', '.cw-delete-toggle', function() {
		var $card = $(this).closest('.cw-product-card');
		$card.addClass('is-removing');
		setTimeout(function() {
			$card.remove();
			updateGlobalCount();
			resetCreateBtnState();
		}, 180);
	});

	function setDragDepth(zoneEl, delta) {
		var depth = (parseInt(zoneEl.dataset.dragDepth || '0', 10) || 0) + delta;
		if (depth < 0) depth = 0;
		zoneEl.dataset.dragDepth = depth;
		zoneEl.classList.toggle('is-dragover', depth > 0);
	}

	$productList.on('dragenter', UPLOAD_ZONES, function(e) {
		e.preventDefault();
		if (inputForZone(this)) setDragDepth(this, 1);
	});
	$productList.on('dragover', UPLOAD_ZONES, function(e) {
		e.preventDefault();
		if (inputForZone(this)) e.originalEvent.dataTransfer.dropEffect = 'copy';
	});
	$productList.on('dragleave', UPLOAD_ZONES, function() {
		setDragDepth(this, -1);
	});
	$productList.on('drop', UPLOAD_ZONES, function(e) {
		e.preventDefault();
		e.stopPropagation();
		this.dataset.dragDepth = 0;
		this.classList.remove('is-dragover');
		var inputEl = inputForZone(this);
		var files = e.originalEvent.dataTransfer && e.originalEvent.dataTransfer.files;
		if (inputEl && files && files.length) uploadIntoInput(files[0], inputEl, this);
	});

	$(document).off('dragover.cwUpload drop.cwUpload').on('dragover.cwUpload drop.cwUpload', function(e) {
		e.preventDefault();
	});

	var pendingZone = null;
	var $filePicker = $('<input type="file" accept="image/*" class="cw-file-picker">').appendTo($productList.parent());

	$productList.on('click', '.cw-product-thumb', function(e) {
		if ($(e.target).closest('.cw-thumb-edit-badge').length) return;
		if (!inputForZone(this)) return;
		pendingZone = this;
		$filePicker.val('').trigger('click');
	});
	$productList.on('click', '.cw-combo-upload-btn', function() {
		var inputEl = this.parentNode.querySelector('.cw-combo-image-input');
		if (!inputForZone(inputEl)) return;
		pendingZone = inputEl;
		$filePicker.val('').trigger('click');
	});
	$filePicker.on('change', function() {
		var file = this.files && this.files[0];
		var zoneEl = pendingZone;
		pendingZone = null;
		if (!file || !zoneEl) return;
		var inputEl = inputForZone(zoneEl);
		if (inputEl) uploadIntoInput(file, inputEl, zoneEl);
	});

	function bindDescrImageZone(cardEl, initialImages) {
		var zoneEl = cardEl.querySelector('.cw-descr-zone');
		if (!zoneEl) return;
		var wallEl = zoneEl.querySelector('.cw-descr-image-wall');
		var pasteEl = zoneEl.querySelector('.cw-paste-zone');
		var images = (initialImages || []).slice();

		function renderWall() {
			if (!wallEl) return;
			wallEl.innerHTML = '';
			images.forEach(function(src, idx) {
				var item = document.createElement('div');
				item.className = 'cw-descr-img-item';
				var safeSrc = String(src).replace(/"/g, '&quot;');
				item.innerHTML =
					'<input type="checkbox" class="cw-descr-check" checked value="' + safeSrc + '">' +
					'<img src="' + safeSrc + '" alt="" title="點擊檢視完整長圖預覽">' +
					'<button type="button" class="cw-descr-img-del" title="' + (I18N.actionDelete || '刪除') + '">' +
						'<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>' +
					'</button>';

				var imgEl = item.querySelector('img');
				var hoverPopover = document.getElementById('cwHoverPreview');
				var hoverImg = document.getElementById('cwHoverPreviewImg');
				var lightbox = document.getElementById('cwImageLightbox');
				var lightboxImg = document.getElementById('cwLightboxImg');

				imgEl.addEventListener('mouseenter', function() {
					if (!hoverPopover || !hoverImg) return;
					hoverImg.src = src;
					var rect = imgEl.getBoundingClientRect();
					var popWidth = 260;
					var popHeight = 380;
					var left = rect.right + 12;
					if (left + popWidth > window.innerWidth) {
						left = Math.max(10, rect.left - popWidth - 12);
					}
					var top = Math.max(10, Math.min(rect.top - 20, window.innerHeight - popHeight - 10));
					hoverPopover.style.left = left + 'px';
					hoverPopover.style.top = top + 'px';
					hoverPopover.classList.add('is-show');
				});

				imgEl.addEventListener('mouseleave', function() {
					if (hoverPopover) hoverPopover.classList.remove('is-show');
				});

				imgEl.addEventListener('click', function(e) {
					e.stopPropagation();
					if (hoverPopover) hoverPopover.classList.remove('is-show');
					if (lightbox && lightboxImg) {
						lightboxImg.src = src;
						lightbox.classList.add('is-active');
						lightbox.setAttribute('aria-hidden', 'false');
					}
				});

				item.querySelector('.cw-descr-img-del').addEventListener('click', function(e) {
					e.stopPropagation();
					if (hoverPopover) hoverPopover.classList.remove('is-show');
					images.splice(idx, 1);
					renderWall();
				});
				wallEl.appendChild(item);
			});
		}

		function addImagesFromHtml(htmlText) {
			if (!htmlText) return;
			var regex = /<img\b[^>]*?(?:data-src|data-original|src)\s*=\s*["']([^"']+)["'][^>]*>/gi;
			var match;
			var added = false;
			while ((match = regex.exec(htmlText)) !== null) {
				var url = match[1].trim();
				if (url && images.indexOf(url) < 0) {
					images.push(url);
					added = true;
				}
			}
			if (added) renderWall();
		}

		if (pasteEl) {
			pasteEl.addEventListener('paste', function(e) {
				e.preventDefault();
				var clipboardData = e.clipboardData || (e.originalEvent && e.originalEvent.clipboardData);
				if (!clipboardData) return;

				var htmlText = clipboardData.getData('text/html');
				if (htmlText) {
					addImagesFromHtml(htmlText);
					return;
				}

				var files = clipboardData.files;
				if (files && files.length) {
					Array.prototype.slice.call(files).forEach(function(file) {
						if (file.type && file.type.indexOf('image/') === 0) {
							uploadIntoInput(file, {
								set value(v) {
									if (v && images.indexOf(v) < 0) {
										images.push(v);
										renderWall();
									}
								},
								get value() { return ''; },
								dispatchEvent: function() {}
							}, pasteEl);
						}
					});
				}
			});
		}

		renderWall();
	}

	function getCheckedDescrImages(cardEl) {
		var urls = [];
		if (!cardEl) return urls;
		cardEl.querySelectorAll('.cw-descr-img-item input[type="checkbox"]:checked').forEach(function(cb) {
			if (cb.value) urls.push(cb.value);
		});
		return urls;
	}

	function addProductCard(data) {
		resetCreateBtnState();
		data = data || {};
		var node = tpl.content.cloneNode(true);
		var cardEl = node.querySelector('.cw-product-card');
		cardEl.dataset.uid = data.uid || '';
		cardEl.dataset.upc = data.upc || '';
		cardEl.querySelector('.cw-product-meta').textContent = data.meta || '';
		cardEl.querySelector('.cw-title-input').value = data.title || '';
		cardEl.querySelector('.cw-price-input').value = data.price || '';
		cardEl.querySelector('.cw-stock-input').value = data.stock || '0';
		cardEl.querySelector('.cw-backorder-input').value = data.backOrderStock || '0';
		cardEl.querySelector('.cw-image-input').value = data.image || '';
		productList0().appendChild(node);
		bindCardFields(cardEl);
		bindDescrImageZone(cardEl, data.descrImages);
		initSpecEditor(cardEl, { detected: !!data.detected });
		updateGlobalCount();
		return cardEl;
	}

	$addProductBtn.on('click', function() {
		if (!ensureItemSet()) return;
		$addOptions.slideToggle(180, function() {
			if ($addOptions.is(':visible')) {
				$step2UrlInput.trigger('focus');
			}
		});
	});
	$step2OptionsClose.on('click', function() {
		$addOptions.slideUp(180);
		$step2Error.hide();
	});
	$step2ManualBtn.on('click', function() {
		$addOptions.slideUp(180);
		$step2Error.hide();
		var cardEl = addProductCard({ meta: I18N.metaManual });
		cardEl.classList.add('is-editing');
		cardEl.querySelector('.cw-title-input').focus();
	});

	function parseAndAddStep2Url() {
		if (!ensureItemSet()) return;
		var url = $.trim($step2UrlInput.val());
		if (!url) {
			$step2Error.text(I18N.errorEmptyUrl || '請輸入商品網址').show();
			return;
		}
		$step2Error.hide();
		btnStartLoading($step2UrlBtn);
		$.ajax({
			type: 'POST',
			url: config.uploadFromUrlEndpoint,
			data: { url: url, groupBuyId: groupBuyId, itemSetId: itemSetId },
			dataType: 'json',
			success: function(product) {
				btnStopLoading($step2UrlBtn);
				$step2UrlInput.val('');
				$addOptions.slideUp(180);
				var cardEl = addProductCard({
					title: product.title || '',
					price: product.price ? String(product.price).replace(/[^0-9.]/g, '') : '',
					image: product.image || '',
					uid: product.uid || '',
					upc: product.upc || '',
					meta: extractHostname(url) + ' ' + I18N.metaParsedSuffix,
					descrImages: product.descrImages || [],
					detected: true
				});
				cardEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
			},
			error: function(xhr) {
				btnStopLoading($step2UrlBtn);
				var msg = (xhr.responseJSON && xhr.responseJSON.error) ? xhr.responseJSON.error : I18N.errorUploadFailed;
				$step2Error.text(msg).show();
			}
		});
	}

	$step2UrlBtn.on('click', parseAndAddStep2Url);
	$step2UrlInput.on('keydown', function(e) {
		if (e.key === 'Enter') {
			e.preventDefault();
			parseAndAddStep2Url();
		}
	});

	$('#createWizardChoiceUrl').on('click', function() {
		if (!ensureItemSet()) return;
		$step0.hide();
		$stepsBar.show();
		$step1.show();
		$modalTitle.text(I18N.titleUrlMode);
		$urlInput.trigger('focus');
	});
	$('#createWizardChoiceManual').on('click', function() {
		if (!ensureItemSet()) return;
		$step0.hide();
		$resultLabel.text(I18N.resultManualLabel);
		$step2.show();
		$step2ManualBtn.trigger('click');
	});
	$('#createWizardBackBtn').on('click', function() {
		$step1.hide();
		$stepsBar.hide();
		$modalTitle.text(I18N.titleGeneric);
		$step0.show();
	});

	function extractHostname(url) {
		try {
			return new URL(url).hostname;
		} catch (e) {
			return url;
		}
	}

	function btnStartLoading($btn) {
		$btn.prop('disabled', true).addClass('is-loading');
	}

	function btnStopLoading($btn) {
		$btn.prop('disabled', false).removeClass('is-loading');
	}

	$uploadBtn.on('click', function() {
		if (!ensureItemSet()) return;
		var url = $.trim($urlInput.val());
		if (!url) {
			$error.empty().append($('<div class="cw-error"></div>').text(I18N.errorEmptyUrl || '請輸入商品網址'));
			return;
		}

		btnStartLoading($uploadBtn);
		$skeleton.show();
		$error.empty();

		var uploadFromUrlEndpoint = config.uploadFromUrlEndpoint;

		$.ajax({
			type: 'POST',
			url: uploadFromUrlEndpoint,
			data: { url: url, groupBuyId: groupBuyId, itemSetId: itemSetId },
			dataType: 'json',
			success: function(product) {
				btnStopLoading($uploadBtn);
				$skeleton.hide();

				$stepIndicators.eq(0).removeClass('is-active').addClass('is-done');
				$stepIndicators.eq(1).addClass('is-active');
				$stepLine.addClass('is-filled');
				$step1.hide();
				$step2.show();

				addProductCard({
					title: product.title || '',
					price: product.price ? String(product.price).replace(/[^0-9.]/g, '') : '',
					image: product.image || '',
					uid: product.uid || '',
					upc: product.upc || '',
					meta: extractHostname(url) + ' ' + I18N.metaParsedSuffix,
					descrImages: product.descrImages || [],
					detected: true
				});
			},
			error: function(xhr) {
				btnStopLoading($uploadBtn);
				$skeleton.hide();
				var msg = (xhr.responseJSON && xhr.responseJSON.error) ? xhr.responseJSON.error : I18N.errorUploadFailed;
				$error.empty().append($('<div class="cw-error"></div>').text(msg));
			}
		});
	});

	var itemEditor = null;
	function getItemEditor() {
		if (itemEditor) return itemEditor;
		var saveEndpoint = config.saveEndpoint;
		itemEditor = new $.fn.dataTable.Editor({
			ajax: {
				create: {
					type: 'POST',
					url: saveEndpoint,
					data: function(d) { d.groupBuyId = groupBuyId; return d; }
				}
			},
			idSrc: 'itemId',
			fields: [
				{ name: 'itemSetId' },
				{ name: 'title' },
				{ name: 'shortName' },
				{ name: 'shortNameDisplay' },
				{ name: 'price' },
				{ name: 'stock' },
				{ name: 'stockAvailable' },
				{ name: 'stockBackOrder' },
				{ name: 'stockBackOrderAvailable' },
				{ name: 'maxOrderQuota' },
				{ name: 'uid' },
				{ name: 'upc' },
				{ name: 'image' },
				{ name: 'tag' },
				{ name: 'productDescrImg[]' }
			]
		});
		return itemEditor;
	}

	function createOneItem(payload, callback) {
		var editor = getItemEditor();
		editor.create(false);
		editor.set(payload);
		var result = { err: true };
		editor.one('submitComplete', function() {
			callback(result.err, result.json);
		});
		editor.submit(
			function(json) { result = { err: null, json: json }; },
			function(xhr) { result = { err: xhr || true }; }
		);
	}

	function isValidPrice(v) {
		return /^\d+(\.\d+)?$/.test($.trim(v || ''));
	}

	function finalizePayload(payload) {
		payload.stockAvailable = payload.stock;
		payload.stockBackOrderAvailable = payload.stockBackOrder;
		payload.maxOrderQuota = 10; // String(Math.min(10, parseInt(payload.stock, 10) || 0));
		payload.shortName = payload.title;
		payload.shortNameDisplay = payload.title;
		return payload;
	}

	function collectUnits() {
		var units = [];
		var invalid = [];
		Array.prototype.slice.call(productList0().querySelectorAll('.cw-product-card')).forEach(function(card) {
			if (card.classList.contains('is-created')) return;
			var descrImgs = getCheckedDescrImages(card);
			var rows = Array.prototype.slice.call(card.querySelectorAll('.cw-combo-row:not(.is-excluded)'));
			if (rows.length) {
				rows.forEach(function(row) {
					if (row.classList.contains('is-created')) return;
					var payload = finalizePayload({
						itemSetId: itemSetId,
						title: row.dataset.comboName,
						price: row.querySelector('.cw-combo-price-input').value,
						stock: row.querySelector('.cw-combo-stock-input').value || '0',
						stockBackOrder: row.querySelector('.cw-combo-backorder-input').value || '0',
						uid: card.dataset.uid || '',
						upc: card.dataset.upc || '',
						image: row.querySelector('.cw-combo-image-input').value,
						tag: row.dataset.comboTag || ''
					});
					payload['productDescrImg[]'] = descrImgs;
					if (!isValidPrice(payload.price)) {
						invalid.push(row);
					} else {
						units.push({ card: card, row: row, payload: payload });
					}
				});
			} else {
				var payload = finalizePayload({
					itemSetId: itemSetId,
					title: card.querySelector('.cw-title-input').value,
					price: card.querySelector('.cw-price-input').value,
					stock: card.querySelector('.cw-stock-input').value || '0',
					stockBackOrder: card.querySelector('.cw-backorder-input').value || '0',
					uid: card.dataset.uid || '',
					upc: card.dataset.upc || '',
					image: card.querySelector('.cw-image-input').value,
					tag: buildTag(card.querySelector('.cw-title-input').value, [], [])
				});
				payload['productDescrImg[]'] = descrImgs;
				if (!$.trim(payload.title).length || !isValidPrice(payload.price)) {
					invalid.push(card);
				} else {
					units.push({ card: card, row: null, payload: payload });
				}
			}
		});
		return { units: units, invalid: invalid };
	}

	function notifyHost() {
		$(document).trigger('item:batchCreated', { itemSetId: itemSetId });
	}

	var PILL = {
		done: { text: I18N.statusDone, cls: 'cw-status-pill done' },
		failed: { text: I18N.statusFailed, cls: 'cw-status-pill failed' }
	};

	function renderUnit(unit) {
		var target = unit.row || unit.card;
		target.classList.toggle('is-created', unit.state === 'done');
		target.classList.toggle('is-failed', unit.state === 'failed');
		if (!unit.row) renderPill(unit.card, unit.state);
		if (unit.state === 'done') closeCardIfComplete(unit.card);
	}

	function renderPill(card, state) {
		var pill = card.querySelector('.cw-status-pill');
		if (!pill || !PILL[state]) return;
		pill.textContent = PILL[state].text;
		pill.className = PILL[state].cls;
	}

	function closeCardIfComplete(card) {
		if (card.querySelectorAll('.cw-combo-row:not(.is-excluded):not(.is-created)').length) return;
		card.classList.add('is-created');
		card.classList.remove('is-editing');
	}

	function renderProgress(done, total) {
		$progressFill.css('width', (done / total * 100) + '%');
		$progressNum.text(done + ' / ' + total);
	}

	function resetCreateBtnState() {
		$createBtn.data('isFinished', false);
		$createBtn.removeClass('btn-success').addClass('btn-warning');
		$createBtn.find('.cw-btn-label').text(I18N.actionCreateItems || '建立商品');
	}

	function renderCreateBtn(phase, total, failed) {
		$createBtn.prop('disabled', phase === 'running');
		if (phase === 'finished') {
			$createBtn.data('isFinished', true);
			$createBtn.removeClass('btn-warning').addClass('btn-success');
			var labelText = failed
				? fmt(I18N.actionPartialDoneSummary, [total - failed, total, failed])
				: ((I18N.statusDone || '已完成') + ' ' + total + ' / ' + total);
			$createBtn.find('.cw-btn-label').text(labelText);
		} else {
			$createBtn.data('isFinished', false);
			if (phase !== 'running') {
				$createBtn.removeClass('btn-success').addClass('btn-warning');
				$createBtn.find('.cw-btn-label').text(I18N.actionCreateItems || '建立商品');
			}
		}
	}

	$createBtn.on('click', function() {
		if ($createBtn.data('isFinished')) {
			$('#myModal').modal('hide');
			return;
		}
		if ($createBtn.prop('disabled')) return;
		if (!ensureItemSet()) return;

		var collected = collectUnits();
		if (collected.invalid.length) {
			collected.invalid.forEach(function(el) {
				el.classList.add('cw-invalid');
				if (el.classList.contains('cw-product-card')) {
					el.classList.add('is-editing');
				} else {
					el.closest('.cw-product-card').classList.add('spec-open');
				}
			});
			collected.invalid[0].scrollIntoView({ block: 'center' });
			return;
		}

		var units = collected.units;
		if (!units.length) return;

		renderCreateBtn('running');
		var total = units.length;
		var done = 0;
		var failed = 0;

		function next(i) {
			if (i >= total) {
				renderCreateBtn('finished', total, failed);
				if (failed < total) {
					notifyHost();
				}
				return;
			}
			var unit = units[i];
			createOneItem(unit.payload, function(err) {
				unit.state = err ? 'failed' : 'done';
				if (err) failed++;
				renderUnit(unit);
				done++;
				renderProgress(done, total);
				next(i + 1);
			});
		}
		next(0);
	});
});
