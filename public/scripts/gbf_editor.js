var colors = [
	"rgb-none", "red lighten-5", "red lighten-4", "red lighten-3", "red lighten-2", "red lighten-1", "red", "red darken-1", "red darken-2", "red darken-3", "red darken-4", "red accent-1", "red accent-2", "red accent-3", "red accent-4", 
	"pink lighten-5", "pink lighten-4", "pink lighten-3", "pink lighten-2", "pink lighten-1", "pink", "pink darken-1", "pink darken-2", "pink darken-3", "pink darken-4", "pink accent-1", "pink accent-2", "pink accent-3", "pink accent-4", 
	"purple lighten-5", "purple lighten-4", "purple lighten-3", "purple lighten-2", "#purple lighten-1", "purple", "purple darken-1", "purple darken-2", "purple darken-3", "purple darken-4", "purple accent-5", "purple accent-5", "purple accent-5", "purple accent-4", 
	"deep-purple lighten-5", "deep-purple lighten-4", "deep-purple lighten-3", "deep-purple lighten-2", "deep-purple lighten-1", "deep-purple", "deep-purple darken-1", "deep-purple darken-2", "deep-purple darken-3", "deep-purple darken-4", "deep-purple accent-1", "deep-purple accent-2", "deep-purple accent-3", "deep-purple accent-4", 
	"indigo lighten-5", "indigo lighten-4", "indigo lighten-3", "indigo lighten-2", "indigo lighten-1", "indigo", "indigo darken-1", "indigo darken-2", "indigo darken-3", "indigo darken-4", "indigo accent-1", "indigo accent-2", "indigo accent-3", "indigo accent-4",
	"blue lighten-5", "blue lighten-4", "blue lighten-3", "blue lighten-2", "blue lighten-1", "blue", "blue darken-1", "blue darken-2", "blue darken-3", "blue darken-4", "blue accent-1", "blue accent-2", "blue accent-3", "blue accent-4",
	"light-blue lighten-5", "light-blue lighten-4", "light-blue lighten-3", "light-blue lighten-2", "light-blue lighten-1", "light-blue", "light-blue darken-1", "light-blue darken-2", "light-blue darken-3", "light-blue darken-4", "light-blue accent-1", "light-blue accent-2", "light-blue accent-3", "light-blue accent-4", 
	"cyan lighten-5", "cyan lighten-4", "cyan lighten-3", "cyan lighten-2", "cyan lighten-1", "cyan", "cyan darken-1", "cyan darken-2", "cyan darken-3", "cyan darken-4", "cyan accent-1", "cyan accent-2", "cyan accent-3", "cyan accent-4",
	"teal lighten-5", "teal lighten-4", "teal lighten-3", "teal lighten-2", "teal lighten-1", "teal", "teal darken-1", "teal darken-2", "teal darken-3", "teal darken-4", "teal accent-1", "teal accent-2", "teal accent-3", "teal accent-4", 
	"green lighten-5", "green lighten-4", "green lighten-3", "green lighten-2", "green lighten-1", "green", "green darken-1", "green darken-2", "green darken-3", "green darken-4", "green accent-1", "green accent-2", "green accent-3", "green accent-4", 
	"light-green lighten-5", "light-green lighten-4", "light-green lighten-3", "light-green lighten-2", "light-green lighten-1", "light-green", "light-green darken-1", "light-green darken-2", "light-green darken-3", "light-green darken-4", "light-green accent-1", "light-green accent-2", "light-green accent-3", "light-green accent-4", 
	"lime lighten-5", "lime lighten-4", "lime lighten-3", "lime lighten-2", "lime lighten-1", "lime", "lime darken-1", "lime darken-2", "lime darken-3", "lime darken-4", "lime accent-1", "lime accent-2", "lime accent-3", "lime accent-4", 
	"yellow lighten-5", "yellow lighten-4", "yellow lighten-3", "yellow lighten-2", "yellow lighten-1", "yellow", "yellow darken-1", "yellow darken-2", "yellow darken-3", "yellow darken-4", "yellow accent-1", "yellow accent-2", "yellow accent-3", "yellow accent-4",
	"amber lighten-5", "amber lighten-4", "amber lighten-3", "amber lighten-2", "amber lighten-1", "amber", "amber darken-1", "amber darken-2", "amber darken-3", "amber darken-4", "amber accent-1", "amber accent-2", "amber accent-3", "amber accent-4",
	"orange lighten-5", "orange lighten-4", "orange lighten-3", "orange lighten-2", "orange lighten-1", "orange", "orange darken-1", "orange darken-2", "orange darken-3", "orange darken-4", "orange accent-1", "orange accent-2", "orange accent-3", "orange accent-4", 
	"deep-orange lighten-5", "deep-orange lighten-4", "deep-orange lighten-3", "deep-orange lighten-2", "deep-orange lighten-1", "deep-orange", "deep-orange darken-1", "deep-orange darken-2", "deep-orange darken-3", "deep-orange darken-4", "deep-orange darken-1", "deep-orange darken-2", "deep-orange darken-3", "deep-orange darken-4",
	"brown lighten-5", "brown lighten-4", "brown lighten-3", "brown lighten-2", "brown lighten-1", "brown", "brown darken-1", "brown darken-2", "brown darken-3", "brown darken-4", 
	"grey lighten-5", "grey lighten-4", "grey lighten-3", "grey lighten-2", "grey lighten-1", "grey", "grey darken-1", "grey darken-2", "grey darken-3", "grey darken-4", 
	"blue-grey lighten-5", "blue-grey lighten-4", "blue-grey lighten-3", "blue-grey lighten-2", "blue-grey lighten-1", "blue-grey", "blue-grey darken-1", "blue-grey darken-2", "blue-grey darken-3", "blue-grey darken-4", 
	"black", "white", "transparent", "mdb-color lighten-5", "mdb-color lighten-4", "mdb-color lighten-3", "mdb-color lighten-2", "mdb-color lighten-1", "mdb-color", "mdb-color darken-1", "mdb-color darken-2", "mdb-color darken-3", "mdb-color darken-4", 
	"rgba-blue-light", "rgba-red-light", "rgba-pink-light", "rgba-purple-light", "rgba-indigo-light", "rgba-cyan-light", "rgba-teal-light", "rgba-green-light", "rgba-lime-light", "rgba-yellow-light", "rgba-orange-light", "rgba-brown-light", "rgba-grey-light", "rgba-bluegrey-light", "rgba-black-light", "rgba-stylish-light", "rgba-white-light", "rgba-blue-strong", "rgba-red-strong", "rgba-pink-strong", "rgba-purple-strong", "rgba-indigo-strong", "rgba-cyan-strong", "rgba-teal-strong", "rgba-green-strong", "rgba-lime-strong", "rgba-yellow-strong", "rgba-orange-strong", "rgba-brown-strong", "rgba-grey-strong", "rgba-bluegrey-strong", "rgba-black-strong", "rgba-stylish-strong", "rgba-white-strong", "rgba-blue-slight", "rgba-red-slight", "rgba-pink-slight", "rgba-purple-slight", "rgba-indigo-slight", "rgba-cyan-slight", "rgba-teal-slight", "rgba-green-slight", "rgba-lime-slight", "rgba-yellow-slight", "rgba-orange-slight", "rgba-brown-slight", "rgba-grey-slight", "rgba-bluegrey-slight", "rgba-black-slight", "rgba-stylish-slight", "rgba-white-slight",
	"purple-gradient", "peach-gradient", "aqua-gradient", "blue-gradient","warm-flame-gradient","night-fade-gradient","spring-warmth-gradient","juicy-peach-gradient","young-passion-gradient","rainy-ashville-gradient","sunny-morning-gradient","lady-lips-gradient","winter-neva-gradient","frozen-dreams-gradient","dusty-grass-gradient","tempting-azure-gradient","heavy-rain-gradient","amy-crisp-gradient","mean-fruit-gradient","deep-blue-gradient","ripe-malinka-gradient","cloudy-knoxville-gradient","morpheus-den-gradient","rare-wind-gradient","near-moon-gradient",
	"blue-green-gradient","red-green-gradient", "theme-bg",
	"theme-bg-color-1", "theme-bg-color-2", "theme-bg-color-3", "theme-bg-color-4",
];

var textColors = [
	"",
	"red-text",
	"pink-text",
	"purple-text",
	"deep-purple-text",
	"indigo-text",
	"blue-text",
	"light-blue-text",
	"cyan-text",
	"teal-text",
	"green-text",
	"light-green-text",
	"lime-text",
	"yellow-text",
	"amber-text",
	"orange-text",
	"deep-orange-text",
	"brown-text",
	"grey-text",
	"dark-grey-text",
	"blue-grey-text",
	"black-text",
	"white-text",
	"theme-color-1-text",
	"theme-color-2-text",
	"theme-color-3-text",
	"theme-color-4-text",
];

var borderStyles = [
	"z-depth-0 border",
	"z-depth-0",
	"z-depth-1",
];

var textAligns = [
	'text-left',
	'text-right',
	'text-center',
];
(function ($) {
	var ColorPicker = function() {
		var
		defaults = {
				type:'bg',
				eventName: 'click',
				onShow: function () {},
				onBeforeShow: function(){},
				onHide: function () {},
				onChange: function () {},
				onSubmit: function () {},
		},
		uiText = function () {
			var html =  '<div class="modal-body modal-body-picker"><div class="row">';
            textColors.forEach(function(c) {
            		if (c == '') {
                  html += '<button class="btn-color-picker btn btn-primary btn-sm px-2 m-1" name="' + c + '"><span class="' + c + '">預設顏色</span></button>';
            		} else if (c == 'white-text') {
            			html += '<button class="btn-color-picker btn btn-default btn-sm px-2 m-1" name="' + c + '"><span class="' + c + '">文字顏色</span></button>';
            		} else {
            			html += '<button class="btn-color-picker btn btn-flat btn-sm px-2 m-1" name="' + c + '"><span class="' + c + '">文字顏色</span></button>';
            		}
            	});
            	html += '</div></div>';
			return html;
		},
		ui = function () {
			var html = '<div class="modal fade top" tabindex="-1" role="dialog" aria-labelledby="myModalLabel" data-backdrop="false" style="display: none;" aria-hidden="true">';
			html += '<div class="modal-dialog modal-frame modal-top modal-notify modal-info" role="document">';
            html += '<div class="modal-content">';
            	html += '<div class="modal-header py-2">'
            + '<p class="heading"> </p>'
            	+ '<button type="button" class="close" data-dismiss="modal" aria-label="Close">'
            + '<span aria-hidden="true" class="white-text">×</span>'
            + '</button></div>';
            	html +=  '<div class="modal-body"><div class="row">';
            	colors.forEach(function(c) {
					if (c == 'rgb-none') {
						html += '<button class="btn-color-picker btn btn px-2 m-1 white" name="' + c + '"><i class="fa fa-slash" style="line-height: 0px;left: 4px;position: absolute;color: black;"></i></button>';
					}
					else
            		html += '<button class="btn-color-picker btn btn-sm px-2 m-1 ' + c + '" name="' + c + '"></button>';
            	});
            	html += '</div></div>';
			html += '</div></div></div>';
			
			var html2 =  '<div class="modal-body modal-body-picker"><div class="row">';
            	colors.forEach(function(c) {
					if (c == 'rgb-none') {
						html2 += '<button class="btn-color-picker btn btn px-2 m-1 white" name="' + c + '"><i class="fa fa-slash" style="line-height: 0px;left: 4px;position: absolute;color: black;"></i></button>';
					}
					else
            		html2 += '<button class="btn-color-picker btn btn-sm px-2 m-1 ' + c + '" name="' + c + '"></button>';
            	});
            	html2 += '</div></div>';
			return html2;
		}
		click = function(evt) {
			var c = $(this).attr('name');
			defaults.onChange(c);
			return false;
		}
		;
		
		return {
			init: function (opt) {
				opt = $.extend({}, defaults, opt||{});
				return this.each(function() {
					defaults = opt;
					if (!$(this).data('colorpickerId')) {
						var options = $.extend({}, opt);
						options.el = this;
						var id = 'colorpicker_' + parseInt(Math.random() * 1000);
						$(this).data('colorpickerId', id);
						var c;
						if (opt.type && opt.type == 'text') {
							c = uiText();
						} else {
							c = ui();
						}
						var cal = $(c).attr('id', id);
						//cal.appendTo(document.body);
						cal.appendTo($(this).parent()).hide();
						cal.find('.btn-color-picker').bind('click', click);
					}
				});
			},
			showPicker: function() {
				return this.each( function () {
					var id = $(this).data('colorpickerId');
					if (id) {
						var $j = $('#' + id);
						if ($j.css('display') == 'none') {
							$j.modal('show');	
						}
					}
				});
			},
			toggle: function() {
				return this.each( function () {
					var id = $(this).data('colorpickerId');
					if (id) {
						var $j = $('#' + id);
						console.log('d=%o', $j.css('display'));
						if ($j.css('display') == 'none') {
							$j.show();	
						} else {
							$j.hide();	
						}
					}
				});
			},
		}
	}();
	
	$.fn.extend({
		ColorPicker: ColorPicker.init,
		ColorPickerShow: ColorPicker.showPicker,
		ColorPickerToggle: ColorPicker.toggle,
	});
})(jQuery)

$.GBObject = function(uuid, type, id) {
	this.uuid = uuid;
	this.type = type;
	this.id = id;
	this.styleId = type + '-' + id;
	this.$section = $('#' + this.styleId);
	if (type == 'item') {
		this.$title = this.$section.find(".item-title, .card-title");
		this.$card = this.$section;
		this.$body = this.$section.find('.card-body');
		this.$input = this.$section.find('select.normal,textarea');
		this.$inputBackOrder = this.$section.find('select.backOrder.input-number-total,textarea');
		this.$priceText = this.$section.find('.item-price');
		this.$retailPriceText = this.$section.find('.item-retail-price-label');
		this.$labelBackOrder = this.$section.find('label');
		this.$settingStockPlaceholder= $('select.normal.input-number-total.'+this.id+' option')[0];
		this.$settingBackOrderPlaceholder= $('select.backOrder.input-number-total.'+this.id+' option')[0];
	} else if (id == 'address') {
		this.$card = this.$section.find('.card');
		this.$title = this.$section.find('.section-address-title');
		this.$body = this.$section.find('.section-address-body');//$('#' + this.styleId + "-body");
		this.$input = this.$body.find('select,textarea,input,label');
	} else {
		this.$title = $('#' + this.styleId + "-title");
		this.$card = this.$section.find('.card');
		this.$body = $('#' + this.styleId + "-body");
		this.$input = this.$body.find('select,textarea,input,label');
	}
	this.$bodyText = this.$body.find('.card-text');
	this.$label = this.$body.find('label');
	this.$tab = this.$body.find('.nav-tabs');
	this.sectionAttr = {
			defaultClass:'section',
			bgColor:'',
			textColor:'',
	};
	this.cardAttr = {
			defaultClass:'card',
			bgColor:'',
			textColor:'',
	};
	this.bodyAttr = {
			defaultClass:'card-body',
			bgColor:'',
			textColor:'',
	};
	this.inputAttr = {
			defaultClass:'form-control',
			bgColor:'',
			textColor:'',
	};
	this.labelAttr = {
			defaultClass:'',
			bgColor:'',
			textColor:'',
	};
	this.inputBackOrderAttr = {
			defaultClass:'form-control',
			bgColor:'',
			textColor:'',
	};
	this.labelBackOrderAttr = {
			defaultClass:'',
			bgColor:'',
			textColor:'',
	};
	this.titleAttr = {
			defaultClass:'card-body',
			bgColor:'',
			textColor:'',
	};
	this.bodyTextAttr = {defaultClass:'card-text',bgColor:'',textColor:''};
	this.tabAttr = {defaultClass:'',bgColor:'',textColor:''};
	
	this.$navbar= $('.navbar.fixed-top');
	this.navbarAttr = {
			defaultClass:'navbar navbar-expand-lg navbar-custom fixed-top z-depth-0',
			bgColor:'',
			textColor:'',
	};
	
	this.$navbarText= $('.nav-link');
	this.navbarTextAttr = {
			defaultClass:'',
			bgColor:'',
			textColor:'',
	};

	this.$pageFooter= $('.page-footer');
	this.pageFooterAttr = {
			defaultClass:'page-footer center-on-small-only',
			bgColor:'',
			textColor:'',
	};

	this.$pageFooterText= $('.page-footer-text-color').not('button');
	this.pageFooterTextAttr = {
			defaultClass:'',
			bgColor:'',
			textColor:'',
	};

	this.$descFooter= $('.section-groupbuy-descr-footer');
	this.descFooterAttr = {
			defaultClass:'section pb-5 section-groupbuy-descr-footer',
			bgColor:'',
			textColor:'',
	};

	this.$descFooterBody= $('.section.section-groupbuy-descr-footer').find('.groupbuy-descr-footer').find('.container').find('.row').find('.col-12');
	this.descFooterBodyAttr = {
			defaultClass:'',
			bgColor:'',
			textColor:'',
	};

	// TODO
	this.$pageFooterSys= $('div.page-footer-text-color');
	this.pageFooterSysAttr = {
			defaultClass:'container-fluid page-footer-text-color',
			bgColor:'',
			textColor:'',
	};

	this.$descFooterBodyText= $('.section.section-groupbuy-descr-footer').find('.groupbuy-descr-footer').find('.container').find('.row');
	this.descFooterBodyTextAttr = {
			defaultClass:'',
			bgColor:'',
			textColor:'',
	};

	this.$addrSection= $('.section-address');
	this.addrSectionAttr = {
			defaultClass:'',
			bgColor:'',
			textColor:'',
	};
	this.$otherSection= $('.section-other');
	this.otherSectionAttr = {
			defaultClass:'',
			bgColor:'',
			textColor:'',
	};

	this.initItemRoom();
	
	this.$noteLabel= $('section.section-other').find('i.fa-sticky-note').parent();
	
	this.priceTextAttr = {defaultClass:'small left mr-1',bgColor:'',textColor:''};
	this.retailPriceTextAttr = {defaultClass:'stroke tiny left',bgColor:'',textColor:''};
	this.initTheme();
	this.initAttr(this.$section, this.sectionAttr);
	this.initAttr(this.$title, this.titleAttr);
	this.initAttr(this.$card, this.cardAttr);
	this.initAttr(this.$body, this.bodyAttr);
	this.initAttr(this.$bodyText, this.bodyTextAttr);
	this.initAttr(this.$input, this.inputAttr);
	this.initAttr(this.$label, this.labelAttr);
	this.initAttr(this.$inputBackOrder, this.inputBackOrderAttr);
	this.initAttr(this.$labelBackOrder, this.labelBackOrderAttr);
	this.initAttr(this.$navbar, this.navbarAttr);
	this.initAttr(this.$navbarText, this.navbarTextAttr);
	this.initAttr(this.$pageFooter, this.pageFooterAttr);
	this.initAttr(this.$pageFooterText, this.pageFooterTextAttr);
	this.initAttr(this.$descFooter, this.descFooterAttr);
	this.initAttr(this.$descFooterBodyText, this.descFooterBodyTextAttr);
	this.initAttr(this.$descFooterBody, this.descFooterBodyAttr);
	this.initAttr(this.$pageFooterSys, this.pageFooterSysAttr);
	this.initAttr(this.$addrSection, this.addrSectionAttr);
	this.initAttr(this.$otherSection, this.otherSectionAttr);
	if (this.$priceText != null) {
		this.initAttr(this.$priceText, this.priceTextAttr);
		this.initAttr(this.$retailPriceText, this.retailPriceTextAttr);
	}
	this.initAttr(this.$tab, this.tabAttr);
	this.customizerShowAll();
	if (this.type == 'banner') {
		$('.customizer-body').find('#gbf-editor-itemSetTopStyle').parent().hide();
		$('.customizer-body').find('#gbf-editor-style').parent().hide();
		$('.customizer-body').find('#gbf-editor-applyAll').parent().hide();
		$('.customizer-body').find('#gbf-editor-applyAll-itemSet').parent().hide();
		$('.customizer-body').find('#addr-section-color').parent().hide();
		$('.customizer-body').find('#tab-bg-color').parent().hide();
		$('.customizer-body').find('#price-text-color').parent().hide();
		$('.customizer-body').find('#retail-price-text-color').parent().hide();
		$('.customizer-body').find('#title-align').parent().hide();
		$('.customizer-body').find('#price-align').parent().hide();
	} else if (this.id == 'other' && this.type == 'section') {
//		Expecting this is editor button at footer.
		$('.customizer-body').find('#navbar-bg-color').parent().hide();
   		$('.customizer-body').find('#navbar-text-color').parent().hide();
		$('.customizer-body').find('#gbf-editor-itemSetTopStyle').parent().hide();
		$('.customizer-body').find('#gbf-editor-style').parent().hide(); 
		$('.customizer-body').find('#gbf-editor-applyAll').parent().hide();
		$('.customizer-body').find('#gbf-editor-applyAll-itemSet').parent().hide();
		$('.customizer-body').find('#addr-section-color').parent().hide();
		$('.customizer-body').find('#tab-bg-color').parent().hide();
		$('.customizer-body').find('#price-text-color').parent().hide();
		$('.customizer-body').find('#retail-price-text-color').parent().hide();
		$('.customizer-body').find('#title-align').parent().hide();
		$('.customizer-body').find('#price-align').parent().hide();
		$('.customizer-body').find('#price-label').parent().hide();
		if (this.$descFooter.length == 0) {
			$('.customizer-body').find('#page-footer-desc-bg-color').parent().hide();
		}
		if (this.$descFooterBodyText.length == 0) {
			$('.customizer-body').find('#page-footer-desc-body-text-color').parent().hide();
			$('.customizer-body').find('#page-footer-desc-body-bg-color').parent().hide();
		}
	} else if (this.id == 'groupbuy-desc-footer' && this.type == 'section') {
		$('.customizer-body').find('#navbar-bg-color').parent().hide();
		$('.customizer-body').find('#navbar-text-color').parent().hide();
		$('.customizer-body').find('#section-color').parent().hide();
		$('.customizer-body').find('#title-bg-color').parent().hide();
		$('.customizer-body').find('#title-text-color').parent().hide();
		$('.customizer-body').find('#title-align').parent().hide();
		$('.customizer-body').find('#body-bg-color').parent().hide();
		$('.customizer-body').find('#body-text-color').parent().hide();
		$('.customizer-body').find('#tab-bg-color').parent().hide();
		$('.customizer-body').find('#border-style').parent().hide();
		$('.customizer-body').find('#price-text-color').parent().hide();
		$('.customizer-body').find('#retail-price-text-color').parent().hide();
		$('.customizer-body').find('#gbf-editor-itemSetTopStyle').parent().hide();
		$('.customizer-body').find('#gbf-editor-style').parent().hide();
		$('.customizer-body').find('#col-full').parent().hide();
		$('.customizer-body').find('#gbf-editor-applyAll').parent().hide();
		$('.customizer-body').find('#gbf-editor-applyAll-itemSet').parent().hide();
		if (this.$descFooter.length == 0) {
			$('.customizer-body').find('#page-footer-desc-bg-color').parent().hide();
		}
		if (this.$descFooterBodyText.length == 0) {
			$('.customizer-body').find('#page-footer-desc-body-text-color').parent().hide();
			$('.customizer-body').find('#page-footer-desc-body-bg-color').parent().hide();
		}
	} else if (this.id == 'address' || this.id == 'other') {
		$('.customizer-body').find('#gbf-editor-itemSetTopStyle').parent().hide();
		$('.customizer-body').find('#gbf-editor-style').parent().hide();
		$('.customizer-body').find('#gbf-editor-applyAll').parent().hide();
		$('.customizer-body').find('#gbf-editor-applyAll-itemSet').parent().hide();
		$('.customizer-body').find('#col-full').parent().hide();
		$('.customizer-body').find('#navbar-bg-color').parent().hide();
		$('.customizer-body').find('#navbar-text-color').parent().hide();
		$('.customizer-body').find('#addr-section-color').parent().hide();
		$('.customizer-body').find('#tab-bg-color').parent().hide();
		$('.customizer-body').find('#price-text-color').parent().hide();
		$('.customizer-body').find('#retail-price-text-color').parent().hide();
		$('.customizer-body').find('#title-align').parent().hide();
		$('.customizer-body').find('#price-align').parent().hide();
	} else if (type == 'item') {
		$('.customizer-body').find('#navbar-bg-color').parent().hide();
		$('.customizer-body').find('#navbar-text-color').parent().hide();
		$('.customizer-body').find('#addr-section-color').parent().hide();
		$('.customizer-body').find('#gbf-editor-itemSetTopStyle').parent().hide();
		$('.customizer-body').find('#gbf-editor-style').parent().hide();
		$('.customizer-body').find('#col-full').parent().hide();
		$('.customizer-body').find('#title-align').parent().hide();
		$('.customizer-body').find('#price-align').parent().hide();
	} else {
		$('.customizer-body').find('#navbar-bg-color').parent().hide();
		$('.customizer-body').find('#navbar-text-color').parent().hide();
		$('.customizer-body').find('#addr-section-color').parent().hide();
		$('.customizer-body').find('#price-text-color').parent().hide();
		$('.customizer-body').find('#retail-price-text-color').parent().hide();
		$('.customizer-body').find('#gbf-editor-applyAll-itemSet').parent().hide();
		$('.customizer-body').find('#price-align').parent().hide();
	}
	if (this.id != 'groupbuy-desc-footer' || this.type != 'section') {
		// Hide footer items.
		$('.customizer-body').find('#page-footer-bg-color').parent().hide();
		$('.customizer-body').find('#page-footer-text-color').parent().hide();
		$('.customizer-body').find('#page-footer-desc-bg-color').parent().hide();
		$('.customizer-body').find('#page-footer-desc-body-text-color').parent().hide();
		$('.customizer-body').find('#page-footer-desc-body-bg-color').parent().hide();
		$('.customizer-body').find('#page-footer-sys-bg-color').parent().hide();
	}
	if (this.id != 'other' || this.type != 'section') {
		$('.customizer-body').find('#note-label').parent().hide();
	}
	if (type != 'item') {
		// Only item has these options.
		$('.customizer-body').find('#input-bg-color').parent().hide();
		$('.customizer-body').find('#input-text-color').parent().hide();
		$('.customizer-body').find('#input-backorder-bg-color').parent().hide();
		$('.customizer-body').find('#input-backorder-text-color').parent().hide();
		// Edit both stock and backOrder options text.
		$('.customizer-body').find('#stock-placeholder-option-label').parent().hide();
		$('.customizer-body').find('#backorder-placeholder-option-label').parent().hide();
		// Price and backOrder price of item
		$('.customizer-body').find('#price-label').parent().hide();
		$('.customizer-body').find('#retail-price-label').parent().hide();
		// Only item has interchanging price and retail price labels.
		$('.customizer-body').find('#groupbuy-retail-prices-interchange').parent().hide();
	}
	if (type === 'itemset') {
		$('.customizer-body').find('#item-room-booked-bg-color').parent().hide();
		$('.customizer-body').find('#item-room-booked-text-color').parent().hide();
	}
}; 
$.GBObject.prototype = {
	init:function(a,b,c) {},
	initAttr:function($obj, attr) {
		if ($obj == null) return;
		var $this = this;
		$obj.each(function(i,v){
			$this.initAttrEx($(v), attr);
		});
	},
	initAttrEx:function($obj, attr) {
		attr.borderStyle = '';
		attr.align = '';
		attr.defaultClass = '';
		attr.bgColor = '';
		attr.textColor = '';
		if ($obj.attr('class') == null) return;
		$obj.attr('class').split(' ').forEach(function(clazz) {
			colors.forEach(function(c) {
				if (c.indexOf(clazz) > -1 && attr.bgColor.indexOf(clazz) == -1) {
					attr.bgColor += (clazz + ' ');
					return;
				}
			});
			textColors.forEach(function(c) {
				if (c == clazz) { 
					console.log('***found');
					attr.textColor += (clazz + ' ');
					return;
				}
			});
			borderStyles.forEach(function(c) {
				if (c == clazz) { 
					attr.borderStyle += (clazz + ' ');
					return;
				}
			});
			textAligns.forEach(function(c) {
				if (c == clazz) { 
					attr.align += (clazz + ' ');
					return;
				}
			});
			if (attr.bgColor.indexOf(clazz) < 0 
					&& attr.textColor.indexOf(clazz) < 0 
					&& attr.borderStyle.indexOf(clazz) < 0 
					&& attr.align.indexOf(clazz) < 0 ) {
				attr.defaultClass += (clazz + ' ');
			}
		});
	},
	sectionId:function(){return 'section-' + this.styleId;},
	updateColor:function($obj, attr) {
		var $this = this;
		$obj.each(function(i,v) {
			$this.updateColorEx($(v), attr);
		});
	},
	updateColorEx:function($obj, attr) {
		this.json.mainBGColor;
		$obj.attr('class', attr.defaultClass);
		if (attr.textColor != null) $obj.addClass(attr.textColor);
		if (attr.bgColor != null) $obj.addClass(attr.bgColor);
		if (attr.align != null) $obj.addClass(attr.align);
		if (attr.borderStyle != null) $obj.addClass(attr.borderStyle);
	},
	setMainBGColor:function(color) {
		this.updateCustomizer();
		if (this.type == 'section' && this.id == 'address') {
			this.json.addrSectionColor = color;	
		} else if (this.type == 'section' && this.id == 'other') {
			this.json.otherSectionColor = color;	
		} else {
			this.json.mainBGColor = color;
		}
		this.sectionAttr.bgColor = color;
		this.updateColor(this.$section, this.sectionAttr);
		this.updateCustomizer();
	},
	setTitleBGColor:function(color) {
		this.updateCustomizer();
		if (this.type == 'section' && this.id == 'address') {
			this.json.addrTitleBGColor = color;	
		} else if (this.type == 'section' && this.id == 'other') {
			this.json.otherTitleBGColor = color;	
		} else {
			this.json.titleBGColor = color;
		}
		this.titleAttr.bgColor = color;
		this.updateColor(this.$title, this.titleAttr);
		this.updateCustomizer();
	},
	setTitleTextColor:function(color) {
		this.updateCustomizer();
		if (this.type == 'section' && this.id == 'address') {
			this.json.addrTitleTextColor = color;	
		} else if (this.type == 'section' && this.id == 'other') {
			this.json.otherTitleTextColor = color;	
		} else {
			this.json.titleTextColor = color;
		}
		this.titleAttr.textColor = color;
		this.updateColor(this.$title, this.titleAttr);
		this.updateCustomizer();
	},
	setTitleAlign:function(align) {
		this.json.titleAlign = align;
		this.titleAttr.align = align;
		this.updateColorEx(this.$title, this.titleAttr);
	},
	setBorderStyle:function(borderStyle) {
		this.json.borderStyle = borderStyle;
		this.cardAttr.borderStyle = borderStyle;
		this.updateColorEx(this.$card, this.cardAttr);
	},
	setBodyBGColor:function(color) {
		this.updateCustomizer();
		if (this.type == 'section' && this.id == 'address') {
			this.json.addrBodyBGColor = color;	
		} else if (this.type == 'section' && this.id == 'other') {
			this.json.otherBodyBGColor = color;	
		} else {
			this.json.bodyBGColor = color;
		}
		this.bodyAttr.bgColor = color;
		this.updateColor(this.$body, this.bodyAttr);
		this.updateCustomizer();
	},
	setBodyTextColor:function(color) {
		this.updateCustomizer();
		if (this.type == 'section' && this.id == 'address') {
			this.json.addrBodyTextColor = color;	
		} else if (this.type == 'section' && this.id == 'other') {
			this.json.otherBodyTextColor = color;	
		} else {
			this.json.bodyTextColor = color;
		}
		this.bodyTextAttr.textColor = color;
		this.updateColor(this.$bodyText, this.bodyTextAttr);
		this.updateCustomizer();
	},
	setPriceTextColor:function(color) {
		this.updateCustomizer();
		this.json.priceTextColor = color;
		this.priceTextAttr.textColor = color;
		this.updateColor(this.$priceText, this.priceTextAttr);
		this.updateCustomizer();
	},
	setPriceLabel:function(label) {
		this.json.priceLabel = label;
	},
	setRetailPriceLabel: function(label) {
		this.json.retailPriceLabel = label;
	},
	setNoteLabel:function(label) {
		this.json.noteLabel = label;
		$(this.$noteLabel).html('<i class="fa fa-sticky-note"></i>  '+label);
	},
	setStockPlaceholderLabel: function(label) {
		this.json.stockPlaceholderLabel = label;
		$(this.$settingStockPlaceholder).html(label);
	},
	setBackOrderPlaceholderLabel: function(label) {
		this.json.backOrderPlaceholderLabel = label;
		$(this.$settingBackOrderPlaceholder).html(label);
	},
	setRetailPriceTextColor:function(color) {
		this.updateCustomizer();
		this.json.retailPriceTextColor = color;
		this.retailPriceTextAttr.textColor = color;
		this.updateColor(this.$retailPriceText, this.retailPriceTextAttr);
		this.updateCustomizer();
	},
	setItemRoomBookedBGColor:function(color) {
		this.updateCustomizer();
		this.json.itemRoomBookedBGColor = color;	
		if (!this.$itemRoomBooked.length || !this.$itemRoomBookedMobile.length) {
			this.initItemRoom();
		}
		this.itemRoomBookedAttr.bgColor = color;
		this.itemRoomBookedMobileAttr.bgColor = color;
		this.updateColor(this.$itemRoomBooked, this.itemRoomBookedAttr);
		this.updateColor(this.$itemRoomBookedMobile, this.itemRoomBookedMobileAttr);
		this.updateCustomizer();
	},
	setItemRoomBookedTextColor:function(color) {
		this.updateCustomizer();
		this.json.itemRoomBookedTextColor = color;
		if (!this.$itemRoomBooked.length || !this.$itemRoomBookedMobile.length) {
			this.initItemRoom();
		}
		this.itemRoomBookedButtonAttr.textColor = color;
		this.updateColor(this.$itemRoomBookedButton, this.itemRoomBookedButtonAttr);
		this.updateColor(this.$itemRoomBookedMobileButton, this.itemRoomBookedMobileButtonAttr);
		this.updateCustomizer();
	},
	setPriceAlign:function(align) {
		this.json.priceAlign = align;
		this.priceTextAttr.align = align;
		this.updateColorEx(this.$priceText, this.priceTextAttr);
	},
	setInputBGColor:function(color) {
		this.updateCustomizer();
		if (this.type == 'section' && this.id == 'address') {
			this.json.addrInputBGColor = color;	
		} else if (this.type == 'section' && this.id == 'other') {
			this.json.otherInputBGColor = color;	
		} else {
			this.json.inputBGColor = color;
		}
		this.inputAttr.bgColor = color;
		this.updateColor(this.$input, this.inputAttr);
		this.updateCustomizer();
	},
	setInputTextColor:function(color) {
		this.updateCustomizer();
		if (this.type == 'section' && this.id == 'address') {
			this.json.addrInputTextColor = color;	
		} else if (this.type == 'section' && this.id == 'other') {
			this.json.otherInputTextColor = color;	
		} else {
			this.json.inputTextColor = color;
		}
		this.inputAttr.textColor = color;
		this.labelAttr.textColor = color;
		this.updateColor(this.$input, this.inputAttr);
		this.updateColor(this.$label, this.labelAttr);
		this.updateCustomizer();
	},
	setInputBackOrderBGColor:function(color) {
		if (this.type != 'item') return;
		this.updateCustomizer();
    this.json.inputBackOrderBGColor = color;
		this.inputBackOrderAttr.bgColor = color;
		this.updateColor(this.$inputBackOrder, this.inputBackOrderAttr);
		this.updateCustomizer();
	},
	setInputBackOrderTextColor:function(color) {
		if (this.type != 'item') return;
		this.updateCustomizer();
    this.json.inputBackOrderTextColor = color;
		this.inputBackOrderAttr.textColor = color;
		this.labelBackOrderAttr.textColor = color;
		this.updateColor(this.$inputBackOrder, this.inputBackOrderAttr);
		this.updateColor(this.$labelBackOrder, this.labelBackOrderAttr);
		this.updateCustomizer();
	},
	setTabBGColor:function(color) {
		this.updateCustomizer();
		this.json.tabBGColor = color;
		this.tabAttr.bgColor = color;
		this.updateColor(this.$tab, this.tabAttr);
		this.updateCustomizer();
	},
	setNavbarBGColor:function(color) {
		this.updateCustomizer();
		this.json.navbarBGColor = color;
		this.navbarAttr.bgColor = color;
		this.updateColor(this.$navbar, this.navbarAttr);
		this.updateCustomizer();
	},
	setNavbarTextColor:function(color) {
		this.updateCustomizer();
		this.json.navbarTextColor = color;
		this.navbarTextAttr.textColor = color;
		this.updateColor(this.$navbarText, this.navbarTextAttr);
		this.updateCustomizer();
	},
	setPageFooterBGColor:function(color) {
		this.updateCustomizer();
		this.json.pageFooterBGColor = color;
		this.pageFooterAttr.bgColor = color;
		this.updateColor(this.$pageFooter, this.pageFooterAttr);
		this.updateCustomizer();
	},
	setPageFooterTextColor:function(color) {
		this.updateCustomizer();
		this.json.pageFooterTextColor = color;
		this.pageFooterTextAttr.textColor = color;
		this.pageFooterSysAttr.textColor = color;
		this.updateColor(this.$pageFooterText, this.pageFooterTextAttr);
		this.updateColor(this.$pageFooterSys, this.pageFooterSysAttr);
		this.updateCustomizer();
	},
	setDescFooterBGColor:function(color) {
		this.updateCustomizer();
		this.json.descFooterBGColor = color;
		this.descFooterAttr.bgColor = color;
		this.updateColor(this.$descFooter, this.descFooterAttr);
		this.updateCustomizer();
	},
	setDescFooterBodyBGColor:function(color) {
		this.updateCustomizer();
		this.json.descFooterBodyBGColor = color;
		this.descFooterBodyAttr.bgColor = color;
		this.updateColor(this.$descFooterBody, this.descFooterBodyAttr);
		this.updateCustomizer();
	},
	setPageFooterSysBGColor: function(color) {
		this.updateCustomizer();
		this.json.pageFooterSysBGColor = color;
		this.pageFooterSysAttr.bgColor = color;
		this.updateColor(this.$pageFooterSys, this.pageFooterSysAttr);
		this.updateCustomizer();
	},
	setDescFooterBodyTextColor:function(color) {
		this.updateCustomizer();
		this.json.descFooterBodyTextColor = color;
		this.descFooterBodyTextAttr.textColor = color;
		this.updateColor(this.$descFooterBodyText, this.descFooterBodyTextAttr);
		this.updateCustomizer();
	},
	setAddrSectionColor:function(color) {
		this.updateCustomizer();
		this.json.addrSectionColor = color;
		this.addrSectionAttr.bgColor = color;
		this.updateColor(this.$addrSection, this.addtSectionAttr);
		this.updateCustomizer();
	},
	setOtherSectionColor:function(color) {
		this.updateCustomizer();
		this.json.otherSectionColor = color;
		this.otherSectionAttr.bgColor = color;
		this.updateColor(this.$otherSection, this.otherSectionAttr);
		this.updateCustomizer();
	},
	setGroupbuyRetailPricesInterchanged: function(checked) {
		this.json.groupbuyRetailPricesInterchanged = checked;
		// TODO: interchange
	},
	setFullCol:function(checked) {
		this.json.fullCol = checked;
		if (this.type == 'itemset') {
			var $banner = this.$section.find('.banner-col');
			if ($banner != null) {
				if (checked) {
					$banner.attr('class', 'banner-col col-md-8 p-3 p-md-0');
				} else {
					$banner.attr('class', 'banner-col col-md-4');
				}
			}
		} else if (this.type == 'banner') {
			if (checked) 
				$('#banner-col').attr('class', 'col-12 px-0');
			else
				$('#banner-col').attr('class', 'col-12 col-xl-8 px-0 px-xl-3');
		}
	},
	changeStyle:function(style) {
		this.json.itemSetStyle = style;
		var ajaxurl = (typeof baseUrl == 'undefined')  ? '..' : baseUrl;
		ajaxurl = ajaxurl  + '/ajax/Theme/itemsView.do';
		var itemSetId = this.id;
	    jQuery.get( ajaxurl,
	    			{'uuid':this.uuid, 'itemSetId':this.id, 'itemSetStyle':style},
	            function( data ) {
	            		$('#itemset-items-'+itemSetId).html(data);
	            		$('#itemset-items-'+itemSetId).find('div[id^=item-]').each(function(index,value) {
	            			if( !$(this).attr('id').match('^item-\\d*$') ) return;
	            			var itid = $(value).attr('id').split('-')[1];
	            			$(value).append('<a class="btn btn-primary btn-sm btn-theme-edit px-1" id="" onClick="javascript:openEditForm(\'item\', \''+itid+'\')">編輯<i class="fa fa-edit"></i></a>');
	            		});
	            }
	    );
	},
	changeItemSetTopStyle:function(style) {
		this.json.itemSetTopStyle = style;
		var ajaxurl = (typeof baseUrl == 'undefined')  ? '..' : baseUrl;
		ajaxurl = ajaxurl  + '/ajax/Theme/itemSetTopView.do';
		var itemSetId = this.id;
	    jQuery.get( ajaxurl,
	    			{'uuid':this.uuid, 'itemSetId':this.id, 'itemSetTopStyle':style},
	            function( data ) {
	            		$('#itemset-top-'+itemSetId).html(data);
	            }
	    );
	},
	initTheme:function() {
		var ajaxurl = (typeof baseUrl == 'undefined')  ? '..' : baseUrl;
		ajaxurl = ajaxurl  + '/ajax/Theme/theme.do';
		var itemSetId = this.id;
		var $this = this;
		this.resetCustomizer();
		var reqJson = {'uuid':this.uuid};
		if ($this.type == 'item') {
			reqJson.itemId = $this.id;
		} else if ($this.type == 'itemset') {
			reqJson.itemSetId = $this.id;
		}
	    jQuery.get( 
	    		ajaxurl,
	    		reqJson,
	    		function( json ) {
	    			console.log('init:%o', json);
	    			$this.json = json;
	    			$this.json.uuid = $this.uuid;
	    			$this.json.itemSetId = $this.id;
	    			$this.updateCustomizer();
	    			if (!$('.customizer').hasClass('open')) {
	    				$('.customizer').toggleClass('open');
	    			}
	    		}
	    );
	},
	restoreTheme: function() {
		if (this.type == 'banner') {
			this.setNavbarBGColor("");
			this.setNavbarTextColor("");
			this.setMainBGColor("");
			this.setTitleBGColor("");
			this.setTitleTextColor("");
			this.setBodyBGColor("");
			this.setBodyTextColor("");
			this.setBorderStyle("");
		} else if (this.id == 'other' && this.type == 'section') {
			// Footer for note
			this.setMainBGColor("");
			this.setTitleBGColor("");
			this.setTitleTextColor("");
			this.setBodyBGColor("");
			this.setBodyTextColor("");
		} else if (this.id == 'groupbuy-desc-footer' && this.type == 'section') {
			// Descr footer
			this.setDescFooterBGColor("");
			this.setDescFooterBodyBGColor("");
			this.setDescFooterBodyTextColor("");
			this.setPageFooterBGColor("");
			this.setPageFooterTextColor("");
			this.setPageFooterSysBGColor("");
		} else if (this.id == 'address' && this.type == 'other') {
			this.setMainBGColor("");
			this.setTitleBGColor("");
			this.setTitleTextColor("");
			this.setBodyBGColor("");
			this.setBodyTextColor("");
		} else if (this.id == 'address' && this.type == 'section') {
			this.setMainBGColor("");
			this.setTitleBGColor("");
			this.setTitleTextColor("");
			this.setBodyBGColor("");
			this.setBodyTextColor("");
			this.setBorderStyle("");
		} else if (this.type == 'item') {
			this.setBodyBGColor("");
			this.setBodyTextColor("");
			this.setMainBGColor("");
			this.setTitleBGColor("");
			this.setTitleTextColor("");
			this.setInputTextColor("");
			this.setInputBGColor("");
			this.setInputBackOrderBGColor("");
			this.setInputBackOrderTextColor("");
			this.setPriceTextColor("");
			this.setRetailPriceTextColor("");
			this.setBorderStyle("");
		} else {
			// type = itemset
			this.setMainBGColor("");
			this.setTitleBGColor("");
			this.setTitleTextColor("");
			this.setTitleAlign("");
			this.setBodyBGColor("");
			this.setBodyTextColor("");
			this.setTabBGColor("");
			this.setBorderStyle("");
		}
	},
	updateTheme:function() {
		var ajaxurl = (typeof baseUrl == 'undefined')  ? '..' : baseUrl;
		ajaxurl = ajaxurl  + '/ajax/Theme/theme.do';
		var $this = this;
		$this.json.uuid = $this.uuid;
		if ($this.type == 'item') {
	 		$this.json.itemId = $this.id;
		} else if ($this.type == 'itemset') {
	 		$this.json.itemSetId = $this.id;
		}
		$this.json.applyAll = $('#gbf-editor-applyAll').is(":checked");
		$this.json.applyAllItemSet = $('#gbf-editor-applyAll-itemSet').is(":checked");
	    jQuery.post( 
	    		ajaxurl,
	    		this.json,
	    		function( json ) {
	    			// console.log('updateTheme:%o', json);
	    			if ($this.json.applyAll || $this.json.applyAllItemSet) {
	    				window.location.reload(true);
	    			} else {
	    				toastr.success(GBFi18n.success_update);
	    			}
	    			$this.json = json;
	    		}
	    );
	},
	customizerShowAll:function() {
		$('.customizer-body').find('.customizer-title').each(function(i,v) {
			$(v).show();
		});
		$('.customizer-body').find('.form-group').each(function(i,v) {
			$(v).show();
		});

		$('.customizer-body').find('#gbf-editor-applyAll').parent().show();
		$('.customizer-body').find('#gbf-editor-applyAll-itemSet').parent().show();
		$('.customizer-body').find('#col-full').parent().show();
		$('.customizer-body').find('#price-text-color').parent().show();
		$('.customizer-body').find('#retail-price-text-color').parent().show();
		$('.customizer-body').find('#groupbuy-retail-prices-interchange').parent().show();
	},
	resetCustomizer:function() {
		//btn btn-flat px-2 m-1
		$('.customizer').find('#section-color').attr('class', 'btn btn-flat px-2 m-1');
		$('.customizer').find('#title-bg-color').attr('class', 'btn btn-flat px-2 m-1');
		$('.customizer').find('#title-text-color').parent().attr('class', 'customizer-title');
		$('.customizer').find('#body-bg-color').attr('class', 'btn btn-flat px-2 m-1');
		$('.customizer').find('#body-text-color').parent().attr('class', 'customizer-title');

		$('.customizer').find('#navbar-bg-color').attr('class', 'btn btn-flat px-2 m-1');
		$('.customizer').find('#navbar-text-color').parent().attr('class', 'customizer-title');
		$('.customizer').find('#addr-section-color').attr('class', this.addrSectionAttr.defalutClass);
		$('.customizer').find('#other-section-color').attr('class', this.otherSectionAttr.defalutClass);

		//$('.customizer').find('#price-text-color').parent().attr('class', this.priceTextAttr.defaultClass);
		//$('.customizer').find('#retail-price-text-color').parent().attr('class', this.retailPriceTextAttr.defaultClass);
		
	},
	updateCustomizer:function() {
		var $this = this;
		if ($this.json == null) return;
		$this.updateIndicator('#section-color', this.json.mainBGColor);
		$this.updateIndicator('#title-bg-color', this.json.titleBGColor);
		$this.updateIndicator('#title-text-color', this.json.titleTextColor);
		$this.updateIndicator('#body-bg-color', this.json.bodyBGColor);
		$this.updateIndicator('#body-text-color', this.json.bodyTextColor);
		if (this.json.borderStyle != null) {
			$('.customizer').find('#border-style').val(this.json.borderStyle);
		} else {
			$('.customizer').find('#border-style').val('');
		}
		if (this.json.titleAlign != null) {
			$('.customizer').find('#title-align').val(this.json.titleAlign);
		} else {
			$('.customizer').find('#title-align').val('');
		}
		if (this.json.priceAlign != null) {
			$('.customizer').find('#price-align').val(this.json.price);
		} else {
			$('.customizer').find('#price-align').val('');
		}
		$('.customizer').find('#gbf-editor-itemSetTopStyle').val(this.json.itemSetTopStyle);
		$('.customizer').find('#gbf-editor-style').val(this.json.itemSetStyle);
		$('.customizer').find('#col-full').prop('checked', this.json.fullCol);
		$('.customizer').find('#groupbuy-retail-prices-interchange').prop('checked', this.json.groupbuyRetailPricesInterchanged);
		
		$this.updateIndicator('#navbar-bg-color', this.json.navbarBGColor);
		$this.updateIndicator('#navbar-text-color', this.json.navbarTextColor);
		$this.updateIndicator('#page-footer-bg-color', this.json.pageFooterBGColor);
		$this.updateIndicator('#page-footer-text-color', this.json.pageFooterTextColor);
		$this.updateIndicator('#page-footer-desc-bg-color', this.json.descFooterBGColor);
		$this.updateIndicator('#page-footer-desc-body-text-color', this.json.descFooterBodyTextColor);
		$this.updateIndicator('#page-footer-desc-body-bg-color', this.json.descFooterBodyBGColor);
		$this.updateIndicator('#page-footer-sys-bg-color', this.json.pageFooterSysBGColor);
		$this.updateIndicator('#tab-bg-color', this.json.tabBGColor);
		$this.updateIndicator('#input-bg-color', this.json.inputBGColor);
		$this.updateIndicator('#input-text-color', this.json.inputTextColor);
		$this.updateIndicator('#input-backorder-bg-color', this.json.inputBackOrderBGColor);
		$this.updateIndicator('#input-backorder-text-color', this.json.inputBackOrderTextColor);
		$this.updateIndicator('#price-text-color', this.json.priceTextColor);
		$this.updateIndicator('#retail-price-text-color', this.json.retailPriceTextColor);
		if ($this.json.priceLabel != null) {
			$('.customizer').find('#price-label').val(this.json.priceLabel);
		} else {
			$('.customizer').find('#price-label').val('');
		}
		if ($this.json.retailPriceLabel != null) {
			$('.customizer').find('#retail-price-label').val(this.json.retailPriceLabel);
		} else {
			$('.customizer').find('#retail-price-label').val('');
		}
		if ($this.json.noteLabel != null) {
			$('.customizer').find('#note-label').val(this.json.noteLabel);
		} else {
			$('.customizer').find('#note-label').val('');
		}
		if ($this.json.stockPlaceholderLabel != null) {
			$('.customizer').find('#stock-placeholder-option-label').val(this.json.stockPlaceholderLabel);
		} else {
			$('.customizer').find('#stock-placeholder-option-label').val('');
		}
		if ($this.json.backOrderPlaceholderLabel != null) {
			$('.customizer').find('#backorder-placeholder-option-label').val(this.json.backOrderPlaceholderLabel);
		} else {
			$('.customizer').find('#backorder-placeholder-option-label').val('');
		}
		if (this.type == 'section' && this.id == 'address') {
			$this.updateIndicator('#section-color', this.json.addrSectionColor);
			$this.updateIndicator('#title-bg-color', this.json.addrTitleBGColor);
			$this.updateIndicator('#title-text-color', this.json.addrTitleTextColor);
			$this.updateIndicator('#body-bg-color', this.json.addrBodyBGColor);
			$this.updateIndicator('#body-text-color', this.json.addrBodyTextColor);
			$this.updateIndicator('#input-text-color', this.json.addrInputTextColor);
			$this.updateIndicator('#input-backorder-text-color', this.json.addrInputBackOrderTextColor);
		} else if (this.type == 'section' && this.id == 'other') {
			$this.updateIndicator('#section-color', this.json.otherSectionColor);
			$this.updateIndicator('#title-bg-color', this.json.otherTitleBGColor);
			$this.updateIndicator('#title-text-color', this.json.otherTitleTextColor);
			$this.updateIndicator('#body-bg-color', this.json.otherBodyBGColor);
			$this.updateIndicator('#body-text-color', this.json.otherBodyTextColor);
			$this.updateIndicator('#input-text-color', this.json.otherInputTextColor);
			$this.updateIndicator('#input-backorder-text-color', this.json.otherInputBackOrderTextColor);
		} 
		this.updateItemRoomEditors(this.json.itemSetStyle);
	},
	updateIndicator:function(id, color) {
		if (color == null) {
			$('.customizer').find(id).parent().find(".indicator").attr('class', 'btn btn-sm px-2 indicator');
		} else {
			color = color.replace('-text', '');
			$('.customizer').find(id).parent().find(".indicator")
			.attr('class', 'btn btn-sm px-2 indicator waves-effect waves-light ' + color);
		}
	},
	initItemRoom:function() {
		this.$itemRoomBooked= $('td.border.room-added');
		this.itemRoomBookedAttr = {
				defaultClass:'border room-added',
				bgColor:'',
				textColor:'',
		};
		this.$itemRoomBookedButton= $('td.border.room-added button');
		this.itemRoomBookedButtonAttr = {
				defaultClass:'border-0 p-0 bg-transparent',
				bgColor:'',
				textColor:'',
		};
		
		this.$itemRoomBookedMobile= $('tr.row.border-bottom.m-1.mb-2.room-added');
		this.itemRoomBookedMobileAttr = {
				defaultClass:'row border-bottom m-1 mb-2 room-added',
				bgColor:'',
				textColor:'',
		};
		this.$itemRoomBookedMobileButton= $('tr.row.border-bottom.m-1.mb-2.room-added button');
		this.itemRoomBookedMobileButtonAttr = {
				defaultClass:'border-0 p-0 bg-transparent',
				bgColor:'',
				textColor:'',
		};
		
		this.initAttr(this.$itemRoomBooked, this.itemRoomBookedAttr);
		this.initAttr(this.$itemRoomBookedButton, this.itemRoomBookedButtonAttr);
		this.initAttr(this.$itemRoomBookedMobile, this.itemRoomBookedMobileAttr);
		this.initAttr(this.$itemRoomBookedMobileButton, this.itemRoomBookedMobileButtonAttr);
	},
	updateItemRoomEditors:function(type) {
		if (type === 'STYLE9') {
			$('.customizer-body').find('#item-room-booked-bg-color').parent().show();
			$('.customizer-body').find('#item-room-booked-text-color').parent().show();
		} else {
			$('.customizer-body').find('#item-room-booked-bg-color').parent().hide();
			$('.customizer-body').find('#item-room-booked-text-color').parent().hide();
		}
	}
};

$.GBEditor = function(obj) {
	this.obj = obj;
};

$.GBEditor.prototype = {
	setObject : function(obj) {
		this.obj = obj;
		return this;
	},
	object : function() {
		return this.obj;
	}
};

var sGBEditor;
var GBEditor = function() {
	if (!sGBEditor) {
		sGBEditor = new $.GBEditor();
	}
	return sGBEditor;
};