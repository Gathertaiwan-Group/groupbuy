var WebOptions = {
	cols: function(){
		var opts = [];
		for (var i=1 ; i<=12 ; i++) {
			opts.push({label: i, value: i});
		}
		return opts;
	},
	fontSize: function() {
		var opts = [];
		for (var i=10 ; i<=40 ; i+=2) {
			opts.push({label: i, value: i});
		}
		return opts;
	},
	menuStyle: function() {
		var opts = [];
		opts.push({label: '水平', value: 'horizontal'});
		opts.push({label: '水平+分隔線', value: 'horizontal-line'});
		opts.push({label: '垂直', value: 'vertical'});
		return opts;
	},
	iconStyle: function() {
		var opts = [];
		opts.push({label: '水平', value: 'horizontal'});
		opts.push({label: '垂直', value: 'vertical'});
		return opts;
	},
	iconSize: function() {
		var opts = [];
		opts.push({label: '大', value: 'large'});
		opts.push({label: '中', value: 'medium'});
		opts.push({label: '小', value: 'small'});
		return opts;
	},
	categories: [
		{ "label": "空欄位", "value": "empty", "icon": "fa-empty-set"},
		{ "label": "文字標籤", "value": "label", "icon": "fa-text"},
		{ "label": "編輯器(新)", "value": "editor", "icon": "fa-edit"},
		{ "label": "編輯器(舊)", "value": "htmlEditor", "icon": "fa-file-code"},
		{ "label": "分隔線", "value": "line", "icon": "fa-horizontal-rule"},
		{ "label": "選單", "value": "menu", "icon": "fa-bars"},
		{ "label": "社群連結", "value": "link", "icon": "fa-share-from-square"},
		{ "label": "原始碼", "value": "code", "icon": "fa-code"},
		{ "label": "版權宣告", "value": "copyright", "icon": "fa-copyright", hidden: true},
	],
	getCategoryLabel: function(value) {
		var label = null;
		WebOptions.categories.forEach(function(item){
			if (item.value == value)
				label = item.label;
		});
		return label;
	}
};