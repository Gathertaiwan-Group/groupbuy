var mdbWrapper = {
	_overwrite:function() {
		$.fn.validateStepInput = function () {
			var valid = true;
			// Find all input fields dat need validation in current step.
			// was: 'input.validate'
			$(this).find(':input[required]').each(function () {
				if (!$(this).valid()) {
					valid = false;
					return false;
				}
			});
			return valid;
		};

		$.fn.nextStep1 = $.fn.nextStep;

		$.fn.nextStep = function (callback, activefb, e) {
			var $step = $(e.target).closest('li');
			var $stepper = this;
			if ($step && !$step.hasClass('active')) {
				var object = $($stepper.children('.step:visible')).index($step);
				$(this).addClass('temp-active');
				$stepper.validatePreviousSteps()
				$stepper.openStep(object + 1);
				$(this).removeClass('temp-active');
			}
			return $stepper.nextStep1(callback, activefb, e);
		}
			
		$.fn.closeAction = function (order, callback) {
			var closable = this.removeClass('active').find('.step-new-content');
		};	
	},
	_injectStepper:function (button) {
			var activeStep = $('li.step.active');
			var currentStep = button.closest('li.step');
			var nextStep = currentStep.next('li.step');
			var navbarHeight = $('nav').height();
			var scrollTo = function (target) {
				$([document.documentElement, document.body]).animate({
					scrollTop: target.offset().top - navbarHeight
				}, 'fast');
			}
			
			if (!nextStep) {
				// the last one step.
				// it may scroll to the error element.
				return;
			}
			// check error element
			var errorEle = activeStep.find('.has-error');
			if (errorEle.length) {
				if (errorEle.visible()) {
					return;
				}
				// has error element, scroll to it.
				nextStep = errorEle;
			} 
			scrollTo(nextStep);
	},
	injectStepper: function () {
		var $this = this;
		$('body').on('click', 'button.next-step', function () {
			var button = $(this);
			setTimeout(function () {
				$this._injectStepper(button);
			}, 450);
		});
		this._overwrite();
	}
}

$.fn.newLinearMdbStepper = function () {
	
	var $stepper = this;
	var validator = $stepper.closest('form').validate();
	
	// overwrite
	$.fn.nextStep = function (callback, activefb, e) {
		var stepper = this;
		var settings = $(stepper).data('settings');
		var form = this.closest('form');
		var active = this.find('.step.active');
		var next = $(this.children('.step:visible')).index($(active)) + 2;
		var feedback = active.find('.next-step').length > 1 ? (e ? $(e.target).data("feedback") : undefined) : active.find('.next-step').data("feedback");
		// If the stepper is parallel, we want to validate the input of the current active step. Not all elements.
		if ((settings.parallel && $(active).validateStep()) || (!settings.parallel && form.isValid())) {
			if (feedback && activefb) {
				if (settings.showFeedbackLoader) stepper.activateFeedback();
				return window[feedback].call();
			}
			active.removeClass('wrong').addClass('done');
			active.dispatchValidResult(true);
			this.openStep(next, callback);
			return this.trigger('nextstep');
		} else {
			active.dispatchValidResult(false);
			active.scrollToErrorElement();
 			return active.removeClass('done').addClass('wrong');
		}
	};
	
	$.fn.dispatchValidResult = function(valid) {
		var activeStep = this;
		const event = new CustomEvent('ep.bag.step.valid.result', {
			detail: { step: activeStep[0], valid: valid }
		});
		activeStep[0].dispatchEvent(event);
		return this;
	}
	
	$.fn.scrollToErrorElement = function () {
		var $step = this;
		var firstElement = validator.invalidElements().filter(function (index) {
			return $step.has(this);
		});
		if (firstElement.length === 0) return this;
		firstElement[0].scrollIntoView({block: 'center'});
		return this;
	}
	
	$stepper.mdbStepper();
	$stepper.off("click", '.step:not(.active)');
	$stepper.on("click", '.step:not(.active)', function () {
		var object = $($stepper.children('.step:visible')).index($(this));
    	var active = $stepper.find('.step.active');
        if ($($stepper.children('.step:visible')).index($(active)) + 1 == object) {
			$stepper.nextStep(undefined, true, undefined);
        } else if ($($stepper.children('.step:visible')).index($(active)) - 1 == object) {
        	var form = $stepper.closest('form');
        	active.dispatchValidResult(form.isValid());
        	$stepper.prevStep(undefined);
        } else if ($($stepper.children('.step:visible')).index($(active)) - 1 > object) {
        	var form = $stepper.closest('form');
        	active.dispatchValidResult(form.isValid());
        	
        	$($stepper.children('.step')).each(function (k) {
        		if (k > object) {
        			$(this).removeClass('wrong done');
        		} else if (k === object) {
        			$stepper.openStep(object + 1);
        		} else {
        			
        		}
        	});
        } else if ($($stepper.children('.step:visible')).index($(active)) + 1 < object) {
            var form = $stepper.closest('form');
            var active = $stepper.find('.step.active');
            if (form.isValid()) {
            	active.removeClass('wrong').addClass('done');
            	active.dispatchValidResult(true);
            } else {
            	active.removeClass('done').addClass('wrong');
            	active.dispatchValidResult(false);
            	active.scrollToErrorElement();
    			return; // if validation is false, stay here.
            }
            
            var indexOfWrong = null;
            var indexOfInit = null;
        	$($stepper.children('.step')).each(function (k) {
				if (k > object) {
					$(this).removeClass('wrong done');
				} else if (k === object) {
					if (indexOfWrong === null && indexOfInit === null) {
						$stepper.openStep(object + 1);
						$(this).removeClass('wrong done').addClass('active');
					} else {
						$(this).removeClass('wrong done');
					}
				} else { // k < object
					var valid = stepValidResult[k];
					if (valid === 'done') {
						if (indexOfWrong === null && indexOfInit === null) {
							$(this).removeClass('wrong').addClass('done');
						} else {
							$(this).removeClass('wrong done');
						}
					} else if (valid === 'wrong') {
						if (indexOfWrong === null) {
							$stepper.openStep(k + 1);
							$(this).removeClass('done').addClass('wrong');
							indexOfWrong = k;
							$(this).scrollToErrorElement();
						} else {
							$(this).removeClass('wrong done');
						}
					} else { // valid === 'init'
						if (indexOfInit === null && indexOfWrong === null) {
							$stepper.openStep(k + 1);
							$(this).removeClass('wrong done').addClass('active');
							indexOfInit = k;
						} else if (indexOfInit === null) {
							$(this).removeClass('wrong done');
							indexOfInit = k;
						} else {
							$(this).removeClass('wrong done');
						}
					}
				}
			});
        }
    });
	
	// Step valid result
	var stepValidResult = [];
	$stepper.children('.step:visible').each(function (index) {
		
		// init		
		stepValidResult[index] = 'init';
		
		// register event
		this.addEventListener('ep.bag.step.valid.result', function (e) {
			var i = $stepper.children('.step:visible').index(e.detail.step);
			stepValidResult[i] = e.detail.valid ? 'done' : 'wrong';
			
			// dispatch valid change event
			const event = new CustomEvent('ep.bag.step.valid.change', {
				detail: stepValidResult
			});
			document.dispatchEvent(event);
		});
		
	});
	
	// dispatch valid change event (init)
	const event = new CustomEvent('ep.bag.step.valid.result.change', {
		detail: stepValidResult
	});
	document.dispatchEvent(event);
	
	return this;
}