/*!
 * groupbuy Editor 相容 shim（自行撰寫，非 DataTables Editor 程式碼）
 *
 * 原站使用商業授權的 DataTables Editor 1.9.2（含 bootstrap4 整合與 CKEditor4 欄位外掛），不可散佈。
 * 本檔以同名 API（$.fn.dataTable.Editor）重新實作原站實際用到的功能，讓原站自家 JS（dataTable.min.js、
 * dataTable.config.min.js、dataTable.api.min.js、dataTable.api.editor.min.js、editor.ckeditor5.min.js、
 * editor.colorPicker.min.js）與各頁 inline script 不需修改即可運作。行為以原站實測與 Editor 公開文件為準。
 *
 * 支援範圍（詳見 docs/MODULE_GUIDE.md「Editor shim」）：
 *   建構選項：ajax（字串 / {create,edit,remove} / jQuery 選項；URL 中 _id_；ajax.data 函式）、idSrc、table、fields、
 *            template（<editor-field name>）、i18n、formOptions（main/inline/bubble）
 *   實例方法：add ajax clear field fields get set val show hide enable disable dependent error message title buttons
 *            create edit remove inline bubble open close blur submit display displayed mode modifier ids inError
 *            processing on one off destroy order background
 *   Field：val get set def error message fieldInfo label labelInfo input node show hide enable disable update
 *         processing focus inError displayed multiSet/multiGet/multiReset/isMultiValue（多列編輯）
 *   欄位型別：text password textarea hidden readonly select checkbox radio datetime upload uploadMany ckeditor select2
 *            （外掛型別 ckeditorClassic、customColorPicker、WebEditor 各型別由原站外掛自行註冊）
 *   事件：open opened close closed preOpen cancelOpen preClose preBlur initCreate initEdit initRemove initSubmit
 *        preSubmit postSubmit submitSuccess submitUnsuccessful submitError submitComplete preCreate postCreate
 *        preEdit postEdit preRemove postRemove setData processing displayOrder uploadXhrSuccess uploadXhrError
 *        preUpload postUpload（*Cancelled 變體）
 *   DataTables 整合：Buttons（create/edit/remove/editSingle/removeSingle）、API editor()、列表回應 options 自動更新欄位選項
 */
(function ($, window, document) {
  'use strict';

  var DataTable = $ && $.fn && $.fn.dataTable;
  if (!DataTable) {
    if (window.console) console.error('[editor-shim] 需要先載入 DataTables');
    return;
  }

  var ext = DataTable.ext;
  var oApi = ext.internal || ext.oApi;
  var getObjFn = function (src) { return oApi._fnGetObjectDataFn(src); };
  var setObjFn = function (src) { return oApi._fnSetObjectDataFn(src); };

  var __inlineCounter = 0;
  var __editorCounter = 0;

  /* ======================================================================
   * 工具
   * ==================================================================== */
  function _pluck(obj, prop) {
    var out = [];
    $.each(obj, function (key, el) { out.push(el[prop]); });
    return out;
  }

  function _triggerChange(input) {
    setTimeout(function () { input.trigger('change', { editor: true, editorSet: true }); }, 0);
  }

  function _isApi(o) {
    return o && typeof o === 'object' && o instanceof DataTable.Api;
  }

  function __dtApi(table) {
    return _isApi(table) ? table : new DataTable.Api(table);
  }

  function __dtjqId(id) {
    return typeof id === 'string' ? '#' + id.replace(/(:|\.|\[|\]|,)/g, '\\$1') : '#' + id;
  }

  function __dtHighlight(node) {
    if (!node) return;
    setTimeout(function () {
      $(node).addClass('highlight');
      setTimeout(function () {
        $(node).addClass('noHighlight').removeClass('highlight');
        setTimeout(function () { $(node).removeClass('noHighlight'); }, 550);
      }, 500);
    }, 20);
  }

  function _deepCompare(a, b) {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (!_deepCompare(a[i], b[i])) return false;
      return true;
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      var ka = Object.keys(a), kb = Object.keys(b);
      if (ka.length !== kb.length) return false;
      for (var j = 0; j < ka.length; j++) if (!_deepCompare(a[ka[j]], b[ka[j]])) return false;
      return true;
    }
    // Editor 以寬鬆比較（數字 1 與字串 '1' 視為相同）
    // eslint-disable-next-line eqeqeq
    return a == b && !(a === '' && b === 0) && !(a === 0 && b === '');
  }

  /* ======================================================================
   * Editor 建構子
   * ==================================================================== */
  var Editor = function (opts) {
    if (!(this instanceof Editor)) {
      // 原站寫法一律用 new；保險起見
      return new Editor(opts);
    }
    this._constructor(opts || {});
  };

  Editor.version = '1.9.2';
  Editor.files = {};
  Editor.display = {};
  Editor.fieldTypes = ext.editorFields || {};
  ext.editorFields = Editor.fieldTypes;

  /** 'a.b' → 'a-b'（與原版相同：只替換點號，[] 保留） */
  Editor.safeId = function (id) {
    return typeof id === 'string' ? id.replace(/\./g, '-') : id;
  };
  Editor.safeQueryId = function (id) {
    return typeof id === 'string' ? id.replace(/(:|\.|\[|\]|,)/g, '\\$1') : id;
  };

  /** 選項迭代：陣列（物件 {label,value,attr} 或純值）或 {label: value} 物件 */
  Editor.pairs = function (data, props, fn) {
    var i, ien, dataPoint;
    props = $.extend({ label: 'label', value: 'value' }, props);
    if (Array.isArray(data)) {
      for (i = 0, ien = data.length; i < ien; i++) {
        dataPoint = data[i];
        if ($.isPlainObject(dataPoint)) {
          fn(dataPoint[props.value] === undefined ? dataPoint[props.label] : dataPoint[props.value], dataPoint[props.label], i, dataPoint.attr);
        } else {
          fn(dataPoint, dataPoint, i);
        }
      }
    } else if (data) {
      i = 0;
      $.each(data, function (key, val) {
        fn(val, key, i);
        i++;
      });
    }
  };

  Editor.classes = {
    wrapper: 'DTE modal-content',
    processing: { indicator: 'DTE_Processing_Indicator', active: 'processing' },
    header: { wrapper: 'DTE_Header modal-header', content: 'DTE_Header_Content' },
    body: { wrapper: 'DTE_Body modal-body', content: 'DTE_Body_Content' },
    footer: { wrapper: 'DTE_Footer modal-footer', content: 'DTE_Footer_Content' },
    form: {
      wrapper: 'DTE_Form',
      content: 'DTE_Form_Content',
      tag: 'form-horizontal',
      info: 'DTE_Form_Info',
      error: 'DTE_Form_Error',
      buttons: 'DTE_Form_Buttons',
      button: 'btn',
      buttonInternal: 'btn btn-outline-secondary'
    },
    field: {
      wrapper: 'DTE_Field form-group row',
      typePrefix: 'DTE_Field_Type_',
      namePrefix: 'DTE_Field_Name_',
      label: 'col-lg-4 col-form-label',
      input: 'col-lg-8',
      inputControl: 'DTE_Field_InputControl',
      error: 'error is-invalid',
      'msg-label': 'DTE_Label_Info',
      'msg-error': 'form-text text-danger small',
      'msg-message': 'form-text text-secondary small',
      'msg-info': 'form-text text-secondary small',
      multiValue: 'card multi-value',
      multiInfo: 'small',
      multiRestore: 'card multi-restore',
      multiNoEdit: 'multi-noEdit disabled',
      disabled: 'disabled',
      processing: 'DTE_Processing_Indicator'
    },
    actions: { create: 'DTE_Action_Create', edit: 'DTE_Action_Edit', remove: 'DTE_Action_Remove' },
    inline: { wrapper: 'DTE DTE_Inline', liner: 'DTE_Inline_Field', buttons: 'DTE_Inline_Buttons' },
    bubble: {
      wrapper: 'DTE DTE_Bubble',
      liner: 'DTE_Bubble_Liner',
      table: 'DTE_Bubble_Table',
      close: 'icon close',
      pointer: 'DTE_Bubble_Triangle',
      bg: 'DTE_Bubble_Background'
    }
  };

  Editor.models = {};
  Editor.models.formOptions = {
    onReturn: 'submit',
    onBlur: 'close',
    onBackground: 'blur',
    onComplete: 'close',
    onEsc: 'close',
    onFieldError: 'focus',
    submit: 'all',
    focus: 0,
    buttons: true,
    title: true,
    message: true,
    drawType: false,
    scope: 'row',
    nest: false
  };
  Editor.models.displayController = {
    init: function () {},
    open: function (dte, append, fn) { if (fn) fn(); },
    close: function (dte, fn) { if (fn) fn(); }
  };
  Editor.models.fieldType = {
    create: function () {},
    get: function () {},
    set: function () {},
    enable: function () {},
    disable: function () {}
  };

  Editor.defaults = {
    table: null,
    ajaxUrl: null,
    fields: [],
    display: 'bootstrap',
    ajax: null,
    idSrc: 'DT_RowId',
    events: {},
    i18n: {
      close: 'Close',
      create: { button: 'New', title: '<h5 class="modal-title">Create new entry</h5>', submit: 'Create' },
      edit: { button: 'Edit', title: '<h5 class="modal-title">Edit entry</h5>', submit: 'Update' },
      remove: {
        button: 'Delete',
        title: '<h5 class="modal-title">Delete</h5>',
        submit: 'Delete',
        confirm: { _: 'Are you sure you wish to delete %d rows?', 1: 'Are you sure you wish to delete 1 row?' }
      },
      error: { system: 'A system error has occurred.' },
      multi: {
        title: 'Multiple values',
        info: 'The selected items contain different values for this input. To edit and set all items for this input to the same value, click or tap here, otherwise they will retain their individual values.',
        restore: 'Undo changes',
        noMulti: 'This input can be edited individually, but not part of a group.'
      },
      datetime: {
        previous: 'Previous',
        next: 'Next',
        months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
        weekdays: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
        amPm: ['am', 'pm'],
        hours: 'Hour',
        minutes: 'Minute',
        seconds: 'Second',
        unknown: '-'
      }
    },
    formOptions: {
      main: $.extend({}, Editor.models.formOptions),
      bubble: $.extend({}, Editor.models.formOptions, { title: false, message: false, buttons: '_basic', submit: 'changed' }),
      inline: $.extend({}, Editor.models.formOptions, { buttons: false, submit: 'changed' })
    },
    legacyAjax: false,
    actionName: 'action'
  };

  /* ======================================================================
   * Field
   * ==================================================================== */
  var Field = function (opts, classes, host) {
    var that = this;
    var multiI18n = host.i18n.multi;
    opts = $.extend(true, {}, Field.defaults, opts);
    if (!Editor.fieldTypes[opts.type]) {
      throw new Error('Error adding field - unknown field type ' + opts.type);
    }
    this.s = $.extend({}, Field.settings, {
      type: Editor.fieldTypes[opts.type],
      name: opts.name,
      classes: classes,
      host: host,
      opts: opts,
      multiValue: false
    });
    if (!opts.id) opts.id = 'DTE_Field_' + opts.name;
    if (opts.dataProp) opts.data = opts.dataProp;
    if (opts.data === '') opts.data = opts.name;

    var dataSrc = opts.data;
    this.valFromData = function (d) {
      var fn = getObjFn(dataSrc);
      return fn(d, 'editor');
    };
    this.valToData = setObjFn(dataSrc);

    var template = $(
      '<div class="' + classes.wrapper + ' ' + classes.typePrefix + opts.type + ' ' + classes.namePrefix + opts.name + ' ' + (opts.className || '') + '">' +
        '<label data-dte-e="label" class="' + classes.label + '" for="' + Editor.safeId(opts.id) + '">' +
          (opts.label === undefined || opts.label === null ? '' : opts.label) +
          '<div data-dte-e="msg-label" class="' + classes['msg-label'] + '">' + (opts.labelInfo || '') + '</div>' +
        '</label>' +
        '<div data-dte-e="input" class="' + classes.input + '">' +
          '<div data-dte-e="input-control" class="' + classes.inputControl + '"></div>' +
          '<div data-dte-e="multi-value" class="' + classes.multiValue + '">' +
            multiI18n.title +
            '<span data-dte-e="multi-info" class="' + classes.multiInfo + '">' + multiI18n.info + '</span>' +
          '</div>' +
          '<div data-dte-e="msg-multi" class="' + classes.multiRestore + '">' + multiI18n.restore + '</div>' +
          '<div data-dte-e="msg-error" class="' + classes['msg-error'] + '"></div>' +
          '<div data-dte-e="msg-message" class="' + classes['msg-message'] + '">' + (opts.message || '') + '</div>' +
          '<div data-dte-e="msg-info" class="' + classes['msg-info'] + '">' + (opts.fieldInfo || '') + '</div>' +
        '</div>' +
        '<div data-dte-e="field-processing" class="' + classes.processing + '"><span></span></div>' +
      '</div>'
    );

    var input = this._typeFn('create', opts);
    if (input !== null && input !== undefined) {
      $('div[data-dte-e="input-control"]', template).prepend(input);
    } else {
      template.css('display', 'none');
    }

    this.dom = $.extend(true, {}, Field.models.dom, {
      container: template,
      inputControl: $('div[data-dte-e="input-control"]', template),
      label: $('label[data-dte-e="label"]', template),
      fieldInfo: $('div[data-dte-e="msg-info"]', template),
      labelInfo: $('div[data-dte-e="msg-label"]', template),
      fieldError: $('div[data-dte-e="msg-error"]', template),
      fieldMessage: $('div[data-dte-e="msg-message"]', template),
      multi: $('div[data-dte-e="multi-value"]', template),
      multiReturn: $('div[data-dte-e="msg-multi"]', template),
      multiInfo: $('span[data-dte-e="multi-info"]', template),
      processing: $('div[data-dte-e="field-processing"]', template)
    });

    // 初始顯示狀態（與原版相同：空訊息區塊不佔空間）
    this.dom.multi.css('display', 'none');
    this.dom.multiReturn.css('display', 'none');
    this.dom.fieldError.css('display', 'none');
    if (!opts.message) this.dom.fieldMessage.css('display', 'none');
    if (!opts.fieldInfo) this.dom.fieldInfo.css('display', 'none');
    this.dom.processing.css('display', 'none');

    // 多值：點「多個數值」→ 全部設為同一值
    this.dom.multi.on('click', function () {
      if (that.s.opts.multiEditable && !template.hasClass(classes.disabled) && opts.type !== 'readonly') {
        that.set('');
        that.focus();
      }
    });
    this.dom.multiReturn.on('click', function () {
      that.multiRestore();
    });

    // 型別上多出來的函式自動掛成 Field 方法（原版行為：update、inst、minDate…）
    $.each(this.s.type, function (name, fn) {
      if (typeof fn === 'function' && that[name] === undefined) {
        that[name] = function () {
          var args = Array.prototype.slice.call(arguments);
          args.unshift(name);
          var ret = that._typeFn.apply(that, args);
          return ret === undefined ? that : ret;
        };
      }
    });
  };

  Field.defaults = {
    className: '',
    data: '',
    def: '',
    fieldInfo: '',
    id: '',
    label: '',
    labelInfo: '',
    name: null,
    type: 'text',
    message: '',
    multiEditable: true,
    submit: true,
    attr: {}
  };
  Field.settings = {
    type: null,
    name: null,
    classes: null,
    opts: null,
    host: null
  };
  Field.models = { dom: {} };

  Field.prototype = {
    _typeFn: function (name) {
      var args = Array.prototype.slice.call(arguments);
      args.shift();
      args.unshift(this.s.opts);
      var fn = this.s.type[name];
      if (fn) return fn.apply(this.s.host, args);
    },

    def: function (set) {
      var opts = this.s.opts;
      if (set === undefined) {
        var def = opts['default'] !== undefined ? opts['default'] : opts.def;
        return typeof def === 'function' ? def() : def;
      }
      opts.def = set;
      return this;
    },

    disable: function () {
      this.dom.container.addClass(this.s.classes.disabled);
      this._typeFn('disable');
      return this;
    },

    enable: function () {
      this.dom.container.removeClass(this.s.classes.disabled);
      this._typeFn('enable');
      return this;
    },

    enabled: function () {
      return this.dom.container.hasClass(this.s.classes.disabled) === false;
    },

    displayed: function () {
      var container = this.dom.container;
      return container.parents('body').length && container.css('display') !== 'none';
    },

    error: function (msg, fn) {
      var classes = this.s.classes;
      if (msg) this.dom.container.addClass(classes.error);
      else this.dom.container.removeClass(classes.error);
      this._typeFn('errorMessage', msg);
      return this._msg(this.dom.fieldError, msg, fn);
    },

    fieldInfo: function (msg) {
      return this._msg(this.dom.fieldInfo, msg);
    },

    isMultiValue: function () {
      return this.s.multiValue && this.s.multiIds.length !== 1;
    },

    inError: function () {
      return this.dom.container.hasClass(this.s.classes.error);
    },

    input: function () {
      return this.s.type.input ? this._typeFn('input') : $('input, select, textarea', this.dom.container);
    },

    focus: function () {
      if (this.s.type.focus) this._typeFn('focus');
      else $('input, select, textarea', this.dom.container).first().trigger('focus');
      return this;
    },

    get: function () {
      if (this.isMultiValue()) return undefined;
      var val = this._typeFn('get');
      return val !== undefined ? val : this.def();
    },

    hide: function (animate) {
      var el = this.dom.container;
      if (animate === undefined) animate = true;
      // 先結束進行中／排隊中的顯示隱藏動畫：後呼叫者為準（否則較早排入的 slideDown／slideUp 結束時會蓋掉這次的結果）
      if (el.stop) el.stop(true, true);
      if (this.s.host.display() && animate && $.fn.slideUp) el.slideUp();
      else el.css('display', 'none');
      return this;
    },

    label: function (str) {
      var label = this.dom.label;
      var labelInfo = this.dom.labelInfo.detach();
      if (str === undefined) {
        var html = label.html();
        label.append(labelInfo);
        return html;
      }
      label.html(str);
      label.append(labelInfo);
      return this;
    },

    labelInfo: function (msg) {
      return this._msg(this.dom.labelInfo, msg);
    },

    message: function (msg, fn) {
      return this._msg(this.dom.fieldMessage, msg, fn);
    },

    multiGet: function (id) {
      var value;
      var multiValues = this.s.multiValues;
      var multiIds = this.s.multiIds;
      if (id === undefined) {
        value = {};
        for (var i = 0; i < multiIds.length; i++) value[multiIds[i]] = this.isMultiValue() ? multiValues[multiIds[i]] : this.val();
      } else if (this.isMultiValue()) {
        value = multiValues[id];
      } else {
        value = this.val();
      }
      return value;
    },

    multiRestore: function () {
      this.s.multiValue = true;
      this._multiValueCheck();
    },

    multiSet: function (idSrc, val) {
      var multiValues = this.s.multiValues;
      var multiIds = this.s.multiIds;
      if (val === undefined) {
        val = idSrc;
        idSrc = undefined;
      }
      var set = function (id, v) {
        if ($.inArray(id, multiIds) === -1) multiIds.push(id);
        multiValues[id] = v;
      };
      if ($.isPlainObject(val) && idSrc === undefined) {
        $.each(val, function (id, v) { set(id, v); });
      } else if (idSrc === undefined) {
        $.each(multiIds, function (i, id) { set(id, val); });
      } else {
        set(idSrc, val);
      }
      this.s.multiValue = true;
      this._multiValueCheck();
      return this;
    },

    multiIds: function () {
      return this.s.multiIds;
    },

    multiInfoShown: function (show) {
      this.dom.multiInfo.css({ display: show ? 'block' : 'none' });
    },

    multiReset: function () {
      this.s.multiIds = [];
      this.s.multiValues = {};
    },

    name: function () {
      return this.s.opts.name;
    },

    dataSrc: function () {
      return this.s.opts.data;
    },

    node: function () {
      return this.dom.container[0];
    },

    nullDefault: function () {
      return this.s.opts.nullDefault;
    },

    processing: function (set) {
      if (set === undefined) return this.dom.processing.css('display') === 'block';
      this.dom.processing.css('display', set ? 'block' : 'none');
      this.s.host._event('processing-field', [set]);
      return this;
    },

    set: function (val, multiCheck) {
      var decodeFn = function (d) {
        return typeof d !== 'string'
          ? d
          : d
              .replace(/&gt;/g, '>')
              .replace(/&lt;/g, '<')
              .replace(/&amp;/g, '&')
              .replace(/&quot;/g, '"')
              .replace(/&#163;/g, '£')
              .replace(/&#0?39;/g, "'")
              .replace(/&#0?10;/g, '\n');
      };
      this.s.multiValue = false;
      var decode = this.s.opts.entityDecode;
      if (decode === undefined || decode === true) {
        if (Array.isArray(val)) {
          for (var i = 0, ien = val.length; i < ien; i++) val[i] = decodeFn(val[i]);
        } else {
          val = decodeFn(val);
        }
      }
      this._typeFn('set', val);
      if (multiCheck === undefined || multiCheck === true) this._multiValueCheck();
      return this;
    },

    show: function (animate) {
      var el = this.dom.container;
      if (animate === undefined) animate = true;
      if (el.stop) el.stop(true, true);
      if (this.s.host.display() && animate && $.fn.slideDown) el.slideDown();
      else el.css('display', '');
      return this;
    },

    val: function (val) {
      return val === undefined ? this.get() : this.set(val);
    },

    compare: function (value, original) {
      var compare = this.s.opts.compare || _deepCompare;
      return compare(value, original);
    },

    submittable: function () {
      return this.s.opts.submit !== false;
    },

    destroy: function () {
      this.dom.container.remove();
      this._typeFn('destroy');
      return this;
    },

    _msg: function (el, msg, fn) {
      if (msg === undefined) return el.html();
      if (typeof msg === 'function') {
        var editor = this.s.host;
        msg = msg(editor, new DataTable.Api(editor.s.table));
      }
      if (el.parent().is(':visible') && $.fn.animate) {
        el.html(msg);
        if (msg) el.slideDown(fn);
        else el.slideUp(fn);
      } else {
        el.html(msg || '').css('display', msg ? 'block' : 'none');
        if (fn) fn();
      }
      return this;
    },

    _multiValueCheck: function () {
      var last;
      var ids = this.s.multiIds;
      var values = this.s.multiValues;
      var isMultiValue = this.s.multiValue;
      var isMultiEditable = this.s.opts.multiEditable;
      var val;
      var different = false;
      if (ids) {
        for (var i = 0; i < ids.length; i++) {
          val = values[ids[i]];
          if (i > 0 && !_deepCompare(val, last)) {
            different = true;
            break;
          }
          last = val;
        }
      }
      if ((different && isMultiValue) || (!isMultiEditable && this.isMultiValue())) {
        this.dom.inputControl.css({ display: 'none' });
        this.dom.multi.css({ display: 'block' });
      } else {
        this.dom.inputControl.css({ display: 'block' });
        this.dom.multi.css({ display: 'none' });
        if (isMultiValue && !different) this.set(last, false);
      }
      this.dom.multiReturn.css({ display: ids && ids.length > 1 && different && !isMultiValue ? 'block' : 'none' });
      this.s.host._multiInfo();
      return true;
    }
  };

  Editor.Field = Field;

  /* ======================================================================
   * 欄位型別
   * ==================================================================== */
  var fieldTypes = Editor.fieldTypes;
  var baseFieldType = $.extend(true, {}, Editor.models.fieldType, {
    get: function (conf) { return conf._input.val(); },
    set: function (conf, val) {
      conf._input.val(val);
      _triggerChange(conf._input);
    },
    enable: function (conf) { conf._input.prop('disabled', false); },
    disable: function (conf) { conf._input.prop('disabled', true); },
    canReturnSubmit: function () { return true; }
  });

  fieldTypes.hidden = {
    create: function (conf) {
      conf._val = conf.value;
      return null;
    },
    get: function (conf) { return conf._val; },
    set: function (conf, val) { conf._val = val; }
  };

  fieldTypes.readonly = $.extend(true, {}, baseFieldType, {
    create: function (conf) {
      conf._input = $('<input/>').attr($.extend({ id: Editor.safeId(conf.id), type: 'text', readonly: 'readonly' }, conf.attr || {}));
      return conf._input[0];
    }
  });

  fieldTypes.text = $.extend(true, {}, baseFieldType, {
    create: function (conf) {
      conf._input = $('<input/>').attr($.extend({ id: Editor.safeId(conf.id), type: 'text' }, conf.attr || {}));
      return conf._input[0];
    }
  });

  fieldTypes.password = $.extend(true, {}, baseFieldType, {
    create: function (conf) {
      conf._input = $('<input/>').attr($.extend({ id: Editor.safeId(conf.id), type: 'password' }, conf.attr || {}));
      return conf._input[0];
    }
  });

  fieldTypes.textarea = $.extend(true, {}, baseFieldType, {
    create: function (conf) {
      conf._input = $('<textarea></textarea>').attr($.extend({ id: Editor.safeId(conf.id) }, conf.attr || {}));
      return conf._input[0];
    },
    canReturnSubmit: function () { return false; }
  });

  fieldTypes.select = $.extend(true, {}, baseFieldType, {
    _addOptions: function (conf, opts, append) {
      var elOpts = conf._input[0].options;
      var countOffset = 0;
      if (!append) {
        elOpts.length = 0;
        if (conf.placeholder !== undefined && conf.placeholder !== null) {
          var placeholderValue = conf.placeholderValue !== undefined ? conf.placeholderValue : '';
          countOffset += 1;
          elOpts[0] = new Option(conf.placeholder, placeholderValue);
          var disabled = conf.placeholderDisabled !== undefined ? conf.placeholderDisabled : true;
          elOpts[0].hidden = disabled;
          elOpts[0].disabled = disabled;
          elOpts[0]._editor_val = placeholderValue;
        }
      } else {
        countOffset = elOpts.length;
      }
      if (opts) {
        Editor.pairs(opts, conf.optionsPair, function (val, label, i, attr) {
          var option = new Option(label, val);
          option._editor_val = val;
          if (attr) $(option).attr(attr);
          elOpts[i + countOffset] = option;
        });
      }
    },
    create: function (conf) {
      conf._input = $('<select></select>')
        .attr($.extend({ id: Editor.safeId(conf.id), multiple: conf.multiple === true }, conf.attr || {}))
        .on('change.dte', function (e, d) {
          if (!d || !d.editor) conf._lastSet = fieldTypes.select.get(conf);
        });
      fieldTypes.select._addOptions(conf, conf.options || conf.ipOpts);
      return conf._input[0];
    },
    update: function (conf, options, append) {
      fieldTypes.select._addOptions(conf, options, append);
      var lastSet = conf._lastSet;
      if (lastSet !== undefined) fieldTypes.select.set(conf, lastSet, true);
      _triggerChange(conf._input);
    },
    get: function (conf) {
      var val = conf._input.find('option:selected').map(function () { return this._editor_val; }).toArray();
      if (conf.multiple) return conf.separator ? val.join(conf.separator) : val;
      return val.length ? val[0] : null;
    },
    set: function (conf, val, localUpdate) {
      if (!localUpdate) conf._lastSet = val;
      if (conf.multiple && conf.separator && !Array.isArray(val)) {
        val = typeof val === 'string' ? val.split(conf.separator) : [];
      } else if (!Array.isArray(val)) {
        val = [val];
      }
      var i, len = val.length, found, allFound = false;
      var options = conf._input.find('option');
      options.each(function () {
        found = false;
        for (i = 0; i < len; i++) {
          // eslint-disable-next-line eqeqeq
          if (this._editor_val == val[i]) {
            found = true;
            allFound = true;
            break;
          }
        }
        this.selected = found;
      });
      if (conf.placeholder && !allFound && !conf.multiple && options.length) options[0].selected = true;
      if (!localUpdate) _triggerChange(conf._input);
      return allFound;
    },
    destroy: function (conf) { conf._input.off('change.dte'); }
  });

  fieldTypes.checkbox = $.extend(true, {}, baseFieldType, {
    _addOptions: function (conf, opts, append) {
      var jqInput = conf._input;
      var offset = 0;
      if (!append) jqInput.empty();
      else offset = $('input', jqInput).length;
      if (opts) {
        Editor.pairs(opts, conf.optionsPair, function (val, label, i, attr) {
          var id = Editor.safeId(conf.id) + '_' + (i + offset);
          jqInput.append('<div><input id="' + id + '" type="checkbox" /><label for="' + id + '">' + label + '</label></div>');
          var inp = $('input:last', jqInput);
          inp.attr('value', val)[0]._editor_val = val;
          if (attr) inp.attr(attr);
        });
      }
    },
    create: function (conf) {
      conf._input = $('<div></div>');
      fieldTypes.checkbox._addOptions(conf, conf.options || conf.ipOpts);
      return conf._input[0];
    },
    get: function (conf) {
      var out = [];
      var selected = conf._input.find('input:checked');
      if (selected.length) selected.each(function () { out.push(this._editor_val); });
      else if (conf.unselectedValue !== undefined) out.push(conf.unselectedValue);
      return conf.separator === undefined || conf.separator === null ? out : out.length === 1 ? out[0] : out.join(conf.separator);
    },
    set: function (conf, val) {
      var jqInputs = conf._input.find('input');
      if (!Array.isArray(val) && typeof val === 'string') val = val.split(conf.separator || '|');
      else if (!Array.isArray(val)) val = [val];
      var i, len = val.length, found;
      jqInputs.each(function () {
        found = false;
        for (i = 0; i < len; i++) {
          // eslint-disable-next-line eqeqeq
          if (this._editor_val == val[i]) {
            found = true;
            break;
          }
        }
        this.checked = found;
      });
      _triggerChange(jqInputs);
    },
    enable: function (conf) { conf._input.find('input').prop('disabled', false); },
    disable: function (conf) { conf._input.find('input').prop('disabled', true); },
    update: function (conf, options, append) {
      var currVal = fieldTypes.checkbox.get(conf);
      fieldTypes.checkbox._addOptions(conf, options, append);
      fieldTypes.checkbox.set(conf, currVal);
    }
  });

  fieldTypes.radio = $.extend(true, {}, baseFieldType, {
    _addOptions: function (conf, opts, append) {
      var jqInput = conf._input;
      var offset = 0;
      if (!append) jqInput.empty();
      else offset = $('input', jqInput).length;
      if (opts) {
        Editor.pairs(opts, conf.optionsPair, function (val, label, i, attr) {
          var id = Editor.safeId(conf.id) + '_' + (i + offset);
          jqInput.append('<div><input id="' + id + '" type="radio" name="' + conf.name + '" /><label for="' + id + '">' + label + '</label></div>');
          var inp = $('input:last', jqInput);
          inp.attr('value', val)[0]._editor_val = val;
          if (attr) inp.attr(attr);
        });
      }
    },
    create: function (conf) {
      conf._input = $('<div></div>');
      fieldTypes.radio._addOptions(conf, conf.options || conf.ipOpts);
      // 原版：開啟表單時重新勾選（瀏覽器在 DOM 移動後可能遺失 radio 狀態）
      this.on('open', function () {
        conf._input.find('input').each(function () {
          if (this._preChecked) this.checked = true;
        });
      });
      return conf._input[0];
    },
    get: function (conf) {
      var el = conf._input.find('input:checked');
      return el.length ? el[0]._editor_val : undefined;
    },
    set: function (conf, val) {
      conf._input.find('input').each(function () {
        this._preChecked = false;
        // eslint-disable-next-line eqeqeq
        if (this._editor_val == val) {
          this.checked = true;
          this._preChecked = true;
        } else {
          this.checked = false;
          this._preChecked = false;
        }
      });
      _triggerChange(conf._input.find('input:checked'));
    },
    enable: function (conf) { conf._input.find('input').prop('disabled', false); },
    disable: function (conf) { conf._input.find('input').prop('disabled', true); },
    update: function (conf, options, append) {
      var currVal = fieldTypes.radio.get(conf);
      fieldTypes.radio._addOptions(conf, options, append);
      var inputs = conf._input.find('input');
      fieldTypes.radio.set(conf, inputs.filter('[value="' + currVal + '"]').length ? currVal : inputs.eq(0).attr('value'));
    }
  });

  /* datetime：以 flatpickr（原站全站已載入 4.6.13 zh-tw）提供日期時間選擇；值格式依 moment 格式字串 */
  function _momentToFlatpickr(fmt) {
    return String(fmt || 'YYYY-MM-DD')
      .replace(/YYYY/g, 'Y')
      .replace(/MM/g, 'm')
      .replace(/DD/g, 'd')
      .replace(/HH/g, 'H')
      .replace(/hh/g, 'h')
      .replace(/mm/g, 'i')
      .replace(/ss/g, 'S')
      .replace(/A/g, 'K');
  }
  fieldTypes.datetime = $.extend(true, {}, baseFieldType, {
    create: function (conf) {
      conf._input = $('<input />').attr($.extend(true, { id: Editor.safeId(conf.id), type: 'text' }, conf.attr || {}));
      var format = conf.format || conf.displayFormat || 'YYYY-MM-DD';
      conf._format = format;
      var hasTime = /[Hh]/.test(format);
      var hasSec = /s/.test(format);
      var dateOnly = !/[YMD]/.test(format) && hasTime;
      var initPicker = function () {
        if (conf._picker || !window.flatpickr) return;
        conf._picker = window.flatpickr(conf._input[0], $.extend({
          allowInput: true,
          disableMobile: true,
          enableTime: hasTime,
          enableSeconds: hasSec,
          noCalendar: dateOnly,
          time_24hr: true,
          dateFormat: _momentToFlatpickr(format),
          locale: window.flatpickr.l10ns && window.flatpickr.l10ns.zh_tw ? 'zh_tw' : 'default',
          onChange: function () { conf._input.trigger('change'); }
        }, conf.opts || {}));
      };
      if (window.flatpickr) initPicker();
      else $(function () { initPicker(); });
      return conf._input[0];
    },
    set: function (conf, val) {
      if (val instanceof Date && window.moment) val = window.moment(val).format(conf._format);
      if (conf._picker) conf._picker.setDate(val === null || val === undefined ? '' : val, false, _momentToFlatpickr(conf._format));
      else conf._input.val(val === null || val === undefined ? '' : val);
      _triggerChange(conf._input);
    },
    get: function (conf) { return conf._input.val(); },
    owns: function (conf, node) {
      return $(node).closest('.flatpickr-calendar').length > 0;
    },
    minDate: function (conf, min) { if (conf._picker) conf._picker.set('minDate', min); },
    maxDate: function (conf, max) { if (conf._picker) conf._picker.set('maxDate', max); },
    destroy: function (conf) { if (conf._picker) { conf._picker.destroy(); conf._picker = null; } },
    canReturnSubmit: function () { return true; }
  });

  /* upload / uploadMany */
  function _uploadUrl(url) {
    // 原站預設上傳到外部主機 https://groupbuyforms.com/json/uploadImage/vcf → 改走本站同路徑
    if (typeof url === 'string') return url.replace(/^https?:\/\/(www\.)?groupbuyforms\.com(\/json\/uploadImage)/, '$2');
    return url;
  }

  Editor.upload = function (editor, conf, files, progressCallback, completeCallback) {
    var reader = new FileReader();
    var counter = 0;
    var ids = [];
    var generalError = '上傳檔案時發生錯誤';
    editor.error(conf.name, '');
    if (typeof conf.ajax === 'function') {
      conf.ajax(files, function (ids2) { completeCallback.call(editor, ids2); });
      return;
    }
    progressCallback(conf, conf.fileReadText || '<i>Uploading file</i>');
    reader.onload = function () {
      var data = new FormData();
      var ajax;
      data.append('action', 'upload');
      data.append('uploadField', conf.name);
      data.append('upload', files[counter]);
      if (conf.ajaxData) conf.ajaxData(data);
      if (conf.ajax) ajax = conf.ajax;
      else if ($.isPlainObject(editor.s.ajax)) ajax = editor.s.ajax.upload ? editor.s.ajax.upload : editor.s.ajax;
      else if (typeof editor.s.ajax === 'string') ajax = editor.s.ajax;
      if (!ajax) throw new Error('No Ajax option specified for upload plug-in');
      if (typeof ajax === 'string') ajax = { url: ajax };
      ajax = $.extend({}, ajax, { url: _uploadUrl(ajax.url) });
      if (typeof ajax.data === 'function') {
        var d = {};
        var ret = ajax.data(d);
        if (ret !== undefined && typeof ret !== 'string') d = ret;
        $.each(d, function (key, value) { data.append(key, value); });
      }
      var preRet = editor._event('preUpload', [conf.name, files[counter], data]);
      if (preRet === false) {
        if (counter < files.length - 1) {
          counter++;
          reader.readAsDataURL(files[counter]);
        } else {
          completeCallback.call(editor, ids);
        }
        return;
      }
      var submit = false;
      editor.on('preSubmit.DTE_Upload', function () {
        submit = true;
        return false;
      });
      $.ajax($.extend({}, ajax, {
        type: 'post',
        data: data,
        dataType: 'json',
        contentType: false,
        processData: false,
        xhr: function () {
          var xhr = $.ajaxSettings.xhr();
          if (xhr.upload) {
            xhr.upload.onprogress = function (e) {
              if (e.lengthComputable) {
                var percent = (e.loaded / e.total * 100).toFixed(0) + '%';
                progressCallback(conf, files.length === 1 ? percent : counter + ':' + files.length + ' ' + percent);
              }
            };
            xhr.upload.onloadend = function () {
              progressCallback(conf, conf.processingText || 'Processing');
            };
          }
          return xhr;
        },
        success: function (json) {
          editor.off('preSubmit.DTE_Upload');
          editor._event('uploadXhrSuccess', [conf.name, json]);
          if (json.fieldErrors && json.fieldErrors.length) {
            for (var i = 0; i < json.fieldErrors.length; i++) editor.error(json.fieldErrors[i].name, json.fieldErrors[i].status);
          } else if (json.error) {
            editor.error(typeof json.error === 'object' ? json.error.message : json.error);
          } else if (!json.upload || !json.upload.id) {
            editor.error(conf.name, generalError);
          } else {
            if (json.files) {
              $.each(json.files, function (table, f) {
                if (!Editor.files[table]) Editor.files[table] = {};
                $.extend(Editor.files[table], f);
              });
            }
            ids.push(json.upload.id);
            if (counter < files.length - 1) {
              counter++;
              reader.readAsDataURL(files[counter]);
            } else {
              completeCallback.call(editor, ids);
              if (submit) editor.submit();
            }
          }
          progressCallback(conf);
        },
        error: function (xhr) {
          editor.off('preSubmit.DTE_Upload');
          editor._event('uploadXhrError', [conf.name, xhr]);
          var json = xhr.responseJSON;
          editor.error(conf.name, json && json.error ? (typeof json.error === 'object' ? json.error.message : json.error) : generalError);
          progressCallback(conf);
        }
      }));
    };
    files = $.map(files, function (val) { return val; });
    if (conf._limitLeft !== undefined) files.splice(conf._limitLeft, files.length);
    reader.readAsDataURL(files[0]);
  };

  function _commonUpload(editor, conf, dropCallback, multiple) {
    var btnClass = editor.classes.form.buttonInternal;
    var container = $(
      '<div class="editor_upload">' +
        '<div class="eu_table">' +
          '<div class="row">' +
            '<div class="cell upload limitHide">' +
              '<button class="' + btnClass + '" type="button"></button>' +
              '<input type="file" ' + (multiple ? 'multiple' : '') + '/>' +
            '</div>' +
            '<div class="cell clearValue">' +
              '<button class="' + btnClass + '" type="button"></button>' +
            '</div>' +
          '</div>' +
          '<div class="row second">' +
            '<div class="cell limitHide">' +
              '<div class="drop"><span></span></div>' +
            '</div>' +
            '<div class="cell">' +
              '<div class="rendered"></div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
    conf._input = container;
    conf._enabled = true;
    if (conf.id) container.find('input[type=file]').attr('id', Editor.safeId(conf.id));
    if (conf.attr) container.find('input[type=file]').attr(conf.attr);
    container.find('div.upload button').html(conf.uploadText || 'Choose file...');
    container.find('div.drop span').text(conf.dragDropText || 'Drag and drop a file here to upload');
    if (window.FileReader && conf.dragDrop !== false) {
      var dragDrop = container.find('div.drop');
      dragDrop
        .on('drop', function (e) {
          if (conf._enabled) {
            Editor.upload(editor, conf, e.originalEvent.dataTransfer.files, _uploadProgress, dropCallback);
            dragDrop.removeClass('over');
          }
          return false;
        })
        .on('dragleave dragexit', function () {
          if (conf._enabled) dragDrop.removeClass('over');
          return false;
        })
        .on('dragover', function () {
          if (conf._enabled) dragDrop.addClass('over');
          return false;
        });
      editor
        .on('open', function () {
          $('body').on('dragover.DTE_Upload drop.DTE_Upload', function () { return false; });
        })
        .on('close', function () {
          $('body').off('dragover.DTE_Upload drop.DTE_Upload');
        });
    } else {
      container.addClass('noDrop');
      container.append(container.find('div.rendered'));
    }
    container.find('div.clearValue button').on('click', function (e) {
      e.preventDefault();
      if (conf._enabled) fieldTypes.upload.set.call(editor, conf, '');
    });
    container.find('div.upload button').on('click', function (e) {
      e.preventDefault();
      container.find('input[type=file]').trigger('click');
    });
    container.find('input[type=file]').on('change', function () {
      Editor.upload(editor, conf, this.files, _uploadProgress, function (ids) {
        dropCallback.call(editor, ids);
        container.find('input[type=file]')[0].value = '';
      });
    });
    return container;
  }

  function _uploadProgress(conf, msg) {
    conf._input.find('div.upload button').html(msg || conf.uploadText || 'Choose file...');
  }

  fieldTypes.upload = $.extend(true, {}, baseFieldType, {
    create: function (conf) {
      var editor = this;
      var container = _commonUpload(editor, conf, function (val) {
        fieldTypes.upload.set.call(editor, conf, val[0]);
        editor._event('postUpload', [conf.name, val[0]]);
      });
      return container[0];
    },
    get: function (conf) { return conf._val; },
    set: function (conf, val) {
      conf._val = val;
      var container = conf._input;
      if (conf.display) {
        var rendered = container.find('div.rendered');
        if (conf._val) rendered.html(conf.display(conf._val));
        else rendered.empty().append('<span>' + (conf.noFileText || '') + '</span>');
      }
      var button = container.find('div.clearValue button');
      if (val && conf.clearText) {
        button.html(conf.clearText);
        container.removeClass('noClear');
      } else {
        container.addClass('noClear');
      }
      conf._input.find('input').triggerHandler('upload.editor', [conf._val]);
    },
    enable: function (conf) {
      conf._input.find('input').prop('disabled', false);
      conf._enabled = true;
    },
    disable: function (conf) {
      conf._input.find('input').prop('disabled', true);
      conf._enabled = false;
    },
    canReturnSubmit: function () { return false; }
  });

  fieldTypes.uploadMany = $.extend(true, {}, baseFieldType, {
    create: function (conf) {
      var editor = this;
      var container = _commonUpload(editor, conf, function (val) {
        conf._val = (conf._val || []).concat(val);
        fieldTypes.uploadMany.set.call(editor, conf, conf._val);
        editor._event('postUpload', [conf.name, conf._val]);
      }, true);
      container.addClass('multi').on('click', 'button.remove', function (e) {
        e.stopPropagation();
        if (conf._enabled) {
          var idx = $(this).data('idx');
          conf._val.splice(idx, 1);
          fieldTypes.uploadMany.set.call(editor, conf, conf._val);
        }
      });
      return container[0];
    },
    get: function (conf) { return conf._val; },
    set: function (conf, val) {
      if (!val) val = [];
      if (!Array.isArray(val)) throw new Error('Upload collections must have an array as a value');
      conf._val = val;
      var that = this;
      var container = conf._input;
      if (conf.display) {
        var rendered = container.find('div.rendered').empty();
        if (val.length) {
          var list = $('<ul></ul>').appendTo(rendered);
          $.each(val, function (i, file) {
            list.append('<li>' + conf.display(file, i) + ' <button class="' + that.classes.form.button + ' remove" data-idx="' + i + '">&times;</button></li>');
          });
        } else {
          rendered.append('<span>' + (conf.noFileText || '') + '</span>');
        }
      }
      conf._input.find('input').triggerHandler('upload.editor', [conf._val]);
    },
    enable: function (conf) {
      conf._input.find('input').prop('disabled', false);
      conf._enabled = true;
    },
    disable: function (conf) {
      conf._input.find('input').prop('disabled', true);
      conf._enabled = false;
    },
    canReturnSubmit: function () { return false; }
  });

  /* ckeditor（CKEditor 4，cdnjs 4.17.1 開源版；原站 editor.ckeditor.js 外掛的同名型別） */
  fieldTypes.ckeditor = $.extend(true, {}, baseFieldType, {
    create: function (conf) {
      var that = this;
      var id = Editor.safeId(conf.id);
      conf._input = $('<div><textarea id="' + id + '"></textarea></div>');
      this.on('open.ckEditInit-' + id, function () {
        if (!window.CKEDITOR) return;
        if (conf._editor) {
          conf._editor.destroy(true);
          conf._editor = null;
        }
        if ($('#' + id).length) {
          conf._editor = window.CKEDITOR.replace(id, conf.opts);
          conf._editor.on('instanceReady', function () {
            if (conf._initSetVal !== undefined) {
              conf._editor.setData(conf._initSetVal);
              conf._initSetVal = undefined;
            }
            if ($(conf._input).parents('div.DTE_Bubble').length && that.bubblePosition) that.bubblePosition();
          });
        }
      });
      this.on('preClose.ckEditInit-' + id, function () {
        if (conf._editor) {
          conf._initSetVal = conf._editor.getData();
          conf._editor.destroy(true);
          conf._editor = null;
        }
      });
      return conf._input[0];
    },
    get: function (conf) {
      if (!conf._editor) return conf._initSetVal !== undefined ? conf._initSetVal : $('textarea', conf._input).val();
      return conf._editor.getData();
    },
    set: function (conf, val) {
      var id = Editor.safeId(conf.id);
      if (conf._editor && conf._editor.document) conf._editor.setData(val !== null ? val : '');
      else {
        conf._initSetVal = val;
        $('#' + id).val(val);
      }
    },
    enable: function () {},
    disable: function () {},
    destroy: function (conf) {
      var id = Editor.safeId(conf.id);
      if (conf._editor) conf._editor.destroy(true);
      this.off('open.ckEditInit-' + id);
      this.off('preClose.ckEditInit-' + id);
    },
    inst: function (conf) { return conf._editor; },
    canReturnSubmit: function () { return false; }
  });

  /* select2（原站 editor.select2 外掛的同名型別；含初始值查詢 initialValue=true&value=<JSON>） */
  fieldTypes.select2 = $.extend(true, {}, baseFieldType, {
    _addOptions: function (conf, opts) {
      var elOpts = conf._input[0].options;
      elOpts.length = 0;
      if (opts) {
        Editor.pairs(opts, conf.optionsPair, function (val, label) {
          elOpts[elOpts.length] = new Option(label, val);
        });
      }
    },
    create: function (conf) {
      var that = this;
      conf._input = $('<select></select>').attr($.extend({ id: Editor.safeId(conf.id) }, conf.attr || {}));
      var options = $.extend({ width: '100%' }, conf.opts);
      fieldTypes.select2._addOptions(conf, conf.options || conf.ipOpts);
      if ($.fn.select2) conf._input.select2(options);
      var first = true;
      var id = Editor.safeId(conf.id);
      // select2 需在可見時初始化尺寸：每次開啟重新初始化（原版行為）
      this.on('open.select2-' + id, function () {
        if (!$.fn.select2) return;
        if (first) {
          first = false;
          var dropdownParent = conf._input.closest('.modal');
          var o = $.extend({}, options);
          if (dropdownParent.length && !o.dropdownParent) o.dropdownParent = dropdownParent;
          if (conf._input.data('select2')) conf._input.select2('destroy');
          conf._input.select2(o);
          if (conf._initSetVal !== undefined) fieldTypes.select2.set.call(that, conf, conf._initSetVal);
        }
      });
      conf._input.on('select2:open', function () {
        // 讓下拉選單在 bootstrap modal 內可輸入
        $('.select2-search__field').trigger('focus');
      });
      return conf._input[0];
    },
    get: function (conf) {
      var val = conf._input.val();
      val = conf._input.prop('multiple') && val === null ? [] : val;
      return conf.separator ? (Array.isArray(val) ? val.join(conf.separator) : val) : val;
    },
    set: function (conf, val) {
      var that = this;
      if (conf.separator && !Array.isArray(val)) val = typeof val === 'string' && val !== '' ? val.split(conf.separator) : val === '' || val === null || val === undefined ? [] : [val];
      conf._initSetVal = val;
      var needAjax = false;
      var vals = Array.isArray(val) ? val : [val];
      var hasValue = function (v) {
        return conf._input.find('option').filter(function () { return this.value == v; }).length > 0; // eslint-disable-line eqeqeq
      };
      if (this.s && this.s.mode === 'inline') {
        // 行內模式：直接補 option
        $.each(vals, function (i, v) {
          if (v !== null && v !== undefined && v !== '' && !hasValue(v)) conf._input.append(new Option(String(v), v, true, true));
        });
      } else {
        $.each(vals, function (i, v) {
          if (v !== null && v !== undefined && v !== '' && !hasValue(v)) needAjax = true;
        });
      }
      var ajax = conf.opts && conf.opts.ajax;
      if (needAjax && ajax) {
        var url = typeof ajax.url === 'function' ? ajax.url.call(conf._input, {}) : ajax.url;
        var q = 'initialValue=true&value=' + encodeURIComponent(JSON.stringify(val));
        $.ajax({
          url: url + (url.indexOf('?') >= 0 ? '&' : '?') + q,
          type: 'GET',
          dataType: 'json',
          success: function (json) {
            var add = function (d) {
              if (!d || d.id === undefined || d.id === null) return;
              if (!hasValue(d.id)) conf._input.append(new Option(d.text, d.id, false, false));
            };
            if (Array.isArray(json)) $.each(json, function (i, d) { add(d); });
            else if (json && Array.isArray(json.results)) $.each(json.results, function (i, d) { add(d); });
            else add(json);
            conf._input.val(val).trigger('change', { editor: true });
          }
        });
      } else {
        if (needAjax) {
          $.each(vals, function (i, v) {
            if (v !== null && v !== undefined && v !== '' && !hasValue(v)) conf._input.append(new Option(String(v), v, false, false));
          });
        }
        conf._input.val(val).trigger('change', { editor: true });
      }
      void that;
    },
    enable: function (conf) { conf._input.prop('disabled', false); },
    disable: function (conf) { conf._input.prop('disabled', true); },
    inst: function (conf) {
      var args = Array.prototype.slice.call(arguments);
      args.shift();
      return conf._input.select2.apply(conf._input, args);
    },
    update: function (conf, data) {
      var val = fieldTypes.select2.get(conf);
      fieldTypes.select2._addOptions(conf, data);
      $(conf._input).val(val).trigger('change', { editor: true });
    },
    focus: function (conf) {
      if (conf._input.data('select2')) conf._input.select2('open');
      else conf._input.trigger('focus');
    },
    owns: function (conf, node) {
      return $(node).closest('.select2-container').length > 0 || $(node).closest('.select2').length > 0 || $(node).hasClass('select2-selection__choice__remove');
    },
    canReturnSubmit: function () { return false; },
    destroy: function (conf) {
      var id = Editor.safeId(conf.id);
      if (conf._input.data('select2')) conf._input.select2('destroy');
      this.off('open.select2-' + id);
    }
  });

  /* ======================================================================
   * 顯示控制器（bootstrap 4 modal）
   * ==================================================================== */
  var bs = (Editor.display.bootstrap = $.extend(true, {}, Editor.models.displayController, {
    init: function (dte) {
      if (!bs._dom.content) {
        bs._dom.content = $('<div class="modal fade DTED"><div class="modal-dialog modal-dialog-scrollable"></div></div>');
        bs._dom.close = $('<button class="close">&times;</button>');
        bs._dom.close.on('click', function () {
          if (bs._dte) bs._dte.close('icon');
        });
        var allowAutoClose = false;
        $(document).on('mousedown', 'div.DTED.modal', function (e) {
          allowAutoClose = $(e.target).hasClass('modal') && bs._shown ? true : false;
        });
        $(document).on('click', 'div.DTED.modal', function (e) {
          if ($(e.target).hasClass('modal') && allowAutoClose && bs._dte) bs._dte.background();
        });
      }
      dte.on('displayOrder.dtebs', function () {
        $.each(dte.s.fields, function (key, field) {
          $('input:not([type=checkbox]):not([type=radio]):not([type=file]), select, textarea', field.node()).addClass('form-control');
        });
      });
      return bs;
    },
    open: function (dte, append, callback) {
      if (bs._shown) {
        if (callback) callback();
        return;
      }
      bs._dte = dte;
      bs._shown = true;
      bs._fullyDisplayed = false;
      var content = bs._dom.content.find('div.modal-dialog');
      content.children().detach();
      content.append(append);
      $('div.modal-header', append).append(bs._dom.close);
      $(bs._dom.content)
        .one('shown.bs.modal', function () {
          if (dte.s.setFocus) dte.s.setFocus.focus();
          bs._fullyDisplayed = true;
          if (callback) callback();
        })
        .one('hidden.bs.modal', function () {
          bs._shown = false;
        })
        .appendTo('body')
        .modal({ backdrop: 'static', keyboard: false });
    },
    close: function (dte, callback) {
      if (!bs._shown) {
        if (callback) callback();
        return;
      }
      if (!bs._fullyDisplayed) {
        $(bs._dom.content).one('shown.bs.modal', function () {
          bs.close(dte, callback);
        });
        return;
      }
      $(bs._dom.content)
        .one('hidden.bs.modal', function () {
          $(this).detach();
        })
        .modal('hide');
      bs._dte = dte;
      bs._shown = false;
      bs._fullyDisplayed = false;
      if (callback) callback();
    },
    node: function () {
      return bs._dom.content[0];
    },
    _shown: false,
    _fullyDisplayed: false,
    _dte: null,
    _dom: {}
  }));
  Editor.display.lightbox = bs;
  Editor.display.envelope = bs;

  /* ======================================================================
   * 資料來源（DataTables 表格 / 獨立表單）
   * ==================================================================== */
  function __dtFieldFromColumn(dt, column, fields) {
    var settings = dt.settings()[0];
    var col = settings.aoColumns[column];
    var dataSrc = col.editField !== undefined ? col.editField : col.mData;
    var resolved = null;
    $.each(fields, function (name, field) {
      if (field.dataSrc() === dataSrc || name === dataSrc) resolved = field;
    });
    return resolved;
  }

  var __dataSources = {};
  __dataSources.dataTable = {
    id: function (data) {
      return getObjFn(this.s.idSrc)(data);
    },
    individual: function (identifier, fieldNames) {
      var that = this;
      var dt = __dtApi(this.s.table);
      var idFn = getObjFn(this.s.idSrc);
      var fields = this.s.fields;
      var out = {};
      var forceFields;
      if (fieldNames) {
        if (!Array.isArray(fieldNames)) fieldNames = [fieldNames];
        forceFields = {};
        $.each(fieldNames, function (i, name) { forceFields[name] = fields[name]; });
      }
      dt.cells(identifier).every(function () {
        var idx = this.index();
        var rowData = dt.row(idx.row).data();
        var id = idFn(rowData);
        var field = forceFields ? null : __dtFieldFromColumn(dt, idx.column, fields);
        var cellFields = {};
        if (forceFields) cellFields = $.extend({}, forceFields);
        else if (field) cellFields[field.name()] = field;
        else throw new Error('Unable to automatically determine field from source. Please specify the field name.');
        if (!out[id]) {
          out[id] = { idSrc: id, data: rowData, node: dt.row(idx.row).node(), fields: {}, displayFields: {}, attach: [], type: 'cell' };
        }
        $.extend(out[id].fields, cellFields);
        $.extend(out[id].displayFields, cellFields);
        out[id].attach.push(this.node());
      });
      void that;
      return out;
    },
    fields: function (identifier) {
      var dt = __dtApi(this.s.table);
      var idFn = getObjFn(this.s.idSrc);
      var fields = this.s.fields;
      var out = {};
      var rowsSel = identifier;
      if ($.isPlainObject(identifier) && (identifier.rows !== undefined || identifier.columns !== undefined || identifier.cells !== undefined)) {
        rowsSel = identifier.rows !== undefined ? identifier.rows : null;
      }
      var rows;
      try {
        rows = rowsSel === null ? dt.rows([]) : dt.rows(rowsSel);
      } catch (e) {
        rows = dt.rows([]);
      }
      rows.every(function () {
        var data = this.data();
        var id = idFn(data);
        out[id] = { idSrc: id, data: data, node: this.node(), fields: fields, type: 'row' };
      });
      return out;
    },
    create: function (fields, data) {
      var dt = __dtApi(this.s.table);
      if (!dt.settings()[0].oFeatures.bServerSide) {
        var row = dt.row.add(data);
        __dtHighlight(row.node());
      }
    },
    edit: function (identifier, fields, data, store) {
      var that = this;
      var dt = __dtApi(this.s.table);
      var opts = this.s.editOpts;
      var drawType = opts.drawType;
      if (!dt.settings()[0].oFeatures.bServerSide || drawType === 'none') {
        var rowId = __dataSources.dataTable.id.call(this, data);
        var row;
        try {
          row = dt.row(__dtjqId(rowId));
        } catch (e) {
          row = dt;
        }
        if (!row.any()) {
          row = dt.row(function (rowIdx, rowData) {
            return rowId == __dataSources.dataTable.id.call(that, rowData); // eslint-disable-line eqeqeq
          });
        }
        if (row.any()) {
          row.data(data);
          var idx = $.inArray(String(rowId), store.rowIds);
          if (idx !== -1) store.rowIds.splice(idx, 1);
        } else {
          row = dt.row.add(data);
        }
        __dtHighlight(row.node());
      }
    },
    remove: function (identifier, fields, store) {
      var that = this;
      var dt = __dtApi(this.s.table);
      var cancelled = store.cancelled || [];
      var rows;
      try {
        rows = dt.rows(identifier);
      } catch (e) {
        return;
      }
      if (cancelled.length === 0) {
        rows.remove();
      } else {
        var indexes = [];
        rows.every(function () {
          var id = __dataSources.dataTable.id.call(that, this.data());
          if ($.inArray(String(id), cancelled.map(String)) === -1) indexes.push(this.index());
        });
        dt.rows(indexes).remove();
      }
    },
    prep: function (action, identifier, submit, json, store) {
      var cancelled = json.cancelled || [];
      if (action === 'edit') {
        store.rowIds = $.map(submit.data, function (val, key) {
          return !$.isEmptyObject(submit.data[key]) && $.inArray(key, cancelled) === -1 ? key : undefined;
        });
      } else if (action === 'remove') {
        store.cancelled = cancelled;
      }
    },
    commit: function (action, identifier, data, store) {
      var that = this;
      var dt = __dtApi(this.s.table);
      var ssp = dt.settings()[0].oFeatures.bServerSide;
      var ids = store.rowIds;
      if (!ssp && action === 'edit' && ids && ids.length) {
        var compare = function (id) {
          return function (rowIdx, rowData) {
            return id == __dataSources.dataTable.id.call(that, rowData); // eslint-disable-line eqeqeq
          };
        };
        for (var i = 0; i < ids.length; i++) {
          var row;
          try {
            row = dt.row(__dtjqId(ids[i]));
          } catch (e) {
            row = dt;
          }
          if (!row.any()) row = dt.row(compare(ids[i]));
          if (row.any()) row.remove();
        }
      }
      var drawType = this.s.editOpts.drawType;
      if (drawType !== 'none') dt.draw(drawType);
    }
  };

  __dataSources.html = {
    id: function (data) {
      return getObjFn(this.s.idSrc)(data);
    },
    individual: function (identifier, fieldNames) {
      var out = {};
      var fields = this.s.fields;
      var names = fieldNames ? (Array.isArray(fieldNames) ? fieldNames : [fieldNames]) : Object.keys(fields);
      var f = {};
      $.each(names, function (i, n) { if (fields[n]) f[n] = fields[n]; });
      var node = $(identifier).length ? $(identifier)[0] : null;
      out['keyless'] = { idSrc: 'keyless', data: {}, node: node, fields: f, displayFields: f, attach: node ? [node] : [], type: 'cell' };
      return out;
    },
    fields: function (identifier) {
      var out = {};
      var fields = this.s.fields;
      var ids = Array.isArray(identifier) ? identifier : [identifier];
      $.each(ids, function (i, id) {
        if (id === undefined || id === null) id = 'keyless';
        if (typeof id === 'object') {
          // 原站 actionButton 會把 editor 物件本身當 remove 對象（當成確認框使用）：容錯略過
          return;
        }
        out[id] = { idSrc: id, data: {}, node: null, fields: fields, type: 'row' };
      });
      return out;
    },
    create: function () {},
    edit: function () {},
    remove: function () {},
    prep: function () {},
    commit: function () {}
  };

  /* ======================================================================
   * Editor 原型
   * ==================================================================== */
  Editor.prototype = {
    _constructor: function (init) {
      var that = this;
      init = $.extend(true, {}, Editor.defaults, init);
      this.s = {
        table: init.domTable || init.table,
        dbTable: init.dbTable || null,
        ajaxUrl: init.ajaxUrl,
        ajax: init.ajax,
        idSrc: init.idSrc,
        dataSource: null,
        formOptions: init.formOptions,
        legacyAjax: init.legacyAjax,
        template: init.template ? $(init.template).detach() : null,
        actionName: init.actionName || 'action',
        fields: {},
        order: [],
        mode: null,
        action: null,
        modifier: null,
        editFields: {},
        editData: {},
        editOpts: {},
        editCount: 0,
        displayed: false,
        processing: false,
        globalError: undefined,
        setFocus: null,
        closeCb: null,
        closeIcb: null,
        includeFields: [],
        unique: ++__editorCounter
      };
      this.classes = $.extend(true, {}, Editor.classes);
      // init 已與 Editor.defaults 深度合併（i18n 亦然）；DataTableConfig.i18n 同時含 DataTables 語系與 Editor 文字
      this.i18n = init.i18n;
      // 每個 Editor 的 formOptions：models 預設 → Editor.defaults → 建構選項（與原版合併順序相同）
      this.s.formOptions = {
        main: $.extend({}, Editor.models.formOptions, Editor.defaults.formOptions.main, (init.formOptions || {}).main),
        bubble: $.extend({}, Editor.models.formOptions, Editor.defaults.formOptions.bubble, (init.formOptions || {}).bubble),
        inline: $.extend({}, Editor.models.formOptions, Editor.defaults.formOptions.inline, (init.formOptions || {}).inline)
      };

      var classes = this.classes;
      var wrapper = $(
        '<div class="' + classes.wrapper + '">' +
          '<div data-dte-e="processing" class="' + classes.processing.indicator + '"><span></span></div>' +
          '<div data-dte-e="body" class="' + classes.body.wrapper + '">' +
            '<div data-dte-e="body_content" class="' + classes.body.content + '"></div>' +
          '</div>' +
          '<div data-dte-e="foot" class="' + classes.footer.wrapper + '">' +
            '<div class="' + classes.footer.content + '"></div>' +
          '</div>' +
        '</div>'
      );
      var form = $(
        '<form data-dte-e="form" class="' + classes.form.tag + '">' +
          '<div data-dte-e="form_content" class="' + classes.form.content + '"></div>' +
        '</form>'
      );
      this.dom = {
        wrapper: wrapper[0],
        form: form[0],
        formError: $('<div data-dte-e="form_error" class="' + classes.form.error + '"></div>')[0],
        formInfo: $('<div data-dte-e="form_info" class="' + classes.form.info + '"></div>')[0],
        header: $('<div data-dte-e="head" class="' + classes.header.wrapper + '"><div class="' + classes.header.content + '"></div></div>')[0],
        buttons: $('<div data-dte-e="form_buttons" class="' + classes.form.buttons + '"></div>')[0]
      };
      this.dom.body = $('div[data-dte-e="body"]', wrapper)[0];
      this.dom.bodyContent = $('div[data-dte-e="body_content"]', wrapper)[0];
      this.dom.footer = $('div[data-dte-e="foot"]', wrapper)[0];
      this.dom.processing = $('div[data-dte-e="processing"]', wrapper)[0];
      this.dom.formContent = $('div[data-dte-e="form_content"]', form)[0];
      $(this.dom.processing).css('display', 'none');
      $(this.dom.formError).css('display', 'none');

      // 原版：建構時就把各區塊組好
      this._assembleMain();

      // 事件（init.events）
      $.each(init.events || {}, function (evt, fn) {
        that.on(evt, function () {
          var args = Array.prototype.slice.call(arguments);
          args.shift();
          fn.apply(that, args);
        });
      });

      // 資料來源
      var table = this.s.table;
      this.s.dataSource = table ? __dataSources.dataTable : __dataSources.html;

      // 欄位
      if (init.fields) this.add(init.fields);

      // 與 DataTable 連結：editor() API、列表回應 options 自動更新欄位選項
      if (table) {
        var unique = this.s.unique;
        var isMyTable = function (settings) {
          var t = $(that.s.table)[0];
          return t && (settings.nTable === t || (_isApi(that.s.table) && that.s.table.context[0] === settings));
        };
        $(document)
          .on('init.dt.dte' + unique, function (e, settings) {
            if (that.s && isMyTable(settings)) settings._editor = that;
          })
          .on('xhr.dt.dte' + unique, function (e, settings, json) {
            if (json && that.s && isMyTable(settings)) that._optionsUpdate(json);
          });
        // 表格已經初始化過（Editor 在 DataTable 之後才建立）
        try {
          if ($.fn.dataTable.isDataTable(table)) {
            var api = __dtApi(table);
            api.settings()[0]._editor = this;
            var json = api.ajax && api.ajax.json ? api.ajax.json() : null;
            if (json) this._optionsUpdate(json);
          }
        } catch (e) { /* ignore */ }
      }

      // 顯示控制器
      var displayName = init.display;
      this.s.displayController = (Editor.display[displayName] || bs).init(this);
      this._event('initComplete', []);
    },

    /* ---------------- 欄位管理 ---------------- */
    add: function (cfg, after) {
      if (Array.isArray(cfg)) {
        if (after !== undefined) cfg.reverse();
        for (var i = 0; i < cfg.length; i++) this.add(cfg[i], after);
      } else {
        var name = cfg.name;
        if (name === undefined) throw new Error('Error adding field. The field requires a `name` option');
        if (this.s.fields[name]) throw new Error("Error adding field '" + name + "'. A field already exists with this name");
        var field = new Editor.Field(cfg, this.classes.field, this);
        if (this.s.mode) {
          var editFields = this.s.editFields;
          field.multiReset();
          $.each(editFields, function (idSrc, edit) {
            var val;
            if (edit.data) val = field.valFromData(edit.data);
            field.multiSet(idSrc, val !== undefined ? val : field.def());
          });
        }
        this.s.fields[name] = field;
        if (after === undefined) this.s.order.push(name);
        else if (after === null) this.s.order.unshift(name);
        else {
          var idx = $.inArray(after, this.s.order);
          this.s.order.splice(idx + 1, 0, name);
        }
      }
      this._displayReorder(this.order());
      return this;
    },

    clear: function (fieldName) {
      var that = this;
      if (fieldName === undefined) {
        $.each(this.fields(), function (i, n) { that.clear(n); });
      } else if (Array.isArray(fieldName)) {
        $.each(fieldName, function (i, n) { that.clear(n); });
      } else {
        var field = this.s.fields[fieldName];
        if (field) {
          field.destroy();
          delete this.s.fields[fieldName];
          var orderIdx = $.inArray(fieldName, this.s.order);
          if (orderIdx !== -1) this.s.order.splice(orderIdx, 1);
          var includeIdx = $.inArray(fieldName, this.s.includeFields);
          if (includeIdx !== -1) this.s.includeFields.splice(includeIdx, 1);
        }
        this._displayReorder();
      }
      return this;
    },

    field: function (name) {
      var fields = this.s.fields;
      if (!fields[name]) throw new Error('Unknown field name - ' + name);
      return fields[name];
    },

    fields: function () {
      return $.map(this.s.fields, function (field, name) { return name; });
    },

    order: function (set) {
      if (!set) return this.s.order;
      if (arguments.length && !Array.isArray(set)) set = Array.prototype.slice.call(arguments);
      this.s.order = set.slice();
      this._displayReorder();
      return this;
    },

    get: function (fieldNames) {
      var fields = this.s.fields;
      if (!fieldNames) fieldNames = this.fields();
      if (Array.isArray(fieldNames)) {
        var out = {};
        $.each(fieldNames, function (i, name) { out[name] = fields[name].get(); });
        return out;
      }
      return fields[fieldNames].get();
    },

    set: function (set, val) {
      var fields = this.s.fields;
      if (!$.isPlainObject(set)) {
        var o = {};
        o[set] = val;
        set = o;
      }
      $.each(set, function (n, v) {
        if (fields[n]) fields[n].set(v);
      });
      return this;
    },

    val: function (field, value) {
      if (value === undefined) return this.get(field);
      return this.set(field, value);
    },

    show: function (names, animate) {
      var that = this;
      $.each(this._fieldNames(names), function (i, n) { that.field(n).show(animate); });
      return this;
    },

    hide: function (names, animate) {
      var that = this;
      $.each(this._fieldNames(names), function (i, n) { that.field(n).hide(animate); });
      return this;
    },

    enable: function (names) {
      var that = this;
      $.each(this._fieldNames(names), function (i, n) { that.field(n).enable(); });
      return this;
    },

    disable: function (names) {
      var that = this;
      $.each(this._fieldNames(names), function (i, n) { that.field(n).disable(); });
      return this;
    },

    displayed: function () {
      return $.map(this.s.fields, function (field, name) { return field.displayed() ? name : null; });
    },

    dependent: function (parent, url, opts) {
      if (Array.isArray(parent)) {
        for (var i = 0; i < parent.length; i++) this.dependent(parent[i], url, opts);
        return this;
      }
      var that = this;
      var field = this.field(parent);
      var ajaxOpts = { type: 'POST', dataType: 'json' };
      opts = $.extend({ event: 'change', data: null, preUpdate: null, postUpdate: null }, opts);
      var update = function (json) {
        if (opts.preUpdate) opts.preUpdate(json);
        if (json && typeof json === 'object') {
          $.each({ labels: 'label', options: 'update', values: 'val', messages: 'message', errors: 'error' }, function (jsonProp, fieldFn) {
            if (json[jsonProp]) {
              $.each(json[jsonProp], function (f, val) {
                var fld = that.field(f);
                if (fld && typeof fld[fieldFn] === 'function') fld[fieldFn](val);
              });
            }
          });
          $.each(['hide', 'show', 'enable', 'disable'], function (i, key) {
            if (json[key]) that[key](json[key], json.animate);
          });
        }
        if (opts.postUpdate) opts.postUpdate(json);
        field.processing(false);
      };
      // 加上 .edep 命名空間，undependent() 才移除得掉
      var events = String(opts.event).split(/\s+/).filter(Boolean).map(function (ev) { return ev + '.edep'; }).join(' ');
      $(field.node()).on(events, function (e) {
        if ($(field.node()).find(e.target).length === 0) return;
        field.processing(true);
        var data = {};
        data.rows = that.s.editFields ? _pluck(that.s.editFields, 'data') : null;
        data.row = data.rows ? data.rows[0] : null;
        data.values = that.val();
        if (opts.data) {
          var ret = opts.data(data);
          if (ret) data = ret;
        }
        if (typeof url === 'function') {
          var o = url.call(that, field.val(), data, update);
          if (o) {
            if (typeof o === 'object' && typeof o.then === 'function') {
              o.then(function (resolved) { if (resolved) update(resolved); });
            } else {
              update(o);
            }
          }
        } else {
          if ($.isPlainObject(url)) $.extend(ajaxOpts, url);
          else ajaxOpts.url = url;
          $.ajax($.extend(ajaxOpts, { data: data, success: update }));
        }
      });
      return this;
    },

    undependent: function (names) {
      var that = this;
      $.each(this._fieldNames(names), function (i, n) { $(that.field(n).node()).off('.edep'); });
      return this;
    },

    /* ---------------- 訊息 ---------------- */
    error: function (name, msg) {
      if (msg === undefined) {
        this._message(this.dom.formError, name);
        this.s.globalError = name;
      } else {
        this.field(name).error(msg);
      }
      return this;
    },

    message: function (name, msg) {
      if (msg === undefined) this._message(this.dom.formInfo, name);
      else this.field(name).message(msg);
      return this;
    },

    title: function (title) {
      var header = $(this.dom.header).children('div.' + this.classes.header.content);
      if (title === undefined) return header.html();
      if (typeof title === 'function') title = title(this, new DataTable.Api(this.s.table));
      header.html(title);
      return this;
    },

    inError: function () {
      if (this.s.globalError) return true;
      var fields = this.s.fields;
      var names = this.fields();
      for (var i = 0; i < names.length; i++) if (fields[names[i]].inError()) return true;
      return false;
    },

    /* ---------------- 按鈕 ---------------- */
    buttons: function (buttons) {
      var that = this;
      if (buttons === '_basic') {
        buttons = [{
          text: this.i18n[this.s.action] ? this.i18n[this.s.action].submit : this.i18n.edit.submit,
          action: function () { this.submit(); }
        }];
      } else if (!Array.isArray(buttons)) {
        buttons = [buttons];
      }
      $(this.dom.buttons).empty();
      $.each(buttons, function (i, btn) {
        if (btn === undefined || btn === null || btn === true || btn === false) return;
        if (typeof btn === 'string') {
          btn = { text: btn, action: function () { this.submit(); } };
        }
        var text = btn.text !== undefined ? btn.text : btn.label;
        var action = btn.action || btn.fn;
        $('<button></button>', { 'class': that.classes.form.button + (btn.className ? ' ' + btn.className : '') })
          .html(typeof text === 'function' ? text(that) : text || '')
          .attr('tabindex', btn.tabIndex !== undefined ? btn.tabIndex : 0)
          .on('keyup', function (e) {
            if (e.keyCode === 13 && action) action.call(that);
          })
          .on('keypress', function (e) {
            if (e.keyCode === 13) e.preventDefault();
          })
          .on('click', function (e) {
            e.preventDefault();
            if (action) action.call(that, e);
          })
          .appendTo(that.dom.buttons);
      });
      return this;
    },

    /* ---------------- CRUD ---------------- */
    create: function (arg1, arg2, arg3, arg4) {
      var that = this;
      var fields = this.s.fields;
      var count = 1;
      if (this._tidy(function () { that.create(arg1, arg2, arg3, arg4); })) return this;
      if (typeof arg1 === 'number') {
        count = arg1;
        arg1 = arg2;
        arg2 = arg3;
      }
      this.s.editFields = {};
      for (var i = 0; i < count; i++) this.s.editFields[i] = { fields: this.s.fields };
      var argOpts = this._crudArgs(arg1, arg2, arg3, arg4);
      this.s.mode = 'main';
      this.s.action = 'create';
      this.s.modifier = null;
      this.dom.form.style.display = 'block';
      this._actionClass();
      this._displayReorder(this.fields());
      $.each(fields, function (name, field) {
        field.multiReset();
        for (var j = 0; j < count; j++) field.multiSet(j, field.def());
        field.set(field.def());
      });
      this._event('initCreate', null, function () {
        that._assembleMain();
        that._formOptions(argOpts.opts);
        argOpts.maybeOpen();
      });
      return this;
    },

    edit: function (items, arg1, arg2, arg3, arg4) {
      var that = this;
      if (this._tidy(function () { that.edit(items, arg1, arg2, arg3, arg4); })) return this;
      var argOpts = this._crudArgs(arg1, arg2, arg3, arg4);
      this._edit(items, this._dataSource('fields', items), 'main', argOpts.opts, function () {
        that._assembleMain();
        that._formOptions(argOpts.opts);
        argOpts.maybeOpen();
      });
      return this;
    },

    remove: function (items, arg1, arg2, arg3, arg4) {
      var that = this;
      if (this._tidy(function () { that.remove(items, arg1, arg2, arg3, arg4); })) return this;
      if (items === undefined || items === null) items = [];
      else if (items.length === undefined || typeof items === 'string') items = [items];
      var argOpts = this._crudArgs(arg1, arg2, arg3, arg4);
      var editFields = this._dataSource('fields', items);
      this.s.action = 'remove';
      this.s.modifier = items;
      this.s.editFields = editFields;
      this.s.mode = 'main';
      this.dom.form.style.display = 'none';
      // 刪除／確認框（DataTableConfig.actionButton 用 remove(editor, true)）只顯示訊息與按鈕：
      // 欄位與自訂 template 一律先移出表單（同原版不渲染），之後 create/edit 會由 _displayReorder 放回
      $(this.dom.formContent).children().detach();
      this._actionClass();
      this._event('initRemove', [_pluck(editFields, 'node'), _pluck(editFields, 'data'), items], function () {
        that._event('initMultiRemove', [editFields, items], function () {
          that._assembleMain();
          that._formOptions(argOpts.opts);
          argOpts.maybeOpen();
          var opts = that.s.editOpts;
          if (opts.focus !== null && opts.focus !== undefined) {
            setTimeout(function () { $('button', that.dom.buttons).eq(opts.focus).trigger('focus'); }, 50);
          }
        });
      });
      return this;
    },

    inline: function (cell, fieldName, opts) {
      var that = this;
      if ($.isPlainObject(fieldName)) {
        opts = fieldName;
        fieldName = undefined;
      }
      opts = $.extend({}, this.s.formOptions.inline, opts);
      var editFields = this._dataSource('individual', cell, fieldName);
      var node, field;
      var countOuter = 0, countInner;
      var closed = false;
      var classes = this.classes.inline;
      $.each(editFields, function (i, editField) {
        if (countOuter > 0) throw new Error('Cannot edit more than one row inline at a time');
        node = $(editField.attach[0]);
        countInner = 0;
        $.each(editField.displayFields, function (j, f) {
          if (countInner > 0) throw new Error('Cannot edit more than one field inline at a time');
          field = f;
          countInner++;
        });
        countOuter++;
      });
      if (!node || !field) return this;
      if ($('div.DTE_Field', node).length) return this;
      if (this._tidy(function () { that.inline(cell, fieldName, opts); })) return this;
      this._edit(cell, editFields, 'inline', opts, function () {
        var namespace = that._formOptions(opts);
        var ret = that._preopen('inline');
        if (!ret) return;
        var children = node.contents().detach();
        node.append($(
          '<div class="' + classes.wrapper + '">' +
            '<div class="' + classes.liner + '">' +
              '<div class="' + that.classes.processing.indicator + '"><span></span></div>' +
            '</div>' +
            '<div class="' + classes.buttons + '"></div>' +
          '</div>'
        ));
        node.find('div.' + classes.liner.replace(/ /g, '.')).append(field.node()).append(that.dom.formError);
        $('input:not([type=checkbox]):not([type=radio]):not([type=file]), select, textarea', field.node()).addClass('form-control');
        if (opts.buttons) node.find('div.' + classes.buttons.replace(/ /g, '.')).append(that.dom.buttons);
        that._closeReg(function (submitComplete, action) {
          closed = true;
          $(document).off('click' + namespace);
          if (!submitComplete || action !== 'edit') {
            node.contents().detach();
            node.append(children);
          }
          that._clearDynamicInfo();
          return 'inline';
        });
        setTimeout(function () {
          if (closed) return;
          $(document).on('click' + namespace, function (e) {
            if (!field._typeFn('owns', e.target) && $.inArray(node[0], $(e.target).parents().addBack()) === -1) that.blur();
          });
        }, 0);
        that._focus([field], opts.focus);
        that._postopen('inline');
      });
      return this;
    },

    bubble: function (cells, fieldNames, show, opts) {
      var that = this;
      if (this._tidy(function () { that.bubble(cells, fieldNames, opts); })) return this;
      if ($.isPlainObject(fieldNames)) {
        opts = fieldNames;
        fieldNames = undefined;
        show = true;
      } else if (typeof fieldNames === 'boolean') {
        show = fieldNames;
        fieldNames = undefined;
        opts = undefined;
      }
      if ($.isPlainObject(show)) {
        opts = show;
        show = true;
      }
      if (show === undefined) show = true;
      opts = $.extend({}, this.s.formOptions.bubble, opts);
      var editFields = this._dataSource('individual', cells, fieldNames);
      this._edit(cells, editFields, 'bubble', opts, function () {
        var namespace = that._formOptions(opts);
        var ret = that._preopen('bubble');
        if (!ret) return;
        $(window).on('resize.' + namespace, function () { that.bubblePosition(); });
        var nodes = [];
        that.s.bubbleNodes = nodes.concat.apply(nodes, _pluck(editFields, 'attach'));
        var classes = that.classes.bubble;
        var background = $('<div class="' + classes.bg + '"><div></div></div>');
        var container = $(
          '<div class="' + classes.wrapper + '">' +
            '<div class="' + classes.liner + '">' +
              '<div class="' + classes.table + '">' +
                '<div class="' + classes.close + '" title="' + that.i18n.close + '"></div>' +
                '<div class="DTE_Processing_Indicator"><span></span></div>' +
              '</div>' +
            '</div>' +
            '<div class="' + classes.pointer + '"></div>' +
          '</div>'
        );
        if (show) {
          container.appendTo('body');
          background.appendTo('body');
        }
        var liner = container.children().eq(0);
        var tableEl = liner.children();
        var close = tableEl.children();
        liner.append(that.dom.formError);
        tableEl.prepend(that.dom.form);
        if (opts.message) liner.prepend(that.dom.formInfo);
        if (opts.title) liner.prepend(that.dom.header);
        if (opts.buttons) tableEl.append(that.dom.buttons);
        var pair = $().add(container).add(background);
        that._closeReg(function () {
          pair.animate({ opacity: 0 }, function () {
            pair.detach();
            $(window).off('resize.' + namespace);
            that._clearDynamicInfo();
            that._event('closed', ['bubble']);
          });
        });
        background.on('click', function () { that.blur(); });
        close.on('click', function () { that._close(); });
        that.bubblePosition();
        pair.animate({ opacity: 1 });
        var displayedFields = [];
        $.each(editFields, function (i, ef) { $.each(ef.displayFields, function (n, f) { displayedFields.push(f); }); });
        that._displayReorder($.map(displayedFields, function (f) { return f.name(); }));
        $.each(displayedFields, function (i, f) {
          $('input:not([type=checkbox]):not([type=radio]):not([type=file]), select, textarea', f.node()).addClass('form-control');
        });
        that._focus(displayedFields, opts.focus);
        that._postopen('bubble');
      });
      return this;
    },

    bubblePosition: function () {
      // 原站頁面 CSS 已把 div.DTE_Bubble 固定在畫面中央（position:fixed + !important），這裡只需維持可見
      var wrapper = $('div.DTE_Bubble');
      if (!wrapper.length) return this;
      wrapper.css({ opacity: 1 });
      return this;
    },

    /* ---------------- 顯示 ---------------- */
    open: function () {
      var that = this;
      this._displayReorder();
      this._closeReg(function () {
        that.s.displayController.close(that, function () {
          that._clearDynamicInfo();
          that._event('closed', ['main']);
        });
      });
      var ret = this._preopen('main');
      if (!ret) return this;
      this.s.displayController.open(this, this.dom.wrapper, function () {
        that._focus($.map(that.s.order, function (name) { return that.s.fields[name]; }), that.s.editOpts.focus);
      });
      this._postopen('main');
      return this;
    },

    close: function () {
      this._close();
      return this;
    },

    blur: function () {
      this._blur();
      return this;
    },

    background: function () {
      var onBackground = this.s.editOpts.onBackground;
      if (typeof onBackground === 'function') onBackground(this);
      else if (onBackground === 'blur') this.blur();
      else if (onBackground === 'close') this.close();
      else if (onBackground === 'submit') this.submit();
      return this;
    },

    display: function (show) {
      if (show === undefined) return this.s.displayed;
      return this[show ? 'open' : 'close']();
    },

    /* 取得／設定 ajax 設定（同原版 Editor.prototype.ajax：有參數時設定並回傳 Editor，無參數回傳目前設定） */
    ajax: function (newAjax) {
      if (newAjax) {
        this.s.ajax = newAjax;
        return this;
      }
      return this.s.ajax;
    },

    mode: function (mode) {
      if (!mode) return this.s.action;
      if (!this.s.action) throw new Error('Not currently in an editing mode');
      if (this.s.action === 'create' && mode !== 'create') throw new Error('Changing from create mode is not supported');
      this.s.action = mode;
      return this;
    },

    modifier: function () {
      return this.s.modifier;
    },

    ids: function (includeHash) {
      return $.map(this.s.editFields, function (edit, idSrc) {
        return includeHash === true ? '#' + idSrc : idSrc;
      });
    },

    processing: function (set) {
      this._processing(set);
      return this;
    },

    submit: function (successCallback, errorCallback, formatdata, hide) {
      var that = this;
      var fields = this.s.fields;
      var errorFields = [];
      var errorReady = 0;
      var sent = false;
      if (this.s.processing || !this.s.action) return this;
      this._processing(true);
      var send = function () {
        if (errorFields.length !== errorReady || sent) return;
        that._event('initSubmit', [that.s.action], function (result) {
          if (result === false) {
            that._processing(false);
            return;
          }
          sent = true;
          that._submit(successCallback, errorCallback, formatdata, hide);
        });
      };
      this.error();
      $.each(fields, function (name, field) {
        if (field.inError()) errorFields.push(name);
      });
      $.each(errorFields, function (i, name) {
        fields[name].error('', function () {
          errorReady++;
          send();
        });
      });
      send();
      return this;
    },

    destroy: function () {
      if (this.s.displayed) this.close();
      this.clear();
      if (this.s.template) $('body').append(this.s.template);
      var unique = this.s.unique;
      $(document).off('.dte' + unique);
      this.dom = null;
      this.s = null;
    },

    /* ---------------- 事件 ---------------- */
    on: function (name, fn) {
      $(this).on(this._eventName(name), fn);
      return this;
    },
    one: function (name, fn) {
      $(this).one(this._eventName(name), fn);
      return this;
    },
    off: function (name, fn) {
      $(this).off(this._eventName(name), fn);
      return this;
    },

    /* ================= 內部 ================= */
    _actionClass: function () {
      var classesActions = this.classes.actions;
      var action = this.s.action;
      var wrapper = $(this.dom.wrapper);
      wrapper.removeClass([classesActions.create, classesActions.edit, classesActions.remove].join(' '));
      if (action === 'create') wrapper.addClass(classesActions.create);
      else if (action === 'edit') wrapper.addClass(classesActions.edit);
      else if (action === 'remove') wrapper.addClass(classesActions.remove);
    },

    _ajax: function (data, success, error) {
      var action = data[this.s.actionName] || data.action;
      var thrown;
      var opts = {
        type: 'POST',
        dataType: 'json',
        data: null,
        error: [function (xhr, text, err) { thrown = err; }],
        success: [],
        complete: [function (xhr, text) {
          var json = null;
          if (xhr.status === 204 || xhr.responseText === 'null') {
            json = {};
          } else {
            try {
              json = xhr.responseJSON ? xhr.responseJSON : JSON.parse(xhr.responseText);
            } catch (e) { /* 非 JSON */ }
          }
          if ($.isPlainObject(json) || Array.isArray(json)) success(json, xhr.status >= 400, xhr);
          else error(xhr, text, thrown);
        }]
      };
      var a;
      var ajaxSrc = this.s.ajax || this.s.ajaxUrl;
      var id = action === 'edit' || action === 'remove' ? _pluck(this.s.editFields, 'idSrc') : null;
      if (Array.isArray(id)) id = id.join(',');
      if ($.isPlainObject(ajaxSrc) && ajaxSrc[action]) ajaxSrc = ajaxSrc[action];
      if (typeof ajaxSrc === 'function') {
        ajaxSrc.call(this, null, null, data, success, error);
        return;
      } else if (typeof ajaxSrc === 'string') {
        if (ajaxSrc.indexOf(' ') !== -1) {
          a = ajaxSrc.split(' ');
          opts.type = a[0];
          opts.url = a[1];
        } else {
          opts.url = ajaxSrc;
        }
      } else {
        var optsCopy = $.extend({}, ajaxSrc || {});
        if (optsCopy.complete) {
          opts.complete.unshift(optsCopy.complete);
          delete optsCopy.complete;
        }
        if (optsCopy.error) {
          opts.error.unshift(optsCopy.error);
          delete optsCopy.error;
        }
        opts = $.extend({}, opts, optsCopy);
      }
      opts.url = String(opts.url || '').replace(/_id_/, id);
      if (opts.data) {
        var isFn = typeof opts.data === 'function';
        var newData = isFn ? opts.data(data) : opts.data;
        data = isFn && newData ? newData : $.extend(true, data, newData);
      }
      opts.data = data;
      if (opts.type === 'DELETE' && (opts.deleteBody === undefined || opts.deleteBody === true)) {
        var params = $.param(opts.data);
        opts.url += opts.url.indexOf('?') === -1 ? '?' + params : '&' + params;
        delete opts.data;
      }
      $.ajax(opts);
    },

    _assembleMain: function () {
      var dom = this.dom;
      $(dom.wrapper).prepend(dom.header);
      // 原站 DOM：processing 指示器緊接在 header 之後
      $(dom.processing).insertAfter(dom.header);
      $(dom.footer).append(dom.formError).append(dom.buttons);
      $(dom.bodyContent).append(dom.formInfo).append(dom.form);
    },

    _blur: function () {
      var opts = this.s.editOpts.onBlur;
      if (this._event('preBlur') === false) return;
      if (typeof opts === 'function') opts(this);
      else if (opts === 'submit') this.submit();
      else if (opts === 'close') this._close();
    },

    _clearDynamicInfo: function (opts) {
      if (!opts) opts = {};
      if (!this.s) return;
      var errorClass = this.classes.field.error;
      var fields = this.s.fields;
      $('div.' + errorClass.replace(/ /g, '.'), this.dom.wrapper).removeClass(errorClass);
      $.each(fields, function (name, field) {
        field.error('');
        if (!opts.noMessage) field.message('');
      });
      this.error('');
      if (!opts.noMessage) this.message('');
    },

    _close: function (submitComplete, mode) {
      if (this._event('preClose') === false) return;
      if (this.s.closeCb) {
        this.s.closeCb(submitComplete, mode);
        this.s.closeCb = null;
      }
      if (this.s.closeIcb) {
        this.s.closeIcb();
        this.s.closeIcb = null;
      }
      $('body').off('focus.editor-focus');
      this.s.displayed = false;
      this._event('close');
    },

    _closeReg: function (fn) {
      this.s.closeCb = fn;
    },

    _crudArgs: function (arg1, arg2, arg3, arg4) {
      var that = this;
      var title, buttons, show, opts;
      if ($.isPlainObject(arg1)) {
        opts = arg1;
      } else if (typeof arg1 === 'boolean') {
        show = arg1;
        opts = arg2;
      } else {
        title = arg1;
        buttons = arg2;
        show = arg3;
        opts = arg4;
      }
      if (show === undefined) show = true;
      if (title) that.title(title);
      if (buttons) that.buttons(buttons);
      return {
        opts: $.extend({}, this.s.formOptions.main, opts),
        maybeOpen: function () {
          if (show) that.open();
        }
      };
    },

    _dataSource: function (name) {
      var args = Array.prototype.slice.call(arguments);
      args.shift();
      var fn = this.s.dataSource[name];
      if (fn) return fn.apply(this, args);
    },

    _displayReorder: function (includeFields) {
      var that = this;
      var formContent = $(this.dom.formContent);
      var fields = this.s.fields;
      var order = this.s.order;
      var template = this.s.template;
      var mode = this.s.mode || 'main';
      if (includeFields) this.s.includeFields = includeFields;
      else includeFields = this.s.includeFields;
      formContent.children().detach();
      $.each(order, function (i, fieldOrName) {
        var name = fieldOrName instanceof Editor.Field ? fieldOrName.name() : fieldOrName;
        if (that._weakInArray(name, includeFields) !== -1 && fields[name]) {
          if (template && mode === 'main') {
            template.find('editor-field[name="' + name + '"]').after(fields[name].node());
            template.find('[data-editor-template="' + name + '"]').append(fields[name].node());
          } else {
            formContent.append(fields[name].node());
          }
        }
      });
      if (template && mode === 'main') template.appendTo(formContent);
      this._event('displayOrder', [this.s.displayed, this.s.action, formContent]);
    },

    _edit: function (items, editFields, type, formOptions, setupDone) {
      var that = this;
      var fields = this.s.fields;
      var usedFields = [];
      var includeInOrder;
      var editData = {};
      this.s.editFields = editFields;
      this.s.editData = editData;
      this.s.modifier = items;
      this.s.action = 'edit';
      this.dom.form.style.display = 'block';
      this.s.mode = type;
      this._actionClass();
      $.each(fields, function (name, field) {
        field.multiReset();
        includeInOrder = false;
        editData[name] = {};
        $.each(editFields, function (idSrc, edit) {
          if (edit.fields[name]) {
            var val = field.valFromData(edit.data);
            var nullDefault = field.nullDefault();
            editData[name][idSrc] = val === null ? '' : Array.isArray(val) ? val.slice() : val;
            if (!formOptions || formOptions.scope === 'row') {
              field.multiSet(idSrc, val === undefined || (nullDefault && val === null) ? field.def() : val);
              if (!edit.displayFields || edit.displayFields[name]) includeInOrder = true;
            } else if (!edit.displayFields || edit.displayFields[name]) {
              field.multiSet(idSrc, val === undefined || (nullDefault && val === null) ? field.def() : val);
              includeInOrder = true;
            }
          }
        });
        if (field.multiIds().length !== 0 && includeInOrder) usedFields.push(name);
      });
      var currOrder = this.order().slice();
      for (var i = currOrder.length - 1; i >= 0; i--) {
        if ($.inArray(currOrder[i].toString(), usedFields) === -1) currOrder.splice(i, 1);
      }
      this._displayReorder(currOrder);
      this._event('initEdit', [_pluck(editFields, 'node')[0], _pluck(editFields, 'data')[0], items, type], function () {
        that._event('initMultiEdit', [editFields, items, type], function () {
          if (setupDone) setupDone();
        });
      });
    },

    _event: function (trigger, args, promiseComplete) {
      if (!args) args = [];
      if (Array.isArray(trigger)) {
        var res;
        for (var i = 0; i < trigger.length; i++) res = this._event(trigger[i], args);
        if (promiseComplete) promiseComplete(res);
        return res;
      }
      var e = $.Event(trigger);
      $(this).triggerHandler(e, args);
      var result = e.result;
      if (trigger.indexOf('pre') === 0 && result === false) {
        $(this).triggerHandler($.Event(trigger + 'Cancelled'), args);
      }
      if (promiseComplete) {
        if (result && typeof result === 'object' && typeof result.then === 'function') result.then(promiseComplete);
        else promiseComplete(result);
      }
      return result;
    },

    _eventName: function (input) {
      var name;
      var names = input.split(' ');
      for (var i = 0; i < names.length; i++) {
        name = names[i];
        var onStyle = name.match(/^on([A-Z])/);
        if (onStyle) name = onStyle[1].toLowerCase() + name.substring(3);
        names[i] = name;
      }
      return names.join(' ');
    },

    _fieldFromNode: function (node) {
      var foundField = null;
      $.each(this.s.fields, function (name, field) {
        if ($(field.node()).find(node).length) foundField = field;
      });
      return foundField;
    },

    _fieldNames: function (fieldNames) {
      if (fieldNames === undefined) return this.fields();
      if (!Array.isArray(fieldNames)) return [fieldNames];
      return fieldNames;
    },

    _focus: function (fieldsIn, focus) {
      var that = this;
      var field;
      var fields = $.map(fieldsIn, function (fieldOrName) {
        return typeof fieldOrName === 'string' ? that.s.fields[fieldOrName] : fieldOrName;
      });
      if (typeof focus === 'number') field = fields[focus];
      else if (focus) {
        if (focus.indexOf('jq:') === 0) field = $('div.DTE ' + focus.replace(/^jq:/, ''));
        else field = this.s.fields[focus];
      }
      this.s.setFocus = field;
      if (field && field.focus) field.focus();
    },

    _formOptions: function (opts) {
      var that = this;
      var inlineCount = __inlineCounter++;
      var namespace = '.dteInline' + inlineCount;
      if (opts.submitOnReturn !== undefined) opts.onReturn = opts.submitOnReturn ? 'submit' : 'none';
      if (opts.submitOnBlur !== undefined) opts.onBlur = opts.submitOnBlur ? 'submit' : 'close';
      if (opts.blurOnBackground !== undefined) opts.onBackground = opts.blurOnBackground ? 'blur' : 'none';
      this.s.editOpts = opts;
      this.s.editCount = inlineCount;
      if (typeof opts.title === 'string' || typeof opts.title === 'function') {
        this.title(opts.title);
        opts.title = true;
      }
      if (typeof opts.message === 'string' || typeof opts.message === 'function') {
        this.message(opts.message);
        opts.message = true;
      }
      if (typeof opts.buttons !== 'boolean') {
        this.buttons(opts.buttons);
        opts.buttons = true;
      }
      $(document).on('keydown' + namespace, function (e) {
        if (e.keyCode === 13 && that.s.displayed) {
          var el = $(document.activeElement);
          if (el) {
            var field = that._fieldFromNode(el);
            if (field && typeof field.canReturnSubmit === 'function' && field.canReturnSubmit(el)) e.preventDefault();
          }
        }
      });
      $(document).on('keyup' + namespace, function (e) {
        var el = $(document.activeElement);
        if (e.keyCode === 13 && that.s.displayed) {
          var field = that._fieldFromNode(el);
          if (field && typeof field.canReturnSubmit === 'function' && field.canReturnSubmit(el)) {
            if (opts.onReturn === 'submit') {
              e.preventDefault();
              that.submit();
            } else if (typeof opts.onReturn === 'function') {
              e.preventDefault();
              opts.onReturn(that, e);
            }
          }
        } else if (e.keyCode === 27 && that.s.displayed) {
          e.preventDefault();
          if (typeof opts.onEsc === 'function') opts.onEsc(that, e);
          else if (opts.onEsc === 'blur') that.blur();
          else if (opts.onEsc === 'close') that.close();
          else if (opts.onEsc === 'submit') that.submit();
        } else if (el.parents('.DTE_Form_Buttons').length) {
          if (e.keyCode === 37) el.prev('button').trigger('focus');
          else if (e.keyCode === 39) el.next('button').trigger('focus');
        }
      });
      this.s.closeIcb = function () {
        $(document).off('keydown' + namespace);
        $(document).off('keyup' + namespace);
      };
      return namespace;
    },

    _message: function (el, msg) {
      if (typeof msg === 'function') msg = msg(this, new DataTable.Api(this.s.table));
      el = $(el);
      if (!msg && this.s.displayed) {
        el.stop().fadeOut(function () { el.html(''); });
      } else if (!msg) {
        el.html('').css('display', 'none');
      } else if (this.s.displayed) {
        el.stop().html(msg).fadeIn();
      } else {
        el.html(msg).css('display', 'block');
      }
    },

    _multiInfo: function () {
      var fields = this.s.fields;
      var include = this.s.includeFields;
      var show = true;
      var state;
      if (!include) return;
      for (var i = 0; i < include.length; i++) {
        var field = fields[include[i]];
        if (!field) continue;
        var multiEditable = field.s.opts.multiEditable;
        if (field.isMultiValue() && multiEditable && show) {
          state = true;
          show = false;
        } else if (field.isMultiValue() && !multiEditable) {
          state = true;
        } else {
          state = false;
        }
        field.multiInfoShown(state);
      }
    },

    _optionsUpdate: function (json) {
      var that = this;
      if (json && json.options) {
        $.each(this.s.fields, function (name) {
          if (json.options[name] !== undefined) {
            var fieldInst = that.field(name);
            if (fieldInst && fieldInst.update) fieldInst.update(json.options[name]);
          }
        });
      }
    },

    _postopen: function (type) {
      var that = this;
      $(this.dom.form)
        .off('submit.editor-internal')
        .on('submit.editor-internal', function (e) { e.preventDefault(); });
      if (type === 'main' || type === 'bubble') {
        $('body').on('focus.editor-focus', function () {
          if ($(document.activeElement).parents('.DTE').length === 0 && $(document.activeElement).parents('.DTED').length === 0) {
            if (that.s.setFocus && that.s.setFocus.focus) that.s.setFocus.focus();
          }
        });
      }
      this._multiInfo();
      this._event('open', [type, this.s.action]);
      this._event('opened', [type, this.s.action]);
      return true;
    },

    _preopen: function (type) {
      if (this._event('preOpen', [type, this.s.action]) === false) {
        this._clearDynamicInfo();
        this._event('cancelOpen', [type, this.s.action]);
        if ((this.s.mode === 'inline' || this.s.mode === 'bubble') && this.s.closeIcb) this.s.closeIcb();
        this.s.closeIcb = null;
        return false;
      }
      this.s.displayed = type;
      return true;
    },

    _processing: function (processing) {
      var procClass = this.classes.processing.active;
      $(this.dom.wrapper).toggleClass(procClass, !!processing);
      this.s.processing = processing;
      this._event('processing', [processing]);
    },

    _submit: function (successCallback, errorCallback, formatdata, hide) {
      var that = this;
      var changed = false;
      var allData = {};
      var changedData = {};
      var fields = this.s.fields;
      var editCount = this.s.editCount;
      var editFields = this.s.editFields;
      var editData = this.s.editData;
      var opts = this.s.editOpts;
      var changedSubmit = opts.submit;
      var submitParamsLocal;
      var action = this.s.action;
      var submitParams = { data: {} };
      submitParams[this.s.actionName] = action;

      if (action === 'create' || action === 'edit') {
        $.each(editFields, function (idSrc, edit) {
          var allRowData = {};
          var changedRowData = {};
          $.each(fields, function (name, field) {
            if (edit.fields[name] && field.submittable()) {
              var value = field.multiGet(idSrc);
              var builder = setObjFn(name);
              var manyBuilder = Array.isArray(value) && name.indexOf('[]') !== -1 ? setObjFn(name.replace(/\[.*$/, '') + '-many-count') : null;
              builder(allRowData, value);
              if (manyBuilder) manyBuilder(allRowData, value.length);
              if (action === 'create' || (editData[name] && field.compare(value, editData[name][idSrc]) === false)) {
                builder(changedRowData, value);
                changed = true;
                if (manyBuilder) manyBuilder(changedRowData, value.length);
              }
            }
          });
          if (!$.isEmptyObject(allRowData)) allData[idSrc] = allRowData;
          if (!$.isEmptyObject(changedRowData)) changedData[idSrc] = changedRowData;
        });
        if (action === 'create' || changedSubmit === 'all' || (changedSubmit === 'allIfChanged' && changed)) {
          submitParams.data = allData;
        } else if (changedSubmit === 'changed' && changed) {
          submitParams.data = changedData;
        } else {
          // 沒有任何變更：不送出，直接完成
          this.s.action = null;
          if (opts.onComplete === 'close' && (hide === undefined || hide)) this._close(false);
          else if (typeof opts.onComplete === 'function') opts.onComplete(this);
          if (successCallback) successCallback.call(this);
          this._processing(false);
          this._event('submitComplete');
          return;
        }
      } else if (action === 'remove') {
        $.each(editFields, function (idSrc, edit) {
          submitParams.data[idSrc] = edit.data;
        });
      }

      submitParamsLocal = $.extend(true, {}, submitParams);
      if (formatdata) formatdata(submitParams);
      if (this._event('preSubmit', [submitParams, action]) === false) {
        this._processing(false);
        return;
      }
      var submitWire = this.s.ajax || this.s.ajaxUrl ? this._ajax : this._submitTable;
      submitWire.call(
        this,
        submitParams,
        function (json, notGood, xhr) {
          that._submitSuccess(json, notGood, submitParams, submitParamsLocal, that.s.action, editCount, hide, successCallback, errorCallback, xhr);
        },
        function (xhr, err, thrown) {
          that._submitError(xhr, err, thrown, errorCallback, submitParams, that.s.action);
        },
        submitParams
      );
    },

    _submitTable: function (data, success) {
      // 沒有 ajax 設定：直接以送出資料當作伺服器回應（本地表格編輯）
      var that = this;
      var action = data.action;
      var out = { data: [] };
      var idGet = getObjFn(this.s.idSrc);
      var idSet = setObjFn(this.s.idSrc);
      if (action !== 'remove') {
        var originalData = this.s.mode === 'main' ? this._dataSource('fields', this.modifier()) : this._dataSource('individual', this.modifier());
        $.each(data.data, function (key, vals) {
          var toSave;
          if (action === 'edit') {
            var rowData = originalData[key] ? originalData[key].data : {};
            toSave = $.extend(true, {}, rowData, vals);
          } else {
            toSave = $.extend(true, {}, vals);
          }
          if (action === 'create' && idGet(toSave) === undefined) idSet(toSave, +new Date() + '' + key);
          out.data.push(toSave);
        });
      }
      void that;
      success(out);
    },

    _submitError: function (xhr, err, thrown, errorCallback, submitParams, action) {
      this._event('postSubmit', [null, submitParams, action, xhr]);
      this.error(this.i18n.error.system);
      this._processing(false);
      if (errorCallback) errorCallback.call(this, xhr, err, thrown);
      this._event(['submitError', 'submitComplete'], [xhr, err, thrown, submitParams]);
    },

    _submitSuccess: function (json, notGood, submitParams, submitParamsLocal, action, editCount, hide, successCallback, errorCallback, xhr) {
      var that = this;
      var setData;
      var fields = this.s.fields;
      var opts = this.s.editOpts;
      var modifier = this.s.modifier;
      this._event('postSubmit', [json, submitParams, action, xhr]);
      if (!json.error) json.error = '';
      if (!json.fieldErrors) json.fieldErrors = [];
      if (notGood || json.error || json.fieldErrors.length) {
        var globalError = [];
        if (json.error) globalError.push(json.error);
        $.each(json.fieldErrors, function (i, err) {
          var field = fields[err.name];
          if (!field) throw new Error('Unknown field: ' + err.name);
          if (field.displayed()) {
            field.error(err.status || 'Error');
            if (i === 0) {
              if (opts.onFieldError === 'focus') {
                try {
                  $(that.dom.bodyContent).animate({ scrollTop: $(field.node()).position().top }, 500);
                } catch (e) { /* ignore */ }
                field.focus();
              } else if (typeof opts.onFieldError === 'function') {
                opts.onFieldError(that, err);
              }
            }
          } else {
            globalError.push(field.name() + ': ' + (err.status || 'Error'));
          }
        });
        this.error(globalError.join('<br>'));
        this._event('submitUnsuccessful', [json]);
        if (errorCallback) errorCallback.call(that, json);
      } else {
        var store = {};
        if (json.data && (action === 'create' || action === 'edit')) {
          this._dataSource('prep', action, modifier, submitParamsLocal, json, store);
          for (var i = 0; i < json.data.length; i++) {
            setData = json.data[i];
            var id = this._dataSource('id', setData);
            this._event('setData', [json, setData, action]);
            if (action === 'create') {
              this._event('preCreate', [json, setData, id]);
              this._dataSource('create', fields, setData, store);
              this._event(['create', 'postCreate'], [json, setData, id]);
            } else if (action === 'edit') {
              this._event('preEdit', [json, setData, id]);
              this._dataSource('edit', modifier, fields, setData, store);
              this._event(['edit', 'postEdit'], [json, setData, id]);
            }
          }
          this._dataSource('commit', action, modifier, json.data, store);
        } else if (action === 'remove') {
          this._dataSource('prep', action, modifier, submitParamsLocal, json, store);
          this._event('preRemove', [json, this.ids()]);
          this._dataSource('remove', modifier, fields, store);
          this._event(['remove', 'postRemove'], [json, this.ids()]);
          this._dataSource('commit', action, modifier, json.data, store);
        }
        if (editCount === this.s.editCount) {
          var sAction = this.s.action;
          this.s.action = null;
          if (opts.onComplete === 'close' && (hide === undefined || hide)) this._close(json.data ? true : false, sAction);
          else if (typeof opts.onComplete === 'function') opts.onComplete(this);
        }
        if (successCallback) successCallback.call(that, json);
        this._event('submitSuccess', [json, setData, action]);
      }
      this._processing(false);
      this._event('submitComplete', [json, setData, action]);
    },

    _tidy: function (fn) {
      var that = this;
      var dt = this.s.table ? new DataTable.Api(this.s.table) : null;
      var ssp = false;
      if (dt) {
        try { ssp = dt.settings()[0].oFeatures.bServerSide; } catch (e) { ssp = false; }
      }
      if (this.s.processing) {
        this.one('submitComplete', function () {
          if (ssp) dt.one('draw', fn);
          else setTimeout(function () { fn(); }, 10);
        });
        return true;
      } else if (this.display() === 'inline' || this.display() === 'bubble') {
        this.one('close', function () {
          if (!that.s.processing) {
            setTimeout(function () { if (that.s) fn(); }, 10);
          } else {
            that.one('submitComplete', function (e, json) {
              if (ssp && json) dt.one('draw', fn);
              else setTimeout(function () { if (that.s) fn(); }, 10);
            });
          }
        }).blur();
        return true;
      }
      return false;
    },

    _weakInArray: function (name, arr) {
      for (var i = 0; i < arr.length; i++) {
        if (name == arr[i]) return i; // eslint-disable-line eqeqeq
      }
      return -1;
    }
  };

  /* ======================================================================
   * DataTables 整合：API editor()、Buttons
   * ==================================================================== */
  function __getInst(api) {
    var ctx = api.context[0];
    return ctx ? ctx.oInit.editor || ctx._editor : undefined;
  }

  if (DataTable.Api && DataTable.Api.register) {
    DataTable.Api.register('editor()', function () {
      return __getInst(this);
    });
  }

  if (ext.buttons) {
    $.extend(ext.buttons, {
      create: {
        text: function (dt, node, config) {
          return dt.i18n('buttons.create', config.editor.i18n.create.button);
        },
        className: 'buttons-create',
        editor: null,
        formButtons: {
          text: function (editor) { return editor.i18n.create.submit; },
          className: 'btn-primary',
          action: function () { this.submit(); }
        },
        formMessage: null,
        formTitle: null,
        action: function (e, dt, node, config) {
          var that = this;
          var editor = config.editor;
          this.processing(true);
          editor
            .one('preOpen', function () { that.processing(false); })
            .create({
              buttons: config.formButtons,
              message: config.formMessage || editor.i18n.create.message,
              title: config.formTitle || editor.i18n.create.title
            });
          // preOpen 被取消時也要解除按鈕處理中狀態
          setTimeout(function () { that.processing(false); }, 0);
        }
      },
      edit: {
        extend: 'selected',
        text: function (dt, node, config) {
          return dt.i18n('buttons.edit', config.editor.i18n.edit.button);
        },
        className: 'buttons-edit',
        editor: null,
        formButtons: {
          text: function (editor) { return editor.i18n.edit.submit; },
          className: 'btn-primary',
          action: function () { this.submit(); }
        },
        formMessage: null,
        formTitle: null,
        action: function (e, dt, node, config) {
          var that = this;
          var editor = config.editor;
          var rows = dt.rows({ selected: true }).indexes();
          var columns = dt.columns({ selected: true }).indexes();
          var cells = dt.cells({ selected: true }).indexes();
          var items = columns.length || cells.length ? { rows: rows, columns: columns, cells: cells } : rows;
          this.processing(true);
          editor
            .one('preOpen', function () { that.processing(false); })
            .edit(items, {
              buttons: config.formButtons,
              message: config.formMessage || editor.i18n.edit.message,
              title: config.formTitle || editor.i18n.edit.title
            });
          setTimeout(function () { that.processing(false); }, 0);
        }
      },
      remove: {
        extend: 'selected',
        limitTo: ['rows'],
        text: function (dt, node, config) {
          return dt.i18n('buttons.remove', config.editor.i18n.remove.button);
        },
        className: 'buttons-remove',
        editor: null,
        formButtons: {
          text: function (editor) { return editor.i18n.remove.submit; },
          className: 'btn-danger',
          action: function () { this.submit(); }
        },
        formMessage: function (editor, dt) {
          var rows = dt.rows({ selected: true }).indexes();
          var i18n = editor.i18n.remove;
          var question = typeof i18n.confirm === 'string' ? i18n.confirm : i18n.confirm[rows.length] ? i18n.confirm[rows.length] : i18n.confirm._;
          return question.replace(/%d/g, rows.length);
        },
        formTitle: null,
        action: function (e, dt, node, config) {
          var that = this;
          var editor = config.editor;
          this.processing(true);
          editor
            .one('preOpen', function () { that.processing(false); })
            .remove(dt.rows({ selected: true }).indexes(), {
              buttons: config.formButtons,
              message: config.formMessage,
              title: config.formTitle || editor.i18n.remove.title
            });
          setTimeout(function () { that.processing(false); }, 0);
        }
      }
    });
    ext.buttons.editSingle = $.extend({}, ext.buttons.edit, { extend: 'selectedSingle' });
    ext.buttons.removeSingle = $.extend({}, ext.buttons.remove, { extend: 'selectedSingle' });
  }

  /* ======================================================================
   * 對外
   * ==================================================================== */
  $.fn.dataTable.Editor = Editor;
  $.fn.DataTable.Editor = Editor;
  DataTable.Editor = Editor;
})(window.jQuery, window, document);
