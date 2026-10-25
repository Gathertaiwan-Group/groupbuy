/**
 * 配送日期設定（後台）
 *
 * 由 web/backend/deliveryTimeSettings_js.jsp 引入，共用於兩個頁面：
 *   - backend/GroupBuyPreference/deliveryTimeSettings.jsp（單一團購的設定，可覆寫系統預設值）
 *   - backend/SystemPreference/deliveryTimeSettings.jsp（系統預設值）
 *
 * 頁面必須在引入本檔案之前先設定好 window.DTS_PAGE：
 *   {
 *     showInheritedUi:   布林，是否顯示「繼承／覆寫系統預設值」相關的介面
 *     allowCustomDate:   布林，配送起訖能不能綁一個固定日期。
 *                        系統預設值會被所有團購套用，所以那一頁必須是 false。
 *     simulatedCampaign: 布林，團購起訖是不是使用者自己填的模擬值。
 *                        系統預設值沒有團購可依附，所以那一頁是 true；
 *                        單一團購頁讀真實的團購資料，欄位唯讀。
 *     urls:            { fetch, save, remove }
 *     fetchParams:     物件，讀取設定時附帶的參數
 *     removeParams:    物件，或吃 fromId 回傳物件的函式
 *   }
 *
 * 架構分層（由上而下，每一層只相依於排在它上面的層級）：
 *   DateUtils      純函式，日期與字串工具
 *   DeliveryRules  純函式，配送日期的領域規則（可配送範圍、排除判定、驗證）
 *   SettingsCodec  純函式，前端設定與後端資料格式的雙向轉換
 *   Template       純函式，產生畫面的 HTML 字串
 *   View           只讀取狀態、只寫入 DOM，不修改狀態
 *   Gateway        只負責與後端溝通，不碰 DOM、不顯示提示訊息
 *   Page           命令式外殼，持有狀態、串接流程、與使用者互動
 */
(function (window, $) {
	'use strict';

	// ==================== 常數 ====================

	var WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];
	var MONTH_LABELS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

	// 沒設定過的資料預設排除星期日；設定過之後完全依使用者的選擇
	var DEFAULT_EXCLUDED_WEEKDAYS = [0];

	var LIMITS = Object.freeze({
		PREP_DAYS_MIN: 0,
		PREP_DAYS_MAX: 60,
		MAX_DAYS_MIN: 1,
		MAX_DAYS_MAX: 60,
		// 錨點偏移只往後推，不接受負數
		OFFSET_MIN: 0,
		OFFSET_MAX: 60
	});

	// 配送起訖的來源。與後端 DeliveryTimeSettings.ANCHOR_* 必須一致。
	var ANCHOR_MODES = Object.freeze([
		{ val: 'NONE', label: '依天數規則' },
		{ val: 'GB_START', label: '團購開始日' },
		{ val: 'GB_END', label: '團購結束日' },
		{ val: 'CUSTOM', label: '自訂日期' }
	]);

	// 全新設定（後端還沒存過最晚配送天數）時採用的預設值
	var DEFAULT_MAX_DAYS = 7;

	// 系統預設值頁沒有真的團購，預覽用的模擬檔期長度
	var DEFAULT_SIMULATED_CAMPAIGN_DAYS = 14;

	var DAYS_PER_WEEK = 7;
	// 推算工作天時額外允許掃過的天數，用來跨過連續的排除日期
	var MAX_WORKING_DAY_SLACK = 366;

	var TYPE_COPY = Object.freeze({
		PREFERRED: '買家挑選<b>一個</b>最想要的配送日。',
		RESTRICTED: '買家標記<b>一段</b>沒辦法收貨的日期；沒標記的日子都視為可以配送。'
	});

	// ==================== DateUtils：純函式 ====================

	var DateUtils = {
		pad: function (n) {
			return n < 10 ? '0' + n : '' + n;
		},
		toIso: function (d) {
			return d.getFullYear() + '-' + DateUtils.pad(d.getMonth() + 1) + '-' + DateUtils.pad(d.getDate());
		},
		fromIso: function (s) {
			var p = s.split('-').map(Number);
			return new Date(p[0], p[1] - 1, p[2]);
		},
		addDays: function (d, n) {
			var r = new Date(d);
			r.setDate(r.getDate() + n);
			return r;
		},
		clamp: function (n, lo, hi) {
			return Math.min(Math.max(n, lo), hi);
		},
		/** 兩個日期相差幾個日曆天（b - a） */
		daysBetween: function (a, b) {
			return Math.round((DateUtils.startOfDay(b) - DateUtils.startOfDay(a)) / 86400000);
		},
		startOfDay: function (d) {
			var r = new Date(d);
			r.setHours(0, 0, 0, 0);
			return r;
		},
		formatShort: function (d) {
			return (d.getMonth() + 1) + '/' + d.getDate();
		},
		escapeHtml: function (s) {
			return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
				return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
			});
		}
	};

	// ==================== DeliveryRules：純函式（領域規則）====================
	//
	// 這一層完全不碰 DOM、不讀取任何外部可變變數：所有輸入都經由參數傳入，
	// 因此可以獨立閱讀、獨立驗證，也不會因為 state 被整個抽換而拿到過期的資料。

	var DeliveryRules = {
		/**
		 * 錨點偏移：只往後推，並且與備貨天數算同一種「工作天」。
		 * 一個畫面裡出現兩種天的定義只會讓人算錯，所以三個天數欄位共用 addWorkingDays。
		 */
		effectiveOffset: function (offset) {
			if (offset == null || isNaN(offset)) {
				return 0;
			}
			return DateUtils.clamp(offset, LIMITS.OFFSET_MIN, LIMITS.OFFSET_MAX);
		},

		/** 該端錨點的基準日（ISO 字串），無法取得時回傳 null */
		anchorBase: function (mode, campaign) {
			campaign = campaign || {};
			if (mode === 'GB_START') {
				return campaign.start || null;
			}
			if (mode === 'GB_END') {
				return campaign.end || null;
			}
			return null;
		},

		/**
		 * 把一端的錨點換算成實際日期，回傳 { iso, skipped }。
		 * 偏移 0 就是基準日當天，即使那天公休也不會被挪走 —— 它只是區間邊界，
		 * 那天照樣會被排除規則蓋掉。
		 * 無法換算（沒有團購可依附）時 iso 為 null，等同這一端不設限，
		 * 與後端 resolveAnchorDate 的處理一致。
		 */
		resolveAnchor: function (settings, which, campaign) {
			var mode = which === 'start' ? settings.startMode : settings.endMode;
			if (mode === 'CUSTOM') {
				return { iso: (which === 'start' ? settings.startDate : settings.endDate) || null, skipped: 0 };
			}
			var base = DeliveryRules.anchorBase(mode, campaign);
			if (!base) {
				return { iso: null, skipped: 0 };
			}
			var offset = DeliveryRules.effectiveOffset(which === 'start' ? settings.startOffset : settings.endOffset);
			var from = DateUtils.fromIso(base);
			var to = DeliveryRules.addWorkingDays(from, offset, settings);
			return { iso: DateUtils.toIso(to), skipped: DateUtils.daysBetween(from, to) - offset };
		},

		/**
		 * 依設定計算可配送的日期範圍，回傳 { minDate, maxDate, clampedByStart, clampedByEnd, empty }。
		 *
		 * 天數規則與配送起訖是「同時生效、取交集」，不是二選一：
		 *   minDate = max(今天 + 備貨天數, 開始配送日)
		 *   maxDate = min(minDate + 最晚配送天數, 結束配送日)
		 * 兩端都可以是「依天數規則」表示不限制；最晚配送天數留空時，上界完全由結束配送日決定。
		 * 這份計算與後端 DeliveryTimeSettings.resolveMinDate/resolveMaxDate 必須維持一致。
		 */
		computeRange: function (settings, today, campaign) {
			var startIso = DeliveryRules.resolveAnchor(settings, 'start', campaign).iso;
			var endIso = DeliveryRules.resolveAnchor(settings, 'end', campaign).iso;

			var minDate = DeliveryRules.addWorkingDays(today, DeliveryRules.effectivePrepDays(settings), settings);
			var clampedByStart = false;
			if (startIso) {
				var start = DateUtils.fromIso(startIso);
				if (start > minDate) {
					minDate = start;
					clampedByStart = true;
				}
			}

			var maxDays = DeliveryRules.effectiveMaxDays(settings);
			var maxDate = maxDays === null ? null : DeliveryRules.addWorkingDays(minDate, maxDays, settings);
			var clampedByEnd = false;
			if (endIso) {
				var end = DateUtils.fromIso(endIso);
				if (maxDate === null || end < maxDate) {
					maxDate = end;
					clampedByEnd = maxDays !== null;
				}
			}
			if (maxDate === null) {
				// 天數與結束日期都沒填：這個狀態會被 validate 擋下無法儲存，
				// 但預覽仍需要一個範圍才能繪製日曆。
				maxDate = DateUtils.addDays(minDate, LIMITS.MAX_DAYS_MIN);
			}

			return {
				minDate: minDate,
				maxDate: maxDate,
				clampedByStart: clampedByStart,
				clampedByEnd: clampedByEnd,
				empty: maxDate < minDate
			};
		},

		/**
		 * 從 from 往後推 days 個「工作天」。
		 * 排除的星期與排除的特定日期都不算，會被直接跨過。
		 * 必須與後端 DeliveryTimeSettings.addWorkingDays 一致。
		 *
		 * 備貨天數與最晚配送天數都走這裡，兩個欄位對「一天」的定義才會一致。
		 * 每個星期都被排除時退回單純的日曆天 —— 那種設定沒有工作天可數，會數不完。
		 */
		addWorkingDays: function (from, days, settings) {
			if (days <= 0) {
				return from;
			}
			if (DeliveryRules.excludedWeekdaySet(settings).size >= DAYS_PER_WEEK) {
				return DateUtils.addDays(from, days);
			}

			// 至少有一個星期可用，所以一定數得完；多留一年只是為了跨過連續的排除日期
			var limit = DateUtils.addDays(from, days * DAYS_PER_WEEK + MAX_WORKING_DAY_SLACK);
			var date = from;
			var remaining = days;
			while (remaining > 0 && date < limit) {
				date = DateUtils.addDays(date, 1);
				if (!DeliveryRules.isExcluded(date, settings)) {
					remaining--;
				}
			}
			return date;
		},

		/** 該日是否被排除的星期或排除的特定日期蓋掉（不看可配送範圍） */
		isExcluded: function (date, settings) {
			return DeliveryRules.excludedWeekdaySet(settings).has(date.getDay())
				|| settings.excludedDates.has(DateUtils.toIso(date));
		},

		/** 備貨天數：留空或不合法時一律當作 0，與後端 getPreparationDays(0) 一致 */
		effectivePrepDays: function (settings) {
			if (settings.prepDays == null || isNaN(settings.prepDays)) {
				return 0;
			}
			return DateUtils.clamp(settings.prepDays, LIMITS.PREP_DAYS_MIN, LIMITS.PREP_DAYS_MAX);
		},

		/** 最晚配送天數：留空回傳 null，代表沒有天數上界（由結束配送日期決定） */
		effectiveMaxDays: function (settings) {
			if (settings.maxDays == null || isNaN(settings.maxDays)) {
				return null;
			}
			return DateUtils.clamp(settings.maxDays, LIMITS.MAX_DAYS_MIN, LIMITS.MAX_DAYS_MAX);
		},

		/** 被排除的星期集合 */
		excludedWeekdaySet: function (settings) {
			return new Set(settings.excludedWeekdays);
		},

		/** 判斷某一天的狀態，回傳 { outOfRange, byWeekday, byDate, available } */
		classifyDay: function (date, settings, range) {
			var outOfRange = date < range.minDate || date > range.maxDate;
			var byWeekday = DeliveryRules.excludedWeekdaySet(settings).has(date.getDay());
			var byDate = settings.excludedDates.has(DateUtils.toIso(date));
			return {
				outOfRange: outOfRange,
				byWeekday: byWeekday,
				byDate: byDate,
				available: !outOfRange && !byWeekday && !byDate
			};
		},

		/** 走訪範圍內的每一天 */
		eachDayInRange: function (range, fn) {
			for (var d = new Date(range.minDate); d <= range.maxDate; d = DateUtils.addDays(d, 1)) {
				fn(d);
			}
		},

		/** 範圍內可配送的天數 */
		countAvailableDays: function (settings, range) {
			var n = 0;
			DeliveryRules.eachDayInRange(range, function (d) {
				if (DeliveryRules.classifyDay(d, settings, range).available) {
					n++;
				}
			});
			return n;
		},

		/** 範圍內不可配送的日期清單（ISO 字串） */
		listUnavailableDays: function (settings, range) {
			var result = [];
			DeliveryRules.eachDayInRange(range, function (d) {
				if (!DeliveryRules.classifyDay(d, settings, range).available) {
					result.push(DateUtils.toIso(d));
				}
			});
			return result;
		},

		/**
		 * 驗證天數與日期欄位。
		 * 畫面上的紅字錯誤提示與儲存前的把關共用這一份規則，避免兩處各寫一份而失去同步。
		 *
		 * range 由 computeRange 算出，用來判斷交集是否為空；省略時不檢查這一項。
		 */
		validate: function (settings, range, campaign) {
			// 備貨天數留空等同 0，是合法的
			var prepDays = settings.prepDays == null || (
				!isNaN(settings.prepDays)
				&& settings.prepDays >= LIMITS.PREP_DAYS_MIN
				&& settings.prepDays <= LIMITS.PREP_DAYS_MAX
			);
			// 最晚配送天數留空代表不限天數，必須有結束配送日接手當上界
			var maxDays = settings.maxDays == null
				? settings.endMode !== 'NONE'
				: (
					!isNaN(settings.maxDays)
					&& settings.maxDays >= LIMITS.MAX_DAYS_MIN
					&& settings.maxDays <= LIMITS.MAX_DAYS_MAX
				);

			var offsets = DeliveryRules.offsetsValid(settings);

			// 順序要比對換算後的日期，不是原始欄位 —— 錨點模式下原始欄位根本是空的
			var startIso = DeliveryRules.resolveAnchor(settings, 'start', campaign).iso;
			var endIso = DeliveryRules.resolveAnchor(settings, 'end', campaign).iso;
			var dateOrder = !(startIso && endIso)
				|| DateUtils.fromIso(startIso) <= DateUtils.fromIso(endIso);

			// 綁了團購起訖卻拿不到那個日期：後端會退回「不設限」，先講清楚再讓他存
			var unresolved = DeliveryRules.unresolvedAnchor(settings, campaign);

			// 區間非空還不夠：整段有可能被排除星期／排除日期吃光，那樣買家一樣選不到任何一天
			var hasAvailableDay = !range
				|| (!range.empty && DeliveryRules.countAvailableDays(settings, range) > 0);

			return {
				prepDays: prepDays,
				maxDays: maxDays,
				offsets: offsets,
				dateOrder: dateOrder,
				unresolved: unresolved,
				hasAvailableDay: hasAvailableDay,
				isValid: prepDays && maxDays && offsets && dateOrder && !unresolved && hasAvailableDay
			};
		},

		/** 兩端的偏移都必須是 0～60 的整數；錨點模式以外的那一端不檢查 */
		offsetsValid: function (settings) {
			return ['start', 'end'].every(function (which) {
				var mode = which === 'start' ? settings.startMode : settings.endMode;
				if (mode !== 'GB_START' && mode !== 'GB_END') {
					return true;
				}
				var offset = which === 'start' ? settings.startOffset : settings.endOffset;
				return offset != null
					&& !isNaN(offset)
					&& offset >= LIMITS.OFFSET_MIN
					&& offset <= LIMITS.OFFSET_MAX;
			});
		},

		/** 綁了團購起訖但基準日拿不到的那一端，回傳 'start' / 'end' / null */
		unresolvedAnchor: function (settings, campaign) {
			var found = null;
			['start', 'end'].forEach(function (which) {
				var mode = which === 'start' ? settings.startMode : settings.endMode;
				var isAnchored = mode === 'GB_START' || mode === 'GB_END';
				if (!found && isAnchored && !DeliveryRules.anchorBase(mode, campaign)) {
					found = which;
				}
			});
			return found;
		}
	};

	// ==================== SettingsCodec：純函式（資料轉換）====================

	var SettingsCodec = {
		/**
		 * 後端資料 → 前端狀態。
		 * 回傳 { settings, meta }：settings 是會被儲存的設定值，meta 是輔助資訊。
		 */
		decode: function (data) {
			data = data || {};

			// 後端只丟掉 null，空陣列會保留下來，所以這兩種情況分得開：
			// 沒有這個欄位＝從未設定，套預設值；空陣列＝使用者刻意不排除任何星期。
			var excludedWeekdays = new Set(
				data.excludedWeekdays == null
					? DEFAULT_EXCLUDED_WEEKDAYS
					: data.excludedWeekdays.map(Number).filter(function (n) { return n >= 0 && n <= 6; })
			);
			var excludedDates = new Set(
				(data.excludedDates || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean)
			);

			// 舊資料可能是用「指定固定的開始／結束日期」模式存的，當時的後台介面聲稱天數不會生效。
			// 實際上後端一直都是取交集，所以買家看到的範圍不變，只是後台終於如實顯示。
			var legacyDateMode = data.minDeliveryTimeType === 'DATE' && !!(data.startDate || data.endDate);

			// 錨點是後來才加的欄位。舊資料沒有 mode：存了日期就是「自訂日期」，
			// 空的就是「依天數規則」，讀回來的行為與過去完全相同，不需要資料遷移。
			// 這份判定與後端 DeliveryTimeSettings.effectiveMode 必須一致。
			var startMode = data.startDateMode || (data.startDate ? 'CUSTOM' : 'NONE');
			var endMode = data.endDateMode || (data.endDate ? 'CUSTOM' : 'NONE');

			return {
				settings: {
					enabled: data.enabled !== false,
					type: data.deliveryTimeSettingType === 'PREFERRED' ? 'PREFERRED' : 'RESTRICTED',
					prepDays: data.preparationDays != null ? data.preparationDays : 0,
					// 沒存過天數時：結束配送日有指定就讓它當唯一的上界，否則給一個預設值，
					// 免得全新的設定一開啟就處於「沒有上界」的錯誤狀態。
					maxDays: data.minDeliveryDays != null
						? data.minDeliveryDays
						: (endMode !== 'NONE' ? null : DEFAULT_MAX_DAYS),
					startMode: startMode,
					startOffset: data.startDateOffset != null ? data.startDateOffset : 0,
					endMode: endMode,
					endOffset: data.endDateOffset != null ? data.endDateOffset : 0,
					startDate: data.startDate || '',
					endDate: data.endDate || '',
					// 本畫面不提供「固定的最晚配送日」欄位，但儲存時不該把舊資料清掉，因此原樣帶回。
					legacyMinDeliveryDate: data.minDeliveryDate || '',
					excludedWeekdays: excludedWeekdays,
					excludedDates: excludedDates,
					mandatory: !!data.mandatory
				},
				meta: {
					fromId: data.fromId || null,
					legacyDateMode: legacyDateMode,
					// 後端注入的團購起訖，只用來換算與顯示，不會被儲存
					campaign: {
						start: data.campaignStartDate || '',
						end: data.campaignEndDate || ''
					}
				}
			};
		},

		/** 前端狀態 → 後端資料 */
		encode: function (settings) {
			var record = {
				enabled: settings.enabled,
				deliveryTimeSettingType: settings.type,
				// DATE 在後端的意思是「用 minDeliveryDate 當最晚配送日」，只有舊資料會走這條路。
				minDeliveryTimeType: settings.legacyMinDeliveryDate ? 'DATE' : 'DAYS',
				preparationDays: settings.prepDays == null ? '' : settings.prepDays,
				// 空字串會讓後端把欄位設成 null，也就是「不限天數」
				minDeliveryDays: settings.maxDays == null ? '' : settings.maxDays,
				startDateMode: settings.startMode,
				startDateOffset: settings.startOffset == null ? '' : settings.startOffset,
				endDateMode: settings.endMode,
				endDateOffset: settings.endOffset == null ? '' : settings.endOffset,
				// 只有 CUSTOM 會用到，但保留使用者上次填的值，切回自訂時才不會不見
				startDate: settings.startDate || '',
				endDate: settings.endDate || '',
				excludedDates: Array.from(settings.excludedDates).sort().join(','),
				mandatory: settings.mandatory
			};

			var weekdays = Array.from(settings.excludedWeekdays);
			if (weekdays.length > 0) {
				record.excludedWeekdays = weekdays;
			} else {
				record['excludedWeekdays-many-count'] = 0;
			}

			var wrapped = {};
			wrapped[0] = record;
			return { data: wrapped };
		}
	};

	// ==================== Template：純函式 ====================

	var Template = {
		// Renders a circle-question icon whose tooltip carries the detailed copy.
		// It is a <button> on purpose: touch devices have no hover, so the tooltip
		// has to be reachable through focus as well.
		hint: function (text) {
			return '<button type="button" class="dts-hint" data-toggle="tooltip" data-html="true"'
				+ ' data-trigger="hover focus" data-placement="top" title="' + text + '">'
				+ '<i class="fa-regular fa-circle-question"></i></button>';
		},

		/**
		 * 一端配送起訖的骨架。換算結果與 body 同列，因為它就是這一列輸入算出來的；
		 * 但它是 body 的兄弟節點而非子節點，才不會被 mountAnchorBody 的重建洗掉。
		 * seg 與 body 的內容由 View 依目前狀態填入：
		 * body 的形狀會隨模式改變，但只有模式真的變了才重建，
		 * 否則每打一個字就重建一次，正在輸入的欄位會失焦。
		 */
		anchorRow: function (which, title) {
			return ''
			+ '<div class="dts-anchor">'
			+ '  <div class="dts-anchor-head">'
			+ '    <span class="dts-anchor-title">' + title + '</span>'
			+ '  </div>'
			+ '  <div class="dts-seg" data-role="seg" data-which="' + which + '"></div>'
			+ '  <div class="dts-anchor-calc">'
			+ '    <div class="dts-anchor-body" data-role="body" data-which="' + which + '"></div>'
			+ '    <span class="dts-anchor-result" data-role="result" data-which="' + which + '"></span>'
			+ '  </div>'
			+ '</div>';
		},

		render: function () {
			return ''
			+ '<div class="dts-banner" id="dtsMigrationBanner" style="display:none;"></div>'
			+ '<div class="dts-inherited-banner" id="dtsInheritedBanner" style="display:none;">'
			+ '  <i class="fa-light fa-link"></i>'
			+ '  <span>目前套用<b>系統預設值</b>，此團購尚未個別設定過。編輯下方任何欄位即會轉為此團購的自訂設定。</span>'
			+ '</div>'
			+ '<div class="row g-4">'
			+ '  <div class="col-lg-7">'
			+ '    <div class="dts-section">'
			+ '      <div class="d-flex align-items-center justify-content-between">'
			+ '        <div>'
			+ '          <label class="dts-section-title mb-0" for="dtsEnabled">啟用配送日期選擇</label>'
			+ Template.hint('停用後，買家結帳頁不會顯示配送日期欄位。')
			+ '        </div>'
			+ '        <label class="dts-switch"><input type="checkbox" id="dtsEnabled"><span class="track"></span><span class="thumb"></span></label>'
			+ '      </div>'
			+ '    </div>'
			+ '    <fieldset id="dtsFieldset">'
			+ '      <div class="dts-section">'
			+ '        <div class="d-flex align-items-center justify-content-between">'
			+ '          <div>'
			+ '            <label class="dts-section-title mb-0" for="dtsMandatory">結帳必填</label>'
			+ Template.hint('開啟後，買家沒有選擇配送日期就無法送出訂單。')
			+ '          </div>'
			+ '          <label class="dts-switch"><input type="checkbox" id="dtsMandatory"><span class="track"></span><span class="thumb"></span></label>'
			+ '        </div>'
			+ '      </div>'
			+ '      <div class="dts-section">'
			+ '        <div class="dts-section-title">買家怎麼選日期</div>'
			+ '        <div class="dts-seg" id="dtsTypeSeg">'
			+ '          <button type="button" data-val="PREFERRED">期望配送日期</button>'
			+ '          <button type="button" data-val="RESTRICTED">不期望配送日期</button>'
			+ '        </div>'
			+ '        <div class="dts-callout info" id="dtsTypeExplain"></div>'
			+ '      </div>'
			+ '      <div class="dts-section">'
			+ '        <div class="dts-section-title">可配送日期範圍</div>'
			+ '        <div class="dts-section-help">天數規則與起訖日同時生效，最後取交集。'
			+ '          這裡的天數一律算工作天（排除的星期／日期會跳過）。'
			+ '          「最快可出貨」與起訖「＋N」填 <b>0</b>＝基準日當天，不會因公休往後挪；'
			+ '          「最晚配送天數」最少為 1，留空＝不限。</div>'
			+ '        <div id="dtsDaysFields">'
			+ '          <div class="dts-field-grid">'
			+ '            <div class="dts-field">'
			+ '              <label for="dtsPrepDays">最快可出貨（工作天）'
			+ Template.hint('下單後的<b>第 N 個工作天當天</b>就能出貨，下單當天不計入：0 = 當天出貨，1 = 隔天。'
				+ '這一天仍算在備貨期間內，若要備完整整 N 天再出貨，請填 N+1。') + '</label>'
			+ '              <input type="number" class="form-control form-control-sm" id="dtsPrepDays" min="0" max="60">'
			+ '              <div class="err" id="dtsPrepDaysErr">請輸入 0～60 之間的整數</div>'
			+ '            </div>'
			+ '            <div class="dts-field">'
			+ '              <label for="dtsMaxDays">最晚配送天數（工作天）</label>'
			+ '              <input type="number" class="form-control form-control-sm" id="dtsMaxDays" min="1" max="60" placeholder="留空＝不限">'
			+ '              <div class="err" id="dtsMaxDaysErr">請輸入 1～60 之間的整數，或留空並指定結束配送日期</div>'
			+ '            </div>'
			+ '          </div>'
			+ '        </div>'
			+ '        <div id="dtsDateFields">'
			+          Template.anchorRow('start', '開始配送日')
			+          Template.anchorRow('end', '結束配送日')
			+ '          <div class="err" id="dtsDateOrderErr">結束配送日不能早於開始配送日</div>'
			+ '        </div>'
			+ '        <div class="dts-callout calc" id="dtsDaysCalc"></div>'
			+ '        <div class="dts-callout warn" id="dtsRangeWarn" style="display:none;"></div>'
			+ '      </div>'
			+ '      <div class="dts-section">'
			+ '        <div class="dts-section-title">排除的星期</div>'
			+ '        <div class="dts-wd-row" id="dtsWeekdayRow"></div>'
			+ '      </div>'
			+ '      <div class="dts-section">'
			+ '        <div class="dts-section-title">排除的特定日期'
			+ Template.hint('用來處理臨時公休、國定假日或物流異常。若剛好落在已排除的星期，會直接被星期規則涵蓋。') + '</div>'
			+ '        <input type="date" class="form-control" id="dtsExcludeDateInput"'
			+ '          aria-label="排除的特定日期" style="max-width:200px;">'
			+ '        <div class="dts-tag-row" id="dtsExcludedDatesRow"></div>'
			+ '        <div class="dts-overlap-note" id="dtsOverlapNote"><span>⚠️</span><span></span></div>'
			+ '      </div>'
			+ '    </fieldset>'
			+ '  </div>'
			+ '  <div class="col-lg-5">'
			+ '    <div class="dts-preview-card">'
			+ '      <div class="fw-bold mb-3">即時預覽'
			+ Template.hint('依目前表單即時換算，未儲存也會更新。') + '</div>'
			+ '      <div class="dts-cal-card">'
			+ '        <div class="dts-cal-nav">'
			+ '          <button type="button" id="dtsCalPrev">‹</button>'
			+ '          <span class="month-label" id="dtsCalMonthLabel"></span>'
			+ '          <button type="button" id="dtsCalNext">›</button>'
			+ '        </div>'
			+ '        <div class="dts-cal-grid" id="dtsCalGrid"></div>'
			+ '      </div>'
			+ '      <div class="dts-legend">'
			+ '        <span class="dts-legend-item"><span class="dts-legend-swatch" style="background:#e6f6ee;border:1px solid #198754;"></span>可配送</span>'
			+ '        <span class="dts-legend-item"><span class="dts-legend-swatch" style="background:repeating-linear-gradient(135deg,#f8f9fa,#f8f9fa 2px,#eceef1 2px,#eceef1 3px);"></span>排除星期</span>'
			+ '        <span class="dts-legend-item"><span class="dts-legend-swatch" style="background:#fdeee7;border:1px solid #dc3545;"></span>手動排除</span>'
			+ '        <span class="dts-legend-item"><span class="dts-legend-swatch" style="border:1.5px solid var(--bs-primary,#0d6efd);"></span>今天</span>'
			+ '      </div>'
			+ '      <div class="dts-summary">'
			+ '        <div><div class="lbl">可配送區間</div><div id="dtsSummaryRange" style="font-size:.85rem; font-weight:700;"></div></div>'
			+ '        <div style="text-align:right;"><div class="n" id="dtsSummaryDays">—</div><div class="lbl">可選天數</div></div>'
			+ '      </div>'
			+ '      <div class="dts-buyer">'
			+ '        <div class="eyebrow" id="dtsBuyerEyebrow">預覽條件</div>'
			+ '        <div class="dts-buyer-field"><span>模擬今天</span><input type="date" class="form-control form-control-sm" id="dtsSimNow"></div>'
			+ '        <div class="dts-buyer-field"><span>團購開始日</span><input type="date" class="form-control form-control-sm" id="dtsSimGbStart"></div>'
			+ '        <div class="dts-buyer-field"><span>團購結束日</span><input type="date" class="form-control form-control-sm" id="dtsSimGbEnd"></div>'
			+ '        <div class="dts-buyer-hint" id="dtsCampaignHint"></div>'
			+ '      </div>'
			+ '    </div>'
			+ '  </div>'
			+ '</div>'
			+ '<div class="dts-footer">'
			+ '  <button type="button" class="btn btn-outline-secondary" id="dtsRevertBtn">還原為系統預設值</button>'
			+ '  <button type="button" class="btn btn-primary" id="dtsSaveBtn">儲存設定</button>'
			+ '</div>';
		}
	};

	// ==================== View：只讀狀態、只寫 DOM ====================
	//
	// 這一層絕不修改狀態。使用者的操作一律透過 handlers 往上通知 Page，
	// 由 Page 修改狀態後再呼叫 render() 重繪。
	//
	// handlers：
	//   changeSettings(mutator)  修改會被儲存的設定 → 標記為已自訂並重繪
	//   changeUi(mutator)        只修改畫面暫存狀態 → 僅重繪
	//   save()                   按下儲存
	//   revert()                 按下還原為系統預設值
	//   previewNow(nowIso)       改「模擬今天」後重繪上方日曆

	var ELEMENT_IDS = [
		'dtsEnabled', 'dtsFieldset', 'dtsTypeSeg', 'dtsTypeExplain', 'dtsDaysFields', 'dtsDateFields',
		'dtsPrepDays', 'dtsMaxDays', 'dtsPrepDaysErr', 'dtsMaxDaysErr', 'dtsDateOrderErr', 'dtsDaysCalc', 'dtsRangeWarn',
		'dtsSimGbStart', 'dtsSimGbEnd', 'dtsCampaignHint',
		'dtsWeekdayRow', 'dtsExcludeDateInput', 'dtsExcludedDatesRow', 'dtsOverlapNote',
		'dtsMandatory', 'dtsCalPrev', 'dtsCalNext', 'dtsCalMonthLabel', 'dtsCalGrid', 'dtsSummaryRange', 'dtsSummaryDays',
		'dtsBuyerEyebrow', 'dtsSimNow', 'dtsRevertBtn', 'dtsSaveBtn',
		'dtsInheritedBanner', 'dtsMigrationBanner'
	];

	function createView(options) {
		var showInheritedUi = options.showInheritedUi;
		var allowCustomDate = options.allowCustomDate;
		var simulatedCampaign = options.simulatedCampaign;
		var today = options.today;
		var handlers = options.handlers;
		var el = {};
		// 第二排的形狀只跟模式有關，記住上次畫的是哪個模式就不必每次重建
		var anchorRendered = { start: null, end: null };

		// 狀態標記位於 #dtsRoot 之外（父頁面的 card-header 內），不會被 $root.html() 重繪清掉，
		// 因此在這裡快取一次即可。
		var statusChip = document.getElementById('dtsStatusChip');

		// -------- 共用小工具 --------

		function setSegActive(container, val) {
			Array.from(container.querySelectorAll('button')).forEach(function (b) {
				b.classList.toggle('active', b.getAttribute('data-val') === val);
			});
		}

		function bindSeg(container, onSelect) {
			Array.from(container.querySelectorAll('button')).forEach(function (b) {
				b.addEventListener('click', function () { onSelect(b.getAttribute('data-val')); });
			});
		}

		/** 讀取選填的數字欄位：留空回傳 null（代表未設定），而不是 NaN */
		function parseOptionalInt(value) {
			return String(value).trim() === '' ? null : parseInt(value, 10);
		}

		// -------- 各區塊的渲染 --------

		function renderStatus(state) {
			var hasSavedOverride = !!state.meta.fromId && state.meta.fromId !== 'PENDING';
			var isPending = state.meta.fromId === 'PENDING';

			if (!showInheritedUi) {
				if (el.dtsRevertBtn) {
					el.dtsRevertBtn.style.display = 'none';
				}
				if (hasSavedOverride || isPending) {
					statusChip.className = 'dts-status-chip custom';
					statusChip.innerHTML = '<span class="dot"></span>' + (isPending ? '尚未儲存的變更' : '已儲存');
				} else {
					statusChip.className = 'dts-status-chip inherited';
					statusChip.innerHTML = '<span class="dot"></span>系統預設設定';
				}
				return;
			}

			if (hasSavedOverride || isPending) {
				statusChip.className = 'dts-status-chip custom';
				statusChip.innerHTML = '<span class="dot"></span>' + (isPending ? '尚未儲存的變更' : '已自訂覆寫');
				el.dtsInheritedBanner.style.display = 'none';
			} else {
				statusChip.className = 'dts-status-chip inherited';
				statusChip.innerHTML = '<span class="dot"></span>套用系統預設值';
				el.dtsInheritedBanner.style.display = 'flex';
			}
			el.dtsRevertBtn.disabled = !hasSavedOverride;
			el.dtsRevertBtn.textContent = hasSavedOverride ? '還原為系統預設值' : '已是系統預設值';
		}

		function renderMigrationBanner(meta) {
			if (meta.downgradedCustom) {
				el.dtsMigrationBanner.innerHTML = '<i class="fa-light fa-triangle-exclamation"></i><span>'
					+ '這筆系統預設值原本把配送起訖綁在<b>固定日期</b>上。'
					+ '系統預設值會套用到所有團購，綁固定日期對其他團購都是錯的，'
					+ '所以已改成<b>依天數規則</b>顯示；儲存後才會真正生效。</span>';
				el.dtsMigrationBanner.style.display = 'flex';
				return;
			}
			if (!meta.legacyDateMode) {
				el.dtsMigrationBanner.style.display = 'none';
				return;
			}
			var migratedMsg = '這筆設定原本是用「指定固定的開始／結束日期」模式儲存的。舊介面聲稱該模式下天數不會生效，'
				+ '但結帳頁一直都是把天數與日期取交集後計算，下方顯示的才是買家真正看到的範圍。'
				+ '若不希望天數限制配送區間，請把「最晚配送天數（工作天）」清空。';
			el.dtsMigrationBanner.innerHTML = '<i class="fa-light fa-triangle-exclamation"></i><span>' + migratedMsg + '</span>';
			el.dtsMigrationBanner.style.display = 'flex';
		}

		function renderTypeExplain(settings) {
			setSegActive(el.dtsTypeSeg, settings.type);
			var icon = settings.type === 'PREFERRED' ? 'fa-calendar-check' : 'fa-calendar-xmark';
			el.dtsTypeExplain.innerHTML = '<i class="fa-light ' + icon + '"></i><span>' + TYPE_COPY[settings.type] + '</span>';
		}

		/** 正在輸入的欄位不要回寫，否則游標會跳掉 */
		function setValueUnlessFocused(input, value) {
			if (document.activeElement !== input) {
				input.value = value;
			}
		}

		function renderRangeFields(settings, asOf, range, campaign, validation) {
			setValueUnlessFocused(el.dtsPrepDays, settings.prepDays == null ? '' : settings.prepDays);
			setValueUnlessFocused(el.dtsMaxDays, settings.maxDays == null ? '' : settings.maxDays);

			el.dtsPrepDaysErr.style.display = validation.prepDays ? 'none' : 'block';
			el.dtsMaxDaysErr.style.display = validation.maxDays ? 'none' : 'block';
			el.dtsDateOrderErr.style.display = validation.dateOrder ? 'none' : 'block';

			renderAnchorRow('start', settings, campaign);
			renderAnchorRow('end', settings, campaign);
			renderRangeCalc(settings, asOf, range, campaign, validation);
		}

		function anchorPart(which, role) {
			return document.querySelector('[data-role="' + role + '"][data-which="' + which + '"]');
		}

		function anchorModeOf(settings, which) {
			return which === 'start' ? settings.startMode : settings.endMode;
		}

		/**
		 * 模式選擇器。系統預設值層級不能綁固定日期，那顆按鈕就整個不出現：它在這個層級
		 * 永遠不可能變成可用，留一顆反灰的只會讓人一直來問為什麼按不下去。舊資料若存的是
		 * 自訂日期，載入時已經被 downgradeCustomAnchors() 降級並掛提示了。
		 */
		function anchorSegHtml(settings, which) {
			var mode = anchorModeOf(settings, which);
			return ANCHOR_MODES
				.filter(function (m) {
					return m.val !== 'CUSTOM' || allowCustomDate;
				})
				.map(function (m) {
					return '<button type="button" class="' + (m.val === mode ? 'active' : '') + '"'
						+ ' data-val="' + m.val + '">' + m.label + '</button>';
				})
				.join('');
		}

		/**
		 * Both anchor rows render the same fields, so the id has to carry the row it
		 * belongs to. The id itself is what the browser's autofill heuristics ask for.
		 */
		function anchorFieldId(role, which) {
			return 'dtsAnchor' + role.charAt(0).toUpperCase() + role.slice(1)
				+ (which === 'start' ? 'Start' : 'End');
		}

		/**
		 * The text around these fields is plain markup, not a label, so a screen reader
		 * would announce the field with no name at all. Spell the name out instead.
		 */
		function anchorFieldLabel(role, which) {
			var row = which === 'start' ? '開始配送日' : '結束配送日';
			return role === 'offset' ? row + '間隔工作天數' : row + '（自訂日期）';
		}

		function anchorBodyHtml(settings, which) {
			var mode = anchorModeOf(settings, which);

			if (mode === 'NONE') {
				return '<span class="dts-anchor-note">這一端不另外設限 — '
					+ (which === 'start'
						? '起始日完全由「最快可出貨（工作天）」決定。'
						: '最後一天完全由「最晚配送天數（工作天）」決定。')
					+ '</span>';
			}
			if (mode === 'CUSTOM') {
				var custom = (which === 'start' ? settings.startDate : settings.endDate) || '';
				return '<input type="date" class="form-control form-control-sm" data-role="custom"'
					+ ' id="' + anchorFieldId('custom', which) + '"'
					+ ' aria-label="' + anchorFieldLabel('custom', which) + '"'
					+ ' value="' + custom + '">';
			}
			var offset = which === 'start' ? settings.startOffset : settings.endOffset;
			return '<span class="dts-anchor-base" data-role="base"></span>'
				+ '<span>＋</span>'
				+ '<input type="number" class="form-control form-control-sm" data-role="offset"'
				+ ' id="' + anchorFieldId('offset', which) + '"'
				+ ' aria-label="' + anchorFieldLabel('offset', which) + '"'
				+ ' min="' + LIMITS.OFFSET_MIN + '" max="' + LIMITS.OFFSET_MAX + '" step="1"'
				+ ' value="' + (offset == null ? '' : offset) + '">'
				+ '<span class="dts-anchor-note">工作天</span>';
		}

		function mountAnchorBody(settings, which) {
			var body = anchorPart(which, 'body');
			body.innerHTML = anchorBodyHtml(settings, which);

			var offset = body.querySelector('[data-role="offset"]');
			if (offset) {
				offset.addEventListener('input', function () {
					var value = parseOptionalInt(offset.value);
					handlers.changeSettings(function (s) {
						if (which === 'start') {
							s.startOffset = value;
						} else {
							s.endOffset = value;
						}
					});
				});
			}

			var custom = body.querySelector('[data-role="custom"]');
			if (custom) {
				custom.addEventListener('change', function () {
					handlers.changeSettings(function (s) {
						if (which === 'start') {
							s.startDate = custom.value;
						} else {
							s.endDate = custom.value;
						}
					});
				});
			}
		}

		function renderAnchorRow(which, settings, campaign) {
			var mode = anchorModeOf(settings, which);
			var seg = anchorPart(which, 'seg');

			// 選擇器的組成只受層級影響，層級在一次頁面生命週期內不會變，所以建一次就夠
			if (!seg.getAttribute('data-built')) {
				seg.innerHTML = anchorSegHtml(settings, which);
				seg.setAttribute('data-built', '1');
				Array.from(seg.querySelectorAll('button[data-val]')).forEach(function (b) {
					b.addEventListener('click', function () {
						var val = b.getAttribute('data-val');
						handlers.changeSettings(function (s) {
							if (which === 'start') {
								s.startMode = val;
							} else {
								s.endMode = val;
							}
						});
					});
				});
			}
			setSegActive(seg, mode);

			if (anchorRendered[which] !== mode) {
				mountAnchorBody(settings, which);
				anchorRendered[which] = mode;
			}

			var anchoredToCampaign = mode === 'GB_START' || mode === 'GB_END';
			// 系統預設值沒有綁定的團購，畫面上的團購起訖只是模擬值。把它寫成具體日期
			// 會被讀成「設定值」，但這裡存的其實是一條規則，日期要等每個團購才算得出來。
			var ruleOnly = simulatedCampaign && anchoredToCampaign;

			var base = anchorPart(which, 'body').querySelector('[data-role="base"]');
			if (base) {
				var baseLabel = mode === 'GB_START' ? '團購開始日' : '團購結束日';
				base.textContent = ruleOnly
					? baseLabel
					: baseLabel + '　' + (DeliveryRules.anchorBase(mode, campaign) || '未設定');
			}

			var resolved = DeliveryRules.resolveAnchor(settings, which, campaign);
			var result = anchorPart(which, 'result');
			if (ruleOnly) {
				result.className = 'dts-anchor-result muted';
				result.textContent = '依各團購的檔期換算';
			} else if (resolved.iso) {
				result.className = 'dts-anchor-result';
				result.innerHTML = '＝ ' + resolved.iso
					+ (resolved.skipped > 0
						? '<span class="dts-anchor-note">（跳過 ' + resolved.skipped + ' 個休息日）</span>'
						: '');
			} else {
				result.className = 'dts-anchor-result muted';
				result.textContent = mode === 'NONE' ? '不設限' : '尚無法換算';
			}
		}

		/**
		 * 買家一天都選不到時，指出到底是哪一項設定造成的。
		 * 只顯示「沒有可選日期」而不講原因，等於要人自己回頭推算，所以這裡把成因分開判斷。
		 */
		function emptyRangeReason(settings, asOf, range, campaign, validation) {
			if (validation.unresolved) {
				var which = validation.unresolved;
				var mode = anchorModeOf(settings, which);
				return '「' + (which === 'start' ? '開始配送日' : '結束配送日') + '」綁定了<b>'
					+ (mode === 'GB_START' ? '團購開始日' : '團購結束日')
					+ '</b>，但目前拿不到那個日期，這一端會變成不設限。'
					+ '請填寫下方的團購起訖，或改選其他來源。';
			}
			if (!validation.dateOrder) {
				return '換算後的<b>結束配送日 ' + DeliveryRules.resolveAnchor(settings, 'end', campaign).iso
					+ '</b> 早於<b>開始配送日 ' + DeliveryRules.resolveAnchor(settings, 'start', campaign).iso
					+ '</b>，買家一天都選不到。請調整偏移天數或來源。';
			}
			var endIso = DeliveryRules.resolveAnchor(settings, 'end', campaign).iso;
			if (endIso && DateUtils.fromIso(endIso) < asOf) {
				return '「結束配送日」換算出來是 <b>' + endIso + '</b>，已經早於目前的日期，'
					+ '整個可配送區間都在過去，買家一天都選不到。請調整來源或偏移天數。';
			}
			if (range.empty) {
				return '天數規則與配送起訖<b>沒有交集</b>，買家一天都選不到。'
					+ '請放寬天數，或調整開始／結束配送日。';
			}
			return '可配送區間 <b>' + DateUtils.toIso(range.minDate) + '</b> 〜 <b>' + DateUtils.toIso(range.maxDate)
				+ '</b> 裡的每一天都被<b>排除的星期</b>或<b>排除的特定日期</b>蓋掉了，買家一天都選不到。'
				+ '請放寬排除條件，或把區間拉長。';
		}

		/**
		 * 把交集的結果講清楚：先說天數規則算出什麼，再說固定日期把它裁成什麼。
		 * 這是後台唯一能看出「兩組欄位同時生效」的地方，所以兩段都要講。
		 */
		function renderRangeCalc(settings, asOf, range, campaign, validation) {
			if (!validation.prepDays || !validation.maxDays || !validation.offsets) {
				el.dtsDaysCalc.style.display = 'none';
				el.dtsRangeWarn.style.display = 'none';
				return;
			}

			if (!validation.isValid) {
				el.dtsDaysCalc.style.display = 'none';
				el.dtsRangeWarn.innerHTML = '<i class="fa-light fa-triangle-exclamation"></i><span>'
					+ emptyRangeReason(settings, asOf, range, campaign, validation) + '</span>';
				el.dtsRangeWarn.style.display = 'flex';
				return;
			}
			el.dtsRangeWarn.style.display = 'none';

			var prepDays = DeliveryRules.effectivePrepDays(settings);
			var maxDays = DeliveryRules.effectiveMaxDays(settings);
			var prepared = DeliveryRules.addWorkingDays(asOf, prepDays, settings);
			var skipped = DateUtils.daysBetween(asOf, prepared) - prepDays;

			var html = '若 <b>' + DateUtils.toIso(asOf) + '</b> 下單，最早可出貨日為 <b>' + DateUtils.toIso(prepared) + '</b>';
			if (maxDays !== null) {
				var latest = DeliveryRules.addWorkingDays(prepared, maxDays, settings);
				skipped += DateUtils.daysBetween(prepared, latest) - maxDays;
				html += '，依天數可配送到 <b>' + DateUtils.toIso(latest) + '</b>';
			} else {
				html += '，天數未設上限';
			}
			html += '。';
			if (skipped > 0) {
				html += '（過程中跳過 ' + skipped + ' 個已排除的日子，這些都不計入天數。）';
			}

			// 錨點的換算過程要攤開，否則後台看不出「＋N」到底變成哪一天
			['start', 'end'].forEach(function (which) {
				var mode = anchorModeOf(settings, which);
				if (mode !== 'GB_START' && mode !== 'GB_END') {
					return;
				}
				var base = DeliveryRules.anchorBase(mode, campaign);
				if (!base) {
					return;
				}
				var resolved = DeliveryRules.resolveAnchor(settings, which, campaign);
				var offset = DeliveryRules.effectiveOffset(which === 'start' ? settings.startOffset : settings.endOffset);
				html += '<br>' + (which === 'start' ? '開始' : '結束') + '配送日＝'
					+ (mode === 'GB_START' ? '團購開始日' : '團購結束日') + ' ' + base
					+ ' ＋' + offset + ' 工作天＝<b>' + resolved.iso + '</b>'
					+ (resolved.skipped > 0 ? '（跳過 ' + resolved.skipped + ' 個休息日）' : '');
			});
			html += '<br>';

			if (range.clampedByStart || range.clampedByEnd) {
				var clampedBy = [];
				if (range.clampedByStart) {
					clampedBy.push('開始配送日把起始日往後推');
				}
				if (range.clampedByEnd) {
					clampedBy.push('結束配送日把最後一天往前拉');
				}
				html += '套用配送起訖後（' + clampedBy.join('、') + '），';
			} else {
				html += '配送起訖沒有再進一步限制，';
			}
			html += '實際可配送區間為 <b>' + DateUtils.toIso(range.minDate) + '</b> 〜 <b>' + DateUtils.toIso(range.maxDate) + '</b>。';

			// .dts-callout 是 flex container，裸露的文字節點與 <b> 都會各自變成 flex item 並排，
			// 整段話會被拆散。包一層 <span> 讓它維持單一 flex item。
			el.dtsDaysCalc.innerHTML = '<span>' + html + '</span>';
			el.dtsDaysCalc.style.display = 'flex';
		}

		function renderWeekdayRow(settings) {
			el.dtsWeekdayRow.innerHTML = '';
			WEEKDAY_LABELS.forEach(function (label, dow) {
				var btn = document.createElement('button');
				btn.type = 'button';
				btn.className = 'dts-wd-chip';
				btn.textContent = label;

				if (settings.excludedWeekdays.has(dow)) {
					btn.classList.add('on');
				}
				btn.addEventListener('click', function () {
					handlers.changeSettings(function (s) {
						if (s.excludedWeekdays.has(dow)) {
							s.excludedWeekdays.delete(dow);
						} else {
							s.excludedWeekdays.add(dow);
						}
					});
				});
				el.dtsWeekdayRow.appendChild(btn);
			});
		}

		function renderExcludedDatesRow(settings) {
			el.dtsExcludedDatesRow.innerHTML = '';
			var sorted = Array.from(settings.excludedDates).sort();
			var covered = [];

			if (sorted.length === 0) {
				var empty = document.createElement('span');
				empty.className = 'dts-tag-empty';
				empty.textContent = '尚未設定排除日期';
				el.dtsExcludedDatesRow.appendChild(empty);
				el.dtsOverlapNote.style.display = 'none';
				return;
			}

			sorted.forEach(function (dstr) {
				var d = DateUtils.fromIso(dstr);
				var isCovered = DeliveryRules.excludedWeekdaySet(settings).has(d.getDay());
				if (isCovered) {
					covered.push(dstr);
				}

				var tag = document.createElement('span');
				tag.className = 'dts-tag';
				tag.innerHTML = isCovered
					? '<span style="opacity:.55;text-decoration:line-through;">' + DateUtils.escapeHtml(dstr) + '</span>'
					: DateUtils.escapeHtml(dstr);

				var x = document.createElement('button');
				x.type = 'button';
				x.textContent = '✕';
				x.title = '移除';
				x.addEventListener('click', function () {
					handlers.changeSettings(function (s) { s.excludedDates.delete(dstr); });
				});

				tag.appendChild(x);
				el.dtsExcludedDatesRow.appendChild(tag);
			});

			if (covered.length) {
				el.dtsOverlapNote.style.display = 'flex';
				el.dtsOverlapNote.querySelector('span:last-child').textContent =
					covered.length + ' 個日期已被排除星期涵蓋（' + covered.join('、') + '），以排除星期為主。';
			} else {
				el.dtsOverlapNote.style.display = 'none';
			}
		}

		function renderCalendar(state, range, asOf) {
			var settings = state.settings;
			var cursor = state.ui.calCursor;

			el.dtsCalMonthLabel.textContent = cursor.getFullYear() + ' 年 ' + MONTH_LABELS[cursor.getMonth()];
			el.dtsCalGrid.innerHTML = '';

			WEEKDAY_LABELS.forEach(function (l) {
				var h = document.createElement('div');
				h.className = 'dts-cal-dow';
				h.textContent = l;
				el.dtsCalGrid.appendChild(h);
			});

			var firstDow = new Date(cursor.getFullYear(), cursor.getMonth(), 1).getDay();
			for (var p = 0; p < firstDow; p++) {
				var padCell = document.createElement('div');
				padCell.className = 'dts-cal-cell pad';
				el.dtsCalGrid.appendChild(padCell);
			}

			var daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
			var todayIso = DateUtils.toIso(asOf);

			for (var day = 1; day <= daysInMonth; day++) {
				el.dtsCalGrid.appendChild(buildCalendarCell(
					new Date(cursor.getFullYear(), cursor.getMonth(), day), day, state, range, todayIso
				));
			}
		}

		function buildCalendarCell(date, day, state, range, todayIso) {
			var settings = state.settings;
			var info = DeliveryRules.classifyDay(date, settings, range);
			var isoStr = DateUtils.toIso(date);

			var cell = document.createElement('div');
			cell.className = 'dts-cal-cell';
			cell.textContent = day;

			if (settings.enabled) {
				if (info.outOfRange) {
					cell.classList.add('out-of-range');
				} else if (info.byWeekday) {
					cell.classList.add('excluded-weekday');
				} else if (info.byDate) {
					cell.classList.add('excluded-date');
				} else {
					cell.classList.add('available');
				}
			} else {
				cell.classList.add('out-of-range');
			}

			if (isoStr === todayIso) {
				cell.classList.add('today');
			}
			if (state.ui.picked && isoStr === state.ui.picked) {
				cell.classList.add('picked');
			}

			if (settings.enabled && info.available && settings.type === 'PREFERRED') {
				cell.title = '模擬買家點選這天';
				cell.addEventListener('click', function () {
					handlers.changeUi(function (ui) { ui.picked = isoStr; });
				});
			} else if (!info.available && !info.outOfRange) {
				cell.title = (info.byWeekday ? '排除星期（' + WEEKDAY_LABELS[date.getDay()] + '）' : '手動排除日期')
					+ ' — 買家不能選這天';
			}

			return cell;
		}

		function renderSummary(settings, range) {
			el.dtsSummaryRange.textContent = DateUtils.formatShort(range.minDate) + ' 〜 ' + DateUtils.formatShort(range.maxDate);
			el.dtsSummaryDays.textContent = settings.enabled ? DeliveryRules.countAvailableDays(settings, range) : '—';
		}

		/**
		 * 團購起訖。單一團購頁讀的是真實資料，所以唯讀；
		 * 系統預設值沒有團購可依附，只能讓使用者填一組模擬值來看預覽。
		 */
		function renderCampaignFields(state) {
			var campaign = state.meta.campaign;
			setValueUnlessFocused(el.dtsSimGbStart, campaign.start || '');
			setValueUnlessFocused(el.dtsSimGbEnd, campaign.end || '');

			el.dtsSimGbStart.disabled = !simulatedCampaign;
			el.dtsSimGbEnd.disabled = !simulatedCampaign;
			el.dtsCampaignHint.innerHTML = simulatedCampaign
				? '系統預設值沒有綁定任何團購，這兩個日期是<b>模擬值</b>：只影響上面的換算與預覽，不會被儲存。'
				: '團購起訖讀自這個團購的資料，不能在這裡修改。改團購檔期後，綁定它的配送起訖會跟著移動。';
		}

		// -------- 事件綁定（只綁一次固定存在的元素）--------

		function bindStaticEvents() {
			el.dtsEnabled.addEventListener('change', function () {
				handlers.changeSettings(function (s) { s.enabled = el.dtsEnabled.checked; });
			});
			el.dtsMandatory.addEventListener('change', function () {
				handlers.changeSettings(function (s) { s.mandatory = el.dtsMandatory.checked; });
			});
			bindSeg(el.dtsTypeSeg, function (val) {
				handlers.changeSettings(function (s) { s.type = val; });
			});
			el.dtsPrepDays.addEventListener('input', function () {
				handlers.changeSettings(function (s) { s.prepDays = parseOptionalInt(el.dtsPrepDays.value); });
			});
			el.dtsMaxDays.addEventListener('input', function () {
				handlers.changeSettings(function (s) { s.maxDays = parseOptionalInt(el.dtsMaxDays.value); });
			});
			el.dtsSimGbStart.addEventListener('change', function () {
				handlers.changeCampaign({ start: el.dtsSimGbStart.value, end: el.dtsSimGbEnd.value });
			});
			el.dtsSimGbEnd.addEventListener('change', function () {
				handlers.changeCampaign({ start: el.dtsSimGbStart.value, end: el.dtsSimGbEnd.value });
			});
			el.dtsExcludeDateInput.addEventListener('change', function () {
				var v = el.dtsExcludeDateInput.value;
				if (!v) {
					return;
				}
				el.dtsExcludeDateInput.value = '';
				handlers.changeSettings(function (s) { s.excludedDates.add(v); });
			});
			el.dtsCalPrev.addEventListener('click', function () {
				handlers.changeUi(function (ui) {
					ui.calCursor = new Date(ui.calCursor.getFullYear(), ui.calCursor.getMonth() - 1, 1);
				});
			});
			el.dtsCalNext.addEventListener('click', function () {
				handlers.changeUi(function (ui) {
					ui.calCursor = new Date(ui.calCursor.getFullYear(), ui.calCursor.getMonth() + 1, 1);
				});
			});
			el.dtsSaveBtn.addEventListener('click', function () { handlers.save(); });

			if (showInheritedUi) {
				el.dtsRevertBtn.addEventListener('click', function () { handlers.revert(); });
			} else {
				el.dtsRevertBtn.style.display = 'none';
			}

			el.dtsSimNow.value = DateUtils.toIso(today);
			el.dtsSimNow.addEventListener('change', function () {
				handlers.previewNow(el.dtsSimNow.value);
			});
		}

		// -------- 對外介面 --------

		return {
			/** 顯示載入中 */
			showLoading: function ($root) {
				$root.html('<div class="dts-loading">載入設定中…</div>');
			},

			/** 顯示載入失敗 */
			showLoadError: function ($root) {
				$root.html('<div class="dts-loading text-danger">載入失敗，請重新整理頁面再試一次。</div>');
			},

			/** 建立畫面骨架、快取元素、綁定固定元素的事件 */
			mount: function ($root) {
				$root.html(Template.render());
				ELEMENT_IDS.forEach(function (id) { el[id] = document.getElementById(id); });
				// mount() runs once per page load and render() never rebuilds the
				// skeleton, so the tooltips need no teardown.
				$root.find('[data-toggle="tooltip"]').tooltip();
				bindStaticEvents();
			},

			/** 依目前狀態重繪整個畫面，是這一層唯一的渲染入口 */
			render: function (state) {
				var settings = state.settings;
				var campaign = state.meta.campaign;
				var asOf = (state.ui && state.ui.simNow)
					? DateUtils.startOfDay(DateUtils.fromIso(state.ui.simNow))
					: today;
				var range = DeliveryRules.computeRange(settings, asOf, campaign);
				var validation = DeliveryRules.validate(settings, range, campaign);

				el.dtsFieldset.setAttribute('data-disabled', settings.enabled ? 'false' : 'true');
				el.dtsEnabled.checked = settings.enabled;
				el.dtsMandatory.checked = settings.mandatory;

				if (el.dtsSimNow && state.ui.simNow && el.dtsSimNow.value !== state.ui.simNow) {
					el.dtsSimNow.value = state.ui.simNow;
				}

				renderStatus(state);
				renderMigrationBanner(state.meta);
				renderTypeExplain(settings);
				renderRangeFields(settings, asOf, range, campaign, validation);
				renderCampaignFields(state);
				renderWeekdayRow(settings);
				renderExcludedDatesRow(settings);
				renderCalendar(state, range, asOf);
				renderSummary(settings, range);

				el.dtsBuyerEyebrow.textContent = settings.enabled ? '預覽條件' : '預覽條件（已停用）';
			},

			/** 儲存進行中時停用儲存按鈕 */
			setSaving: function (saving) {
				el.dtsSaveBtn.disabled = saving;
			}
		};
	}

	// ==================== Gateway：只負責與後端溝通 ====================
	//
	// 不碰 DOM、不顯示提示訊息，一律回傳 promise 交給 Page 處理。

	function createGateway(config) {
		return {
			fetch: function () {
				return $.get(config.urls.fetch, config.fetchParams || {});
			},
			save: function (settings) {
				return $.post(config.urls.save, SettingsCodec.encode(settings));
			},
			remove: function (fromId) {
				var params = typeof config.removeParams === 'function'
					? config.removeParams(fromId)
					: (config.removeParams || {});
				return $.post(config.urls.remove, params);
			}
		};
	}

	// ==================== Page：命令式外殼 ====================

	$(document).ready(function () {
		var config = window.DTS_PAGE;
		if (!config || !config.urls || !config.urls.fetch || !config.urls.save || !config.urls.remove) {
			throw new Error('window.DTS_PAGE.urls.{fetch,save,remove} is required');
		}

		var today = DateUtils.startOfDay(new Date());
		var $root = $('#dtsRoot');
		var gateway = createGateway(config);
		var state = null;

		var handlers = {
			/** 修改會被儲存的設定：標記為已自訂，然後重繪 */
			changeSettings: function (mutator) {
				mutator(state.settings);
				if (!state.meta.fromId) {
					state.meta.fromId = 'PENDING';
				}
				view.render(state);
			},

			/** 只修改畫面暫存狀態（日曆游標、模擬點選）：不標記為已自訂，只重繪 */
			changeUi: function (mutator) {
				mutator(state.ui);
				view.render(state);
			},

			/**
			 * 團購起訖只影響換算與預覽，不是會被儲存的設定，
			 * 所以不標記為已自訂 —— 在系統預設值頁改模擬值不該讓人以為動到了設定。
			 */
			changeCampaign: function (campaign) {
				state.meta.campaign = { start: campaign.start || '', end: campaign.end || '' };
				state.ui.calCursor = firstDayOfRangeMonth(state.settings, state.ui.simNow, state.meta.campaign);
				view.render(state);
			},

			save: function () { save(); },
			revert: function () { revert(); },
			previewNow: function (nowIso) {
				if (!nowIso) {
					return;
				}
				state.ui.simNow = nowIso;
				state.ui.calCursor = firstDayOfRangeMonth(state.settings, nowIso, state.meta.campaign);
				view.render(state);
			}
		};

		var view = createView({
			showInheritedUi: !!config.showInheritedUi,
			allowCustomDate: !!config.allowCustomDate,
			simulatedCampaign: !!config.simulatedCampaign,
			today: today,
			handlers: handlers
		});

		/**
		 * 月曆要停在可配送區間開始的那個月，而不是「今天」所在的月份。
		 * 指定了未來的開始配送日期時，停在今天這個月只會看到整片不可選，
		 * 讓人以為設定壞了。
		 */
		function firstDayOfRangeMonth(settings, nowIso, campaign) {
			var asOf = DateUtils.startOfDay(DateUtils.fromIso(nowIso));
			var minDate = DeliveryRules.computeRange(settings, asOf, campaign).minDate;
			return new Date(minDate.getFullYear(), minDate.getMonth(), 1);
		}

		/**
		 * 系統預設值不能把配送起訖綁在固定日期上。舊資料若是那樣存的，開啟時先降級並掛提示，
		 * 而不是靜默改掉，也不是讓他按下儲存才被後端擋。回傳是否真的降級過。
		 */
		function downgradeCustomAnchors(settings) {
			if (config.allowCustomDate) {
				return false;
			}
			var downgraded = false;
			['startMode', 'endMode'].forEach(function (key) {
				if (settings[key] === 'CUSTOM') {
					settings[key] = 'NONE';
					downgraded = true;
				}
			});
			return downgraded;
		}

		/**
		 * 團購起訖。單一團購頁由後端注入；系統預設值頁沒有團購可依附，
		 * 給一組預設的模擬值，免得畫面一開啟就是「尚無法換算」的錯誤狀態。
		 * 重新載入時保留使用者填的模擬值，不要把他的輸入洗掉。
		 */
		function resolveCampaign(campaign, isRefresh) {
			campaign = campaign || { start: '', end: '' };
			if (campaign.start || campaign.end) {
				return campaign;
			}
			if (!config.simulatedCampaign) {
				return campaign;
			}
			if (isRefresh && state && state.meta && state.meta.campaign) {
				return state.meta.campaign;
			}
			return {
				start: DateUtils.toIso(today),
				end: DateUtils.toIso(DateUtils.addDays(today, DEFAULT_SIMULATED_CAMPAIGN_DAYS))
			};
		}

		function load(isRefresh) {
			if (!isRefresh) {
				view.showLoading($root);
			}
			return gateway.fetch()
				.done(function (json) {
					var decoded = SettingsCodec.decode(json.data);
					var simNow = (isRefresh && state && state.ui && state.ui.simNow)
						? state.ui.simNow
						: DateUtils.toIso(today);

					decoded.meta.downgradedCustom = downgradeCustomAnchors(decoded.settings);
					decoded.meta.campaign = resolveCampaign(decoded.meta.campaign, isRefresh);

					state = {
						settings: decoded.settings,
						meta: decoded.meta,
						ui: {
							simNow: simNow,
							calCursor: firstDayOfRangeMonth(decoded.settings, simNow, decoded.meta.campaign),
							picked: null
						}
					};
					if (!isRefresh) {
						view.mount($root);
					}
					view.render(state);
				})
				.fail(function () {
					view.showLoadError($root);
				});
		}

		function save() {
			// 欄位不合法時直接擋下，避免把 NaN 或空區間送到後端
			var range = DeliveryRules.computeRange(state.settings, today, state.meta.campaign);
			var validation = DeliveryRules.validate(state.settings, range, state.meta.campaign);
			if (!validation.isValid) {
				toastr.error(saveErrorMessage(validation));
				return;
			}

			view.setSaving(true);
			gateway.save(state.settings)
				.done(function () {
					toastr.success('已儲存配送日期設定');
					load(true);
				})
				.fail(function () {
					toastr.error('儲存失敗，請確認欄位內容後再試一次');
				})
				.always(function () {
					view.setSaving(false);
				});
		}

		/** 把 validate 的結果翻成一句可以直接給使用者看的話 */
		function saveErrorMessage(validation) {
			if (!validation.prepDays) {
				return '最快可出貨（工作天）請輸入 0～60 之間的整數';
			}
			if (!validation.maxDays) {
				return '最晚配送天數（工作天）請輸入 1～60 之間的整數；若要留空不限天數，「結束配送日」就不能選「依天數規則」';
			}
			if (!validation.offsets) {
				return '配送起訖的偏移請輸入 0～60 之間的整數，不接受負數';
			}
			if (validation.unresolved) {
				return (validation.unresolved === 'start' ? '開始' : '結束')
					+ '配送日綁定了團購的日期，但目前拿不到那個日期，請先填寫團購起訖或改選其他來源';
			}
			if (!validation.dateOrder) {
				return '結束配送日不能早於開始配送日';
			}
			return '目前的設定讓買家一天都選不到，請依畫面上的紅色提示調整後再儲存';
		}

		function revert() {
			if (!config.showInheritedUi) {
				return;
			}
			if (!state.meta.fromId || state.meta.fromId === 'PENDING') {
				return;
			}
			if (!window.confirm('確定要清除這個團購的自訂設定，改用系統預設值嗎？')) {
				return;
			}

			gateway.remove(state.meta.fromId)
				.done(function () {
					toastr.success('已還原為系統預設值');
					load(true);
				})
				.fail(function () {
					toastr.error('還原失敗，請再試一次');
				});
		}

		load();
	});

})(window, jQuery);
