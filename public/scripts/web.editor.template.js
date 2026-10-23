var WebTemplate = {
	editorStyle: function() {
		var style = `
		<style class='editor-panel-style'>
		.editor-panel-setting-btn {position:absolute;top:0px; right:20px; z-index: 1040; border: 1px solid black;min-width: 110px;}
		.editor-panel-preview-btn {position:absolute;top:20px; right:20px; z-index: 1040; border: 1px solid black;min-width: 110px;}
		.editor-panel-save-btn {position:absolute;top:40px; right:20px; z-index: 1040; border: 1px solid black;min-width: 110px;}
		.editor-fluid { width: 100%; margin-right: auto; margin-left: auto; }
		@media (min-width: 768px) {}
		@media (min-width: 1200px) {.container{max-width: 960px !important;}}
		@media (min-width: 1400px) {.container{max-width: 1200px !important;}}
		#footer-editor {margin-top:40px;}
		</style>
		`;
		return style;
	},
	rowStyle: function() {
		var style = `
		<style class='editor-row-style'>
		.editor-row-container { position:relative; padding: 15px; }
		.editor-row { position: relative; margin-top: 5px; padding: 10px; min-height: 55px; font-family: "微軟正黑體","Helvetica Neue",Helvetica,Arial,sans-serif;min-height:120px;}
		.editor-row-footer { position: relative; margin-top: 0px; padding: 0px; padding: 0px; !important}
		.editor-row-add {position:absolute;top:0px; left:40px; left: 50%; transform: translate(-50%, 0); }
		.editor-row-btn-edit { position:absolute; top:-8px;left:-48px;width:36px; z-index: 1040;border: 1px solid black;}
		.editor-row-btn-visible { position:absolute; left:-48px;top:34px;width:36px; z-index: 1040;border: 1px solid black;}
		.editor-row-btn-del { position:absolute;left:-48px;top:76px;width:36px; z-index: 1040;border: 1px solid black;}
		.editor-row-title { position:absolute;top:5px; left:130px; width: auto; z-index: 1040; background-color:#4285f4 !important}
		.editor-row-side-pos {position:absolute;top:20px; left:-80px; width: auto; z-index: 1040;border: 1px solid black;}
		.editor-row-btn-pos-up {position:absolute;top:-80px; left: 50%; transform: translate(-65%, 0);width: auto; z-index: 1040;border: 1px solid black;}
		.editor-row-btn-pos-down {position:absolute;bottom:-26px; left: 50%; transform: translate(-65%, 0);width: auto; z-index: 1040;border: 1px solid black;}
		.editor-row-non-focus { position: relative; border: 3px solid black; }
		.editor-row-focus { position: relative; border: 3px solid blue; }
		</style>
		`;
		return style;	
	},
	colStyle: function() {
		var style = `
		<style class='editor-col-style'>
		.editor-col { position: relative; padding-bottom: 10px; padding-top: 10px; min-height: 80px; }
		.editor-col-hor-add {position:absolute; top:0px; left: 50%; transform: translate(-50%, 0); }
		.editor-col-ver-add { position: absolute; top: 50%; transform: translate(0, -50%); right: -10px; }
		.editor-col-card {background-color: transparent; }
		.editor-col-card-header { margin-bottom: 20px; }
		.editor-col-top-label { position:absolute;top:5px; left:130px; width: auto; z-index: 1040; border: 1px solid black; background-color: #b17c7c !important; }
		.editor-col-top-btn-edit { position:absolute;top:0px; left:0px; width: auto; z-index: 1040;}
		.editor-col-top-btn-visible { position:absolute;top:0px; left:40px; width: auto; z-index: 1040;}
		.editor-col-top-btn-del { position:absolute;top:0px; left:84px; width: auto; z-index: 1040;}
		.editor-col-bottom-label { position:absolute;bottom:5px; left:130px; width: auto; z-index: 1040; border: 1px solid black; background-color: #b17c7c !important; }
		.editor-col-bottom-btn-edit { position:absolute;bottom:0px; left:0px; width: auto; z-index: 1040;}
		.editor-col-bottom-btn-visible { position:absolute;bottom:0px; left:40px; width: auto; z-index: 1040;}
		.editor-col-bottom-btn-del { position:absolute;bottom:0px; left:84px; width: auto; z-index: 1040;}
		.editor-col-non-focus { position: relative; border: 1px dashed black; }
		.editor-col-focus { position: relative; border: 3px solid black; }
		.editor-col-btn-pos-up {position:absolute;top:0px; width: auto; z-index: 1040;border: 1px solid black;}
		.editor-col-btn-pos-down {position:absolute;top:50px; width: auto; z-index: 1040;border: 1px solid black;}
		.editor-col-non-container { width: 80%; margin-left: auto; margin-right: auto;}
		</style>
		`;
		return style;	
	},
	modalStyle: function(category) {
		var modalWidth = 380;
		if (category == 'editor' || category == 'htmlEditor')
			modalWidth = 680;
		var style = `
		<style class='editor-modal-style'>
		.modal-dialog { margin: 1.75rem auto; height: auto; position: absolute; right: 10px; top:20px; max-width:600px; }
		.modal-backdrop { background-color: transparent; }
		.modal-content { background-color: #374250; color: #bbb; font-size: 14px; font-weight: 500; width: {0}px;}
		.DTE_Footer.modal-footer { background-color: #374250; }
		select.form-control { background-color:white; }
		button.close { color: white; font-size: 40px; height: 40px; opacity: 1; position: absolute; top: 0px; right: 10px; }
		.btn.btn-flat { border-bottom: none; border-right: none; }
		.btn.indicator { border: 1px solid #aaa; }
		.DTE_Form_Error { color: yellow !important }
		div.DTE div.DTE_Processing_Indicator span,div.DTE div.DTE_Processing_Indicator:before,div.DTE div.DTE_Processing_Indicator:after { background: #fff; !important}
		</style>
		`.format(modalWidth);
		return style;			
	},
	modalStyleFullscreen: function() {
		var style = `
		<style class='editor-modal-style'>
		.modal-content { background-color: #374250; color: #bbb; font-size: 14px; font-weight: 500;}
		.DTE_Footer.modal-footer { background-color: #374250; }
		select.form-control { background-color:white; }
		button.close { color: white; font-size: 40px; height: 40px; opacity: 1; position: absolute; top: 0px; right: 10px; }
		.btn.btn-flat { border-bottom: none; border-right: none; }
		.btn.indicator { border: 1px solid #aaa; }
		</style>
		`;
		return style;			
	},
	getGlobalStyle: function(cfg) {
		var style =`
			<style>
			</style>
		`.format();
		return style;
	},
	panelToggleHtml: function() {
		var html = `
		<div id="fixed-bottom-row" style="z-index:1030; position:fixed;top: 60px; width:100%; left: 0;">
	        <div class="containerx smooth-scroll" style="position:relative">
	            <a class="btn btn-primary btn-sm editor-panel-btn editor-panel-setting-btn">設定 <i class="fa fa-cog"></i></a>
	        </div>
    	</div>
		<div id="fixed-bottom-row" style="z-index:1030; position:fixed;top: 90px; width:100%; left: 0;">
	        <div class="containerx smooth-scroll" style="position:relative">
	            <a class="btn btn-primary btn-sm editor-panel-btn editor-panel-preview-btn">預覽(關閉)</a>
	        </div>
    	</div>
		<div id="fixed-bottom-row" style="z-index:1030; position:fixed;top: 120px; width:100%; left: 0;">
	        <div class="containerx smooth-scroll" style="position:relative">
	            <a class="btn btn-info btn-sm editor-panel-btn editor-panel-save-btn">儲存</a>
	        </div>
    	</div>
		`;
		return html;
	},
	rowEmptyHtml: function(seq) {
		var html = `
			<div data-row-id="0" data-row-title="" data-row-hidden="false" class="editor-ui">
				<div class="container editor-row-container">
			    	<div class="row">
			        	<div class="col-md-12">
			        		<a onclick="gWebEditor._rowAddFunc({0})"><i class="far fa-plus-square fa-2x editor-row-add"></i></a>
		                	<div class="editor-col-card-header rgba-white-slight"></div>
						</div>	    		            
			        </div>
			    </div>
			</div>
		`.format(seq);
		return html;
	},
	rowHtml: function(r, colsHtml) {
		if (colsHtml == null)
			colsHtml = WebTemplate.colHtml({id:0, col:12});
			
		var container = '';
		if (!r.fluid) {
			container = 'container';
		}
		else {
			container = 'container-fluid';
		}

		var bgImage = '';
		var bgImageClass = '';
		if (r.bgImage != null && r.bgImage.length > 0) {
			var bgImgUrl = r.bgImage.startsWith('vcf/') ? `/upload/images/${r.bgImage}` : `/upload/images/${r.bgImage}`
			bgImage = `
			<style>
			.editor-row-style-{0} {
				background-image:url({1});
				background-repeat: no-repeat;
				background-size: cover;
				background-position: center;
				justify-content: center;
			}
			</style>
			`.format(r.id, bgImgUrl);	
			bgImageClass = ' editor-row-style-' + r.id;
		}

		var dataAttrs = `
			data-row-title="{0}" data-row-hidden="{1}" 
		`.format(r.title, r.hidden);
		
		if (gWebEditor.cfg.preview) {
			dataAttrs = '';
		}

		var html = `
			{6}
			<row data-row-id={0} {8}>
			    <div class="{4} {7} editor-row editor-row-non-focus editor-row-container {5}">
			        <div class="row">
						{3}
			        </div><!-- /.row -->
			    </div><!-- /.container -->
			</row>
		`.format(r.id, r.title, r.hidden, colsHtml, container, WebTemplate.rowHtmlClass(r), bgImage, bgImageClass, dataAttrs);
		return html;
	},
	rowHtmlClass: function(r){
		var cls = (r.bgColor != null) ? r.bgColor : '';
		if (r.copyright == true)
			cls += ' editor-row-footer';
		return cls;
	},
	rowButtonHtml: function(r) {
		var eyeIcon = 'fa-eye';
		var eyeColor = '';
		if (r.hidden) {
			eyeIcon = 'fa-eye-slash';
			eyeColor = 'yellow-text';
		}
			
		var html = `
			<div class="editor-ui">
			<h2><span class="badge badge-white editor-row-title">{1}</span></h2>
			<button type="button" 
	   			class="editor-row-btn-edit-{0} p-1 btn btn-sm btn-primary editor-row-btn editor-row-btn-edit"
    			onclick="gWebEditor._rowEditFunc({0})"><i class="fa fa-2x fa-edit"></i>
    	    </button>
			<button type="button" 
	   			class="editor-row-btn-edit-{0} p-1 btn btn-sm btn-primary editor-row-btn editor-row-btn-visible"
    			onclick="gWebEditor._rowVisibleToggleFunc({0})"><i class="fa fa-2x {2} {3}"></i>
    	    </button>
    	    <button type="button" 
    			class="editor-row-btn-del-{0} p-1 btn btn-sm btn-primary editor-row-btn editor-row-btn-del"
    			onclick="gWebEditor._rowDeleteFunc({0})"><i class="fa fa-2x fa-trash yellow-text"></i>
			</button>
			</div>
		`.format(r.id, r.title, eyeIcon, eyeColor);
		return html;  
	},
	colPositionButtonHtml: function(rowId, colId) {
		var html = `
			<div class='editor-row-side-pos editor-ui'>
			<button type="button" 
	   			class="p-1 btn btn-sm btn-info editor-col-btn-pos editor-col-btn-pos-up"
    			onclick="gWebEditor._colPosChangeFunc({0}, {1}, true)"><i class="fa fa-2x fa-arrow-square-up"></i>
    	    </button>
			<button type="button" 
	   			class="p-1 btn btn-sm btn-info editor-col-btn-pos editor-col-btn-pos-down"
    			onclick="gWebEditor._colPosChangeFunc({0}, {1}, false)"><i class="fa fa-2x fa-arrow-square-down"></i>
    	    </button>
			</div>
		`.format(rowId, colId);
		return html;  
	},
	rowPositionButtonHtml: function(rowId, drawUp, drawDown) {
		var upHtml = '';
		var downHtml = '';
		
		if (drawUp) {
			upHtml = `
				<div class='editor-up-pos editor-ui'>
				<button type="button" 
		   			class="p-1 btn btn-sm btn-info editor-row-btn-pos-up"
	    			onclick="gWebEditor._rowPosChangeFunc({0}, true)"><i class="fa fa-2x fa-retweet"></i>
	    	    </button>
				</div>
			`.format(rowId);	
		}
		
		if (drawDown) {
			downHtml = `
				<div class='editor-down-pos editor-ui'>
				<button type="button" 
		   			class="p-1 btn btn-sm btn-info editor-row-btn-pos-down"
	    			onclick="gWebEditor._rowPosChangeFunc({0}, false)"><i class="fa fa-2x fa-retweet"></i>
	    	    </button>
				</div>
			`.format(rowId);
		}
		
		return `{0} {1}`.format(upHtml, downHtml);
	},
	colEmptyHorHtml: function(seq, rowId) {
		var html = `
			<div class="col-md-12 editor-ui">
				<div class="editor-col-card-header rgba-white-slight"></div>
				<a onclick="gWebEditor._colAddFunc({0}, {1})"><i class="far fa fa-2x fa-plus-circle editor-col-hor-add"></i></a>
			</div>
		`.format(seq, rowId);
		return html;
	},
	colHtml: function(c, rowId) {
		var cardHeader = '';
		if (c.title != null && c.title.length > 0) {
			if (c.category != 'menu') {
				cardHeader = `
				<div class="card-header rgba-white-slight border-0">
		            <h4 class="text-center text-primary editor-col-title-{1}">{0}</h4>
		        </div>
				`.format(c.title, c.id);				
			}
		}
		
		var dataAttrs = `
				data-col-parent-id={0} 
				data-col-id={1} 
				data-col-title="{2}" 
				data-col-hidden="{3}"
				data-col-category="{4}"
		`.format(rowId, c.id, c.title, c.hidden, c.category);
		
		if (gWebEditor.cfg.preview) {
			dataAttrs = '';
		}
			
		var html = `
			<div class="col-md-{1} editor-col editor-col-non-focus" {8}>
				<div class="">
					{5}
				</div>
				{7}
			</div>
		`.format(c.id, c.col, c.title, c.hidden, c.category, 
		cardHeader, rowId, WebEditorCols[c.category].colHtml(c), dataAttrs);
		return html;
	},
	colButtonHtml: function(r, c, pos) {
		var eyeIcon = 'fa-eye';
		var eyeColor = '';
		if (c.hidden) {
			eyeIcon = 'fa-eye-slash';
			eyeColor = 'yellow-text';
		}
		
		var label = `<span class="badge badge-white editor-col-{1}-label">{0}</span>`
				.format(WebOptions.getCategoryLabel(c.category), pos);
				
		var otherButton = '';
		if (c.category == 'empty') {
			otherButton = `
	    	    <button type="button" 
	    			class="editor-row-btn-del-{0} p-1 btn btn-sm btn-black editor-col-{5}-btn-visible"
	    			onclick="gWebEditor._colDeleteFunc({4},{0})"><i class="fa fa-2x fa-trash yellow-text"></i>
				</button>
			`.format(c.id, WebOptions.getCategoryLabel(c.category), eyeIcon, eyeColor, r.id, pos);
			
			label = '';
		}
		else if (r.copyright != true) {
			otherButton = `
				<button type="button" 
		   			class="editor-row-btn-edit-{0} p-1 btn btn-sm btn-black editor-col-{5}-btn-visible"
	    			onclick="gWebEditor._colVisibleToggleFunc({4}, {0})"><i class="fa fa-2x {2} {3}"></i>
	    	    </button>
	    	    <button type="button" 
	    			class="editor-row-btn-del-{0} p-1 btn btn-sm btn-black editor-col-{5}-btn-del"
	    			onclick="gWebEditor._colDeleteFunc({4},{0})"><i class="fa fa-2x fa-trash yellow-text"></i>
				</button>
			`.format(c.id, WebOptions.getCategoryLabel(c.category), eyeIcon, eyeColor, r.id, pos);
		}
		
		var html = `
			<div class="editor-ui">
			<h2>{4}</h2>
			<button type="button" 
	   			class="editor-row-btn-edit-{0} p-1 btn btn-sm btn-black editor-col-{3}-btn-edit"
    			onclick="gWebEditor._colEditFunc({1}, {0})"><i class="fa fa-2x fa-edit"></i>
    	    </button>
			{2}
			</div>
		`.format(c.id, r.id, otherButton, pos, label);
		return html;  
	},
	colFieldStyle: function(cols) {
		var style = '<style>';
		cols.forEach(function(c){
			style += WebEditorCols[c.category].colStyle(c);
		});
		style += '</style>';
		if (style == '<style></style>')
			style = '';
		return style;
	},
};