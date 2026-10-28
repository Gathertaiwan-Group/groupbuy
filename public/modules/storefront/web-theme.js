/* 官網型頁面：快訊輪播（推導，見 templates/storefront/partials/web-marquee.html）。 */
(function () {
  function start() {
    var items = document.querySelectorAll('.nav-marquee-info .nav-marquee-text');
    if (items.length < 2) return;
    var i = 0;
    setInterval(function () {
      items[i].classList.add('d-none');
      i = (i + 1) % items.length;
      items[i].classList.remove('d-none');
    }, 4000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
