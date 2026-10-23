// 原站 /backend/ReturnRefund/returnAndRefund.js?v=3（原單操作 ReturnRefundApp）鏡射；以下為本系統的必要修改（其餘未改）：
//  1) prepare.do / updateOrderItem.do / addOrderItem.do 原站以 jQuery.get 呼叫，但會改動伺服器端暫存的編輯草稿 → 依本系統規定寫入一律 POST，改 jQuery.post（參數相同）
//  2) /ajax/Item/getFirstTags.do、/ajax/Item/list.do?groupBuyItemSetId&tag（下拉選擇商品）本系統的 /ajax/Item/list 是商品列表 API（契約不同）
//     → 改呼叫 /ajax/ReturnRefund/itemTags.do、/ajax/ReturnRefund/itemOptions.do（回傳格式同原站：[{value,label}]）
//  3) /ajax/Item/isTypeBundleConfigable → /ajax/ReturnRefund/isTypeBundleConfigable（可設定組合商品不支援，一律直接加入）

var ReturnRefundApp = {
    gba: '',
    salesOrderId: '',
    rrJson: null,
    editingOrderItemId: null,

    init: function (config) {
        this.gba = config.gba;
        this.salesOrderId = config.salesOrderId;

        this.bindEvents();
        this.loadPrepare();

        // Init Bundle Modal
        if (typeof BundleModal !== 'undefined') {
            BundleModal.init(this.salesOrderId, (resp) => this.bundleSuccess(resp), {
                renderMode: 'inline',
                targetContainer: '#bundle-selection-container',
                mainContainer: '#ReturnRefundForm .modal-header, #ReturnRefundForm .modal-body, #ReturnRefundForm .modal-footer',
                apiEndpoints: {
                    config: `${this.gba}/ajax/ReturnRefund/getBundleConfig.do`,
                    addBundle: `${this.gba}/ajax/ReturnRefund/addBundleOrderItem.do`
                }
            });
        }
    },

    bindEvents: function () {
        var self = this;
        $('#ReturnRefundForm').on('keydown', function (e) {
            if (e.keyCode == 13) {
                e.preventDefault();
                return false;
            }
        });

        $('#modal-message').hide();
        $('#optionCreateSalesOrderContainer, #optionGrandTotalToPayContainer, #optionRegenVirtualAccountContainer').hide();

        $('#optionCreateSalesOrder').change(function (e) {
            if ($('#optionCreateSalesOrder').prop('checked')) {
                $('#optionGrandTotalToPayContainer').show();
            } else {
                $('#optionGrandTotalToPayContainer').hide();
            }
        });

        initAjaxForm('ReturnRefundForm', this.success);

        $('input#summary_new_grand_total').change(function () {
            self.rrJson.newGrandTotal = $(this).val();
            self.rrJson.salesOrder.shippingAmount = $('input#summary_shipping_amount').val();
            self.initSummary(self.rrJson);
        });

        // Button bindings
        $('#btn_addItemSelect2').click(function () { self.btnAddItemSelect2(); });
        $('#btn_addItemSelect3').click(function () { self.btnAddItemSelect3(); });
        $('#btn_addItem').click(function () { self.btnAddItem(); });
        $('#btnApplySalesRules').click(function () { self.applySalesRules(); });
    },

    loadPrepare: function () {
        var self = this;
        jQuery.post(
            `${this.gba}/ajax/ReturnRefund/prepare.do`,
            { 'salesOrderId': this.salesOrderId },
            function (data) {
                self.fullReload(data.data);
                self.fetchGroupBuyItemSet(data.data.aliasId);
                self.initItemNameSelect2(data.data.aliasId);
                self.initItemNameSelect3(data.data.aliasId);
            }
        ).fail(function (data) {
            json = data.responseJSON;
            modalShowDanger($('#myModal'), json.error);
        });
    },

    initSummary: function (json, updated) {
        updated = updated || false;
        this.rrJson = json;
        var dif = 0;
        $("#summary_ori_grand_total").html(json.oriGrandTotal);
        $("#summary_new_grand_total").val(json.oriGrandTotal);

        if (json.newGrandTotal != null && json.newGrandTotal > 0 || updated) {
            dif = json.newGrandTotal - json.oriGrandTotal;
            var signDif = (dif > 0) ? '+' + dif : '' + dif;
            $("#summary_new_grand_total").val(json.newGrandTotal);
            $("#summary_diff_grand_total").html(' (' + signDif + ')');
        }
        $("#summary_shipping_amount").val(json.salesOrder.shippingAmount);

        if (dif > 0) {
            $('#optionGrandTotalToPay').val(dif);
            if (json.salesOrder.paid) {
                $('#optionCreateSalesOrderContainer').show();
            }
        } else {
            $('#optionGrandTotalToPay').val(0);
            $('#optionCreateSalesOrder').attr('checked', false);
            $('#optionCreateSalesOrderContainer').hide();
        }

        if ($('#optionCreateSalesOrder').prop('checked')) {
            $('#optionGrandTotalToPayContainer').show();
        } else {
            $('#optionGrandTotalToPayContainer').hide();
        }

        $('#optionRegenVirtualAccountContainer').hide();
        $('#optionRenewCVSPickupContainer').hide();
        if (json.salesOrder.payByVirtualBank && !json.salesOrder.paid) {
            $('#optionRegenVirtualAccountContainer').show();
        } else if (json.salesOrder.paymentMethodCVSPickup) {
            $('#optionRenewCVSPickupContainer').show();
        }

        if (json.salesReturnRecords != null && json.salesReturnRecords.length > 0) {
            var srrHtml = '';
            for (var idx in json.salesReturnRecords) {
                var srr = json.salesReturnRecords[idx];
                var clazz = (srr.returnTotal > 0) ? 'red lighten-4 small' : 'green lighten-4 small';
                srrHtml += '<div class="col-9 ' + clazz + '">' + srr.title + '</div>';
                if (srr.returnTotal > 0) srrHtml += '<div class="col-3 ' + clazz + '">-' + srr.returnTotal + '數量</div>';
                else srrHtml += '<div class="col-3 ' + clazz + '">+' + srr.salesTotal + '數量</div>';
            }
            $('#item_result_container').html(srrHtml);
        }
    },

    addOrderItemsToForm: function (items) {
        for (var idx in items) {
            this.addOrderItemToForm(items[idx], $('input[name*=orderItemId]').length);
        }
    },

    addOrderItemToForm: function (item, i, $targetContainer) {
        var self = this;
        var defClass = item.orderItemId < 0 ? 'green lighten-4' : '';
        // Visual distinction for Bundle Root
        if (item.bundleRoot) {
            defClass += ' bg-light'; // Ensure root has some distinction if not wrapped
        }
        var namePrefix = 'orderItems[' + i + '].';
        var note = '';

        if (item.note != null && item.note.trim() !== '') {
            note = '<div class="col-12 small font-weight-bold" style="color: #4a5568;">商品備註</div>'
                + '<div class="col-12 small well" style="white-space: pre-line; background-color: #f7fafc; border: 1px solid #edf2f7; border-radius: 4px; padding: 6px 10px; margin-top: 4px; color: #2d3748;">' + item.note + '</div>';
        }

        var priceTag = '';
        if (item.priceTags != null && item.priceTags.length > 0) {
            priceTag = ' <span class="badge badge-info">' + item.priceTags[0].tag + "</span>";
        }

        var selectorPrefix = 'orderItems\\[' + i + '\\]\\.';

        // Quantity Widget
        var qtyHtml = '';
        if (item.bundleChild) {
            qtyHtml += '<div class="bundle-child-locked-view d-flex align-items-center">'
                + '<span class="form-control-plaintext font-weight-bold d-inline mr-1">' + item.total + '</span>'
                + '<i class="fa fa-lock text-muted btn-unlock-bundle-child" style="cursor: pointer;" title="解鎖編輯數量 (有風險)"></i>'
                + '</div>';
        }
        qtyHtml += '<div class="input-group input-group-sm input-group-total" style="width: 120px;">'
            + '<div class="input-group-prepend"><button class="btn btn-outline-secondary btn-minus" type="button">-</button></div>'
            + '<input type="text" class="form-control text-center p-0" style="height:auto" name="orderItems[' + i + '].total" value="' + item.total + '">'
            + '<div class="input-group-append"><button class="btn btn-outline-secondary btn-plus" type="button">+</button></div>'
            + '</div>';

        // Edit Button (only if not deleted/quantity 0)
        var editBtn = '';
        if (item.total > 0 && !item.bundleChild) { // Disable spec edit for child
            editBtn = ' <a href="javascript:void(0)" class="text-info btn-edit-spec" title="Edit Spec"><i class="glyphicon glyphicon-pencil"></i></a>';
        }

        var html = '<div class="row py-3 ' + defClass + ' order-item-row" data-index="' + i + '">'
            + '<input type="hidden" name="orderItems[' + i + '].orderItemId" value="' + item.orderItemId + '">'
            + '<input type="hidden" name="orderItems[' + i + '].groupBuyItemSetId" value="' + item.groupBuyItemSetId + '">'
            + '<input type="hidden" name="orderItems[' + i + '].itemId" value="' + item.itemId + '">'
            + '<div class="col-12 small">' + item.title + priceTag + editBtn + ' (' + item.itemId + ') </div>'
            + '<div class="col-3 small" style="">單價</div>'
            + '<div class="col-3 small" style="">數量</div>'
            + '<div class="col-3 small" style="">折價</div>'
            + '<div class="col-3 small" style="">狀態</div>'
            + '<div class="col-3 small" style=""><input type="text" size=5 name="orderItems[' + i + '].price" value="' + item.price + '"></div>'
            + '<div class="col-3 small" style="">' + qtyHtml + '</div>'
            + '<div class="col-3 small" style=""><input type="text" size=5 name="orderItems[' + i + '].discount" value="' + item.discount + '"></div>'
            + '<div class="col-3 small" style=""><select name="orderItems[' + i + '].status"><option value="UNSHIPPING">現貨</option><option value="BACKORDER">預購</option></select></div>'
            + note
            + '<div class="col-12 small help text-danger"></div></div>'
            + '<hr class="w-100 my-2">';

        var $row = $(html);
        if ($targetContainer) {
            $targetContainer.append($row);
        } else {
            $('#order_item_container').append($row);
        }

        // Initial value set
        $row.find('select[name=' + selectorPrefix + 'status]').val(item.status);


        $row.find('.btn-edit-spec').click(function () {
            self.openSpecEditor(item);
        });

        // Quantity Button Handlers
        $row.find('.btn-minus').click(function () {
            var $input = $row.find('input[name*="total"]');
            var val = parseInt($input.val()) || 0;
            val--;
            if (val <= 0) {
                if (confirm('確定刪除此商品（數量歸零）？')) {
                    val = 0;
                    $input.val(val).trigger('change');
                }
            } else {
                $input.val(val).trigger('change');
            }
        });

        $row.find('.btn-plus').click(function () {
            var $input = $row.find('input[name*="total"]');
            var val = parseInt($input.val()) || 0;
            $input.val(val + 1).trigger('change');
        });

        // Debounced Change Handler
        var $qtyInput = $row.find('input[name=' + selectorPrefix + 'total]');
        var debounceTimer;
        $qtyInput.change(function (e) {
            var $this = $(this);
            var v = $this.val();
            if (v < 0) {
                $this.val(0);
                v = 0;
            }

            // Clear previous timer
            clearTimeout(debounceTimer);

            // Set new timer
            debounceTimer = setTimeout(function () {
                self.updateOrderItem(selectorPrefix);
            }, 500);
        });

        $qtyInput.on('click', function (e) {
            self.updateItemSet(selectorPrefix);
        });

        if (item.bundleChild) {
            $row.find('.input-group-total').hide();
            $row.find('.btn-unlock-bundle-child').click(function () {
                $row.find('.input-group-total').show();
                $row.find('.bundle-child-locked-view').hide();
                $row.find('.help').html('<i class="fa fa-exclamation-triangle mr-1"></i>注意：手動修改組合商品明細數量可能造成套組數量不一致，也需確認是否需要調整主商品金額');
            });
        }

        $row.find('input[name=' + selectorPrefix + 'price]').change(function (e) {
            self.updateOrderItem(selectorPrefix);
        });
        $row.find('input[name=' + selectorPrefix + 'discount]').change(function (e) {
            self.updateOrderItem(selectorPrefix);
        });
        $row.find('select[name=' + selectorPrefix + 'status]').change(function (e) {
            self.updateOrderItem(selectorPrefix);
        });
    },

    openSpecEditor: function (item) {
        this.editingOrderItemId = item.orderItemId;
        // Scroll to the dropdown area
        var $container = $("#select_gbis_container");
        if ($container.length > 0) {
            $('html, body').animate({
                scrollTop: $container.offset().top - 100
            }, 500);

            // Set the GBIS select if matches
            if (item.groupBuyItemSetId) {
                $('select[name="groupBuyItemSetId"]').val(item.groupBuyItemSetId).trigger('change');
            }
            // Visual feedback
            $container.parent().addClass('border-info shadow');
            setTimeout(function () { $container.parent().removeClass('border-info shadow'); }, 2000);
        }
    },

    addGroupBuyItemSetSelect: function (dataArray) {
        var self = this;
        var html = '<select name="groupBuyItemSetId" class="form-control" id="groupBuyItemSetId">';
        dataArray.forEach(function (c, i) {
            html += '<option value="' + c.groupBuyItemSetId + '">' + c.itemSet.title + '</option>';
        });
        html += '</select>';
        $('#select_gbis_container').html(html);

        $('#groupBuyItemSetId').change(function (e) {
            var selectvalue = $(this).val();
            $('#tag').html('<option value="">載入中...</option>');
            self.loadTagSelect(selectvalue);
        }).trigger('change');
    },

    addTagSelect: function (dataArray) {
        var self = this;
        var html = '<select name="tag" class="form-control" id="tag">';
        dataArray.forEach(function (c, i) {
            html += '<option value="' + c.value + '">' + c.label + '</option>';
        });
        html += '</select>';
        $('#select_tag_container').html(html);

        $('#tag').change(function (e) {
            var selectvalue = $(this).val();
            $('#itemId').html('<option value="">載入中...</option>');
            var gbisId = $('#groupBuyItemSetId').val();
            self.loadItemSelect(gbisId, selectvalue);
        }).trigger('change');
    },

    addItemSelect: function (dataArray) {
        var html = '<select name="itemId" class="form-control" id="itemId">';
        dataArray.forEach(function (c, i) {
            html += '<option value="' + c.value + '">' + c.label + '</option>';
        });
        html += '</select>';
        $('#select_item_container').html(html);
    },

    loadTagSelect: function (groupBuyItemSetId) {
        var self = this;
        jQuery.get(
            `${this.gba}/ajax/ReturnRefund/itemTags.do`,
            { 'groupBuyItemSetId': groupBuyItemSetId },
            function (data) {
                self.addTagSelect(data);
            }
        ).fail(function (data) {
            json = data.responseJSON;
            modalShowDanger($('#myModal'), json.error);
        });
    },

    loadItemSelect: function (groupBuyItemSetId, tag) {
        var self = this;
        jQuery.get(
            `${this.gba}/ajax/ReturnRefund/itemOptions.do`,
            {
                'groupBuyItemSetId': groupBuyItemSetId,
                'tag': tag
            },
            function (data) {
                self.addItemSelect(data);
            }
        ).fail(function (data) {
            json = data.responseJSON;
            modalShowDanger($('#myModal'), json.error);
        });
    },

    processReturnItemResult: function (rr) {
        $('#summary_new_grand_total').val(rr.newGrandTotal);
    },

    btnAddItemSelect2: function () {
        var $btn = $('#btn_addItemSelect2');
        var $err = $('#btnAddItemSelect2_help');
        var itemId = $('#selItem').val();
        $('#selItem').val('').trigger('change');
        this.addItem($btn, $err, null, itemId);
    },

    btnAddItemSelect3: function () {
        var $btn = $('#btn_addItemSelect3');
        var $err = $('#btnAddItemSelect3_help');
        var itemId = $('#selItemUid').val();
        $('#selItemUid').val('').trigger('change');
        this.addItem($btn, $err, null, itemId);
    },

    btnAddItem: function () {
        var $btn = $('#btn_addItem');
        var $err = $('#btnAddItem_help');
        var gbisId = $('#groupBuyItemSetId').val();
        var itemId = $('#itemId').val();
        this.addItem($btn, $err, gbisId, itemId);
    },

    addItem: function ($btn, $err, groupBuyItemSetId, itemId) {
        var self = this;
        btnStartLoading($btn);
        $err.html('');

        // 1. Check if Item is a Bundle (Config Type) using new endpoint
        jQuery.get(
            `${this.gba}/ajax/ReturnRefund/isTypeBundleConfigable`,
            { 'itemId': itemId },
            function (resp) {
                // If it is a bundle and needs configuration
                if (resp && resp.data && resp.data.isConfigurable) {
                    btnStopLoading($btn);
                    if (typeof BundleModal !== 'undefined') {
                        // Pass call to Bundle Modal
                        BundleModal.fetchBundleData(itemId, groupBuyItemSetId);
                    } else {
                        alert('Bundle Modal library not loaded.');
                    }
                } else {
                    // Not a configurable bundle -> Add Directly
                    self.doAddOrderItem($btn, $err, groupBuyItemSetId, itemId);
                }
            }
        ).fail(function () {
            // Error fetching config (not a bundle?) -> Add Directly
            self.doAddOrderItem($btn, $err, groupBuyItemSetId, itemId);
        });
    },



    doAddOrderItem: function ($btn, $err, groupBuyItemSetId, itemId) {
        var self = this;
        jQuery.post(
            `${this.gba}/ajax/ReturnRefund/addOrderItem.do`,
            {
                'groupBuyItemSetId': groupBuyItemSetId,
                'itemId': itemId,
            },
            function (data) {
                var rr = data.data;
                self.bundleSuccess({ data: rr }); // Reuse success handler
                btnStopLoading($btn);
            }
        ).fail(function (data) {
            var json = data.responseJSON;
            btnStopLoading($btn);
            if (json && json.error) $err.html(json.error);
            else $err.html('Error adding item');
        });
    },

    bundleSuccess: function (response) {
        var self = this;
        var rr = response.data;
        if (rr) {
            self.addOrderItemsToForm(rr.updatedOrderItems);
            self.initSummary(rr);

            // SWAP LOGIC
            if (self.editingOrderItemId) {
                $('input[name$=".orderItemId"]').each(function () {
                    if ($(this).val() == self.editingOrderItemId) {
                        var name = $(this).attr('name');
                        var prefix = name.replace('orderItemId', '');
                        $('input[name="' + prefix + 'total"]').val(0).trigger('change');
                    }
                });
                self.editingOrderItemId = null;
            }
        }
        $('#myModal .modal-message').hide();
    },

    applySalesRules: function () {
        var self = this;
        var $btn = $('#btnApplySalesRules');
        btnStartLoading($btn);
        jQuery.post(
            `${this.gba}/ajax/ReturnRefund/applySalesRules.do`,
            {},
            function (data) {
                var rr = data.data;
                self.fullReload(rr);
                $('#myModal .modal-message').hide();
                btnStopLoading($btn);
            }
        ).fail(function (data) {
            var json = data.responseJSON;
            modalShowDanger($('#myModal'), json.error);
            btnStopLoading($btn);
        });
    },

    updateItemSet: function (namePrefix) {
        var inputPrefix = namePrefix.replace(/\\/g, '');
        var g = $('input[name=' + namePrefix + 'groupBuyItemSetId]').val();
        if ($('select[name=groupBuyItemSetId]').val() == g) return;
        $('select[name=groupBuyItemSetId] > option').each(function () {
            if (this.value == g) {
                $('select[name=groupBuyItemSetId]').val(g).change();
            }
        });
    },

    updateOrderItem: function (namePrefix) {
        var self = this;
        jQuery.post(
            `${this.gba}/ajax/ReturnRefund/updateOrderItem.do`,
            {
                'orderItemId': $('input[name=' + namePrefix + 'orderItemId]').val(),
                'price': $('input[name=' + namePrefix + 'price]').val(),
                'total': $('input[name=' + namePrefix + 'total]').val(),
                'discount': $('input[name=' + namePrefix + 'discount]').val(),
                'status': $('select[name=' + namePrefix + 'status]').val(),
                //'note':$('textarea[name='+namePrefix+'note]').val(),
            },
            function (data) {
                self.updateSuccess(data, namePrefix);
            }
        ).fail(function (data) {
            var json = data.responseJSON;
            //showMessageBox(json.error);
            $('input[name=' + namePrefix + 'orderItemId]').parent().find('.help').html(json.error);
        });
    },

    updateSuccess: function (data, namePrefix) {
        var self = this;
        // Highlight logic could be here if namePrefix is passed
        if (namePrefix) {
            $('input[name=' + namePrefix + 'orderItemId]').parent().addClass('red lighten-4');
        }

        var rr = data.data;
        self.processReturnItemResult(rr);
        self.updateOrderItemsInForm(rr.updatedOrderItems);
        self.initSummary(rr, true);
        $('#myModal .modal-message').hide();

        if (namePrefix) {
            $('input[name=' + namePrefix + 'orderItemId]').parent().find('.help').html('');
        }
    },

    updateOrderItemsInForm: function (items) {
        if (!items || items.length === 0) return;
        var self = this;
        items.forEach(function (item) {
            // Find input by orderItemId
            var $idInput = $('input[name$=".orderItemId"]').filter(function () {
                return $(this).val() == item.orderItemId;
            });

            if ($idInput.length > 0) {
                var name = $idInput.attr('name'); // e.g. orderItems[5].orderItemId
                var prefix = name.replace('orderItemId', ''); // orderItems[5].
                var $row = $idInput.closest('.order-item-row');

                // Update Total (Quantity)
                var $totalInput = $('input[name="' + prefix + 'total"]');
                if ($totalInput.length) {
                    if ($totalInput.val() != item.total) {
                        $totalInput.val(item.total);
                    }
                    $row.find('.bundle-child-locked-view span, span.form-control-plaintext').text(item.total);
                }

                // Update other fields
                $('input[name="' + prefix + 'price"]').val(item.price);
                $('input[name="' + prefix + 'discount"]').val(item.discount);
                $('select[name="' + prefix + 'status"]').val(item.status);
            }
        });
    },

    fullReload: function (rr) {
        var self = this;
        $('#order_item_container').html('');
        var so = rr.salesOrder;
        $('#rr_uuid').html(so.uuid);
        if (so.uuid.indexOf('P') > 0) {
            $('.badge.order-type').html('換貨單');
        } else if (so.uuid.indexOf('R') > 0) {
            $('.badge.order-type').html('退貨單');
        }
        so.sortedOrderItems.forEach(function (c, i) {
            self.addOrderItemToForm(c, i);
        });
        self.initSummary(rr);
    },

    success: function (json) {
        table.ajax.reload(null, false);
        $('#myModal').modal('hide');
        modalShowSuccess($('#myModal'), json.error);
    },

    fetchGroupBuyItemSet: function (groupBuyId) {
        var self = this;
        jQuery.get(
            `${this.gba}/ajax/GroupBuyItemSet/list.do`,
            {
                'groupBuyId': groupBuyId,
                'iDisplayLength': 500,
                'iSortCol_0': '0',
                'mDataProp_0': 't.seqString',
                'sSortDir_0': 'asc',
                'readyForSale': true
            },
            function (data) {
                var dataArray = data.data;
                self.addGroupBuyItemSetSelect(dataArray);
            }
        ).fail(function (data) {
            var json = data.responseJSON;
            modalShowDanger($('#myModal'), json.error);
        });
    },

    initItemNameSelect2: function (groupBuyId) {
        $('#selItem').select2({
            width: 'auto',
            allowClear: true,
            inputClass: 'input-large',
            placeholder: GBFi18n.select,
            dropdownAuthWidth: true,
            language: GBF.language,
            ajax: {
                delay: 1000,
                url: function () {
                    return GBF.baseUrl + '/ajax/Lookup/item';
                },
                dataType: 'json',
                data: function (data) {
                    data = {
                        groupBuyId: groupBuyId,
                        q: data.term,
                    };
                    return data;
                }
            }
        });
    },

    initItemNameSelect3: function (groupBuyId) {
        $('#selItemUid').select2({
            width: 'auto',
            allowClear: true,
            inputClass: 'input-large',
            placeholder: GBFi18n.select,
            dropdownAuthWidth: true,
            language: GBF.language,
            ajax: {
                delay: 1000,
                url: function () {
                    return GBF.baseUrl + '/ajax/Lookup/item';
                },
                dataType: 'json',
                data: function (data) {
                    data = {
                        groupBuyId: groupBuyId,
                        q: data.term,
                        m: 'uid',
                    };
                    return data;
                }
            }
        });
    }
};

$(document).ready(function () {
    // Initialization is called from JSP
});
