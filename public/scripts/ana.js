function dailyChart(selector, enableDateTimePicker = false) {

	let chart;
	var $selector = $(selector);

	var backgroundColors = [
		'rgba(255, 99, 132, 0.4)',
		'rgba(54, 162, 235, 0.4)',
		'rgba(255, 206, 86, 0.4)',
		'rgba(75, 192, 192, 0.4)',
		'rgba(153, 102, 255, 0.4)',
		'rgba(255, 159, 64, 0.4)',
		'rgba(205, 99, 132, 0.4)',
		'rgba(54, 162, 185, 0.4)',
		'rgba(255, 156, 86, 0.4)',
		'rgba(75, 142, 192, 0.4)',
		'rgba(153, 102, 205, 0.4)',
		'rgba(205, 159, 64, 0.4)',
		];
		
	var borderColors = [
		'rgba(255, 99, 132, 1)',
		'rgba(54, 162, 235, 1)',
		'rgba(255, 206, 86, 1)',
		'rgba(75, 192, 192, 1)',
		'rgba(153, 102, 255, 1)',
		'rgba(255, 159, 64, 1)',
		'rgba(205, 99, 132, 1)',
		'rgba(54, 162, 185, 1)',
		'rgba(255, 156, 86, 1)',
		'rgba(75, 142, 192, 1)',
		'rgba(153, 102, 205, 1)',
		'rgba(205, 159, 64, 1)',
		];

	var initDatePicker = function(enableDateTimePicker) {
		if (!enableDateTimePicker) return;
		var selector = '.dateTimeInterval';
		if ($(selector).length) return;
		const html = `
					<div class="dateTimeInterval mb-4"></div>
					`
					;
		$selector.append(html);
		var onSubmit = function(dateBegin, dateEnd, $trigger) {
			loadChart(dateBegin, dateEnd, $trigger);
		}
		$(selector).generateDatePickers(
		{
			dateBegin: getDateFromNow(-30)
		}
		,onSubmit);
		
	}
	
	var initChart = function(labels) {
		var ctx = $(selector + ' canvas')[0].getContext('2d');
		var chart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: '訂單數',
                        backgroundColor: backgroundColors[0],
                        yAxisID: 'y-axis-1',
                    },
                    {
                        label: '訂單金額',
                        type: 'line',
                        borderColor: borderColors[1],
                        yAxisID: 'y-axis-2',
                        fill: false
                    }
                ]
            },
            options: {
                responsive: true,
				maintainAspectRatio: false,
                scales: {
                    'y-axis-1': {
                        type: 'linear',
                        position: 'left',
                        title: {
                            display: true,
                            text: '訂單數'
                        }
                    },
                    'y-axis-2': {
                        type: 'linear',
                        position: 'right',
                        title: {
                            display: true,
                            text: '訂單金額'
                        }
                    }
                }
            }
        });
        
		window.addEventListener('resize', function () {
			chart.resize() 
		})
		return chart;
	}
	
	var updateChart = function(data) {
		
		if (!chart) {
			chart = initChart(data.labels)
		}
		chart.data.labels = data.labels;
		chart.data.datasets[0].data = data.salesCount;
		chart.data.datasets[1].data = data.salesAmount;
		chart.update();
	}
	
	function processData(json) {
		const labels = json.data.dailyCounts.map(item => item.label);
		const salesCount = json.data.dailyCounts.map(item => parseInt(item.data));
		const salesAmount = json.data.dailyCounts.map(item => parseInt(item.data2));
		return { labels, salesCount, salesAmount };
	}
        
	$('#showChart').click(function() {
		var $s = $selector;
		if ($s.is(':visible')) {
			$s.hide();
		} else {
			if (!$selector.hasClass('chart-loaded')) {
				var $btn = $('#showChart');
				loadChart(null,null,$btn);
			} else {
				$s.show();
			}
		}
	});
	
	var loadChart = function(dateBegin, dateEnd, $trigger) {
		dateBegin = dateBegin || getDateFromNow(-30);
		dateEnd = dateEnd || getDateFromNow(0); 

		btnStartLoading($trigger);
		var query = {
				all:1,
				dateCreatedBegin:dateBegin,
				dateCreatedEnd:dateEnd,
		}
		var jsonData = $.ajax({
				url: GBF.baseUrl + '/ajax/GroupBuy/analytics',
				dataType: 'json',
				data:query
			})
			.done(function (json) {
				btnStopLoading($trigger);
				$selector.addClass('chart-loaded');
				$selector.show();
				//if (json.data.dailyCounts.length == 0) return;
				//createChart(selector + ' canvas', 'bar', "訂單數", json.data.dailyCounts, '日', 3, true);
				var data = processData(json);
				updateChart(data);
			});
	};
	
	if (!$selector.find('canvas').length) {
		initDatePicker(enableDateTimePicker);
		const html = `
					<div class="chart-container" style="position: relative; height:200px; width:100%">
						<canvas></canvas>
					</div>
					`
					;
		$selector.append(html);
	}
}