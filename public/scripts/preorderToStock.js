/**
 * 預購轉現貨管理系統 JavaScript 庫
 * v1.0.0
 * 
 * 提供團購預購商品轉現貨功能，包括：
 * - 列出團購的預購商品
 * - 顯示每個商品的庫存和暫存數量
 * - 轉換預購商品為現貨
 * - 顯示單一商品的訂單明細
 * - 轉換單一訂單的預購商品為現貨
 */
var PreorderToStockManager = (function() {
    // 私有變數
    var itemsData = []; // 存儲商品數據
    var orderItemsData = []; // 存儲單一商品訂單項目數據
    var currentItemId = null; // 當前查看明細的商品ID
    var currentItemTitle = ''; // 當前查看明細的商品標題
	var bulkConversionActive = false;
	var currentOrderBy = 'DATE_PAID'; // Default order by
    
    var config = {
        baseUrl: '', // 將由初始化時設定
        groupBuyId: null,
        selectors: {
            loadingState: '#loadingState',
            itemsContainer: '#itemsContainer',
            errorState: '#errorState',
            noItemsState: '#noItemsState',
            errorMessage: '#errorMessage',
            itemsList: '#itemsList',
            refreshButton: '#refreshButton',
            returnToListButton: '#returnToListButton',
            successMessage: '#successMessage',
            successMessageText: '#successMessageText',
            itemDetailsContainer: '#itemDetailsContainer',
            itemDetailsTitle: '#itemDetailsTitle',
            backToItemsButton: '#backToItemsButton',
            orderItemsList: '#orderItemsList',
			convertItemModal: '#convertItemModal',
			convertItemTitle: '#convertItemTitle',
			convertAmount: '#convertAmount',
			maxConvertAmount: '#maxConvertAmount',
			orderBySelect: '#orderBySelect',
			confirmConvertItemButton: '#confirmConvertItemButton',
			convertOrderItemModal: '#convertOrderItemModal',
			convertOrderItemMessage: '#convertOrderItemMessage',
			confirmConvertOrderItemButton: '#confirmConvertOrderItemButton',
			addStockModal: '#addStockModal',
			stockAmount: '#stockAmount',
			confirmAddStockButton: '#confirmAddStockButton',
			addStockItemTitle: '#addStockItemTitle',
			orderDetailsSortSelect: '#orderDetailsSortSelect',
		    applyFilterButton: '#applyFilterButton',
		    bulkConvertButton: '#bulkConvertButton'
        },
        endpoints: {
            getList: '/ajax/PreorderToStock/fetchPreorderInfo',
            convertItem: '/ajax/PreorderToStock/convertSingleItem',
            getItemDetail: '/ajax/PreorderToStock/fetchSingleItemPreorderInfo',
            convertOrderItem: '/ajax/PreorderToStock/convertSingleOrderItem',
			addStock: '/ajax/PreorderToStock/addStock',
			stockToCache: '/ajax/PreorderToStock/stockToCache'
        }
    };

    // 私有方法
    function showLoading() {
        $(config.selectors.loadingState).show();
        $(config.selectors.itemsContainer).hide();
        $(config.selectors.errorState).hide();
        $(config.selectors.noItemsState).hide();
        $(config.selectors.successMessage).hide();
        $(config.selectors.itemDetailsContainer).hide();
    }

    function hideLoading() {
        $(config.selectors.loadingState).hide();
    }

    function showError(message) {
        // 隱藏所有其他區域
        $(config.selectors.loadingState).hide();
        $(config.selectors.itemsContainer).hide();
        $(config.selectors.noItemsState).hide();
        $(config.selectors.successMessage).hide();
        $(config.selectors.itemDetailsContainer).hide();
        
        // 顯示錯誤訊息
        $(config.selectors.errorMessage).text(message || '發生錯誤，請稍後再試');
        $(config.selectors.errorState).show();
        
        // 滾動到錯誤訊息
        $('html, body').animate({
            scrollTop: $(config.selectors.errorState).offset().top - 100
        }, 500);
    }
    
    function showSuccessMessage(message) {
        // 顯示成功訊息
        $(config.selectors.successMessageText).text(message || '操作已成功完成');
        $(config.selectors.successMessage).show();
        
        // 滾動到成功訊息
        $('html, body').animate({
            scrollTop: $(config.selectors.successMessage).offset().top - 100
        }, 500);
        
        // 3秒後自動隱藏
        setTimeout(function() {
            $(config.selectors.successMessage).fadeOut('slow');
        }, 3000);
    }

    function showNoItems() {
        $(config.selectors.loadingState).hide();
        $(config.selectors.itemsContainer).hide();
        $(config.selectors.errorState).hide();
        $(config.selectors.successMessage).hide();
        $(config.selectors.itemDetailsContainer).hide();
        $(config.selectors.noItemsState).show();
    }

    function getConvertibilityStatus(item) {
        const canConvert = item.stockAvailable > 0 || item.stockCache > 0;
        if (canConvert) {
            return {
                canConvert: true,
                message: '可轉現貨',
                class: 'badge-success'
            };
        } else {
            return {
                canConvert: false,
                message: '庫存不足',
                class: 'badge-danger'
            };
        }
    }

    function displayItems(items) {
        const itemsTable = $(config.selectors.itemsList);
        itemsTable.empty();
        
        if (items.length === 0) {
            showNoItems();
            return;
        }
        
		items.forEach(function(item) {
		    const status = getConvertibilityStatus(item);
		    const statusBadge = `<span class="badge ${status.class}">${status.message}</span>`;
		    
		    const row = $(`
		        <tr data-item-id="${item.itemId}">
		            <td>${item.title}</td>
		            <td>${item.preorderTotal}</td>
		            <td>
		                <div class="d-flex align-items-center">
		                    <span class="mr-2">${item.stockAvailable}</span>
		                    <button class="btn btn-sm btn-default btn-action add-stock-btn" data-item-id="${item.itemId}" data-item-title="${item.title}" title="增加庫存">
		                        <i class="fas fa-plus"></i>
		                    </button>
		                  <!--  <button class="btn btn-sm btn-default btn-action stock-to-cache-btn" data-item-id="${item.itemId}" data-item-title="${item.title}" title="轉移到暫存">
		                        <i class="fas fa-arrow-right"></i>
		                    </button> -->
		                </div>
		            </td>
		            <td>${item.stockCache}</td>
		            <td>${statusBadge}</td>
		            <td>
		                <div class="d-flex flex-column flex-sm-row gap-2">
		                    <button class="btn btn-sm btn-default btn-action show-detail-btn mb-1 mb-sm-0" data-item-id="${item.itemId}" data-item-title="${item.title}">
		                        <i class="fas fa-list"></i> 顯示訂單
		                    </button>
		                    <button class="btn btn-sm btn-primary btn-action convert-item-btn" data-item-id="${item.itemId}" ${status.canConvert ? '' : 'disabled'}>
		                        <i class="fas fa-exchange-alt"></i> 轉換
		                    </button>
		                </div>
		            </td>
		        </tr>
		    `);
            
            itemsTable.append(row);
        });
        
        // 顯示商品容器
        hideLoading();
        $(config.selectors.itemsContainer).show();
        
        // 附加事件處理器
        attachItemEventHandlers();
    }
    
    function displayOrderItemDetails(items) {
        const orderItemsTable = $(config.selectors.orderItemsList);
        orderItemsTable.empty();
        
        if (items.length === 0) {
            const emptyRow = $(`
                <tr>
                    <td colspan="4" class="text-center">無相關訂單資訊</td>
                </tr>
            `);
            orderItemsTable.append(emptyRow);
        } else {
            items.forEach(function(item) {
                const row = $(`
                    <tr data-order-item-id="${item.orderItemId}">
                        <td>${item.uuid}</td>
						<td>${item.datePaid}</td>
						<td>${item.amount}</td>
                        <td>${item.preorderTotal}</td>
                        <td>
                            <div class="d-flex justify-content-center">
                                <button class="btn btn-sm btn-primary btn-action convert-order-item-btn" data-order-item-id="${item.orderItemId}">
                                    <i class="fas fa-exchange-alt"></i> 轉換
                                </button>
                            </div>
                        </td>
                    </tr>
                `);
                
                orderItemsTable.append(row);
            });
        }
        
        // 設置標題
        $(config.selectors.itemDetailsTitle).text(`商品訂單明細: ${currentItemTitle}`);
        
        // 顯示訂單明細容器
        hideLoading();
        $(config.selectors.itemDetailsContainer).show();
        
        // 附加事件處理器
        attachOrderItemEventHandlers();
    }

    function attachItemEventHandlers() {
        // 顯示細節按鈕處理
        $('.show-detail-btn').click(function() {
            const itemId = $(this).data('item-id');
            const itemTitle = $(this).data('item-title');
            loadItemDetails(itemId, itemTitle);
        });
        
		// 轉換商品按鈕處理
		$('.convert-item-btn').click(function() {
		    const itemId = $(this).data('item-id');
		    const itemTitle = $(this).closest('tr').find('td:first').text();
		    const amount = parseInt($(this).closest('tr').find('td:eq(1)').text());
		    const stockAvailable = parseInt($(this).closest('tr').find('td:eq(2)').find('span').html());
		    const stockCache = parseInt($(this).closest('tr').find('td:eq(3)').text());
		    const stock = Math.max(stockAvailable, stockCache);
		    // 設置商品標題
		    $(config.selectors.convertItemTitle).text(`商品：${itemTitle}`);
		    
		    // 設置可轉換的最大數量
		    $(config.selectors.maxConvertAmount).text(stock);
		    $(config.selectors.convertAmount).attr('max', stock);
		    $(config.selectors.convertAmount).val(stock);
		    
		    // 設置確認按鈕的事件處理器
		    $(config.selectors.confirmConvertItemButton).off('click').on('click', function() {
		        const convertAmount = parseInt($(config.selectors.convertAmount).val());
		        const orderBy = $(config.selectors.orderBySelect).val();
		        
		        if (!isNaN(convertAmount) && convertAmount > 0 && convertAmount <= stock) {
		            convertItem(itemId, convertAmount, orderBy);
		          //  $(config.selectors.convertItemModal).modal('hide');
		        } else {
		            alert(`請輸入有效的數量（1至${stock}的整數）`);
		        }
		    });
		    
		    // 顯示模態對話框
		    $(config.selectors.convertItemModal).modal('show');
		});

		// 增加庫存按鈕處理
		$('.add-stock-btn').click(function() {
		    const itemId = $(this).data('item-id');
		    const itemTitle = $(this).data('item-title');
		    
		    // 設置商品標題
		    $(config.selectors.addStockItemTitle).text(`商品：${itemTitle}`);
		    
		    // 重置輸入框
		    $(config.selectors.stockAmount).val(1);
		    
		    // 設置確認按鈕的事件處理器
		    $(config.selectors.confirmAddStockButton).off('click').on('click', function() {
		        const stockAmount = parseInt($(config.selectors.stockAmount).val());
		        
		        if (!isNaN(stockAmount) && stockAmount > 0) {
		            addItemStock(itemId, stockAmount);
		            $(config.selectors.addStockModal).modal('hide');
		        } else {
		            alert('請輸入有效的數量（大於0的整數）');
		        }
		    });
		    
		    // 顯示模態對話框
		    $(config.selectors.addStockModal).modal('show');
		});

		// 庫存轉暫存按鈕處理
		$('.stock-to-cache-btn').click(function() {
		    const itemId = $(this).data('item-id');
		    const itemTitle = $(this).data('item-title');
		    
		    // 從表格中獲取目前的庫存數量
		    const currentStock = parseInt($(this).closest('div').find('span').text());
		    
		    if (currentStock <= 0) {
		        alert('當前庫存為0，無法轉移到暫存');
		        return;
		    }
		    
		    // 彈出輸入數量的提示框
		    const cacheAmount = prompt(`請輸入要將「${itemTitle}」庫存轉移到暫存的數量 (當前庫存: ${currentStock}):`, currentStock);
		    
		    // 檢查輸入是否有效
		    if (cacheAmount !== null) {
		        const amount = parseInt(cacheAmount);
		        if (!isNaN(amount) && amount > 0 && amount <= currentStock) {
		            transferStockToCache(itemId, amount);
		        } else {
		            alert(`請輸入有效的數量（1至${currentStock}的整數）`);
		        }
		    }
		});
    }
    
    function attachOrderItemEventHandlers() {
        // 轉換訂單項目按鈕處理
		$('.convert-order-item-btn').click(function() {
		    const orderItemId = $(this).data('order-item-id');
		    const orderRow = $(this).closest('tr');
		    const orderId = orderRow.find('td:first').text();
		    const itemTitle = orderRow.find('td:eq(1)').text();
			convertOrderItem(orderItemId);
		    /*
		    // 設置確認訊息
		    $(config.selectors.convertOrderItemMessage).text(`您確定要將訂單「${orderId}」中的商品「${itemTitle}」轉換為現貨嗎？`);
		    
		    // 設置確認按鈕的事件處理器
		    $(config.selectors.confirmConvertOrderItemButton).off('click').on('click', function() {
		        convertOrderItem(orderItemId);
		        $(config.selectors.convertOrderItemModal).modal('hide');
		    });
		    
		    // 顯示確認對話框
		    $(config.selectors.convertOrderItemModal).modal('show');
			*/
		});
     
    }
    
    function loadItems() {
        showLoading();

        let url = config.baseUrl + config.endpoints.getList;
        // 發送AJAX請求獲取商品資訊
        $.ajax({
            url: url,
            type: 'GET',
            data: { groupBuyId: config.groupBuyId },
            dataType: 'json',
            success: function(response) {
                if (response.data && response.data.length > 0) {
                    // 保存商品數據
                    itemsData = response.data;
                    
                    // 顯示商品列表
                    displayItems(itemsData);
                } else {
                    // 顯示無商品狀態
                    showNoItems();
                }
            },
            error: function(xhr, status, error) {
                // 處理伺服器錯誤訊息
                let errorMessage = '獲取商品資訊失敗';
                
                // 嘗試解析JSON錯誤訊息
                if (xhr.responseText) {
                    try {
                        const errorResponse = JSON.parse(xhr.responseText);
                        if (errorResponse.error) {
                            errorMessage = errorResponse.error;
                        }
                    } catch (e) {
                        console.error('Error parsing error response:', e);
                    }
                }
                
                showError(errorMessage);
                console.error('Error fetching items:', error);
            }
        });
    }
    
	function loadItemDetails(itemId, itemTitle, orderBy) {
	    currentItemId = itemId;
	    currentItemTitle = itemTitle;
	    if (orderBy) {
	        currentOrderBy = orderBy;
	    }
	    
	    showLoading();

	    let url = config.baseUrl + config.endpoints.getItemDetail;
	    // 發送AJAX請求獲取商品訂單明細
	    $.ajax({
	        url: url,
	        type: 'GET',
	        data: { 
	            groupBuyId: config.groupBuyId,
	            itemId: itemId,
	            orderBy: currentOrderBy
	        },
	        dataType: 'json',
	        success: function(response) {
	            if (response.data) {
	                // 保存訂單項目數據
	                orderItemsData = response.data;
	                
	                // 顯示訂單項目列表
	                displayOrderItemDetails(orderItemsData);
	                
	                // 設置排序下拉框的值
	                $(config.selectors.orderDetailsSortSelect).val(currentOrderBy);
	            } else {
	                // 顯示空訂單列表
	                displayOrderItemDetails([]);
	            }
	        },
	        error: function(xhr, status, error) {
	            // 處理伺服器錯誤訊息
	            let errorMessage = '獲取商品訂單明細失敗';
	            
	            // 嘗試解析JSON錯誤訊息
	            if (xhr.responseText) {
	                try {
	                    const errorResponse = JSON.parse(xhr.responseText);
	                    if (errorResponse.error) {
	                        errorMessage = errorResponse.error;
	                    }
	                } catch (e) {
	                    console.error('Error parsing error response:', e);
	                }
	            }
	            
	            showError(errorMessage);
	            console.error('Error fetching item details:', error);
	        }
	    });
	}
    
	function convertItem(itemId, total, orderBy) {
	    
		$(config.selectors.confirmConvertItemButton).prop('disabled', true);
		$(config.selectors.confirmConvertItemButton).html('<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> 處理中...');


	    let url = config.baseUrl + config.endpoints.convertItem;
	    // 發送AJAX請求轉換商品
	    $.ajax({
	        url: url,
	        type: 'POST',
	        data: { 
	            groupBuyId: config.groupBuyId,
	            itemId: itemId,
	            total: total,
	            orderBy: orderBy
	        },
	        dataType: 'json',
			success: function(response) {
			    // 更改模態框顯示成功訊息
			    //$(config.selectors.convertItemTitle).parent().hide();
				$('.form-group', config.selectors.convertItemModal).hide();
			    $('.modal-body', config.selectors.convertItemModal).append(
			        `<div class="alert alert-success" role="alert">
			        <i class="bi bi-check-circle-fill mr-2"></i> ${response.error}
			        </div>`
			    );
			    
			    // 更改按鈕文字，並啟用按鈕
			    $(config.selectors.confirmConvertItemButton).hide();
			    $('button[data-dismiss="modal"].btn', config.selectors.convertItemModal).text('關閉');
			    
			    // 當模態框被關閉時重新載入商品列表
			    $(config.selectors.convertItemModal).one('hidden.bs.modal', function() {
			        // 重置模態框內容
			        resetConvertItemModal();
			        // 重新載入商品列表
			        loadItems();
			    });
			},
			error: function(xhr, status, error) {
			       // 處理伺服器錯誤訊息
			       let errorMessage = '商品轉換失敗';
			       
			       // 嘗試解析JSON錯誤訊息
			       if (xhr.responseText) {
			           try {
			               const errorResponse = JSON.parse(xhr.responseText);
			               if (errorResponse.error) {
			                   errorMessage = errorResponse.error;
			               }
			           } catch (e) {
			               console.error('Error parsing error response:', e);
			           }
			       }
			       
			       // 更改模態框顯示錯誤訊息
			       $(config.selectors.convertItemTitle).parent().hide();
			       $('.form-group', config.selectors.convertItemModal).hide();
			       $('.modal-body', config.selectors.convertItemModal).append(
			           '<div class="alert alert-danger" role="alert">' +
			           '<i class="bi bi-exclamation-triangle-fill mr-2"></i> ' + errorMessage +
			           '</div>'
			       );
			       
			       // 更改按鈕文字，並啟用按鈕
			       $(config.selectors.confirmConvertItemButton).hide();
			       $('button[data-dismiss="modal"]', config.selectors.convertItemModal).text('關閉');
			       
			       // 當模態框被關閉時重新載入商品列表
			       $(config.selectors.convertItemModal).one('hidden.bs.modal', function() {
			           // 重置模態框內容
			           resetConvertItemModal();
			           // 重新載入商品列表（即使失敗也重新載入）
			           loadItems();
			       });
			       
			       console.error('Error converting item:', error);
			   }
	    });
	}
    
	// 添加一個函數來重置轉換模態框的內容
	function resetConvertItemModal() {
	    // 移除任何警告或訊息
	    $('.alert', config.selectors.convertItemModal).remove();
	    
	    // 重新顯示原始內容
	    $(config.selectors.convertItemTitle).parent().show();
	    $('.form-group', config.selectors.convertItemModal).show();
	    
	    // 重置按鈕
	    $(config.selectors.confirmConvertItemButton).html('確認轉換').prop('disabled', false).show();
	    $('button[data-dismiss="modal"]', config.selectors.convertItemModal).text('取消');
	}
	
    function convertOrderItem(orderItemId, reloadWhenComplete = true, callback) {
		// 找到相應的按鈕並記錄其位置
		const $button = $(`.convert-order-item-btn[data-order-item-id="${orderItemId}"]`);
		const $buttonContainer = $button.parent();

		// 禁用確認按鈕，並顯示處理中狀態
		$(config.selectors.confirmConvertOrderItemButton).prop('disabled', true);
		$(config.selectors.confirmConvertOrderItemButton).html('<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> 處理中...');

        let url = config.baseUrl + config.endpoints.convertOrderItem;
        // 發送AJAX請求轉換訂單項目
        $.ajax({
            url: url,
            type: 'POST',
            data: { 
                groupBuyId: config.groupBuyId,
                orderItemId: orderItemId
            },
            dataType: 'json',
            success: function(response) {
				// 替換按鈕為「已轉換」標籤
				$buttonContainer.html(
				    '<span class="badge badge-success">已轉換</span>'
				);
				
				// 檢查是否所有訂單項目都已經轉換完成
				const remainingButtons = $('.convert-order-item-btn').length;
				if (reloadWhenComplete && remainingButtons === 0) {
                    // 如果沒有剩餘的轉換按鈕，表示所有訂單都已經轉換
                    // 重新加載商品詳情以獲取新的一批數據
                    loadItemDetails(currentItemId, currentItemTitle);
                }
				
				if (callback) callback(true)
            },
            error: function(xhr, status, error) {
                // 處理伺服器錯誤訊息
                let errorMessage = '訂單項目轉換失敗';
                
                // 嘗試解析JSON錯誤訊息
                if (xhr.responseText) {
                    try {
                        const errorResponse = JSON.parse(xhr.responseText);
                        if (errorResponse.error) {
                            errorMessage = errorResponse.error;
                        }
                    } catch (e) {
                        console.error('Error parsing error response:', e);
                    }
                }
				$buttonContainer.html(`<span class="badge badge-danger">${errorMessage}</span>`);
                //showError(errorMessage);
                console.error('Error converting order item:', error);
				if (callback) callback(false)
            }
        });
    }

	function addItemStock(itemId, stockAmount) {
	       showLoading();

	       let url = config.baseUrl + config.endpoints.addStock;
	       // 發送AJAX請求增加庫存
	       $.ajax({
	           url: url,
	           type: 'POST',
	           data: { 
	               groupBuyId: config.groupBuyId,
	               itemId: itemId,
	               stock: stockAmount
	           },
	           dataType: 'json',
	           success: function(response) {
	               hideLoading();
	               
	               // 顯示成功訊息
	               showSuccessMessage(`成功增加 ${stockAmount} 件庫存`);
	               
	               // 重新載入商品列表
	               loadItems();
	           },
	           error: function(xhr, status, error) {
					// 處理伺服器錯誤訊息
					let errorMessage = '增加庫存失敗';
	
					// 嘗試解析JSON錯誤訊息
					if (xhr.responseText) {
					    try {
					        const errorResponse = JSON.parse(xhr.responseText);
					        if (errorResponse.error) {
					            errorMessage = errorResponse.error;
					        }
					    } catch (e) {
					        console.error('Error parsing error response:', e);
					    }
					}
	
					$(config.selectors.addStockModal).modal('hide');
					showError(errorMessage);
					console.error('Error adding stock:', error);
	           }
	       });
	   }
	   
   function transferStockToCache(itemId, cacheAmount) {
       showLoading();

       let url = config.baseUrl + config.endpoints.stockToCache;
       // 發送AJAX請求將庫存轉移到暫存
       $.ajax({
           url: url,
           type: 'POST',
           data: { 
               groupBuyId: config.groupBuyId,
               itemId: itemId,
               cacheTotal: cacheAmount
           },
           dataType: 'json',
           success: function(response) {
               hideLoading();
               
               // 顯示成功訊息
               showSuccessMessage(`成功將 ${cacheAmount} 件庫存轉移到暫存`);
               
               // 重新載入商品列表
               loadItems();
           },
           error: function(xhr, status, error) {
               // 處理伺服器錯誤訊息
               let errorMessage = '庫存轉移失敗';
               
               // 嘗試解析JSON錯誤訊息
               if (xhr.responseText) {
                   try {
                       const errorResponse = JSON.parse(xhr.responseText);
                       if (errorResponse.error) {
                           errorMessage = errorResponse.error;
                       }
                   } catch (e) {
                       console.error('Error parsing error response:', e);
                   }
               }
               
               showError(errorMessage);
               console.error('Error transferring stock to cache:', error);
           }
       });
   }

   // Add function to handle bulk conversion
   function startBulkConversion() {
       bulkConversionActive = true;
       updateBulkConvertButtonStatus();
       processBulkConversion();
   }

   function stopBulkConversion() {
       bulkConversionActive = false;
       updateBulkConvertButtonStatus();
   }

   function updateBulkConvertButtonStatus() {
       if (bulkConversionActive) {
           $(config.selectors.bulkConvertButton)
               .removeClass('btn-outline-success')
               .addClass('btn-outline-danger')
               .html('<i class="fas fa-stop"></i> 停止轉換');
       } else {
           $(config.selectors.bulkConvertButton)
               .removeClass('btn-outline-danger')
               .addClass('btn-outline-success')
               .html('<i class="fas fa-exchange-alt"></i> 全部轉換');
       }
   }

   function processBulkConversion() {
       if (!bulkConversionActive) {
           return;
       }
       
       // 尋找第一個尚未轉換的項目
       const $nextButton = $('.convert-order-item-btn').first();
       
       if ($nextButton.length > 0) {
           const orderItemId = $nextButton.data('order-item-id');
           
           // 顯示正在處理的項目
           const $row = $nextButton.closest('tr');
           $row.addClass('table-info');
           
           // 模擬點擊轉換按鈕
           convertOrderItem(orderItemId, false, function(success) {
               // 轉換後移除高亮
               $row.removeClass('table-info');
               
               if (success) {
                   // 成功轉換，延遲1秒後繼續下一個
                   setTimeout(function() {
                       if (bulkConversionActive) {
                           processBulkConversion();
                       }
                   }, 1500);
               } else {
                   // 失敗則停止轉換
                   stopBulkConversion();
                   //showError('批次轉換過程中發生錯誤，已停止轉換');
               }
           });
       } else {
           // 沒有更多項目可轉換
           stopBulkConversion();
           showSuccessMessage('全部項目已轉換完成');
           
           // 重新載入訂單詳情以獲取新的一批數據
           //loadItemDetails(currentItemId, currentItemTitle);
       }
   }

    // 公共方法
    function init(options) {
        // 合併配置
        if (options) {
            if (options.baseUrl) config.baseUrl = options.baseUrl;
            if (options.groupBuyId) config.groupBuyId = options.groupBuyId;
            if (options.endpoints) {
                config.endpoints = $.extend(config.endpoints, options.endpoints);
            }
            if (options.selectors) {
                config.selectors = $.extend(config.selectors, options.selectors);
            }
        }
		
        if (!config.groupBuyId) {
            console.error('PreorderToStockManager初始化錯誤: 缺少groupBuyId');
            showError('缺少團購ID參數');
            return;
        }

		// 初始化全局事件處理器，確保只綁定一次
		initGlobalEventHandlers();

        // 載入商品資訊
        loadItems();
        
        console.log('PreorderToStockManager 初始化完成');
    }
	
	// 新增全局事件處理器初始化函數
	function initGlobalEventHandlers() {
	    // 重新整理按鈕處理
	    $(config.selectors.refreshButton).off('click').on('click', function() {
	        loadItems();
	    });
	    
	    // 返回商品列表按鈕處理
	    $(config.selectors.returnToListButton).off('click').on('click', function() {
	        $(config.selectors.errorState).hide();
	        loadItems();
	    });
	    
	    // 返回商品列表按鈕處理
	    $(document).off('click', config.selectors.backToItemsButton).on('click', config.selectors.backToItemsButton, function() {
	        // 確保停止任何正在進行的批量轉換
	        bulkConversionActive = false;
	        updateBulkConvertButtonStatus();
	        
	        $(config.selectors.itemDetailsContainer).hide();
	        $(config.selectors.itemsContainer).show();
	    });
	    
	    // 篩選套用按鈕處理
	    $(document).off('click', config.selectors.applyFilterButton).on('click', config.selectors.applyFilterButton, function() {
	        const selectedOrderBy = $(config.selectors.orderDetailsSortSelect).val();
	        loadItemDetails(currentItemId, currentItemTitle, selectedOrderBy);
	    });
	    
	    // 全部轉換按鈕處理
	    $(document).off('click', config.selectors.bulkConvertButton).on('click', config.selectors.bulkConvertButton, function() {
	        if (bulkConversionActive) {
	            stopBulkConversion();
	        } else {
	            // 檢查是否有可轉換的項目
	            if ($('.convert-order-item-btn').length > 0) {
	                startBulkConversion();
	            } else {
	                showSuccessMessage('沒有可轉換的項目');
	            }
	        }
	    });
	}
	
    // 返回公共API
    return {
        init: init,
        reload: loadItems
    };
})();