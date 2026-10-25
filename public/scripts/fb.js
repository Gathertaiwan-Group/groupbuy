$.EPFB = function(groupBuyId) {
	this.groupBuyId = groupBuyId;
}
$.EPFB.prototype = {
	getGroup:function() {
		var $this = this;
		$.ajax({
			type:'GET',
			url:GBF.baseUrl+'/ajax/FbGroup/get',
			data:{groupBuyId:this.groupBuyId},
			async:true,
		})
		.done(function(json) {
				$('#section-select-group').hide();
				$this.setGroup(json.data);
			}
		)
		.fail(function(jqXHR, textStatus, errorThrown) {
				var json = jqXHR.responseJSON;
				if (json.code == 404) {
					$('#section-select-group').hide();
				} else {
					displayAlertWarning(json.error);
				}
			}
		);
	},
	setGroup:function(group) {
		this.groupId = group.groupId;
		var inited = (this.fbGroupId != undefined);
		this.fbGroupId = group.fbGroupId;
		$('#section-group-detail').show();
		$('#section-feeds').show();
		$('#group-name').html(group.name);
		$('#group-feedTemplate').val(group.feedTemplate);
		if (!inited) {
			initDataTable(group.fbGroupId);
		}
		if (group.expired) {
			$('#section-select-group').show();
			$('#section-select-group').append('<div class="help-block">授權已過期，請重新授權</div>');
		} else {
			$('#section-select-group').hide();
		}
	},
	setPage:function(page) {
		console.log('render page:%o',page);
		this.pageId = page.pageId
		$('#page-name').html(page.pageName);
	},
	selectGroup:function() {
		openForm(GBF.ctx+'/backend/FbGroup/select', 'groupBuyId=' + this.groupBuyId);
	},
	selectPage:function() {
		//$(window.event.target);
		console.log('this' + this + ',e=' + window);
		openForm(GBF.ctx+'/backend/FbPage/select', 'groupBuyId=' + this.groupBuyId);
	},
	selectFeed:function() {
		openForm(GBF.ctx+'/backend/FbFeed/select', 'groupBuyId=' + this.groupBuyId);
	},
	bindGroup:function(groupId, name, selectPage, accessToken) {
		var $this = this;
		var ajaxurl = baseUrl + '/ajax/FbGroup/bind';
		$.ajax({
			type:'POST',
			url:ajaxurl,
			data:{
				groupBuyId:this.groupBuyId, 
				groupId:groupId,
				selectPage:selectPage, 
				name:name,
				accessToken:accessToken
			},
			async:true,
		})
		.done(function(json) {
				$('#myModal').modal('hide');
				$this.setGroup(json.data);
			}
		)
		.fail(function(jqXHR, textStatus, errorThrown) {
				var json = jqXHR.responseJSON;
				modalShowDanger($('#myModal'),json.error);

				console.log(json);
			}
		);
	},
	bindPage:function(pageId, name, accessToken) {
		var $this = this;
		var ajaxurl = baseUrl + '/ajax/FbPage/bind';
		$.ajax({
			type:'POST',
			url:ajaxurl,
			data:{groupBuyId:this.groupBuyId, pageId:pageId, name:name, accessToken:accessToken},
			async:true,
		})
		.done(function(json) {
				$('#myModal').modal('hide');
				$this.setPage(json.data);
			}
		)
		.fail(function(jqXHR, textStatus, errorThrown) {
				var json = jqXHR.responseJSON;
				modalShowDanger($('#myModal'),json.error);
				console.log(json);
			}
		);
	},
	updateFeedTemplate:function(btn='#btn-updateFeedTemplate') {
		var $this = this;
		var ajaxurl = baseUrl + '/ajax/FbGroup/update';
		var data = {
			fbGroupId:this.fbGroupId,
			feedTemplate:$('#group-feedTemplate').val()
		}
		var dataJson = {data:{}};
		dataJson.data[this.fbGroupId] = data;
		var $btn = $(btn);
		btnStartLoading($btn);
		$.ajax({
			type:'POST',
			url:ajaxurl,
			data:dataJson,
			async:true,
		})
		.done(function(json) {
				$this.setGroup(json.data[0]);
				btnStopLoading($btn);
				$btn.html('樣板已更新');
			}
		)
		.fail(function(jqXHR, textStatus, errorThrown) {
				var json = jqXHR.responseJSON;
				if (json.error != null) {
					toastr.warning(json.error);
				} else {
					toastr.warning('unexpected error');
				}
				btnStopLoading($btn);
			}
		);
	},
	resetFeedTemplate:function() {
		$('#group-feedTemplate').val('');
		this.updateFeedTemplate('#btn-resetFeedTemplate');
	},
	newFeed:function() {
		var $this = this;
		var ajaxurl = baseUrl + '/ajax/FbFeed/save';
		var data = {
			fbGroupId:this.fbGroupId,
			message:$('#group-feedTemplate').val()
		}
		var dataJson = {data:{}};
		dataJson.data[0] = data;
		var $btn = $('#btn-newFeed');
		btnStartLoading($btn);
		$.ajax({
			type:'POST',
			url:ajaxurl,
			data:dataJson,
			async:true,
		})
		.done(function(json) {
				btnStopLoading($btn);
				fbFeedTable.clear().ajax.reload(null, false);
				$this.bindItem(json.data[0].fbFeedId);
			}
		)
		.fail(function(jqXHR, textStatus, errorThrown) {
				var json = jqXHR.responseJSON;
				if (json.error != null) {
					toastr.warning(json.error);
				} else {
					toastr.warning('unexpected error');
				}
				btnStopLoading($btn);
			}
		);
	},
	bindItem:function(fbFeedId) {
		if (this.fbGroupId == undefined) {
			messagebox('錯誤', '請先設定完成臉書社團', '關閉');
		} else {
			openFormF(GBF.ctx+'/backend/FbFeed/bindItem', 'fbFeedId=' + fbFeedId);
		}
	},
	bindFeed:function(fbFeedId) {
		if (this.fbGroupId == undefined) {
			messagebox('錯誤', '請先設定完成臉書社團', '關閉');
		} else {
			openForm(GBF.ctx+'/backend/FbFeed/select', 'groupBuyId=' + this.groupBuyId + '&fbFeedId=' + fbFeedId);
		}
	},
	publish:function(fbFeedId) {
		if (this.fbGroupId == undefined) {
			messagebox('錯誤', '請先設定完成臉書社團', '關閉');
		} else {
			openFormF(GBF.ctx+'/backend/FbFeed/publish', 'fbFeedId=' + fbFeedId);
		}
	},
	getFbFeed:function(fbFeedId, callback) {
		var $this = this;
		$.ajax({
			type:'GET',
			url:GBF.baseUrl+'/ajax/FbFeed/get',
			data:{
				fbGroupId:this.fbGroupId,
				fbFeedId:fbFeedId,
				},
			async:true,
		})
		.done(function(json) {
				$this.setFbFeed(json.data);
				if (callback != undefined) {
					callback(json.data);
				}
			}
		)
		.fail(function(jqXHR, textStatus, errorThrown) {
				var json = jqXHR.responseJSON;
				if (json.error != null) {
					toastr.warning(json.error);
				} else {
					toastr.warning('unexpected error');
				}
			}
		);
	},
	setFbFeed:function(fbFeed) {
		console.log('setFbFeed:%o',fbFeed);
		this.fbFeed = fbFeed;
	},
	getFbFeedImages:function(fbFeedId, callback) {
		var $this = this;
		$.ajax({
			type:'GET',
			url:GBF.baseUrl+'/ajax/FbFeed/getImages',
			data:{
				fbGroupId:this.fbGroupId,
				fbFeedId:fbFeedId,
				},
			async:true,
		})
		.done(function(json) {
				if (callback != undefined) {
					callback(json.data);
				}
			}
		)
	},
	fetchComments:function(fbFeedId, ignore, caller, callback) {
		btnStartLoading($(caller));
		var $this = this;
		$.ajax({
			type:'GET',
			url:GBF.baseUrl+'/ajax/FbFeed/fetchComments',
			data:{
				fbGroupId:this.fbGroupId,
				fbFeedId:fbFeedId,
				ignore:ignore
				},
			async:true,
		})
		.done(function(json) {
				if (callback != undefined) {
					callback(json.data);
				} else {
					messagebox('成功', json.data, '關閉');
				}
				btnStopLoading($(caller));
			}
		)
		.fail(function(jqXHR, textStatus, errorThrown) {
			var json = jqXHR.responseJSON;
			if (json.error != null) {
				toastr.warning(json.error);
			} else {
				toastr.warning('unexpected error');
			}
			btnStopLoading($(caller));
		}
		);
	},
	verifyUser:function(fbCommentId, caller, callback) {
		btnStartLoading($(caller));
		var $this = this;
		$.ajax({
			type:'GET',
			url:GBF.baseUrl+'/ajax/FbComment/verifyUser',
			data:{
				fbGroupId:this.fbGroupId,
				fbCommentId:fbCommentId,
				},
			async:true,
		})
		.done(function(json) {
				if (callback != undefined) {
					callback(json.data);
				}
				btnStopLoading($(caller));
				//messagebox('成功', json.error, '關閉');
			}
		)
		.fail(function(jqXHR, textStatus, errorThrown) {
			var json = jqXHR.responseJSON;
			if (json.error != null) {
				toastr.warning(json.error);
			} else {
				toastr.warning('unexpected error');
			}
			btnStopLoading($(caller));
		}
		);
	},
}