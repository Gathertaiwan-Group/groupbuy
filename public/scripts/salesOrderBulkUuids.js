/**
 * SalesOrderBulkUuids Module
 * 專門處理批量訂單號碼查詢的前端 DOM 生成、驗證與彈窗互動的模組化元件
 * 
 * 支援以下調用方式：
 * 1. SalesOrderBulkUuids.init('#bulkUuidsContainer', { maxLimit: 100 });
 * 2. $('#bulkUuidsContainer').salesOrderBulkUuids({ maxLimit: 100 });
 * 3. const bulk = new SalesOrderBulkUuids('#bulkUuidsContainer', options);
 */
(function (root, factory) {
	if (typeof define === 'function' && define.amd) {
		define(['jquery'], factory);
	} else if (typeof module === 'object' && module.exports) {
		module.exports = factory(require('jquery'));
	} else {
		root.SalesOrderBulkUuids = factory(root.jQuery);
	}
}(typeof self !== 'undefined' ? self : this, function ($) {
	'use strict';

	class SalesOrderBulkUuids {
		/**
		 * @param {string|HTMLElement|jQuery} container - 目標掛載容器
		 * @param {Object} [options] - 配置選項
		 */
		constructor(container, options = {}) {
			this.$container = $(container);
			if (!this.$container.length) {
				console.warn('[SalesOrderBulkUuids] 找不到目標容器：', container);
				return;
			}

			// 合併預設參數
			this.options = Object.assign({
				maxLimit: 100,
				label: '批量訂單號',
				placeholder: '點擊輸入多筆訂單號碼',
				inputName: 'uuids',
				modalId: 'bulkUuidsModal',
				onApply: function (list, value) {
					if (typeof table !== 'undefined' && table && table.ajax) {
						table.ajax.reload(null, false);
					}
				}
			}, options);

			this.list = [];
			this.modalId = this.options.modalId;

			this.init();
		}

		/** 初始化元件與 DOM 生成 */
		init() {
			this.renderControl();
			this.renderModal();
			this.bindEvents();

			// 綁定於 DOM data 便於後續存取
			this.$container.data('salesOrderBulkUuids', this);
			SalesOrderBulkUuids.instances.push(this);
		}

		/** 渲染控制欄到容器中 */
		renderControl() {
			var limit = this.options.maxLimit;
			var html = `
				<div class="input-group py-2">
					<div class="input-group-prepend">
						<span class="input-group-text md-addon">${this.options.label}</span>
					</div>
					<input type="text" id="bulkUuidsSummary" class="form-control bg-white js-bulk-summary" placeholder="${this.options.placeholder} (上限 ${limit} 筆)" readonly style="cursor: pointer;">
					<input type="hidden" name="${this.options.inputName}" id="bulkUuids" class="js-bulk-hidden-val" value="">
					<div class="input-group-append">
						<button type="button" class="btn btn-outline-primary m-0 px-3 py-2 z-depth-0 waves-effect js-btn-open-modal" id="btnOpenBulkUuidsModal" data-toggle="modal" data-target="#${this.modalId}">
							<i class="fa fa-list-ol mr-1"></i>輸入號碼 <span class="badge badge-primary ml-1 js-bulk-badge" id="bulkUuidsBadge" style="display:none;">0</span>
						</button>
						<button type="button" class="btn btn-outline-danger m-0 px-2 py-2 z-depth-0 waves-effect js-btn-clear" id="btnClearBulkUuids" title="清除所有訂單號" style="display:none;">
							<i class="fa fa-times"></i>
						</button>
					</div>
				</div>
			`;
			this.$container.html(html);

			// 快取控制項元素
			this.$summary = this.$container.find('.js-bulk-summary');
			this.$hiddenInput = this.$container.find('.js-bulk-hidden-val');
			this.$badge = this.$container.find('.js-bulk-badge');
			this.$btnClear = this.$container.find('.js-btn-clear');
			this.$btnOpen = this.$container.find('.js-btn-open-modal');
		}

		/** 渲染並掛載 Modal 到 body */
		renderModal() {
			this.$modal = $(`#${this.modalId}`);
			if (this.$modal.length) return; // 避免重複生成

			var limit = this.options.maxLimit;
			var modalHtml = `
				<div class="modal fade" id="${this.modalId}" tabindex="-1" role="dialog" aria-labelledby="${this.modalId}Label" aria-hidden="true">
					<div class="modal-dialog modal-dialog-centered modal-lg" role="document">
						<div class="modal-content shadow-lg border-0">
							<div class="modal-header bg-primary text-white py-3">
								<h5 class="modal-title font-weight-bold" id="${this.modalId}Label">
									<i class="fa fa-list-alt mr-2"></i>批量訂單號碼查詢
								</h5>
								<button type="button" class="close text-white" data-dismiss="modal" aria-label="Close" style="opacity:0.9;">
									<span aria-hidden="true">&times;</span>
								</button>
							</div>
							<div class="modal-body p-4">
								<div class="alert alert-info py-2 px-3 mb-3 d-flex align-items-center justify-content-between">
									<div>
										<i class="fa fa-info-circle mr-1"></i>
										請輸入訂單號碼，<strong>每行一筆</strong>（上限 <strong class="js-bulk-limit-val">${limit}</strong> 筆）。支援直接貼上 Excel 或多行文本。
									</div>
									<div class="badge badge-pill badge-light px-2 py-1 font-weight-bold" style="font-size: 0.85rem;">
										上限 <span class="js-bulk-limit-val">${limit}</span> 筆
									</div>
								</div>
								
								<div class="form-group mb-2">
									<div class="d-flex justify-content-between align-items-center mb-1">
										<label for="${this.modalId}Textarea" class="font-weight-bold mb-0 text-secondary">
											訂單號碼清單（每行一筆）：
										</label>
										<div class="btn-group btn-group-sm">
											<button type="button" class="btn btn-sm btn-outline-secondary py-1 px-2 z-depth-0 waves-effect js-btn-deduplicate" title="過濾重複的訂單號">
												<i class="fa fa-filter mr-1"></i>自動去重
											</button>
											<button type="button" class="btn btn-sm btn-outline-secondary py-1 px-2 z-depth-0 waves-effect js-btn-clean" title="移除前後空白與空行">
												<i class="fa fa-eraser mr-1"></i>整理/清空行
											</button>
											<button type="button" class="btn btn-sm btn-outline-warning py-1 px-2 z-depth-0 waves-effect js-btn-cut" style="display:none;" title="僅保留前上限筆數">
												<i class="fa fa-cut mr-1"></i>截取前 <span class="js-bulk-limit-val">${limit}</span> 筆
											</button>
										</div>
									</div>
									<textarea id="${this.modalId}Textarea" class="form-control js-bulk-textarea" rows="10" placeholder="請在此輸入或貼上訂單號碼，每行一筆&#10;例如：&#10;24091800000001&#10;24091800000002&#10;24091800000003" style="font-family: SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace; font-size: 13px; line-height: 1.5; resize: vertical;"></textarea>
								</div>

								<div class="d-flex justify-content-between align-items-center mt-2">
									<div>
										<span class="text-muted">有效筆數：</span>
										<span class="font-weight-bold text-primary js-bulk-count" style="font-size: 1.1rem;">0</span>
										<span class="text-muted">/ <span class="js-bulk-limit-val">${limit}</span> 筆</span>
										<span class="text-danger ml-2 font-weight-bold js-bulk-limit-alert" style="display:none;">
											<i class="fa fa-exclamation-triangle mr-1"></i>已超過 <span class="js-bulk-limit-val">${limit}</span> 筆上限，請刪減後套用
										</span>
									</div>
									<div>
										<button type="button" class="btn btn-sm btn-link text-danger p-0 js-btn-reset">
											<i class="fa fa-trash mr-1"></i>清空輸入
										</button>
									</div>
								</div>
							</div>
							<div class="modal-footer bg-light py-2 px-4">
								<button type="button" class="btn btn-secondary waves-effect" data-dismiss="modal">取消</button>
								<button type="button" class="btn btn-primary waves-effect js-btn-apply">
									<i class="fa fa-check mr-1"></i>確認套用
								</button>
							</div>
						</div>
					</div>
				</div>
			`;
			$('body').append(modalHtml);
			this.$modal = $(`#${this.modalId}`);
		}

		/** 綁定互動事件 */
		bindEvents() {
			var self = this;
			var $modal = this.$modal;
			var $textarea = $modal.find('.js-bulk-textarea');
			var $btnCut = $modal.find('.js-btn-cut');
			var $btnApply = $modal.find('.js-btn-apply');

			// 開啟 Modal
			this.$summary.on('click', () => $modal.modal('show'));
			this.$btnOpen.on('click', () => $modal.modal('show'));

			// Modal 顯示時聚焦並同步數值
			$modal.on('shown.bs.modal', function () {
				$textarea.val(self.getValue());
				self.updateModalState();
				$textarea.focus();
			});

			// 即時文字輸入統計
			$textarea.on('input propertychange', () => this.updateModalState());

			// 自動去重
			$modal.find('.js-btn-deduplicate').on('click', function () {
				var list = self.parseText($textarea.val());
				var unique = [];
				var seen = {};
				for (var i = 0; i < list.length; i++) {
					if (!seen[list[i]]) {
						seen[list[i]] = true;
						unique.push(list[i]);
					}
				}
				$textarea.val(unique.join('\n'));
				self.updateModalState();
			});

			// 整理/清除空行
			$modal.find('.js-btn-clean').on('click', function () {
				var list = self.parseText($textarea.val());
				$textarea.val(list.join('\n'));
				self.updateModalState();
			});

			// 截取前 N 筆
			$btnCut.on('click', function () {
				var list = self.parseText($textarea.val());
				$textarea.val(list.slice(0, self.options.maxLimit).join('\n'));
				self.updateModalState();
			});

			// 清空輸入
			$modal.find('.js-btn-reset').on('click', function () {
				$textarea.val('');
				self.updateModalState();
			});

			// 確認套用
			$btnApply.on('click', function () {
				var list = self.parseText($textarea.val());
				if (list.length > self.options.maxLimit) {
					alert('訂單號碼最多只能輸入 ' + self.options.maxLimit + ' 筆，目前共 ' + list.length + ' 筆，請刪減後再套用。');
					return;
				}
				self.setValue(list);
				$modal.modal('hide');
			});

			// 快速清除按鈕
			this.$btnClear.on('click', function (e) {
				e.stopPropagation();
				self.clear();
			});
		}

		/** 更新 Modal 內部計數器與警示狀態 */
		updateModalState() {
			var text = this.$modal.find('.js-bulk-textarea').val();
			var list = this.parseText(text);
			var count = list.length;
			var limit = this.options.maxLimit;
			var $count = this.$modal.find('.js-bulk-count');
			var $alert = this.$modal.find('.js-bulk-limit-alert');
			var $btnCut = this.$modal.find('.js-btn-cut');
			var $btnApply = this.$modal.find('.js-btn-apply');

			$count.text(count);

			if (count > limit) {
				$count.removeClass('text-primary').addClass('text-danger');
				$alert.show();
				$btnCut.show();
				$btnApply.prop('disabled', true).addClass('disabled');
			} else {
				$count.removeClass('text-danger').addClass('text-primary');
				$alert.hide();
				$btnCut.hide();
				$btnApply.prop('disabled', false).removeClass('disabled');
			}
		}

		/** 解析多行訂單號文字為陣列 */
		parseText(text) {
			if (!text) return [];
			var raw = text.split(/\r\n|\r|\n/);
			var list = [];
			for (var i = 0; i < raw.length; i++) {
				var line = $.trim(raw[i]);
				if (line.length > 0) {
					list.push(line);
				}
			}
			return list;
		}

		/** 設定數值並觸發同步與回呼 */
		setValue(valOrList) {
			var list = Array.isArray(valOrList) ? valOrList : this.parseText(valOrList);
			this.list = list;
			var count = list.length;
			var newlineStr = list.join('\n');

			this.$hiddenInput.val(newlineStr);

			if (count === 0) {
				this.$summary.val('');
				this.$badge.text('0').hide();
				this.$btnClear.hide();
				this.$summary.attr('placeholder', this.options.placeholder + ' (上限 ' + this.options.maxLimit + ' 筆)');
			} else {
				var preview = list.slice(0, 2).join(', ');
				if (count > 2) {
					preview += '...等 ' + count + ' 筆';
				} else {
					preview += ' (共 ' + count + ' 筆)';
				}
				this.$summary.val(preview);
				this.$badge.text(count + ' 筆').show();
				this.$btnClear.show();
			}

			if (typeof this.options.onApply === 'function') {
				this.options.onApply(list, newlineStr);
			}
			return this;
		}

		/** 取得訂單號碼字串 (換行分隔) */
		getValue() {
			return this.$hiddenInput ? this.$hiddenInput.val() : '';
		}

		/** 取得訂單號碼陣列 */
		getList() {
			return this.list ? this.list.slice() : [];
		}

		/** 清空資料 */
		clear() {
			this.setValue([]);
			return this;
		}

		/** 靜態初始化接口 */
		static init(container, options) {
			return new SalesOrderBulkUuids(container, options);
		}

		/** 取得特定容器綁定的實例 */
		static getInstance(container) {
			if (container) {
				return $(container).data('salesOrderBulkUuids') || null;
			}
			return SalesOrderBulkUuids.instances[0] || null;
		}
	}

	SalesOrderBulkUuids.instances = [];

	// jQuery Plugin 支援
	$.fn.salesOrderBulkUuids = function (options) {
		return this.each(function () {
			if (!$(this).data('salesOrderBulkUuids')) {
				new SalesOrderBulkUuids(this, options);
			}
		});
	};

	return SalesOrderBulkUuids;
}));
