(function () {
  'use strict';

  /* Expose the real height of the fixed overlay nav (its children are
     absolutely positioned, so the header element itself measures 0). Inner
     pages pad their content below this so nothing sits under the stacked
     link column — the menu's always-expanded sublevels grow it. */
  function trackHeaderHeight() {
    var header = document.querySelector('.site-header');
    if (!header) return;
    var parts = [
      header.querySelector('.site-header__nav--primary'),
      header.querySelector('.site-header__logo')
    ].filter(Boolean);
    if (!parts.length) return;
    var set = function () {
      var bottom = 0;
      parts.forEach(function (el) {
        bottom = Math.max(bottom, el.getBoundingClientRect().bottom);
      });
      document.documentElement.style.setProperty('--header-height', Math.ceil(bottom) + 'px');
    };
    set();
    if ('ResizeObserver' in window) {
      var observer = new ResizeObserver(set);
      parts.forEach(function (el) {
        observer.observe(el);
      });
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

      /* The button is three spans — label, thin divider, price — so the
         price swaps without rebuilding the markup (Figma: "ADD TO CART | $"). */
      var label = button.querySelector('[data-atc-label]');
      var divider = button.querySelector('[data-atc-divider]');
      var price = button.querySelector('[data-atc-price]');

      select.addEventListener('change', function () {
        var variant = variants.find(function (v) {
          return String(v.id) === select.value;
        });
        if (!label || !divider || !price) return;
        if (variant && variant.available) {
          button.disabled = false;
          label.textContent = root.dataset.addText;
          divider.hidden = false;
          price.hidden = false;
          price.textContent = variant.price;
        } else {
          button.disabled = true;
          label.textContent = variant ? root.dataset.soldOutText : root.dataset.unavailableText;
          divider.hidden = true;
          price.hidden = true;
          price.textContent = '';
        }
      });
    });
  }

  /* NOTES tabs: role=tablist with roving tabindex + arrow-key navigation.
     Without JS every panel is visible, so content is never hidden. */
  function initTabs() {
    document.querySelectorAll('[data-tabs]').forEach(function (root) {
      var tabs = Array.prototype.slice.call(root.querySelectorAll('[role="tab"]'));
      if (tabs.length < 2) return;

      function select(tab) {
        tabs.forEach(function (t) {
          var selected = t === tab;
          t.setAttribute('aria-selected', selected ? 'true' : 'false');
          t.tabIndex = selected ? 0 : -1;
          var panel = document.getElementById(t.getAttribute('aria-controls'));
          if (panel) panel.hidden = !selected;
        });
      }

      tabs.forEach(function (tab, index) {
        tab.addEventListener('click', function () {
          select(tab);
        });
        tab.addEventListener('keydown', function (event) {
          var dir = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
          if (!dir) return;
          event.preventDefault();
          var next = tabs[(index + dir + tabs.length) % tabs.length];
          select(next);
          next.focus();
        });
      });
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    trackHeaderHeight();
    initDrawer();
    initProductForms();
    initTabs();
  });
})();
