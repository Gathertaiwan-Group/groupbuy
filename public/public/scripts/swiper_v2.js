/**
 * Classify the swiper container by class.
 * 'home-banner' : defined in BannerView.java.
 * 'itemset-carousel-' + itemSetId : defined in ItemSetView4.java
 * 'carousel-' + itemId : defined in show.jsp in web/GroupBuyItemSet and
 * 						 show.jsp in web/Item.
 */

const swiperType = {
	HOME_BANNER: 'home-banner',
	HOME_BANNRE_5: 'home-banner-5',
	ITEM_SET_BANNER: 'item-set-banner',
	THUMBS_GALLERY: 'thumbs_gallery_swiper',
	MARQUEE_BOX: 'marquee_box',
	DEFAULT: 'swiper',
}

var swiperManager = {
	thumbsCacheList: new Array(),
	addThumbs: function (thumbsElement, thumbsElementId) {
		var binding = {
			id: thumbsElementId,
			swiper: thumbsElement,
		};
		this.thumbsCacheList.push(binding);
	},
	/** Use element id of the swiper carousel to find its thumb. */
	queryThumbs: function (swiperElementId) {
		var thumbsId = swiperElementId + '-galleryThumbs';
		var swiper = document.getElementById(thumbsId);
		/*for (i = 0; i < this.thumbsCacheList.length; i++) {
			var element = this.thumbsCacheList[i];
			if (element.id === thumbsId) {
				swiper = element.swiper;
				break;
			}
		}*/
		return swiper;
	},
	swiperType: function (element) {
		var swiperId = element.id;
		var $elem = $(element);
		if ($elem.hasClass('banner-view') && $elem.hasClass('style-5')) {
			return swiperType.HOME_BANNRE_5;
		} else if (swiperId.includes('home-banner')) {
			return swiperType.HOME_BANNER;
		} else if ($elem.hasClass('item-set-banner')) {
			return swiperType.ITEM_SET_BANNER;
		} else if (this.isThumbsGallery(swiperId)) {
			return swiperType.THUMBS_GALLERY;
		} else if ($elem.hasClass('nav-marquee-container')) {
			return swiperType.MARQUEE_BOX;
		} else {
			return swiperType.DEFAULT;
		}
	},
	isThumbsGallery: function (swiperId) {
		var thumbs = this.queryThumbs(swiperId);
		if (thumbs) {
			return true;
		} else {
			return false;
		}
	},
}

var swiperParam = {
	homeBanner: function (swiperElement, isLooped) {
		var param = {
			autoplay: true,
			loop: isLooped,
			pagination: {
				el: '.swiper-pagination',
				clickable: true,
			},
			navigation: {
				nextEl: '.swiper-button-next',
				prevEl: '.swiper-button-prev',
			}
		};
		param = this.setupSwiperControls(swiperElement, param);
		return param;
	},
	homeBanner5: function (swiperElement) {
		var param = {
			centeredSlides: true,
			freeMode: true,
			loop: true,
			loopAdditionalSlides: 1,
			spaceBetween: 10,
			slidesPerView: 1,
			slidesPerGroupSkip: 1,
			breakpoints: {
				768: {
					spaceBetween: 15,
					slidesPerView: 1.9,		
				}
			},
			navigation: {
				nextEl: '.swiper-button-next',
				prevEl: '.swiper-button-prev',
			},
			pagination: {
				el: '.swiper-pagination',
				clickable: true,
			},
			autoplay: {
				delay: 5000,
				disableOnInteraction: false,
			}
		};
		param = this.setupSwiperControls(swiperElement, param);
		return param;
	},
	itemSetBanner: function (swiperElement) {
		var param = {
			loop: true,
			autoplay: {
				delay: 4000,
				disableOnInteraction: false,
			},
			navigation: {
				nextEl: '.swiper-button-next',
				prevEl: '.swiper-button-prev',
			},
			pagination: {
				el: '.swiper-pagination',
				clickable: true,
			},
			effect: 'fade',
			fadeEffect: {
				crossFade: true
			},
			autoplay: {
				delay: 5000,
				disableOnInteraction: false,
			}
		};
		param = this.setupSwiperControls(swiperElement, param);
		return param;
	},
	thumbsGallery: function (swiperElement) {
		const thumbs = swiperManager.queryThumbs(swiperElement.id);
		var param = {
			spaceBetween: 10,
			navigation: {
				nextEl: '.swiper-button-next',
				prevEl: '.swiper-button-prev',
			},
			thumbs: {
				swiper: thumbs.swiper
			}
		};
		param = this.setupSwiperNavigationButtons(swiperElement, param);
		return param;
	},
	thumbnails: function () {
		var param = {
			spaceBetween: 10,
			slidesPerView: 4,
			freeMode: true,
			watchSlidesVisibility: true,
			watchSlidesProgress: true,
		};
		return param;
	},
	marquee: function(isLooped) {
		var param = {
			autoplay: {
				delay: 5000,
				disableOnInteraction: false,
			},
			slidesPerView: 1,
			loop: isLooped,
		};
		return param;
	},
	normal: function (param) {
		var data = {
			grabCursor: true,
			freeMode: true,
			spaceBetween: 10,
			slidesPerView: param.numberOfSlidesInMobile,
			slidesPerGroup: parseInt(param.numberOfSlidesInMobile),
			breakpoints: {
				768: {
					spaceBetween: 15,
					slidesPerView: param.numberOfSlidesInDesktop,
					slidesPerGroup: parseInt(param.numberOfSlidesInDesktop),
				},
			},	
		};
		return data;
	},
	parseParamOfSwiper: function (swiper) {
		var $swiper = $(swiper);
		var result = {};
		var countOfSlides = $swiper.find('.swiper-slide').length;
		var isFullSlide = $swiper.hasClass('is-fluid-slide');
		var offset = isFullSlide ? 0 : 0.4;
		result.numberOfSlidesInDesktop = parseInt($swiper.attr('data-row-desktop')) + offset;
		result.numberOfSlidesInMobile = parseInt($swiper.attr('data-row-mobile')) + offset;
		result.delayMS = parseInt($swiper.attr('data-autoplay-delay'));
		
		return result;
	},
	setupSwiperControls: function (swiperElement, data) {
		data = this.setupSwiperPagination(swiperElement, data);
		data = this.setupSwiperNavigationButtons(swiperElement, data);
		return data;
	},
	setupSwiperPagination: function (swiperElement, data) {
		if (!data || !swiperElement) return data;
		
		var p = swiperElement.getElementsByClassName('swiper-pagination');
		if (p.length === 1) {
			data.pagination.el = p[0];	
		} else {
			delete data.pagination;
		}
		return data;
	},
	setupSwiperNavigationButtons: function (swiperElement, data) {
		if (!data || !swiperElement) return data;
		
		var nextEl = swiperElement.getElementsByClassName('swiper-button-next');
		var prevEl = swiperElement.getElementsByClassName('swiper-button-prev');
		if (nextEl.length === 1) {
			data.navigation.nextEl = nextEl[0];	
		} else {
			delete data.navigation.nextEl;
		}
		if (prevEl.length === 1) {
			data.navigation.prevEl = prevEl[0];	
		} else {
			delete data.navigation.prevEl;
		}
		if (nextEl.length === 0 && prevEl.length === 0) {
			delete data.navigation;
		}
		return data;
	}
}


var initSwiper = function (index, element) {
	var $this = $(this);
	var swiperEle = $(element);
	swiperEle.addClass('instance-' + index);

	var param = swiperParam.parseParamOfSwiper(swiperEle);
	
	var data = null;
	// For special swiper.
	var type = swiperManager.swiperType(element);
	switch (type) {
		case swiperType.HOME_BANNER: {
			const canLoop = swiperEle.find('.swiper-slide').length > 1;
			data = swiperParam.homeBanner(element, canLoop);
			break;
		}
		case swiperType.HOME_BANNRE_5: {
			data = swiperParam.homeBanner5(element);
			break;
		}
		case swiperType.ITEM_SET_BANNER: {
			data = swiperParam.itemSetBanner(element);
			break;
		}
		case swiperType.THUMBS_GALLERY: {
			data = swiperParam.thumbsGallery(element);
			break;
		}
		case swiperType.MARQUEE_BOX: {
			const canLoop = swiperEle.find('.swiper-slide').length > 1;
			data = swiperParam.marquee(canLoop);
			break;
		}
		default: {
			data = swiperParam.normal(param);
			if (swiperEle.find('.swiper-button-prev').length && 
				swiperEle.find('.swiper-button-next').length) {
				data.navigation = {
					nextEl: swiperEle.find('.swiper-button-next')[0],
					prevEl: swiperEle.find('.swiper-button-prev')[0],
				};
			}
			break;
		}
	}
	
	if (param.delayMS) {
		data.autoplay = {
			delay: param.delayMS,
			disableOnInteraction: false,
		};
	}
	
	var swiper = new Swiper(swiperEle[0], data);
}

var initThumbsSwiper = function (index, element) {
	var data = swiperParam.thumbnails();
	var thumbsContainer = '#' + element.id;
	var thumbs = new Swiper(thumbsContainer, data);
	swiperManager.addThumbs(thumbs, element.id);
}

var initSwipers = function() {
	// Handle normal carousel div.
	$('.swiper').not('.gallery-thumbs, .swiper-initialized').each(initSwiper);
}

var initThumbsSwipers = function () {
	// Handle thumbnails gallery first.
	$('.swiper.gallery-thumbs').not('.swiper-initialized').each(initThumbsSwiper);
}


$(function () {
	initThumbsSwipers();
	initSwipers();
});
