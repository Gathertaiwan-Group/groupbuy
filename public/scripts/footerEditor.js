/**
 * 
 */

function readURL(input) {
    if (input.files && input.files[0]) {
        var reader = new FileReader();
        
        reader.onload = function (e) {
            $('#icon-img').attr('src', e.target.result);
        }
        
        reader.readAsDataURL(input.files[0]);
    }
}

function uploadLogo(input) {
    if (input.files && input.files[0]) {
        $('#logoDelete').button('loading');

        var form = new FormData();
        form.append('action', 'upload');
        form.append('uploadField', 'groupBuySettings.footerView.logo');
        form.append('upload', input.files[0]);
        $.ajax({
                type: 'POST',
                url: '/json/uploadImage/vcf',
                data: form,
                success: function (response) {
                    // ex. response = { "upload" : {"id" : "xxxx"} }
                    var $id = (typeof response === 'string' ? $.parseJSON(response) : response)['upload']['id'];
                    updateLogo($id);
                },
                error: function (response) {

                },
                processData: false,
                contentType: false
            });
    }
}

$('button#logoDelete').click(function () {
    // remove logo src and name
    $('#icon-img').attr('src', '/upload/images/unsort/trans.png');
    $('#icon-img').attr('name', '');

    $('img#iconImageFile').attr('src', '/upload/images/unsort/trans.png');
    $('img#iconImageFile').attr('name', '');

    // Remove any files in input
    $('input#iconImageFile').val('');

    $('input[name*=footerLogo]').val('');
});

function blockEnterEvent(event) {
    $(window).keydown(function(event){
        if ($(event.target).attr('id') == 'webFooterInfo') {
            return true;
        }
        if (event.keyCode == 13) {
            event.preventDefault();
            return false;
        }
    });
}

function updateLogo(imageName) {
	var srcPath = '';
	if (imageName.startsWith('http')) {
		srcPath = imageName;
	} else {
		srcPath = '/upload/images/' + imageName;
	}
    $('#icon-img').attr('src', srcPath);
    $('#icon-img').attr('name', imageName);

    $('button#logoDelete').button('complete');
    $('img#iconImageFile').attr('src', srcPath);
    $('img#iconImageFile').attr('name', imageName);
    
    var value = $('input[name=footerLogoURL]').val();
    if (value.length == 0) {
    	$('input[name=footerLogoURL]').val(srcPath);
    }

    $('input[name=footerLogo]').val(imageName);
}

function getList() {
    var groupBuyId = $('input[name*=groupBuyId]').val();
    var ajaxurl = baseUrl + '/ajax/WebEditor/list.do';
    jQuery.get(
        ajaxurl,
        { 'groupBuyId' : groupBuyId },
        function (json) {
            reload(json);
        }
    )
}

function reload(data) {
    var info = data['footerInfo'];
    var menu = data['footerMenu'];
    var bgColor = data['footerBGColor'];
    var sysBGColor = data['footerSysBGColor'];
    var textColor = data['footerTextColor'];
    var copyrightString = data['copyright'];
    var logo = data['footerLogo'];

    if (info) {
        var infoTextarea = $('textarea[name*=footerInfo]');
        infoTextarea.val(info);

        var list = info.split("\n");
        var outText = "";
        for (const i in list) {
            outText += "<p>"+list[i]+"</p>"
        }
        $("div#webFooterInfo").html(outText);
    }

    if (copyrightString) {
        var crInput = $('input[name*=copyright]');
        crInput.val(copyrightString);

        $("span#copyrightStatement").text(copyrightString);
    }

    if (bgColor != null && bgColor != '') {
        var bgColorInput = $('input[name*=footerBGColor]');
        bgColorInput.val(bgColor);
        bgColorInput.prop('class', 'form-control p-1 web-footer-css-color valid');
        bgColorInput.addClass(bgColor);

        var footerPage = $('footer.page-footer#footer-edit');
        footerPage.addClass(bgColor);
    }
    
    if (sysBGColor != null && sysBGColor != '') {
        var sysBGColorInput = $('input[name*=footerSysBGColor]');
        sysBGColorInput.val(sysBGColor);
        sysBGColorInput.prop('class', 'form-control p-1 web-footer-css-color valid');
        sysBGColorInput.addClass(sysBGColor);

        const sysBlock = $('.footer-copyright.text-center.py-3');
        sysBlock.addClass(sysBGColor);
    }

    if (textColor != null && textColor != '') {
        var textColorInput = $('input[name*=footerTextColor]');
        textColorInput.val(textColor);
        textColorInput.prop('class', 'form-control p-1 web-footer-css-color valid');
        if (textColor == 'white-text') {
            textColorInput.addClass('bg-primary');
        }
        textColorInput.addClass(textColor);

        var footerPage = $('footer.page-footer#footer-edit');
        footerPage.addClass(textColor);
        
        // social media
        var fbDefaultClass = 'fab fa-facebook-square';
        var fbIcon = $('i.fab.fa-facebook-square');
        fbIcon.prop('class', fbDefaultClass);
        fbIcon.addClass(textColor);
        
        var igDefaultClass = 'fab fa-instagram';
        var igIcon = $('i.fab.fa-instagram');
        igIcon.prop('class', igDefaultClass);
        igIcon.addClass(textColor);
            
        var lineDefaultClass = 'fab fa-line';
        var lineIcon = $('i.fab.fa-line')
        lineIcon.prop('class', lineDefaultClass);
        lineIcon.addClass(textColor);

        var defaultClass = 'btn-social-flat mx-1 waves-effect waves-light';
        var aFB = $('a#facebookLink');
        var aIG = $('a#instagramLink');
        var aLine = $('a#lineLink');
        aFB.prop('class', defaultClass);
        aIG.prop('class', defaultClass);
        aLine.prop('class', defaultClass);
        if (textColor == 'white-text') {
            aFB.addClass(bgColor);
            aIG.addClass(bgColor);
            aLine.addClass(bgColor);
        }

        // menu
        for (let i = 1; i < 7; i++) {
            var subitemSelector = 'a#item' + i + 'Title';
            var subitem = $(subitemSelector);
            subitem.prop('class', '');
            subitem.addClass(textColor);
        }
    }

    if (logo != null && logo != '') {
        updateLogo(logo);
    }

    if (menu != null && menu != '') {
        var items = menu.split('\n');
        for (let index = 0; index < items.length; index++) {
            const element = items[index];
            if (element.length == 0) { continue; }
            var titleAndLink = element.split('#');
            var title = titleAndLink[0];
            var link = titleAndLink[1];
            var i = index + 1;
            $('#webFooterItem' + i + 'Title').val(title);
            $('#webFooterItem' + i + 'Link').val(link);
            $('a#item' + i + 'Title').text(title);
            $('a#item' + i + 'Title').attr('href', link);
        }
    }

    // Social media
    var facebookId = data['facebookId'];
    var instagramId = data['instagramId'];
    var lineId = data['lineId'];

    if (facebookId) {
        var facebookInput = $('.form-control#facebookLinkInput');
        facebookInput.val(facebookId);
		const prefix = 'https://www.facebook.com/';
		var v = (facebookId.startsWith(prefix)) ? facebookId : prefix + facebookId;
        $('a#facebookLink').attr('href', v);
    }
    if (instagramId) {
        var instagramInput = $('input[name*=instagramId]');
		instagramInput.val(instagramId);
		const prefix = 'https://www.instagram.com/';
		var v = (instagramId.startsWith(prefix)) ? instagramId : prefix + instagramId;
        $('a#instagramLink').attr('href', v);
    }
    if (lineId) {
        var lineInput = $('input[name*=lineId]');
        lineInput.val(lineId);
		const prefix = 'https://line.me/';
		var v = (lineId.startsWith(prefix)) ? lineId : 'https://line.me/R/ti/p/' + lineId;
        $('a#lineLink').attr('href', v);
    }
}

$( document ).ready(function() {
    blockEnterEvent(event);
    getList();

    $('textarea[name*=footerInfo]').css('height', 'auto');

    $('textarea[name*=footerInfo]').on('change', function() { 
        var $this = $(this);
        if ($this) {
            var text = $this.val();
            var list = text.split("\n");
            var div = $('<div></div>');
            for (const i in list) {
                $('<p>' + list[i] + '</p>').appendTo(div);
            }
            $("div#webFooterInfo").html(div.html());
        }
    });

    $('input[id*=webFooterItem][id$=Title]').each(function(i, element) {
        $(element).on('change', function() {
            var $this = $(this);
            if ($this) {
                var inputText = $this.val();
                var parentId = $this.parent().attr('id');
                var text = (inputText.length > 0) ? inputText : "選單"+parentId;
                $("a#item"+parentId+"Title").text(text);

                var validator = $( "#FooterEditorForm" ).validate();
                validator.form();
            }
        });
    });
    $('input[id*=webFooterItem][id$=Link]').each(function(i, element) {
        $(element).on('change', function() {
            var $this = $(this);
            if ($this) {
                var parentId = $this.parent().attr('id');
                $("a#item"+parentId+"Title").attr('href', $this.val());

                var validator = $( "#FooterEditorForm" ).validate();
                validator.form();
            }
        });
    });

    $('input[name*=facebookId]').on('change', function() {
		const prefix = 'https://www.facebook.com/';
		var v = $(this).val();
		if (!v.startsWith(prefix)) v = prefix+$(this).val();
        $("a#facebookLink").attr('href', v);
    });
    $('input[name*=instagramId]').on('change', function() {
		const prefix = 'https://www.instagram.com';
		var v = $(this).val();
		if (!v.startsWith(prefix)) v = prefix+$(this).val();
        $("a#instagramLink").attr('href', v);
    });
    $('input[name*=lineId]').on('change', function() {
		const prefix = 'https://line.me/R/ti/p/';
		var v = $(this).val();
		if (!v.startsWith(prefix)) v = prefix+$(this).val();
        $("a#lineLink").attr('href', v);
    });

    $('#iconImageFile').on('change', function() {
        uploadLogo(this);
    });
    
    $('input[name*=footerLogoURL]').change(function() {
    	var $this = $(this);
    	var value = $this.val();
    	$('#icon-img').attr('src', value);
    	$('img#iconImageFile').attr('src', value);
    	
        $('input[name*=footerLogo]').val(value);
    });

    $('input[name*=copyright]').on('change', function() {
        var $this = $(this);
        if ($this) {
            $("span#copyrightStatement").text($this.val());
        }
    });

    $('#FooterEditorForm').validate({
        rules: {
            webFooterItem1Title: {
                required: function (element) {
                    return $('input[name*=webFooterItem1Link]').val().length > 0;
                }
            },
            webFooterItem1Link: {
                required: function (element) {
                    return $('input[name*=webFooterItem1Title]').val().length > 0;
                }
            },
            webFooterItem2Title: {
                required: function (element) {
                    return $('input[name*=webFooterItem2Link]').val().length > 0;
                }
            },
            webFooterItem2Link: {
                required: function (element) {
                    return $('input[name*=webFooterItem2Title]').val().length > 0;
                }
            },
            webFooterItem3Title: {
                required: function (element) {
                    return $('input[name*=webFooterItem3Link]').val().length > 0;
                }
            },
            webFooterItem3Link: {
                required: function (element) {
                    return $('input[name*=webFooterItem3Title]').val().length > 0;
                }
            },
            webFooterItem4Title: {
                required: function (element) {
                    return $('input[name*=webFooterItem4Link]').val().length > 0;
                }
            },
            webFooterItem4Link: {
                required: function (element) {
                    return $('input[name*=webFooterItem4Title]').val().length > 0;
                }
            },
            webFooterItem5Title: {
                required: function (element) {
                    return $('input[name*=webFooterItem5Link]').val().length > 0;
                }
            },
            webFooterItem5Link: {
                required: function (element) {
                    return $('input[name*=webFooterItem5Title]').val().length > 0;
                }
            },
            webFooterItem6Title: {
                required: function (element) {
                    return $('input[name*=webFooterItem6Link]').val().length > 0;
                }
            },
            webFooterItem6Link: {
                required: function (element) {
                    return $('input[name*=webFooterItem6Title]').val().length > 0;
                }
            },
        },
        messages: {},
        errorPlacement: function(error, element) {
            error.addClass('text-danger');
            error.insertAfter(element);
        },
        wrapper: 'span'
    });
});

// Modal
function colorButton (className, colorClassName) {
	var button = document.createElement('button');
	button.className = 'btn btn-sm px-2 m-1 ' + colorClassName + ' ' + className;
	button.name = colorClassName;
	$(button).attr('data-dismiss', 'modal');
	return button.outerHTML;
}

function bgColorButtons (className) {
    var htmlText = '<div class="row">';
    var plainColors = ["red","pink","purple","deep-purple","indigo","blue","light-blue","cyan","teal","green","light-green","lime","yellow","amber","orange","deep-orange","brown","grey","blue-grey","mdb-color"];
    var plainColorProperties = ["lighten","darken","accent"];
    plainColors.forEach(function(color) {
        plainColorProperties.forEach(function(property) {
            for (let i = 1; i < 5; i++) {
                htmlText += colorButton(className, color+' '+property+'-'+i);
            }
        });
        htmlText += colorButton(className, color);
    });

    var levelColors = ["blue","red","pink","purple","indigo","cyan","teal","green","lime","yellow","orange","brown","grey","bluegrey","black","stylish","white"];
    var levels = ["light","strong","slight"];
    levelColors.forEach(function(color) {
        levels.forEach(function(level) {
            htmlText += colorButton(className, 'rgba-'+color+'-'+level);
        });
    });

    var gradientColors = ["purple-gradient", "peach-gradient", "aqua-gradient", "blue-gradient"];
    gradientColors.forEach(function(color) {
        htmlText += colorButton(className, color);
    });
    htmlText += colorButton(className, 'theme-bg');
    
    htmlText += '</div>';
    return htmlText;
}

$('#bgColorPickerBody').ready(function() {
	$('#bgColorPickerBody').html(bgColorButtons('btn-color-picker'));
});
$('#sysBGColorPickerBody').ready(function() {
	$('#sysBGColorPickerBody').html(bgColorButtons('btn-sys-color-picker'));
});
$('.modal-body-picker').ready(function() {
    $('.btn-color-picker').click(function() {
        var $this = $(this);
        var bgColor = $this.attr('name');
        // Update bg color of footer.
        var defaultClass = 'page-footer font-small pt-4';
        var footerPage = $('footer.page-footer#footer-edit');
        footerPage.prop('class', defaultClass);
        footerPage.addClass(bgColor);
        // Add text color to footer because it is removed.
        var textColor = $('input[name*=footerTextColor]').val();
        if (textColor == null || textColor == '') {
            textColor = 'text-dark';
        }
        footerPage.addClass(textColor);
        // Update input value of text color input.
        var bgColorInput = $('input[name*=footerBGColor]');
        bgColorInput.val(bgColor);
        // Update bg color of text color input.
        bgColorInput.prop('class', 'form-control p-1 web-footer-css-color valid');
        bgColorInput.addClass(bgColor);
        // Update social media bg color if text color is white
        if (textColor == 'white-text') {
            var defaultClass = 'btn-social-flat mx-1 waves-effect waves-light';
            var aFB = $('a#facebookLink');
            var aIG = $('a#instagramLink');
            var aLine = $('a#lineLink');
            aFB.prop('class', defaultClass);
            aIG.prop('class', defaultClass);
            aLine.prop('class', defaultClass);
            aFB.addClass(bgColor);
            aIG.addClass(bgColor);
            aLine.addClass(bgColor);
        }
    });
    $('.btn-sys-color-picker').click(function() {
        var $this = $(this);
        // Get color name
        var bgColor = $this.attr('name');
        // Set color of footer system block 
        var defaultClass = 'footer-copyright text-center py-3';
        var footerSys = $('.footer-copyright.text-center.py-3');
        footerSys.prop('class', defaultClass);
        footerSys.addClass(bgColor);
        // Update input for system bg color
        var colorInput = $('input[name*=footerSysBGColor]');
        colorInput.val(bgColor);
        colorInput.prop('class', 'form-control p-1 web-footer-css-color valid');
        colorInput.addClass(bgColor);
    });
    $('.btn-text-color-picker').click(function() {
        var $this = $(this);
        var textColor = $this.prop('name');
        var defaultClass = 'page-footer font-small pt-4';
        var footerPage = $('footer.page-footer#footer-edit');
        footerPage.attr('class', defaultClass);
        footerPage.addClass(textColor);
        var textColorInput = $('input[name*=footerTextColor]');
        textColorInput.val(textColor);
        textColorInput.prop('class', 'form-control p-1 web-footer-css-color valid');
        if (textColor == 'white-text') {
            // button add 
            textColorInput.addClass('bg-primary');
        }
        textColorInput.addClass(textColor);

        var bgColorClass = '';
        var footerBGColorInput = $('input[name*=footerBGColor]');
        if (footerBGColorInput.val().length > 0) {
            bgColorClass = footerBGColorInput.val();
        }
        footerPage.addClass(bgColorClass);
        
        // social media
        var fbDefaultClass = 'fab fa-facebook-square';
        var fbIcon = $('i.fab.fa-facebook-square');
        fbIcon.prop('class', fbDefaultClass);
        fbIcon.addClass(textColor);
        
        var igDefaultClass = 'fab fa-instagram';
        var igIcon = $('i.fab.fa-instagram');
        igIcon.prop('class', igDefaultClass);
        igIcon.addClass(textColor);
        	
        var lineDefaultClass = 'fab fa-line';
        var lineIcon = $('i.fab.fa-line')
        lineIcon.prop('class', lineDefaultClass);
        lineIcon.addClass(textColor);

        var defaultClass = 'btn-social-flat mx-1 waves-effect waves-light';
        var aFB = $('a#facebookLink');
        var aIG = $('a#instagramLink');
        var aLine = $('a#lineLink');
        aFB.prop('class', defaultClass);
        aIG.prop('class', defaultClass);
        aLine.prop('class', defaultClass);
        if (textColor == 'white-text') {
            aFB.addClass(bgColorClass);
            aIG.addClass(bgColorClass);
            aLine.addClass(bgColorClass);
        }

        // menu
        for (let i = 1; i < 7; i++) {
        	var subitemSelector = 'a#item' + i + 'Title';
        	var subitem = $(subitemSelector);
        	subitem.prop('class', '');
        	subitem.addClass(textColor);
        }
    });
    $('#bgColorHexForm').on('change', function() {
        var $this = $(this);
    });
});