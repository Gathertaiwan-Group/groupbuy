/*
	每新增一個 category, 都需要新增下面幾個 function
	category: { //直接對應 WebOptions.categories 裡面的 value
		colDefault: {
			//col 裡面參數所需要的預設值	
		},
		colHtml: function(c) {
			//此 col 所需要的客製化 HTML
			return html;
		},
		colStyle: function(c) {
			//此 col 所需要的客製化 CSS style
			return style;
		},
		colFields: function(c, fields) {
			//此 col 要顯示在 Editor 上的欄位有哪些
			return fields;
		},
		colFieldOpts: function(opts) {
			//如果Editor 有使用到 select, 所需要用到的 options 資料有哪些
			return opts;
			},
		colAssign: function(from, to) {
			//Editor 儲存時, 有哪些資料是要被儲存的
		},
		colLoad: function(c) {
			//如果 col 是 select2 類型, 可以透過 colLoad 來動態載入資料
		}
	},
*/

$.WebEditorMenuCache = function() {
	this.cache = {};
}

$.WebEditorMenuCache.prototype = {
	clean: function() {
		this.cache = {};
	},
	getCache: function(menuId) {
		var key = gWebEditor.editor.data('groupBuyId') + '-' + menuId;
		return this.cache[key];
	},
	setCache: function(menuId, data) {
		var key = gWebEditor.editor.data('groupBuyId') + '-' + menuId;
		this.cache[key] = data;
	}
}

// Disable menu cache
//var menuCache = null;

// Enabled menu cache
var menuCache = new $.WebEditorMenuCache();

WebEditorCols = {
	//
	// Common
	//
	commonClass: function(c) {
		var cls = '';
		if (c.fluid) {
			cls += 'editor-fluid ';
		}
		return cls;		
	},
	//
	// Label
	//
	label: {
		colDefault: {
			fontSize: 12,
			fontColor: 'black',
			bgColor: 'rgb-none',	
		},
		colHtml: function(c) {
			if (c.text == null)
				return '';
				
			// class
			var cls = WebEditorCols.commonClass(c);
			if (c.text != null) {
				cls += `{0}-text {1}`
					.format((c.fontColor != null) ? c.fontColor : WebEditorCols.label.colDefault.fontColor,
							(c.bgColor != null) ? c.bgColor : WebEditorCols.label.colDefault.bgColor);
			}; 
			
			// underline tag
			var uStart = '';
			var uEnd = '';
			if (c.fontType != null) {
				var types = c.fontType.split(',');
				uStart = (types.includes('underline')) ? '<u>' : '';
				uEnd = (types.includes('underline')) ? '</u>' : '';
			}
			
			return `<label class='editor-col-style-label-{0} {2}'>{3} {1} {4}</label>`
					.format(c.id, c.text, cls, uStart, uEnd);
		},
		colStyle: function(c) {
			var bold = '';
			var italy = '';
			var align = '';
			if (c.fontType != null) {
				var types = c.fontType.split(',');
				bold = (types.includes('bold'))? 'font-weight: bold;' : '' ;
				italy = (types.includes('italic'))? 'font-style: italic;' : '' ;
			}
			
			if (c.fontAlign != null) {
				if (c.fontAlign == 'align-left')
					align = 'text-align: left;';
				if (c.fontAlign == 'align-center')
					align = 'text-align: center;';
				if (c.fontAlign == 'align-right')
					align = 'text-align: right;';
			}
			var style = `
				.editor-col-style-label-{0} \{
					font-size: {1}px;  {2} {3} {4}
					margin-bottom: 0px;
				\}
				`.format(c.id, 
					(c.fontSize != null) ? c.fontSize : WebEditorCols.label.colDefault.fontSize,
					bold, italy, align);
			return style;
		},
		colFields: function(c, fields) {
			fields.push({
				type: 'input',
			    label: '文字',
			    name: 'text',
			    defValue: (c.text != undefined) ? c.text : ''
			});
			fields.push({
				type: 'select',
			    label: '文字大小',
			    name: 'fontSize',
			    defValue: (c.fontSize != undefined) ? c.fontSize : WebEditorCols.label.colDefault.fontSize
			});
			fields.push({
				type: 'fontType',
			    label: '文字樣式',
			    name: 'fontType',
				darkMode: true,
			    defValue: (c.fontType != undefined) ? c.fontType : ''
			});
			fields.push({
				type: 'fontAlign',
			    label: '文字對齊',
			    name: 'fontAlign',
				darkMode: true,
			    defValue: (c.fontAlign != undefined) ? c.fontAlign : ''
			});
			fields.push({
				type: 'colorPicker',
			    label: '文字顏色',
			    name: 'fontColor',
				colorType: 'text',
			    defValue: (c.fontColor != undefined) ? c.fontColor : WebEditorCols.label.colDefault.fontColor
			});
			fields.push({
				type: 'colorPicker',
			    label: '背景顏色',
			    name: 'bgColor',
				colorType: 'bg',
			    defValue: (c.bgColor != undefined) ? c.bgColor : WebEditorCols.label.colDefault.bgColor
			});
			return fields;
		},
		colFieldOpts: function(opts) {
			opts.fontSize = WebOptions.fontSize();
			return opts;
		},
		colAssign: function(from, to) {
			to.text = from.text;
			to.fontSize = from.fontSize;
			to.fontColor = from.fontColor;
			to.bgColor = from.bgColor;
			to.fontType = from.fontType;
			to.fontAlign = from.fontAlign;
		},
		colLoad: function(c) {			
		},
	},
	//
	// ckeditor5
	//
	editor: {
		colDefault: {
			fontColor: 'black',
			bgColor: 'rgb-none',
		},
		colHtml: function(c) {
			var html = `
				<div class='{1}-text {2}'>
					<div class="d-none d-md-block">
						{0}
					</div>
					<div class="d-md-none">
						<div class="text-center"> {0} </div>
					</div>
				</div>
				`
				.format(c.htmlContent,
					(c.fontColor != undefined) ? c.fontColor : WebEditorCols.editor.colDefault.fontColor,
					(c.bgColor != undefined) ? c.bgColor : WebEditorCols.editor.colDefault.bgColor);
			return html;
		},
		colStyle: function(c) {
			var style = '';
			return style;
		},
		colFields: function(c, fields) {
			fields.push({
				type: 'colorPicker',
			    label: '文字顏色',
			    name: 'fontColor',
				colorType: 'text',
			    defValue: (c.fontColor != undefined) ? c.fontColor : WebEditorCols.editor.colDefault.fontColor
			});
			fields.push({
				type: 'colorPicker',
			    label: '背景顏色',
			    name: 'bgColor',
				colorType: 'bg',
			    defValue: (c.bgColor != undefined) ? c.bgColor : WebEditorCols.editor.colDefault.bgColor
			});
			fields.push({
				type: 'ckeditor5',
			    label: '編輯器',
			    name: 'htmlContent',
				defValue: (c.htmlContent != undefined) ? c.htmlContent : ''
			});
			return fields;
		},
		colFieldOpts: function(opts) {
			return opts;
			},
		colAssign: function(from, to) {
			to.htmlContent = from.htmlContent;
			to.fontColor = from.fontColor;
			to.bgColor = from.bgColor;
		},
		colLoad: function(c) {			
		},
	},
	//
	// copyright
	//
	copyright: {
		colDefault: {
			bgColor: 'gray',
			fontColor: 'rgb-none'
		},
		colHtml: function(c) {
			var year = new Date().getYear() + 1900;
			var html = `
				<div class="footer-copyright text-center py-3 {1}-text {2}">
				© {0} Powered by <a href="https://groupbuyforms.tw" class="{1}-text"> 伊洛帕科技</a>
				</div>
			`.format(year,
					(c.fontColor != null) ? c.fontColor : WebEditorCols.copyright.colDefault.fontColor,
					(c.bgColor != null) ? c.bgColor : WebEditorCols.copyright.colDefault.bgColor);
			return html;
		},
		colStyle: function(c) {
			return '';
		},
		colFields: function(c, fields) {
			fields.push({
				type: 'colorPicker',
			    label: '文字顏色',
			    name: 'fontColor',
				colorType: 'text',
			    defValue: (c.fontColor != undefined) ? c.fontColor : WebEditorCols.copyright.colDefault.fontColor
			});
			fields.push({
				type: 'colorPicker',
			    label: '背景顏色',
			    name: 'bgColor',
				colorType: 'bg',
			    defValue: (c.bgColor != undefined) ? c.bgColor : WebEditorCols.copyright.colDefault.bgColor
			});
			return fields;
		},
		colFieldOpts: function(opts) {
			return opts;
		},
		colAssign: function(from, to) {
			to.fontColor = from.fontColor;
			to.bgColor = from.bgColor;
			to.fluid = true;
			to.hidden = false;
			to.col = 12;
		},
		colLoad: function(c) {			
		},
	},
	//
	// line
	//
	line: {
		colDefault: {
			bgColor: 'white'
		},
		colHtml: function(c) {
			var html = `
				<hr class="editor-col-style-line-{0} {1}">
			`.format(c.id, c.bgColor);
			return html;
		},
		colStyle: function(c) {
			var style = `
				.editor-col-style-line-{0} \{
				\}
				`.format(c.id);
			return style;
		},
		colFields: function(c, fields) {
			fields.push({
				type: 'colorPicker',
			    label: '分隔線顏色',
			    name: 'bgColor',
				colorType: 'bg',
			    defValue: (c.bgColor != undefined) ? c.bgColor : WebEditorCols.line.colDefault.bgColor
			});
			return fields;
		},
		colFieldOpts: function(opts) {
			return opts;
		},
		colAssign: function(from, to) {
			to.bgColor = from.bgColor;
		},
		colLoad: function(c) {			
		},
	},
	//
	// menu
	//
	menu: {
		colDefault: {
			fontSize: 20,
			fontColor: 'black',
			fontAlign: 'align-center',
			menuStyle: 'horizontal'
		},
		colHtml: function(c) {
			var html = `
				<div class="editor-col-menu-{0}">
					<div class="text-center {1}-text"> 載入中... </div>
				</div>
			`.format(c.id, c.fontColor);
			return html;
		},
		colStyle: function(c) {
			var bold = '';
			var italy = '';
			if (c.fontType != null) {
				var types = c.fontType.split(',');
				bold = (types.includes('bold'))? 'font-weight: bold;' : '' ;
				italy = (types.includes('italic'))? 'font-style: italic;' : '' ;
			}
			
			var style = `
				.editor-col-menu-{0} {
					font-size: {1}px; {2} {3}
				}
				.editor-col-menu-title-{0} {
					font-size: {4}px;
				}
				.editor-col-htmleditor-{0} {
					list-style: none; 
					padding: 0px; 
					display: flex!important;
				}
				.editor-col-htmleditor-{0}>li {
					border-left: 1px solid #000;
					padding: 5px;
				}
				.editor-col-htmleditor-{0}>li:last-child {
					border-right: 1px solid #000;
				}
				.editor-col-htmleditor-mobile-{0} {
					list-style: none; 
				}
				`.format(c.id, c.fontSize, bold, italy, (c.fontSize + 4));
			return style;
		},
		colFields: function(c, fields) {
			fields.push({
				type: 'select2',
			    label: '選單',
			    name: 'menuId',
				ajaxUrl: GBF.baseUrl + '/ajax/WebMenu/listMenu.do?groupBuyId=' + gWebEditor.editor.data('groupBuyId'),
			    defValue: (c.menuId != undefined) ? c.menuId : ''
			});
			fields.push({
				type: 'select',
			    label: '文字大小',
			    name: 'fontSize',
			    defValue: (c.fontSize != undefined) ? c.fontSize : WebEditorCols.menu.colDefault.fontSize
			});
			fields.push({
				type: 'fontType',
			    label: '文字樣式',
			    name: 'fontType',
				darkMode: true,
			    defValue: (c.fontType != undefined) ? c.fontType : ''
			});
			fields.push({
				type: 'colorPicker',
			    label: '文字顏色',
			    name: 'fontColor',
				colorType: 'text',
			    defValue: (c.fontColor != undefined) ? c.fontColor : WebEditorCols.menu.colDefault.fontColor
			});
			fields.push({
				type: 'fontAlign',
			    label: '文字對齊',
			    name: 'fontAlign',
				darkMode: true,
			    defValue: (c.fontAlign != undefined) ? c.fontAlign : WebEditorCols.menu.colDefault.fontAlign
			});
			fields.push({
				type: 'select',
			    label: '樣式',
			    name: 'menuStyle',
			    defValue: (c.menuStyle != undefined) ? c.menuStyle : WebEditorCols.menu.colDefault.menuStyle
			});
			return fields;
		},
		colFieldOpts: function(opts) {
			opts.fontSize = WebOptions.fontSize();
			opts.menuStyle = WebOptions.menuStyle();
			return opts;
		},
		colAssign: function(from, to) {
			to.menuId = parseInt(from.menuId);
			to.menuStyle = from.menuStyle;
			to.fontColor = from.fontColor;
			to.fontAlign = from.fontAlign;
			to.fontSize = from.fontSize;
			to.fontType = from.fontType;
		},
		colLoad: function(c) {
			if (menuCache != null) {
				var menu = menuCache.getCache(c.menuId);
				if (menu != null) {
					WebEditorCols.menu._draw(c, menu);
					return;
				}
			}
			var url = GBF.baseUrl + '/ajax/WebMenu/listMenuNode.do';
			
			var data = {
				groupBuyId: gWebEditor.editor.data('groupBuyId'),
				webMenuId: c.menuId
			};
			
			var async = (gWebEditor.cfg.async != null) ? gWebEditor.cfg.async : true;
			$.ajax({
				type: 'POST',
				url: url,
				data: data,
				success: function(menu){
					//success
					if (menuCache != null)
						menuCache.setCache(c.menuId, menu);
					WebEditorCols.menu._draw(c, menu);
				},
				dataType: 'json',
				async: async
			});
		},
		_draw: function(c, menu) {
			var html = '';
			if (c.menuStyle == 'horizontal')
				html += WebEditorCols.menu._horizontalHtml(c, menu);
			else if (c.menuStyle == 'horizontal-line')
				html += WebEditorCols.menu._horizontalLineHtml(c, menu);
			else if (c.menuStyle == 'vertical')
				html += WebEditorCols.menu._verticalHtml(c, menu);
				
			$('.editor-col-menu-' + c.id).html(html);
		},
		_verticalHtml: function(c, menu) {
			var align = '';
			if (c.fontAlign == 'align-left')
				align = 'text-left';
			else if (c.fontAlign == 'align-center')
				align = 'text-center';
			else if (c.fontAlign == 'align-right')
				align = 'text-right';
			
			// underline tag
			var uStart = '';
			var uEnd = '';
			if (c.fontType != null) {
				var types = c.fontType.split(',');
				uStart = (types.includes('underline')) ? '<u>' : '';
				uEnd = (types.includes('underline')) ? '</u>' : '';
			}
			
			var html = `<ul class="{0}" style="list-style: none; padding-left: 0px;">`
					.format(align);
					
			if (c.title != null && c.title.length > 0) {
				html += `<li class="{1}-text"><strong editor-col-menu-title-{2}>{0}</strong></li>`
					.format(c.title, c.fontColor, c.id);
			}
			menu.forEach(function(m){
				if (m.link == null || m.link.length == 0 || m.link == 'NA') {
					html += `<li class="{1}-text">{2} {0} {3}</li>`
							.format(m.text, c.fontColor, uStart, uEnd);
				}
				else {
					html += `<li class=""><a href="{0}" class="{2}-text">{3} {1} {4}</a></li>`
							.format(m.link, m.text, c.fontColor ,uStart, uEnd);
				}
			});
			html += '</ul>';
			return html;
		},
		_horizontalHtml: function(c, menu) {
			// underline tag
			var uStart = '';
			var uEnd = '';
			if (c.fontType != null) {
				var types = c.fontType.split(',');
				uStart = (types.includes('underline')) ? '<u>' : '';
				uEnd = (types.includes('underline')) ? '</u>' : '';
			}

			var align = '';
			if (c.fontAlign == 'align-left')
				align = 'justify-content-start';
			else if (c.fontAlign == 'align-center')
				align = 'justify-content-between';
			else if (c.fontAlign == 'align-right')
				align = 'justify-content-end';
				
			var content = '';
			menu.forEach(function(m){
				if (m.link == null || m.link.length == 0 || m.link == 'NA') {
					content += `
						<div class="col-md-auto mb-1 px-0 mx-sm-3">
						    <label class="text-uppercase {2}-text">{3} {1} {4}</label>
						</div>
					`.format(m.link, m.text, c.fontColor, uStart, uEnd);
				}
				else {
					content += `
						<div class="col-md-auto mb-1 px-0 mx-sm-3">
						    <label class="text-uppercase"><a class="{2}-text" href="{0}">{3} {1} {4}</a></label>
						</div>
					`.format(m.link, m.text, c.fontColor, uStart, uEnd);					
				}
			});
			
			var html = `
					<div class="d-none d-md-block">
						<div class="row {1}"> {0} </div>
					</div>
					<div class="d-md-none">
						<div class="row text-center"> {0} </div>
					</div>
				`.format(content, align);
			return html;			
		},
		_horizontalLineHtml: function(c, menu) {
			// underline tag
			var uStart = '';
			var uEnd = '';
			if (c.fontType != null) {
				var types = c.fontType.split(',');
				uStart = (types.includes('underline')) ? '<u>' : '';
				uEnd = (types.includes('underline')) ? '</u>' : '';
			}

			var align = '';
			if (c.fontAlign == 'align-left')
				align = 'justify-content-start';
			else if (c.fontAlign == 'align-center')
				align = 'justify-content-center';
			else if (c.fontAlign == 'align-right')
				align = 'justify-content-end';
				
			var count = 0;
			var desktopContent = '';
			
			menu.forEach(function(m){
				var borderRight = '';
				//if (count == menu.length - 1) {
				//	borderRight = `style="border-right: 1px solid #000;"`.format();
				//}
				if (m.link == null || m.link.length == 0 || m.link == 'NA') {
					desktopContent += `
						<li {5} class="{2}-text">{3} {1} {4}</li>
					`.format(m.link, m.text, c.fontColor, uStart, uEnd, borderRight);
				}
				else {
					desktopContent += `
						<li {5}><a class="{2}-text" href="{0}">{3} {1} {4}</a></li>
					`.format(m.link, m.text, c.fontColor, uStart, uEnd, borderRight);					
				}
				count += 1;
			});
			html += '';
			
			var html = `
				<div class="d-none d-md-block">
					<div class="d-flex {0}">
					<ul class="d-flex text-center editor-col-htmleditor-{1}">
					{2}
					</ul></div>
				</div>
				<div class="d-md-none">
					<div class="text-center editor-col-htmleditor-mobile-{1}"> {2} </div>
				</div>
			`.format(align, c.id, desktopContent);
			return html;			
		},
	},
	//
	// link
	//
	link: {
		colDefault: {
			iconSize: 'medium',
			iconAlign: 'align-right',
			iconStyle: 'horizontal',
			bgColor: 'black',
		},
		_iconHtml: function(c, link, icon, align = 'text-center', style = ''){
			if (link == null || link.length == 0)
				return '';
			
			if (icon == 'fa fa-envelope')
				link = 'mailto: ' + link;
				
			var linkHtml = `
				<a target="_blank" href="{1}" class="btn-social-flat-{0} mx-1">
				<i class="{2} editor-col-icon-{0} {3}-text">
				</i></a>
			`.format(c.id, link, icon, c.bgColor);
			
			if (style == 'vertical') {
				linkHtml = '<div class="row d-block ' + align + '">'  + linkHtml + '</div>';
			}
			
			return linkHtml;
		},
		_colDesktopHtml: function(c, align) {
			var iconStyle = '';
			if (c.iconStyle == 'horizontal')
				iconStyle = 'row';

			var html = `
				<div class="editor-col-link-{0}">
				<div class="{2} {1} col-md-12 col-sm-12 p-0 m-0 d-block">
				{3} {4} {5} {6} {7} {8} {9} {10}
				</div>
				</div>
			`.format(c.id, align, iconStyle,
					WebEditorCols.link._iconHtml(c, c.fb, "fab fa-facebook-square", align, c.iconStyle),
					WebEditorCols.link._iconHtml(c, c.ig, "fab fa-instagram-square", align, c.iconStyle),
					WebEditorCols.link._iconHtml(c, c.line, "fab fa-line", align, c.iconStyle),
					WebEditorCols.link._iconHtml(c, c.rss, "fa fa-rss-square", align, c.iconStyle),
					WebEditorCols.link._iconHtml(c, c.twitter, "fab fa-twitter-square", align, c.iconStyle),
					WebEditorCols.link._iconHtml(c, c.youtube, "fab fa-youtube-square", align, c.iconStyle),
					WebEditorCols.link._iconHtml(c, c.mail, "fa fa-envelope", align, c.iconStyle),
					WebEditorCols.link._iconHtml(c, c.shopee, "fa fa-shopping-bag", align, c.iconStyle));
			return html;
		},
		_colMobileHtml: function(c) {
			var html = `
				<div class="editor-col-link-{0}">
				<div class="text-center col-md-12 col-sm-12 p-0 m-0 d-block">
				{1} {2} {3} {4} {5} {6} {7} {8}
				</div>
				</div>
			`.format(c.id,
					WebEditorCols.link._iconHtml(c, c.fb, "fab fa-facebook-square"),
					WebEditorCols.link._iconHtml(c, c.ig, "fab fa-instagram-square"),
					WebEditorCols.link._iconHtml(c, c.line, "fab fa-line"),
					WebEditorCols.link._iconHtml(c, c.rss, "fa fa-rss-square"),
					WebEditorCols.link._iconHtml(c, c.twitter, "fab fa-twitter-square"),
					WebEditorCols.link._iconHtml(c, c.youtube, "fab fa-youtube-square"),
					WebEditorCols.link._iconHtml(c, c.mail, "fa fa-envelope"),
					WebEditorCols.link._iconHtml(c, c.shopee, "fa fa-shopping-bag"));
			return html;
		},
		colHtml: function(c) {
			var align = '';
			if (c.iconAlign == 'align-left')
				align = 'text-left';
			else if (c.iconAlign == 'align-center')
				align = 'text-center';
			else if (c.iconAlign == 'align-right')
				align = 'text-right';
								
			var html = `
			<div class="d-none d-md-block">
			{0}
			</div>
			<div class="d-md-none">
			{1}
			</div>
			`.format(
				WebEditorCols.link._colDesktopHtml(c, align),
				WebEditorCols.link._colMobileHtml(c, align));
			return html;
		},
		colStyle: function(c) {
			var height = 0;
			var width = 0;
			var size = '';
			if (c.iconSize == 'large') {
				height = 46;
				width = 56;
				size = '3.4';
			}
			else if (c.iconSize == 'medium') {
				height = 32;
				width = 42;
				size = '2.4';
			}
			else if (c.iconSize == 'small') {
				height = 22;
				width = 32;
				size = '1.4';
			}
			
			//a.btn-social-flat-{0} i {font-size: {3}rem; line-height: {1}px; width: {2}px}
			var style = `
				.editor-col-link-{0} \{\}
				a.btn-social-flat-{0} {width: {2}px; padding: 5px;}
				a.btn-social-flat-{0} i {font-size: {3}rem; line-height: {1}px;}
				i.fab.fa-line.editor-col-icon-{0} {font-size: {3}rem; line-height: {1}px;}
				a.btn-social-flat {border-radius: 0.25rem !important;width: {2}px; height: {1}px; background-color: transparent; text-align: center !important; }
				`.format(c.id, height, width, size);
			return style;
		},
		colFields: function(c, fields) {
			fields.push({
				type: 'select',
			    label: '圖示大小',
			    name: 'iconSize',
			    defValue: (c.iconSize != undefined) ? c.iconSize : WebEditorCols.link.colDefault.iconSize
			});
			fields.push({
				type: 'fontAlign',
			    label: '圖示對齊',
			    name: 'iconAlign',
				darkMode: true,
			    defValue: (c.iconAlign != undefined) ? c.iconAlign : WebEditorCols.link.colDefault.iconAlign
			});
			fields.push({
				type: 'select',
			    label: '圖示排列',
			    name: 'iconStyle',
			    defValue: (c.iconStyle != undefined) ? c.iconStyle : WebEditorCols.link.colDefault.iconStyle
			});
			fields.push({
				type: 'checkbox_bool',
			    label: '使用原始顏色',
			    name: 'useSocialMediaOriColor',
			    defValue: (c.useSocialMediaOriColor !== undefined) ? c.useSocialMediaOriColor : true
			});
			fields.push({
				type: 'colorPicker',
			    label: '圖示顏色',
			    name: 'bgColor',
				colorType: 'text',
			    defValue: (c.bgColor != undefined) ? c.bgColor : WebEditorCols.link.colDefault.bgColor
			});
			fields.push({
				type: 'input',
			    label: 'Facebook',
			    name: 'fb',
			    defValue: (c.fb != undefined) ? c.fb : ''
			});
			fields.push({
				type: 'input',
			    label: 'Instagram',
			    name: 'ig',
			    defValue: (c.ig != undefined) ? c.ig : ''
			});
			fields.push({
				type: 'input',
			    label: 'Line',
			    name: 'line',
			    defValue: (c.line != undefined) ? c.line : ''
			});
			fields.push({
				type: 'input',
			    label: 'Twitter',
			    name: 'twitter',
			    defValue: (c.twitter != undefined) ? c.twitter : ''
			});
			fields.push({
				type: 'input',
			    label: 'Youtube',
			    name: 'youtube',
			    defValue: (c.youtube != undefined) ? c.youtube : ''
			});
			fields.push({
				type: 'input',
			    label: 'Mail',
			    name: 'mail',
			    defValue: (c.mail != undefined) ? c.mail : ''
			});
			fields.push({
				type: 'input',
			    label: 'RSS',
			    name: 'rss',
			    defValue: (c.rss != undefined) ? c.rss : ''
			});
			fields.push({
				type: 'input',
			    label: 'Shopee',
			    name: 'shopee',
			    defValue: (c.shopee != undefined) ? c.shopee : ''
			});
			return fields;
		},
		colFieldOpts: function(opts) {
			opts.iconSize = WebOptions.iconSize();
			opts.iconStyle = WebOptions.iconStyle();
			return opts;
		},
		colAssign: function(from, to) {
			to.fb = from.fb;
			to.ig = from.ig;
			to.line = from.line;
			to.twitter = from.twitter;
			to.youtube = from.youtube;
			to.mail = from.mail;
			to.rss = from.rss;
			to.shopee = from.shopee;
			to.iconSize = from.iconSize;
			to.iconAlign = from.iconAlign;
			to.bgColor = from.bgColor;
			to.iconStyle = from.iconStyle;
			to.useSocialMediaOriColor = from.useSocialMediaOriColor;
		},
		colLoad: function(c) {			
		},
	},
	//
	// empty
	//
	empty: {
		colDefault: {
			height: 0
		},
		colHtml: function(c) {
			var html = `
				<div class="d-none d-md-block">
					<div class="editor-col-empty-{0}"></div>
				</div>
				<div class="d-md-none">
				</div>
				
			`.format(c.id);
			return html;
		},
		colStyle: function(c) {
			var style = `
				.editor-col-empty-{0} { min-height: {1}px; }
				`.format(c.id, c.height);
			return style;
		},
		colFields: function(c, fields) {
			fields = [];
			fields.push({
				type: 'input',
			    label: '排序',
			    name: 'seq',
			    defValue: c.seq,
				readOnly: true
			});
			fields.push({
				type: 'select',
			    label: '寬度',
			    name: 'col',
			    defValue: (c.col != undefined) ? c.col : 12
			});
			fields.push({
				type: 'input',
			    label: '高度(px)',
			    name: 'height',
			    defValue: (c.height != undefined) ? c.height : WebEditorCols.empty.colDefault.height
			});
			return fields;
		},
		colFieldOpts: function(opts) {
			return opts;
		},
		colAssign: function(from, to) {
			to.hidden = false;
			to.fluid = false;
			to.name = '';
			to.height = from.height;
		},
		colLoad: function(c) {			
		},
	},
	//
	// ckeditor
	//
	htmlEditor: {
		colDefault: {
			fontColor: 'black',
			bgColor: 'rgb-none',
		},
		colHtml: function(c) {
			var html = `
				<div class='{1}-text {2}'>
					<div class="d-none d-md-block">
						{0}
					</div>
					<div class="d-md-none">
						<div class="text-center"> {0} </div>
					</div>
				</div>
				`
				.format(c.htmlContent,
					(c.fontColor != undefined) ? c.fontColor : WebEditorCols.htmlEditor.colDefault.fontColor,
					(c.bgColor != undefined) ? c.bgColor : WebEditorCols.htmlEditor.colDefault.bgColor);
			return html;
		},
		colStyle: function(c) {
			var style = '';
			return style;
		},
		colFields: function(c, fields) {
			fields.push({
				type: 'colorPicker',
			    label: '文字顏色',
			    name: 'fontColor',
				colorType: 'text',
			    defValue: (c.fontColor != undefined) ? c.fontColor : WebEditorCols.htmlEditor.colDefault.fontColor
			});
			fields.push({
				type: 'colorPicker',
			    label: '背景顏色',
			    name: 'bgColor',
				colorType: 'bg',
			    defValue: (c.bgColor != undefined) ? c.bgColor : WebEditorCols.htmlEditor.colDefault.bgColor
			});
			fields.push({
				type: 'ckeditor',
			    label: '編輯器',
			    name: 'htmlContent',
				defValue: (c.htmlContent != undefined) ? c.htmlContent : ''
			});
			return fields;
		},
		colFieldOpts: function(opts) {
			return opts;
			},
		colAssign: function(from, to) {
			if (from.htmlContent.indexOf('/maps/') > 0) {
				var obj = $(from.htmlContent).addClass('img-fluid gmap');
				to.htmlContent = obj[0].outerHTML;
			}
			else
				to.htmlContent = from.htmlContent;
			to.fontColor = from.fontColor;
			to.bgColor = from.bgColor;
		},
		colLoad: function(c) {			
		},
	},
	//
	// code
	//
	code: {
		colDefault: {
		},
		colHtml: function(c) {
			return c.code;
		},
		colStyle: function(c) {
			var style = '';
			return style;
		},
		colFields: function(c, fields) {
			fields.push({
				type: 'textarea',
			    label: '原始碼',
			    name: 'code',
				defValue: (c.code != undefined) ? c.code : ''
			});
			return fields;
		},
		colFieldOpts: function(opts) {
			return opts;
			},
		colAssign: function(from, to) {
			if (from.code.indexOf('/maps/') > 0) {
				var obj = $(from.code).addClass('img-fluid gmap');
				to.code = obj[0].outerHTML;
			}
			else
				to.code = from.code;
		},
		colLoad: function(c) {			
		},
	},
}