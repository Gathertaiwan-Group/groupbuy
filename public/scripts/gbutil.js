class SimpleEditorManager {
    constructor(selectorId, config) {
        this.selectorId = selectorId;
        this.config = {
            getUrl: '',
            updateUrl: '',
            fields: [],
            ...config
        };
        this.editor = null;
        this.actionCallback = null;
    }
    
    // 抽象方法：獲取實際的 GET URL
    getGetUrl(id) {
        throw new Error('getGetUrl must be implemented');
    }

    // 抽象方法：獲取實際的 UPDATE URL
    getUpdateUrl(id) {
        throw new Error('getUpdateUrl must be implemented');
    }

    // 設置 action 回調
    setActionCallback(callback) {
        this.actionCallback = callback;
        return this;
    }

    init() {
        this.initEditor();
        this.bindClickEvent();
        return this;
    }
    
    // 綁定通用的 data-action 事件
    bindClickEvent() {
        $(this.selectorId).on('click', '[data-action]', (e) => {
			e.stopPropagation();
            const $target = $(e.currentTarget);
            const action = $target.data('action');
            const id = $target.data('id');
            
            if (this.actionCallback) {
                // 傳遞 URL 處理方法給回調
                const urls = {
                    getUrl: this.getGetUrl(id),
                    updateUrl: this.getUpdateUrl(id)
                };
                this.actionCallback(action, id, urls, e);
            }
        });
    }
 	async fetchEditorConfig() {
        try {
            const response = await fetch(this.config.getUrl);
            return await response.json();
        } catch (error) {
            console.error('Failed to fetch editor config:', error);
            throw error;
        }
    }

    initEditor() {
        this.editor = new $.fn.dataTable.Editor({
            ajax: {
                url: (action, data) => {
                    const id = data.data ? Object.keys(data.data)[0] : null;
                    return action === 'edit' ? 
                        this.getUpdateUrl(id) : 
                        this.getGetUrl(id);
                },
                // 處理發送到服務器的數據
                data: this._processData.bind(this),
                // 處理從服務器返回的數據
                dataSrc: this._processResponseData.bind(this)
            },
            table: this.selectorId,
            fields: this.config.fields,
            formOptions: {
                main: {
                    onBackground: 'blur'
                }
            },
            i18n: this.getI18nConfig()
        });

        this.bindEditorEvents();
        return this.editor;
    }

    _processUrl(url, action) {
        return action === 'edit' ? this.config.updateUrl : this.config.getUrl;
    }

    // 處理發送到服務器的數據
    _processData(data) {
        return data.action === 'get' ? {} : { data: data.data };
    }
    
    // 處理從服務器返回的數據
    _processResponseData(response) {
        if (!response) return {};
        
        // 如果是 GET 請求的響應，需要將數據轉換為 Editor 期望的格式
        if (response.data) {
            return {
                data: {
                    // 使用第一個 ID 作為鍵
                    [Object.keys(response.data)[0]]: response.data
                }
            };
        }

        return response;
    }

    combineFields(serverFields, localFields) {
        return [...serverFields, ...localFields].map(field => ({
            label: field.label || field.name,
            name: field.name,
            type: field.type || 'text'
        }));
    }

    bindEditorEvents() {
        this.editor
            .on('preSubmit', this.onPreSubmit.bind(this))
            .on('submitSuccess', this.onSubmitSuccess.bind(this))
            .on('submitError', this.onSubmitError.bind(this));
    }

    open(id) {
        const getUrl = this.getGetUrl(id);
        const updateUrl = this.getUpdateUrl(id);

        this.editor
            .ajax({url:getUrl,type:'GET'})
            .edit(id, true);
    }

    onPreSubmit(e, data, action) {
        return true;
    }

    onSubmitSuccess(e, data, action) {
        // 可以被覆寫
    }

    onSubmitError(e, xhr, error, thrown) {
        console.error('Submission error:', error);
    }

    getI18nConfig() {
        return {
            edit: {
                title: "編輯",
                submit: "更新"
            },
            error: {
                system: "發生錯誤"
            }
        };
    }

    getEditor() {
        return this.editor;
    }
}

class PasswordEditor extends SimpleEditorManager {
    constructor(selectorId, config) {
        super(selectorId, {
            ...config,
            fields: [{
                name: 'maxDate',
                label: '密碼',
                type: 'text'
            }]
        });
    }
    // 實現獲取 GET URL 的方法
    getGetUrl(id) {
        if (!id) return this.config.getUrl;
        return this.config.getUrl.replace('_id_', id);
    }

    // 實現獲取 UPDATE URL 的方法
    getUpdateUrl(id) {
        if (!id) return this.config.updateUrl;
        return this.config.updateUrl.replace('_id_', id);
    }
}

// 使用範例
const initPasswordEditor = async (selectorId) => {
    const passwordEditor = await new PasswordEditor(selectorId, {
        getUrl: GBF.ctx + '/ajax/GroupBuyPreference/deliveryTimeSettings?groupBuyId=_id_',
        updateUrl: '/api/lessons/_id_/password'
    })
    .setActionCallback((action, id, event) => {
        // 根據不同的 action 執行對應操作
        switch (action) {
            case 'show-password-editor':
                passwordEditor.open(id);
                break;
            case 'reset-password':
                // 處理重置密碼
                break;
            case 'disable-password':
                // 處理禁用密碼
                break;
            // 可以處理更多 action...
            default:
                console.warn(`Unknown action: ${action}`);
        }
    })
    .init();

    return passwordEditor;
};
