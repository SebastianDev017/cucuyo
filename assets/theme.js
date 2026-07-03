(function () {
  'use strict';

  /* Expose the real header height so the fixed sidebar can sit below it. */
  function trackHeaderHeight() {
    var header = document.querySelector('.site-header');
    if (!header) return;
    var set = function () {
      document.documentElement.style.setProperty('--header-height', header.offsetHeight + 'px');
    };
    set();
    if ('ResizeObserver' in window) {
      new ResizeObserver(set).observe(header);
    } else {
      window.addEventListener('resize', set);
    }
  }

  /* Mobile navigation drawer (native <dialog> for focus trap + top layer). */
  function initDrawer() {
    var drawer = document.getElementById('NavDrawer');
    if (!drawer) return;

    document.querySelectorAll('[data-drawer-open]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        drawer.showModal();
        btn.setAttribute('aria-expanded', 'true');
      });
    });

    var syncExpanded = function () {
      document.querySelectorAll('[data-drawer-open]').forEach(function (btn) {
        btn.setAttribute('aria-expanded', 'false');
      });
    };

    drawer.querySelectorAll('[data-drawer-close]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        drawer.close();
      });
    });

    /* Close when clicking the backdrop (outside the inner panel). */
    drawer.addEventListener('click', function (event) {
      if (event.target === drawer) drawer.close();
    });

    drawer.addEventListener('close', syncExpanded);
  }

  /* Product form: the variant <select> carries name="id" so the correct
     variant is submitted even without JS. Here we progressively enhance by
     updating the button's price and availability on change. Variant data is
     embedded server-side so prices keep the store's money format. */
  function initProductForms() {
    document.querySelectorAll('[data-product-form]').forEach(function (root) {
      var select = root.querySelector('[data-variant-select]');
      var dataEl = root.querySelector('[data-variant-data]');
      var button = root.querySelector('[data-add-button]');
      if (!select || !dataEl || !button) return;

      var variants;
      try {
        variants = JSON.parse(dataEl.textContent);
      } catch (error) {
        return;
      }

      select.addEventListener('change', function () {
        var variant = variants.find(function (v) {
          return String(v.id) === select.value;
        });
        if (!variant) {
          button.disabled = true;
          button.textContent = root.dataset.unavailableText;
          return;
        }
        if (variant.available) {
          button.disabled = false;
          button.textContent = root.dataset.addTemplate.replace('[PRICE]', variant.price);
        } else {
          button.disabled = true;
          button.textContent = root.dataset.soldOutText;
        }
      });
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    trackHeaderHeight();
    initDrawer();
    initProductForms();
  });
})();
