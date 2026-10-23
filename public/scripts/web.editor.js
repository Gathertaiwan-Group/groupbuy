var gWebEditor = null;

Array.prototype.insert = function(index, item) {
	this.splice(index, 0 ,item);
}

Array.prototype.first = function() {
	if (this.length == 0)
		return null;
	return this[0];
}

Array.prototype.last = function() {
	if (this.length == 0)
		return null;
	return this[this.length - 1];
}

Array.prototype.secondLast = function() {
	if (this.length < 2)
		return null;
	return this[this.length - 2];
}

Array.prototype.swap = function(i1, i2) {
	if (this.length <= i1 || this.length <= i2)
			return;
	var elem = this[i1];
	this[i1] = this[i2];
	this[i2] = elem;
}

//
// WebEditor
//
$.WebEditor = function(editor) {
	this.editor = editor;
	this.cfg = window[editor.data('config')];
	this.panel = [];
	this.focus = {};
	
	if (this.cfg.globalCfg == null) {
		this.cfg.globalCfg = {
			bgColor: ''
		}
	}
	if (!this.editor.hasClass('editor-global-style'))
		this.editor.addClass('editor-global-style');
	
	// preview mode is disabled
	this.cfg.preview = false;

	// check copyright is existed or not?
	if (this.cfg.rows == null)
		return;
	var existed = false;
	this.cfg.rows.forEach(function(r){
		if (r.copyright == true)
			existed = true;
	});
	if (!existed)
		this._appendCopyright();
}

$.WebEditor.prototype = {
	//
	// public functions
	//
	open: function() {
		this._initUI();
		this._registryUI();
		this._draw();
	},
	
	// public functions by Editor invkoing
	webEditorPreviewLabel: function() {
		if (gWebEditor.cfg.preview)
			return '預覽(開啟)';
		else
			return '預覽(關閉)';
	},
	webEditorPreview: function() {
		gWebEditor.cfg.preview = !gWebEditor.cfg.preview;
		gWebEditor._draw();
	},
	webEditorBGColor: function() {
		console.log('bgColor');
	},
	
	//
	// callback events
	//
	_rowAddFunc: function(seq) {
		if (this.disabled == true) return;
		var _this = this;
		var config = this._prepareEditorConfig("新增", 'create');
		config.fields = WebFields.row2EditorField({seq: seq}); 
		
		this._showEditor(null, config, function(id, data){
			var needToAppendCopyright = false;
			if (_this.cfg.rows == null) {
				_this.cfg.rows = [];
				needToAppendCopyright = true;
			}
						
			var row = {
				seq: seq,
				id: Date.now(),
				name: data.name,
				title: data.title,
				hidden: false,
				fluid: data.fluid,
				bgColor: data.bgColor,
				bgImage: data.bgImage
			};

			// insert new row to specific position
			var i=0;			
			for (i=0 ; i<_this.cfg.rows.length ; i++) {
				if (_this.cfg.rows[i].seq >= seq)
					break;
			}
			_this.cfg.rows.insert(i, row);
			
			// rewrite seq according to new position
			for (i=0 ; i<_this.cfg.rows.length ; i++) {
				if (_this.cfg.rows[i].copyright != true)
					_this.cfg.rows[i].seq = i + 1;
			}
			
			if (needToAppendCopyright)
				_this._appendCopyright();	
		});
		this._save();
	},
	_rowEditFunc: function(rowId) {
		if (this.disabled == true) return;
		var row = this._getRow(rowId);
		var config = this._prepareEditorConfig('編輯-' + row.title, 'edit');
		config.editId = row.id;
		config.fields = WebFields.row2EditorField(row);
		
		var _origRow = {};
		var _tmpRow = {};
		Object.assign(_origRow, row);
		Object.assign(_tmpRow, row);
		var _submitted = false;
		var _changed = false;
		var _this = this;
		this._showEditor(null, config, function(id, data){
			_this._updateRowBy(id, data);
			_submitted = true;
		}, true,
		function(){
			// closed
			if (_submitted || !_changed)
				return;
			
			_this._updateRowBy(rowId, _origRow);
			_this._draw();
		},
		function(key, value){
			// changed
			_changed = true;
			_tmpRow[key] = value;
			_this._updateRowBy(rowId, _tmpRow);
			_this._draw();
		});
		this._save();
	},
	_rowVisibleToggleFunc: function(rowId) {
		if (this.disabled == true) return;
		var row = this._getRow(rowId);
		row.hidden = !row.hidden;
		this._draw();
		this._save();
	},
	_rowDeleteFunc: function(rowId) {
		if (this.disabled == true) return;
		var _this = this;
		var row = this._getRow(rowId);
		var config = this._prepareEditorConfig('刪除', 'remove');
		config.editId = row.id;		
		config.ajax = { remove: '' };
		var delMessage = '';
		if (row.title != null && row.title.length > 0)
			delMessage = ` [{0}] `.format(row.title);
		config.message = `確定要刪除{0}區塊?`.format(delMessage);
		
		this._showEditor(null, config, function(id, data){
			_this._delRow(rowId);
			_this.focus.row = null;
			_this.focus.col = null;
		});
		this._save();
	},
	_colAddFunc: function(seq, rowId) {
		if (this.disabled == true) return;
		var _this = this;
		var _category = null;
		var config = this._prepareEditorConfig('選擇類別', 'create');
		config.fields = [
			{
				type: 'gridRadioIcon', 
				label: '類別', 
				name: 'category', 
				defValue:'',
				darkMode: true
			}
		];
		config.options = {category: WebOptions.categories};
		
		this._showEditor(null, config, function(id, data){
			if (data.category != null && data.category.length > 0)
				_category = data.category;
		}, false, function(){
			if (_category == null)
				return;
			_this._colAddCategoryFunc(seq, _this._getRow(rowId), _category);
		});
		this._save();
	},
	_colAddCategoryFunc: function(seq, row, category) {
		if (this.disabled == true) return;
		if (category == null)
			return;
		var _this = this;
		var _error = false;
		var config = this._prepareEditorConfig(WebOptions.getCategoryLabel(category), 'create');
		var col = {seq: seq, col:12, category: category};
		config.fields = WebFields.col2EditorField(col);
		config.options = WebFields.options(col);
		config.dependencies = WebEditorDeps[col.category];
		this._showEditor(category, config, function(id, data){
			if (category == 'menu' && data.menuId == null) {
				_error = true;
				return;
			}
			
			if (_this.cfg.cols == null)
				_this.cfg.cols = {};
			
			if (_this.cfg.cols[row.id] == null)
				_this.cfg.cols[row.id] = [];
			
			var col = {
				id: Date.now(),
				seq: seq,
				hidden: false,
				category: category
			};
			WebFields.assign(data, col);
						
			// insert new col to specific position
			var i=0;			
			for (i=0 ; i<_this.cfg.cols[row.id].length ; i++) {
				if (_this.cfg.cols[row.id][i].seq >= seq)
					break;
			}
			_this.cfg.cols[row.id].insert(i, col);
			
			// rewrite seq according to new position
			for (i=0 ; i<_this.cfg.cols[row.id].length ; i++) {
				_this.cfg.cols[row.id][i].seq = i + 1;
			}
		}, true,
		function(){
			//close
			if (_error) {
				_this._dialog('選單不能為空');
			}
		});
		this._save();
	},
	_colEditFunc: function(rowId, colId) {
		if (this.disabled == true) return;
		var _this = this;		
		var col = this._getCol(rowId, colId);
		var config = this._prepareEditorConfig('編輯-' + WebOptions.getCategoryLabel(col.category), 'edit');
		config.editId = col.id;
		config.fields = WebFields.col2EditorField(col);
		config.options = WebFields.options(col);
		config.dependencies = WebEditorDeps[col.category];
		
		var _origCol = {};
		var _tmpCol = {};
		Object.assign(_origCol, col);
		Object.assign(_tmpCol, col);
		var _submitted = false;
		var _changed = false;
		this._showEditor(col.category, config, function(id, data){
			_this._updateColBy(rowId, colId, data);
			_submitted = true;
		}, true,
		function(){
			// closed
			if (_submitted || !_changed)
				return;
			
			_this._updateColBy(rowId, colId, _origCol);
			_this._draw();
		},
		function(key, value){
			// changed
			_changed = true;
			_tmpCol[key] = value;
			_this._updateColBy(rowId, colId, _tmpCol);
			_this._draw();
		});		
		this._save();
	},
	_colVisibleToggleFunc: function(rowId, colId) {
		if (this.disabled == true) return;
		var col = this._getCol(rowId, colId);
		col.hidden = !col.hidden;
		
		this._draw();
		
		this.focus.row = $('[data-row-id=' + rowId + ']');
		this.focus.col =  $('[data-col-id=' + colId + ']');		
		
		this._drawColFocus();
		this._drawRowFocus();
		this._save();
	},
	_colDeleteFunc: function(rowId, colId) {
		if (this.disabled == true) return;
		var _this = this;
		var col = this._getCol(rowId, colId);
		var config = this._prepareEditorConfig('刪除', 'remove');
		config.editId = col.id;
		config.message = `確定要刪除 [{0}]?`.format(WebOptions.getCategoryLabel(col.category));
		config.ajax = { remove: '' };
		
		this._showEditor(col.category, config, function(id, data){
			_this._delCol(rowId, colId);
			_this.focus.col = null;
		});
		this._save();
	},
	_rowPosChangeFunc: function(rowId, up) {
		if (this.disabled == true) return;
		var row = this._getRow(rowId);
		if (row == null)
			return;
			
		if (up && row.seq == this.cfg.rows.first().seq)
			return;
			
		if (!up && row.seq == this.cfg.rows.last().seq)
			return;
			
		for (var i=0 ; i<this.cfg.rows.length ; i++) {
			if (this.cfg.rows[i].id == row.id) {
				this.cfg.rows.swap(i, (up) ? i - 1 : i + 1);
				break;
			}
		}// for
		this._draw();
		this._save();
	},
	_colPosChangeFunc: function(rowId, colId, up) {
		if (this.disabled == true) return;
		var row = this._getRow(rowId);
		var col = this._getCol(rowId, colId);
		if (col == null || row == null)
			return;
		
		if (up && col.seq == this.cfg.cols[row.id].first().seq)
			return;
			
		if (!up && col.seq == this.cfg.cols[row.id].last().seq)
			return;

		for (var i=0 ; i<this.cfg.cols[row.id].length ; i++) {
			if (this.cfg.cols[row.id][i].id == col.id) {
				this.cfg.cols[row.id].swap(i, (up) ? i - 1 : i + 1);
				break;
			}
		}// for
		this._draw();
		this._save();
	},
	
	//
	// private functions
	//
	_initStyle: function() {
		this.editor.append(WebTemplate.getGlobalStyle(this.cfg.globalCfg));
		this.editor.append(WebTemplate.editorStyle());
		this.editor.append(WebTemplate.rowStyle());
		this.editor.append(WebTemplate.colStyle());
	},	
	_initUI: function() {
		if (this.editor.css('display') != 'none')
	        $('main').append(WebTemplate.panelToggleHtml());
	},
	_registryUI: function() {
		var _this = this;
		$('.editor-panel-setting-btn').click(function(){
            _this._openEditorPanel();
        });
		$('.editor-panel-preview-btn').click(function(){
            _this.webEditorPreview();
			$(this).text(_this.webEditorPreviewLabel());
        });
		$('.editor-panel-save-btn').click(function(){
            if (_this.cfg.submit != null)
				_this.cfg.submit();
        });
	},
	_openEditorPanel: function() {
		var config = this._prepareEditorConfig('設定', 'edit');
		config.editId = (this.cfg.homeViewCacheId != null) ? this.cfg.homeViewCacheId : 0;
		config.fields = WebFields.panelEditorField(this.cfg.globalCfg);


		// append extra buttons if needed		
		if (this.cfg.panel != null) {
			this.cfg.panel.forEach(function(item){
				if (item.type == 'button') {
					config.fields.push({
						type: 'button',
					    label: item.label,
					    name: item.name,
					    defValue: item.func
					});
				}
			});			
		}
		
        var _origCfg = {};
		Object.assign(_origCfg, this.cfg.globalCfg);
		var _submitted = false;
		var _changed = false;
        var _this = this;
		this._showEditor(null, config, function(id, data){
			_submitted = true;
		}, true,
		function(){
			// closed
			if (_submitted || !_changed)
				return;
				
			Object.assign(this.cfg.globalCfg, _origCfg);
			_this._draw();
		},
		function(key, value){
			// changed
			_changed = true;
			_this.cfg.globalCfg[key] = value;
			_this._draw();
		});		
		this._save();
	},
	_save: function() {
		
	},
	_draw: function() {
		var _this = this;
		var seq = 1;
		
		// keep current focus information
		var currFocusRowId = (this.focus.row != null) ? this.focus.row.data('rowId') : null;
		var currFocusColId = (this.focus.col != null) ? this.focus.col.data('colId') : null;
		
		// clear editor
		this.editor.empty();
		this._initStyle();
		
		// apply global style
		var globalCls = 'editor-global-style ';
		if (this.cfg.globalCfg.bgColor != null)
			globalCls += this.cfg.globalCfg.bgColor + ' ';
		this.editor.prop('class', globalCls);
		
		// insert the first empty row
		if (!this.cfg.preview)
			this.editor.append(WebTemplate.rowEmptyHtml(seq));

		if (this.cfg.rows == null)
			return;
			
		// traverse all rows and colso
		this.cfg.rows.forEach(function(row){
			// get col data according to row's name property
			var colSeq = 1;
			var colsHtml = '';
			if (row.copyright != true)
				colsHtml = WebTemplate.colEmptyHorHtml(colSeq, row.id);
			var colStyle = '';
			if (_this.cfg.cols != null) {
				var cols = _this.cfg.cols[row.id];
				if (cols != undefined) {
					// prepare all cols html
					var totalCols = 0;
					for (var i=0 ; i<cols.length ; i++) {
						col = cols[i];
						colsHtml += WebTemplate.colHtml(col, row.id);
						
						// insert empty col
						colSeq += 1;
						totalCols += col.col;
						var insertEmpty = true;
						if (i < cols.length - 1) {
							if (totalCols + cols[i + 1].col <= 12)
								insertEmpty = false;
						}
						
						if (insertEmpty && row.copyright != true) {
							colsHtml += WebTemplate.colEmptyHorHtml(colSeq, row.id);
							totalCols = 0;
						}
					}; // for (var i=0;..)
					colStyle += WebTemplate.colFieldStyle(cols);
				} // if (cols != undefined) {
			}
			
			// append row html & style
			_this.editor.append(colStyle);
			_this.editor.append(WebTemplate.rowHtml(row, colsHtml));
			
			// load data by ajax if needing
			if (_this.cfg.rows != null) {
				_this.cfg.rows.forEach(function(row){
					if (_this.cfg.cols == null || _this.cfg.cols[row.id] == null)
						return;
					_this.cfg.cols[row.id].forEach(function(c){
						WebEditorCols[c.category].colLoad(c);
					});
				});				
			}
			
			// inject edit buttons for row and col
			_this._appendEditButton(row);

			if (row.copyright != true) {
				// insert empty row
				seq += 1;
				_this.editor.append(WebTemplate.rowEmptyHtml(seq));	
			}
		});	//this.cfg.rows.forEach(function(row){
		
		// registry click event for each col
		$('.editor-col').on('click', function(event){
			if (_this.cfg.preview)
				return;
				
			_this.focus.row = null;
			_this.focus.col = null;
			_this._draw();
			
			_this.focus.row = $('[data-row-id=' + $(this).data('colParentId') + ']');
			_this.focus.col =  $('[data-col-id=' + $(this).data('colId') + ']');
			
			_this._drawColFocus();
			_this._drawRowFocus();
			
			// stop event propagation because already know the row's id
			event.stopPropagation();
		});
		
		// registry click event for each row
		$('.editor-row').on('click', function(){
			if (_this.cfg.preview)
				return;

			_this.focus.row = null;
			_this.focus.col = null;
			_this._draw();
			
			var rowId = $(this).parent().data('rowId');
			_this.focus.row = $($.find('[data-row-id=' + rowId + ']'));
			_this._drawRowFocus();
		});
		
		// recover current focus
		if (currFocusRowId != null && currFocusColId != null) {
			this.focus.row = $('[data-row-id=' + currFocusRowId + ']');
			this.focus.col =  $('[data-col-id=' + currFocusColId + ']');
			this._drawColFocus();
			this._drawRowFocus();
		}
		else if (currFocusRowId != null) {
			this.focus.col = null;
			this.focus.row = $('[data-row-id=' + currFocusRowId + ']');
			this._drawRowFocus();
		}
		
		if (this.cfg.preview) {
			// if preview is enabled, remove all editor-ui components
			$('.editor-ui').remove();
			$('.editor-row').removeClass('editor-row-focus');
			$('.editor-row').removeClass('editor-row-non-focus');
			$('.editor-col').removeClass('editor-col-focus');
			$('.editor-col').removeClass('editor-col-non-focus');
			$('.editor-col').removeClass('editor-col');
		}
	},
	_drawColFocus: function() {
		// recover all cols
		$('.editor-row-side-pos').remove();
		this.focus.row.find('.editor-col').removeClass('editor-col-focus');
		this.focus.row.find('.editor-col').removeClass('editor-col-non-focus');

		if (this.focus.row == null || this.focus.row.length == 0 ||
				this.focus.col == null ||  this.focus.col.length == 0) {
			return;
		}
				
		// apply according focus's col
		var _this = this;
		this.focus.row.find('.editor-col').each(function(){
			if ($(this).data('colId') == _this.focus.col.data('colId'))
				$(this).addClass('editor-col-focus');
			else
				$(this).addClass('editor-col-non-focus');
		});
		
		// draw side buttons of row
		var row = this._getRow(this.focus.row.data('rowId'));
		if (row.copyright == true)
			return;

		this.focus.row.children('.editor-row-container').append(
			WebTemplate.colPositionButtonHtml(
				this.focus.row.data('rowId'), 
				this.focus.col.data('colId')
			)
		);	
	},
	_drawRowFocus: function() {
		// recover all cols
		$('.editor-up-pos').remove();
		$('.editor-down-pos').remove();
		$('.editor-row').removeClass('editor-row-focus');
		$('.editor-row').removeClass('editor-row-non-focus');

		if (this.focus.row == null || this.focus.row.length == 0) {
			return;
		}
		
		// apply according focus's row
		var _this = this;
		$('.editor-row').each(function(){
			if ($(this).parent().data('rowId') == _this.focus.row.data('rowId'))
				$(this).addClass('editor-row-focus');
			else
				$(this).addClass('editor-row-non-focus');
		});
		
		// draw up/down rotation button
		var row = this._getRow(this.focus.row.data('rowId'));
		if (row.copyright == true)
			return;
		
		var drawDown = false;
		if (this.cfg.rows.secondLast() != null)
			drawDown = (this.focus.row.data('rowId') == this.cfg.rows.secondLast().id) ? false : true;
			
		this.focus.row.children('.editor-row-container').append(
			WebTemplate.rowPositionButtonHtml(
				this.focus.row.data('rowId'), 
				(this.focus.row.data('rowId') == this.cfg.rows.first().id) ? false : true,
				drawDown
			)
		);
	},
	_appendEditButton: function(row) {
		var obj = $('[data-row-id=' + row.id + ']');
		if (obj.length == 0)
			return;	

		if (row.copyright != true)
			obj.children('.editor-row-container').append(WebTemplate.rowButtonHtml(row));
		
		var _this = this;
		var count = 0;
		obj.find('.editor-col').each(function(){
			var col = _this._getCol(row.id, $(this).data('colId'));
			if (col == null)
				return;
			$(this).append(WebTemplate.colButtonHtml(row, col, (count % 2 == 0) ? 'top' : 'bottom'));
			count += 1;
		});
	},
	_prepareEditorConfig: function(title, action) {
		var ajax = {};
		if (action == 'edit')
			ajax.edit = '';
		else if (action == 'remove')
			ajax.remove = '';
		else if (action != null)
			ajax.create = '';
			
		var config = {
			title: title,
			ajax: ajax,
			disableModalFade: true
		};
		return config;
	},
	_showEditor: function(category, config, submit, style = false, closed = null, changed) {
		if (style) {
			$('body').append(WebTemplate.modalStyle(category));
			$.fn.dataTable.Editor.defaults.formOptions.main.onBackground = 'none';
			$.fn.dataTable.Editor.defaults.formOptions.bubble.onBackground = 'none';
		}
		else {
			$('body').append(WebTemplate.modalStyleFullscreen());
		}
		
		var convertVal = function(k, v) {
			if (k == 'hidden' || k == 'fluid')
				return (v == '1') ? true : false;
			else if (k == 'seq' || k == 'col')
				return parseInt(v);
			else
				return v;
		}
		
		var _this = this;
		EditorManager.show(config, null, null,
			function(action, data){
				//presubmit
				if (submit == null)
					return false;
					
				for (const [key, value] of Object.entries(data)) {
					//temporarily
					for (const [k, v] of Object.entries(value)) {
						value[k] = convertVal(k, v);
					}
					
					submit(key, value);
				}
				_this._draw();
				return false; // stop the editor to call create URL
			}, function(name, value){
				// change
				if (changed)
					changed(name, convertVal(name, value));
			},
			function() {
				// closed
				if (style) {
					$('.editor-modal-style').remove();
					$.fn.dataTable.Editor.defaults.formOptions.main.onBackground = 'blur';
					$.fn.dataTable.Editor.defaults.formOptions.bubble.onBackground = 'blur';
				}
				if (closed != null)
					closed();
			}
		);
	},
	_dialog: function(message) {
		$('body').append(WebTemplate.modalStyleFullscreen());
		var _this = this;
		var config = {
			title: '訊息',
			message: message,
			ajax: {
				close: ''
			},
			disableModalFade: true
		};
		EditorManager.show(config, null, null,
			function(action, data){
				return false; // stop the editor to call create URL
			}
		);
	},
	_getRow: function(rowId) {
		if (this.cfg.rows != null) {
			for (var i=0 ; i<this.cfg.rows.length ; i++) {
				if (this.cfg.rows[i].id == rowId)
					return this.cfg.rows[i];
			}			
		}
		return null;
	},
	_updateRowBy: function(rowId, data) {
		if (this.cfg.rows == null)
			return;
		
		for (var i=0 ; i<this.cfg.rows.length ; i++) {
			if (this.cfg.rows[i].id == rowId) {
				Object.assign(this.cfg.rows[i], data);
				return;
			}
		}
		return;
	},
	_delRow: function(rowId) {
		if (this.cfg.rows == null)
			return;
		for (var i=0 ; i<this.cfg.rows.length ; i++) {
			if (this.cfg.rows[i].id == rowId) {
				this.cfg.rows.splice(i, 1);
				break;
			}
		}
	},
	_getCol: function(rowId, colId) {
		if (this.cfg.cols == null)
			return null;
		if (this.cfg.cols[rowId] == null)
			return null;
			
		var col = null;
		this.cfg.cols[rowId].forEach(function(c){
			if (c.id == colId) {
				col = c;
			}
		});
		return col;
	},
	_updateColBy: function(rowId, colId, data) {
		if (this.cfg.cols == null)
			return;
		if (this.cfg.cols[rowId] == null)
			return;

		for (var i=0 ; i<this.cfg.cols[rowId].length ; i++) {
			if (this.cfg.cols[rowId][i].id == colId) {
				WebFields.assign(data, this.cfg.cols[rowId][i]);
				return;
			}
		}
	},
	_delCol: function(rowId, colId) {
		if (this.cfg.cols == null)
			return;
		if (this.cfg.cols[rowId] == null)
			return;
		
		for (var i=0 ; i<this.cfg.cols[rowId].length ; i++) {
			if (this.cfg.cols[rowId][i].id == colId) {
				this.cfg.cols[rowId].splice(i, 1);
				break;
			}
		}
	},
	_appendCopyright: function() {
		var crRow = {
			seq: 99999,
			id: Date.now() + 1,
			name: 'copyright',
			title: '',
			hidden: false,
			fluid: true,
			copyright: true
		};
		this.cfg.rows.push(crRow);
		
		if (this.cfg.cols == null)
			this.cfg.cols = {};
	
		if (this.cfg.cols[crRow.id] == null)
			this.cfg.cols[crRow.id] = [];

		var crCol = {
			id: Date.now(),
			seq: 1,
			hidden: false,
			fluid: true,
			col: 12,
			category: 'copyright'
		};
		this.cfg.cols[crRow.id].push(crCol);
	},
}

$.fn.extend({
	open: function(cfg) {
		$.find('[data-editor="editor"]').forEach(function(editor){
			gWebEditor = new $.WebEditor($(editor));
			gWebEditor.editor.parent().removeClass('container-fluid');
			gWebEditor.editor.parent().addClass('container');
		});
		if (menuCache != null)
			menuCache.clean();
		gWebEditor.open();
	},
	disable: function() {
		gWebEditor.disabled = true;
	},
	enable: function() {
		gWebEditor.disabled = false;
	},
	getConfig: function() {
		var cfg = {};
		cfg.globalCfg = gWebEditor.cfg.globalCfg;
		cfg.rows = gWebEditor.cfg.rows;
		cfg.cols = gWebEditor.cfg.cols;
		this.ensureFullSocialMediaUrl(cfg.cols);
		return cfg;
	},
	getHtml: function() {
		// switch to preview mode
		gWebEditor.cfg.preview = true;
		gWebEditor._draw();
		
		// get preview's html
		//
		// remove all unnecessry style
		//
		$('.editor-panel-style').remove();
		$('.editor-row-style').remove();
		$('.editor-col-style').remove();
		var editorHtml = gWebEditor.editor.html();
		
		// switch to editor mode
		gWebEditor.cfg.preview = false;
		gWebEditor._draw();

		// append global style
		editorHtml = `
			<div class='{0}'>{1}</div>
		`.format(gWebEditor.editor.prop('class'), editorHtml);
		return editorHtml;
	},
	ensureFullSocialMediaUrl: function(obj) {
		if (!obj || JSON.stringify(obj) === '{}') return;
		for (let key in obj) {
			const arr = obj[key];
			for (let i = 0; i < arr.length; i++) {
				const o = arr[i];
				if (o.hasOwnProperty('fb') && !!o['fb']) {
					o['fb'] = ensureFullFacebookUrl(o['fb']);
				}
				if (o.hasOwnProperty('ig') && !!o['ig']) {
					o['ig'] = ensureFullInstagramUrl(o['ig']);
				}
				if (o.hasOwnProperty('line') && !!o['line']) {
					o['line'] = ensureFullLineUrl(o['line']);
				}
			}
		}

		function ensureFullFacebookUrl(input) {
			if (!input) return input;
			// Check if input starts with either http:// or https://, followed by www (optional), and then facebook.com/
			if (/^https?:\/\/(www\.)?facebook\.com\//.test(input)) {
				return input;  // If it matches, return the input as it is
			} else {
				// If not, prepend 'https://www.facebook.com/' to the input
				return 'https://www.facebook.com/' + input;
			}
		}

		function ensureFullInstagramUrl(input) {
			if (!input) return input;
			// Check if input starts with either http:// or https://, followed by www (optional), and then instagram.com/
			if (/^https?:\/\/(www\.)?instagram\.com\//.test(input)) {
				return input;  // If it matches, return the input as it is
			} else {
				// If not, prepend 'https://www.instagram.com/' to the input
				return 'https://www.instagram.com/' + input;
			}
		}

		function ensureFullLineUrl(input) {
			if (!input) return input;
			if (input.startsWith('https://line.me/R/ti/p/')) {
				return input;
			} else {
				return 'https://line.me/R/ti/p/' + input;
			}
		}
	}
});	
