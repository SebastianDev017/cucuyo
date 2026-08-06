/* Cucuyo theme.js — rev: mobile drawer + focus wrap */
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

  /* Home only: the header is deliberately transparent over full-bleed
     imagery, so its ink has to follow whatever section is passing under it.
     Each home section declares data-header-tone; the probe sits at the
     vertical middle of the header's text block. Inner pages keep their
     static ink and never enter here. Failure mode is the light tone the
     hero is built for, so the hero always reads correctly. */
  function initHeaderTone() {
    if (!document.body.classList.contains('template-index')) return;
    var zones = Array.prototype.slice.call(document.querySelectorAll('[data-header-tone]'));
    if (!zones.length) return;

    var PROBE = 120;
    var ticking = false;
    var apply = function () {
      ticking = false;
      var tone = 'light';
      for (var i = 0; i < zones.length; i++) {
        var rect = zones[i].getBoundingClientRect();
        if (rect.top <= PROBE && rect.bottom > PROBE) {
          tone = zones[i].getAttribute('data-header-tone') || 'light';
          break;
        }
      }
      document.body.classList.toggle('header-ink', tone === 'ink');
    };
    var schedule = function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(apply);
    };

    apply();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    window.addEventListener('pageshow', schedule);
    document.addEventListener('shopify:section:load', function () {
      zones = Array.prototype.slice.call(document.querySelectorAll('[data-header-tone]'));
      schedule();
    });
  }

  /* Mobile navigation drawer (native <dialog>: focus trap, Esc close and
     focus return to the trigger are built in). We add page scroll locking —
     Lenis owns wheel scrolling, so it gets stopped too — and close the
     drawer if the viewport grows past the mobile breakpoint. */
  function initDrawer() {
    var drawer = document.getElementById('NavDrawer');
    if (!drawer) return;

    var lockScroll = function (lock) {
      document.documentElement.classList.toggle('nav-drawer-open', lock);
      if (window.lenis) {
        if (lock) window.lenis.stop();
        else window.lenis.start();
      }
    };

    document.querySelectorAll('[data-drawer-open]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        drawer.showModal();
        lockScroll(true);
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

    /* Native modal dialogs still let Tab escape to browser UI; wrap focus at
       the edges so it stays inside while the drawer is open. */
    drawer.addEventListener('keydown', function (event) {
      if (event.key !== 'Tab') return;
      var focusables = drawer.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (!focusables.length) return;
      var first = focusables[0];
      var last = focusables[focusables.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === drawer)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });

    drawer.addEventListener('close', function () {
      syncExpanded();
      lockScroll(false);
    });

    if (window.matchMedia) {
      var mq = window.matchMedia('(min-width: 768px)');
      var onChange = function (event) {
        if (event.matches && drawer.open) drawer.close();
      };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  }

  /* Muted inline autoplay hardening for iOS/WebKit. The <video> already
     carries the native autoplay/muted/playsinline attributes (declarative
     path — the one WebKit honors most reliably); this only retries the
     cases WebKit is known to drop: the muted IDL property not being set,
     bfcache restores coming back paused, and below-fold videos. Every
     play() is a caught no-op when the policy still says no. */
  function initAutoplayVideos() {
    var videos = document.querySelectorAll('video[data-autoplay-video]');
    if (!videos.length) return;

    var nudge = function (video) {
      video.muted = true;
      if (video.paused) {
        var attempt = video.play();
        if (attempt && attempt.catch) attempt.catch(function () {});
      }
    };

    videos.forEach(function (video) {
      nudge(video);
    });

    if ('IntersectionObserver' in window) {
      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) nudge(entry.target);
        });
      }, { threshold: 0.2 });
      videos.forEach(function (video) {
        observer.observe(video);
      });
    }

    window.addEventListener('pageshow', function (event) {
      if (event.persisted) {
        videos.forEach(function (video) {
          nudge(video);
        });
      }
    });
  }

  /* Live cart count: SSR-cached pages and bfcache restores (back button
     after an add to cart) can carry a stale number, so sync it from
     /cart.js on load and on every bfcache restore. */
  function initCartCount() {
    var els = document.querySelectorAll('[data-cart-count]');
    if (!els.length) return;
    var refresh = function () {
      fetch('/cart.js')
        .then(function (response) { return response.json(); })
        .then(function (cart) {
          els.forEach(function (el) {
            el.textContent = cart.item_count;
          });
        })
        .catch(function () {});
    };
    refresh();
    window.addEventListener('pageshow', function (event) {
      if (event.persisted) refresh();
    });
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
    initHeaderTone();
    initDrawer();
    initAutoplayVideos();
    initCartCount();
    initProductForms();
    initTabs();
  });
})();
