/* 原站公開靜態檔 /scripts/itemCopy.js?v=20250630，以 HTTP 直接下載（2026-10-23）原樣沿用 */
/**
 * 團購商品複製模組
 * GroupBuyCopyModule.js
 */
class GroupBuyCopyModule {
    constructor(options = {}) {
        this.tableName = options.tableName || '#dataTable';
        this.selectedTargets = [];
        this.selectedItems = [];
        this.initialized = false;
        
        // 綁定方法到實例
        this.removeTarget = this.removeTarget.bind(this);
        this.resetForm = this.resetForm.bind(this);
        this.submitCopy = this.submitCopy.bind(this);
        this.refreshSelectedItems = this.refreshSelectedItems.bind(this);
    }

    /**
     * 初始化模組
     */
    init() {
        if (this.initialized) {
            console.warn('GroupBuyCopyModule already initialized');
            return;
        }

        $(document).ready(() => {
            this.initializeSelects();
            this.loadSelectedItems();
            this.updateSelectedTargetsDisplay();
            this.bindEvents();
            this.initialized = true;
            
            // 將方法暴露到全局，以便HTML中的onclick可以使用
            window.removeTarget = this.removeTarget;
            window.resetForm = this.resetForm;
            window.submitCopy = this.submitCopy;
            window.refreshSelectedItems = this.refreshSelectedItems;
        });
    }

    /**
     * 初始化選擇器
     */
    initializeSelects() {
        // 初始化團購選擇器
        $('#groupBuySelect').select2({
            placeholder: '請輸入團購名稱搜尋...',
            allowClear: true,
            ajax: {
                url: function(params) {
                    return GBF.baseUrl+'/ajax/Lookup/groupBuy?restricted=true&months=1&q=' + encodeURIComponent(params.term || '');
                },
                dataType: 'json',
                delay: 250,
                processResults: function(data) {
                    return {
                        results: data.results,
                        pagination: data.pagination
                    };
                },
                cache: true
            }
        });
    }

    /**
     * 綁定事件
     */
    bindEvents() {
        // 團購選擇變更事件
        $('#groupBuySelect').on('change', () => {
            const groupBuyId = $('#groupBuySelect').val();
            const isToSameName = $('#toSameName').is(':checked');
            
            if (groupBuyId && !isToSameName) {
                // 選擇了團購且未勾選"複製到相同品相名稱"時，初始化品項組選擇器
                this.initializeItemSetSelect(groupBuyId)
                $('#itemSetSection').show();
            } else {
                // 未選擇團購或勾選了"複製到相同品相名稱"時，銷毀並隱藏品項組選擇
				this.destroyItemSetSelect();
                $('#itemSetSection').hide();
            }
        });

        // 目的地品項選項變更事件 (改為複製到相同品相名稱)
        $('#toSameName').on('change', () => {
            const groupBuyId = $('#groupBuySelect').val();
            if (!$('#toSameName').is(':checked') && groupBuyId) {
                // 未勾選時，需要初始化品項組選擇器
                this.initializeItemSetSelect(groupBuyId);
                $('#itemSetSection').show();
            } else {
                // 勾選時，銷毀並隱藏品項組選擇
				this.destroyItemSetSelect();
                $('#itemSetSection').hide();
            }
        });

        // 新增目標按鈕事件
        $('#addTarget').on('click', () => {
            this.addTarget();
        });
    }

    /**
     * 載入選中的商品（從DataTable）
     */
    loadSelectedItems() {
        try {
            if ($(this.tableName).length > 0 && $.fn.DataTable.isDataTable(this.tableName)) {
                const dt = $(this.tableName).DataTable();
                this.selectedItems = [];
                let title = '';
                
                dt.rows({selected: true}).data().each((obj, index) => {
                    this.selectedItems.push({
                        itemId: obj.itemId || obj.id,
                        seq: obj.seq,
                        title: obj.title
                    });
                    
                    const t = obj.seq + '.' + obj.title;
                    if (index == 0) {
                        title += t;
                    } else {
                        title += '<br>' + t;
                    }
                });
                
                if (this.selectedItems.length > 0) {
                    $('#selectedItems').html(title);
                } else {
                    $('#selectedItems').html('<div class="text-muted">尚未選中任何商品</div>');
                }
            } else {
                // 如果DataTable不存在，顯示提示信息
                $('#selectedItems').html('<div class="text-warning">DataTable未初始化或不存在</div>');
                console.warn('DataTable not found:', this.tableName);
            }
        } catch (error) {
            console.error('Error loading selected items:', error);
            $('#selectedItems').html('<div class="text-danger">載入商品時發生錯誤</div>');
        }
    }

    /**
     * 載入品項組
	 * 初始化品項組選擇器（使用 select2 動態搜尋）
     */
	initializeItemSetSelect(groupBuyId) {
	    // 如果已經初始化過，先銷毀
	    if ($('#itemSetSelect').hasClass('select2-hidden-accessible')) {
	        $('#itemSetSelect').select2('destroy');
	    }
        $('#itemSetSelect').empty().append('<option value="">載入中...</option>');
		// 清空選項
		$('#itemSetSelect').empty();

		// 初始化 select2 with ajax
		$('#itemSetSelect').select2({
		    placeholder: '請輸入品項組名稱搜尋...',
		    allowClear: true,
		    ajax: {
		        url: function(params) {
		            return `${GBF.baseUrl}/ajax/Lookup/groupBuyItemSet?groupBuyId=${groupBuyId}&q=${encodeURIComponent(params.term || '')}`;
		        },
		        dataType: 'json',
		        delay: 250,
		        processResults: function(data) {
		            return {
		                results: data.results || [],
		                pagination: data.pagination || {}
		            };
		        },
		        cache: true
		     },
		    minimumInputLength: 0
		});
    }
	
	/**
	 * 銷毀品項組選擇器
	 */
	destroyItemSetSelect() {
	    if ($('#itemSetSelect').hasClass('select2-hidden-accessible')) {
	        $('#itemSetSelect').select2('destroy');
	    }
	    $('#itemSetSelect').empty();
	}

    /**
     * 新增目標
     */
    addTarget() {
        const groupBuyId = $('#groupBuySelect').val();
        const groupBuyText = $('#groupBuySelect option:selected').text();
        const itemSetId = $('#itemSetSelect').val();
        const itemSetText = $('#itemSetSelect option:selected').text();
        const isToSameName = $('#toSameName').is(':checked');
        
        if (!groupBuyId) {
            alert('請選擇團購');
            return;
        }
        
        // 如果未勾選"複製到相同品相名稱"，則必須選擇品項組
        if (!isToSameName && !itemSetId) {
            alert('請選擇品項組');
            return;
        }
        
        // 檢查是否已經存在相同的目標
        const targetKey = groupBuyId + (!isToSameName ? '_' + itemSetId : '_sameName');
        if (this.selectedTargets.some(target => target.key === targetKey)) {
            alert('此目標已經存在');
            return;
        }
        
        const target = {
            key: targetKey,
            groupBuyId: groupBuyId,
            groupBuyText: groupBuyText,
            itemSetId: !isToSameName ? itemSetId : null,
            itemSetText: !isToSameName ? itemSetText : null,
            toSameName: isToSameName
        };
        
        this.selectedTargets.push(target);
        this.updateSelectedTargetsDisplay();
        
        // 清空選擇
        $('#groupBuySelect').val(null).trigger('change');
        this.destroyItemSetSelect();
        $('#itemSetSection').hide();
    }

    /**
     * 更新已選擇目標的顯示
     */
    updateSelectedTargetsDisplay() {
        const container = $('#selectedTargets');
        
        if (this.selectedTargets.length === 0) {
            container.html('<div class="text-muted">尚未選擇任何目標</div>');
            return;
        }
        
        let html = '';
        this.selectedTargets.forEach((target, index) => {
            html += `
                <div class="selected-target" data-index="${index}">
                    <button type="button" class="remove-btn" onclick="removeTarget(${index})">&times;</button>
                    <div><strong>團購：</strong>${target.groupBuyText}</div>
                    ${target.toSameName ? 
                        '<div><strong>複製方式：</strong>複製到相同品相名稱</div>' : 
                        `<div><strong>品項組：</strong>${target.itemSetText}</div>`
                    }
                </div>
            `;
        });
        
        container.html(html);
    }

    /**
     * 移除目標
     */
    removeTarget(index) {
        this.selectedTargets.splice(index, 1);
        this.updateSelectedTargetsDisplay();
    }

    /**
     * 重置表單
     */
    resetForm() {
        this.selectedTargets = [];
        $('#shareStock').prop('checked', false);
        $('#toSameName').prop('checked', false);
        $('#groupBuySelect').val(null).trigger('change');
        this.destroyItemSetSelect();
        $('#itemSetSection').hide();
        this.updateSelectedTargetsDisplay();
    }

    /**
     * 執行複製
     */
    submitCopy() {
        if (this.selectedItems.length === 0) {
            alert('沒有選中的商品');
            return;
        }
        
        if (this.selectedTargets.length === 0) {
            alert('請選擇至少一個目標');
            return;
        }
        
        const copyData = {
            items: this.selectedItems.map(item => ({ itemId: item.itemId })),
            targets: this.selectedTargets,
            options: {
                shareStock: $('#shareStock').is(':checked'),
                toSameName: $('#toSameName').is(':checked')
            }
        };
        
        // 顯示載入狀態
        const submitButton = $('#submitButton');
        const originalText = submitButton.text();
        submitButton.prop('disabled', true).text('複製中...');
        
        $.ajax({
            url: `${GBF.baseUrl}/ajax/Item/copyToGroupBuy`,
            type: 'POST',
            data: JSON.stringify(copyData),
            contentType: 'application/json',
            dataType: 'json',
            success: (response) => {
                alert('複製成功！');
                this.resetForm();
                this.refreshSelectedItems();
                console.log('Copy success:', response);
            },
            error: (xhr, status, error) => {
                console.error('Copy failed:', error);
                let errorMessage = '複製失敗！';
                
                if (xhr.responseJSON && xhr.responseJSON.message) {
                    errorMessage += '\n錯誤訊息：' + xhr.responseJSON.message;
                } else if (xhr.responseText) {
                    errorMessage += '\n錯誤訊息：' + xhr.responseText;
                }
                
                alert(errorMessage);
            },
            complete: () => {
                // 恢復按鈕狀態
                submitButton.prop('disabled', false).text(originalText);
            }
        });
    }

    /**
     * 刷新選中商品（可由外部調用）
     */
    refreshSelectedItems() {
        this.loadSelectedItems();
    }

    /**
     * 設置新的表格名稱
     */
    setTableName(tableName) {
        this.tableName = tableName;
        this.refreshSelectedItems();
    }

    /**
     * 獲取當前選中的商品
     */
    getSelectedItems() {
        return this.selectedItems;
    }

    /**
     * 獲取當前選中的目標
     */
    getSelectedTargets() {
        return this.selectedTargets;
    }

    /**
     * 銷毀模組
     */
    destroy() {
        if (!this.initialized) return;
        
        // 移除事件監聽器
        $('#groupBuySelect').off('change');
        $('#toSameName').off('change');
        $('#addTarget').off('click');
        
        // 銷毀Select2
        if ($('#groupBuySelect').hasClass('select2-hidden-accessible')) {
            $('#groupBuySelect').select2('destroy');
        }
        this.destroyItemSetSelect();
        
        // 重置狀態
        this.selectedTargets = [];
        this.selectedItems = [];
        this.initialized = false;
        
        // 清理全局方法
        if (window.removeTarget === this.removeTarget) delete window.removeTarget;
        if (window.resetForm === this.resetForm) delete window.resetForm;
        if (window.submitCopy === this.submitCopy) delete window.submitCopy;
        if (window.refreshSelectedItems === this.refreshSelectedItems) delete window.refreshSelectedItems;
    }
}

// 如果是在瀏覽器環境中，將類別暴露到全局（避免重複宣告）
if (typeof window !== 'undefined') {
    if (!window.GroupBuyCopyModule) {
        window.GroupBuyCopyModule = GroupBuyCopyModule;
    }
}

// 如果是在Node.js環境中，導出模組
if (typeof module !== 'undefined' && module.exports) {
    module.exports = GroupBuyCopyModule;
}