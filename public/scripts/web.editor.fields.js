var WebFields = {
	panelEditorField: function(cfg) {
		var fields = [];
		fields.push({
				type: 'colorPicker',
			    label: '背景顏色',
			    name: 'bgColor',
				colorType: 'bg',
			    defValue: (cfg.bgColor != undefined) ? cfg.bgColor : ''
			});
		return fields;
	},
	row2EditorField: function(row) {
		var fields = WebFields._commonEditorField(row);
		fields.push({
				type: 'colorPicker',
			    label: '背景顏色',
			    name: 'bgColor',
				colorType: 'bg',
			    defValue: (row.bgColor != undefined) ? row.bgColor : ''
			});
			
		var imageUrl = '';
		if (row.bgImage != null && row.bgImage.length > 0)	
			imageUrl = row.bgImage;
		fields.push({
				type: 'upload',
			    label: '背景圖片',
			    name: 'bgImage',
				defValue: imageUrl
			});
		return fields;	
	},
	col2EditorField: function(col) {
		var fields = [];
		if (col.category != 'copyright')
			fields = WebFields._commonColEditorField(col);
		fields = WebEditorCols[col.category].colFields(col, fields);
		return fields;
	},
	assign: function(from, to) {
		// common
		to.name = from.name;
		to.fluid = from.fluid;
		to.title = from.title;
		to.col = from.col;

		WebEditorCols[to.category].colAssign(from, to);		
	},
	options: function(col) {
		var opts = {col: WebOptions.cols()};
		opts = WebEditorCols[col.category].colFieldOpts(opts);
		return opts;
	},
	_commonEditorField: function(data) {
		var fields = [];
		fields.push({
			type: 'input',
		    label: '名稱',
		    name: 'name',
		    defValue: (data.name != undefined) ? data.name : ''
		});
		fields.push({
			type: 'input',
		    label: '標題',
		    name: 'title',
		    defValue: (data.title != undefined) ? data.title : ''
		});
		fields.push({
			type: 'checkbox_bool',
		    label: '滿版',
		    name: 'fluid',
		    defValue: (data.fluid != undefined) ? data.fluid : false
		});
		fields.push({
			type: 'input',
		    label: '排序',
		    name: 'seq',
		    defValue: data.seq,
			readOnly: true
		});
		return fields;	
	},	
	_commonColEditorField: function(col) {
		var fields = WebFields._commonEditorField(col);
		fields.push({
			type: 'select',
		    label: '寬度',
		    name: 'col',
		    defValue: (col.col != undefined) ? col.col : 12
		});
		return fields;	
	},	
};