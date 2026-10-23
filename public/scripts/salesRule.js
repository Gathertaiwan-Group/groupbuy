
var salesRuleManager = {
	init : function(salesRuleId) {
		this.salesRuleId = salesRuleId || '';
		return this;
	},
	prepare: function(dt) {
		var _this = this;
		jQuery.get(
			GBF.baseUrl+'/ajax/SalesRule/getPackage',
			{
				'salesRuleId':_this.salesRuleId
			},
			function(data) {
				var json = data.data;
				_this.buildForm(json);
			}
		).fail(function(data) {
			json = data.responseJSON;
			modalShowDanger($(_this.formId), json.error);
		});
	},
	buildForm: function(itemBundle) {
		var formContainer = $("#form-container");
		var html = '';
	
		// Render itemBundle title and hidden input
		html += '<input type="hidden" name="itemBundleId" value="' + itemBundle.itemBundleId + '">';
		html += '<div class="form-group row">';
		html += '<label class="col-sm-2 col-form-label">優惠條件名稱</label>';
		html += '<div class="col-sm-10">';
		html += '<input type="text" name="title" class="form-control" value="' + itemBundle.title + '" >';
		html += '</div>';
		html += '</div>';
		html += '<div class="form-group row">';
		html += '<label class="col-sm-2 col-form-label">主商品名稱</label>';
		html += '<div class="col-sm-10">';
		html += '<input type="text" name="title" class="form-control" value="' + itemBundle.itemTitle + '" >';
		html += '</div>';
		html += '</div>';
	
		// Render internalItemBundleOptions
		itemBundle.internalItemBundleOptions.forEach(function(option, optionIndex){
		    html += '<div class="form-group row">';
		    html += '<label class="col-sm-12 col-form-label">' + option.title + '</label>';
		    html += '<div class="col-sm-10">';
		    html += '<div class="input-group">';
		    html += '<div class="input-group-prepend">';
		    html += '<span class="input-group-text">可挑選數量範圍</span>';
		    html += '</div>';
		    html += '<input type="text" class="form-control" name="itemBundleOptions[' + optionIndex + '].qualityMin" value="' + option.qualityMin + '">';
		    html += '<div class="input-group-append">';
		    html += '<span class="input-group-text">至</span>';
		    html += '</div>';
		    html += '<input type="text" class="form-control" name="itemBundleOptions[' + optionIndex + '].qualityMax" value="' + option.qualityMax + '">';
		    html += '<input type="hidden" name="itemBundleOptions[' + optionIndex + '].itemBundleOptionId" value="' + option.itemBundleOptionId + '">';
		    html += '<input type="hidden" name="itemBundleOptions[' + optionIndex + '].seq" value="' + option.seq + '">';
		    html += '</div>'; // input-group
		    html += '</div>'; // col-sm-10
		    html += '</div>'; // form-group
	
		    // Render internalItemBundleOptionItems
		    option.internalItemBundleOptionItems.forEach(function(item, itemIndex){
		        html += '<div class="form-check">';
		        html += '<input checked class="form-check-input" type="checkbox" id="' + item.title + '_' + item.itemBundleOptionItemId + '" name="itemBundleOptions[' + optionIndex + '].itemBundleOptionItems[' + itemIndex + '].itemBundleOptionItemId" value="' + item.itemBundleOptionItemId + '">';
		        html += '<label class="form-check-label" for="' + item.title + '_' + item.itemBundleOptionItemId + '">' + item.title + '</label>';
		        html += '<input type="hidden" name="itemBundleOptions[' + optionIndex + '].itemBundleOptionItems[' + itemIndex + '].seq" value="' + item.seq + '">';
		        html += '</div>';
		    });
		});
	
		formContainer.html(html);
	}
};