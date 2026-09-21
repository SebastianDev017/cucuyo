/* Cucuyo theme.js — rev: mobile drawer + focus wrap */
(function () {
  'use strict';

  /* Expose how far down the fixed header reaches INTO THE CONTENT COLUMN (its
     children are absolutely positioned, so the header element itself measures
     0). Inner pages pad their content below this so the header can never
     cover anything.

     Only the wordmark counts by default. It is centred over the content
     column, so content always has to clear it. The stacked link column is
     not: inner pages start their content at --sidebar-gutter, far to the
     right of it — that gutter is exactly what keeps them apart. Measuring the
     column too was reserving its full height as vertical space as well,
     ~180px of dead air, and made the whole page shift down by the height of
     the SHOP panel every time the dropdown opened.

     The column is still counted whenever it actually reaches into the content
     band — a very long menu label, or a layout with no gutter — so the
     guarantee holds in every case rather than by assumption. With no JS at
     all this never runs and the CSS keeps its generous 320px fallback. */
  function trackHeaderHeight() {
    var header = document.querySelector('.site-header');
    if (!header) return;
    var nav = header.querySelector('.site-header__nav--primary');
    var logo = header.querySelector('.site-header__logo');
    if (!nav && !logo) return;
    var main = document.querySelector('main');

    /* Measured from the header's own top, not the viewport's. The header
       now moves — it scrolls away with the page and parks above the viewport
       when hidden — and a resize caught in either state used to read a
       scrolled or negative bottom, which collapsed the clearance and pulled
       the whole page up under the nav. While the header sits at the top the
       two readings are identical. */
    var set = function () {
      var origin = header.getBoundingClientRect().top;
      var bottom = 0;
      if (logo) bottom = logo.getBoundingClientRect().bottom - origin;
      if (nav) {
        var navRect = nav.getBoundingClientRect();
        var gutter = main ? parseFloat(getComputedStyle(main).paddingLeft) : 0;
        if (!gutter || navRect.right > gutter) {
          bottom = Math.max(bottom, navRect.bottom - origin);
        }
      }
      document.documentElement.style.setProperty('--header-height', Math.ceil(bottom) + 'px');
    };

    set();
    if ('ResizeObserver' in window) {
      var observer = new ResizeObserver(set);
      [nav, logo].filter(Boolean).forEach(function (el) {
        observer.observe(el);
      });
    }
    /* Always on resize too: crossing the 1200px breakpoint moves the
       wordmark (centred → flush left) without necessarily resizing it, and a
       ResizeObserver only hears about size. */
    window.addEventListener('resize', set);
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

  /* Header on scroll — Eugenia's ask, modelled on hereustudio.com and
     measured there with real wheel scrolling (it runs Shopify Horizon's
     sticky="scroll-up" with transparent="not-sticky"):

       top       at the top of the page: transparent over the hero, in the
                 document, so it scrolls away WITH the content instead of
                 vanishing on the first pixel.
       hidden    once it has scrolled completely out of view going down.
                 Hiding from the revealed state is instant, as on HEREU.
       revealed  on ANY upward scroll past that point (HEREU reacts to a
                 6px nudge — there is no threshold): pinned to the top on a
                 solid ground, sliding down from above. HEREU itself fades in
                 over 125ms without moving; the slide is Eugenia's call.
       back to the very top (scrollY 0): transparent again, as HEREU does.

     Reduced motion gets no hiding and no sliding at all: `solid`, pinned and
     on its ground from the first frame. Without JS none of this runs.

     EVERY TEMPLATE, not only home, since the header became one row across
     the site: a fixed row of links over a scrolling collection or product
     page would sit on top of the content, which is exactly what this
     behaviour exists to avoid. On inner pages the top state looks the same
     as before — the header on the page's white, the content below it — it
     simply leaves on the way down instead of floating over the page.

     Two guarantees beyond HEREU's own. The header can never be hidden while
     the mobile menu is open — state is frozen for as long as the drawer is,
     and an open drawer always has its header showing. And keyboard focus
     reveals it: a hidden header stays focusable (moved, not visibility),
     so Shift+Tab back into the nav brings the nav into view with it. */
  function initStickyHeader() {
    var header = document.querySelector('.site-header');
    if (!header) return;
    var root = document.documentElement;
    var drawer = document.getElementById('NavDrawer');
    var reduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

    var state = '';
    var lastY = window.scrollY;
    var reach = 0;
    var ticking = false;

    var set = function (next) {
      if (next === state) return;
      state = next;
      header.setAttribute('data-header-state', next);
    };

    /* The header box measures 0 (its children are absolutely positioned),
       so its reach is read off the children that are actually showing: the
       wordmark and the stacked link column on a desktop, the wordmark and the
       burger on a phone. The solid ground is as tall as that, plus the same
       gap below the lowest item as there is above the highest — so it is
       sized by the header's real content, and grows with the SHOP panel. */
    var measure = function () {
      var origin = header.getBoundingClientRect().top;
      var high = Infinity;
      var low = 0;
      header.querySelectorAll('.site-header__logo, .site-header__nav--primary, .site-header__burger').forEach(function (el) {
        var r = el.getBoundingClientRect();
        if (!r.width || !r.height) return;
        high = Math.min(high, r.top - origin);
        low = Math.max(low, r.bottom - origin);
      });
      if (!isFinite(high)) return;
      reach = low;
      var panel = Math.ceil(low + high);
      root.style.setProperty('--header-panel', panel + 'px');
      /* keyboard focus and anchor jumps must land below the pinned ground,
         never underneath it */
      root.style.scrollPaddingTop = panel + 'px';
    };

    var update = function () {
      ticking = false;
      var y = window.scrollY;
      if (drawer && drawer.open) {
        lastY = y;
        return;
      }
      if (reduce && reduce.matches) {
        set('solid');
      } else if (y <= 0) {
        set('top');
      } else if (y > lastY + 1) {
        set(y > reach ? 'hidden' : 'top');
      } else if (y < lastY - 1 && (y > reach || state !== 'top')) {
        set('revealed');
      } else if (!state) {
        set(y > reach ? 'hidden' : 'top');
      }
      lastY = y;
    };

    var schedule = function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    };

    measure();
    update();

    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', function () {
      measure();
      schedule();
    });
    if ('ResizeObserver' in window) {
      var watch = new ResizeObserver(measure);
      header.querySelectorAll('.site-header__logo, .site-header__nav--primary, .site-header__burger').forEach(function (el) {
        watch.observe(el);
      });
    }
    if (reduce) {
      var onReduce = function () {
        state = '';
        update();
      };
      if (reduce.addEventListener) reduce.addEventListener('change', onReduce);
      else if (reduce.addListener) reduce.addListener(onReduce);
    }

    header.addEventListener('focusin', function () {
      if (state === 'hidden') set('revealed');
    });

    if (drawer) {
      drawer.addEventListener('close', function () {
        /* the scroll lock may have moved nothing, but the last reading is
           stale either way: start the next comparison from where we are */
        lastY = window.scrollY;
      });
      document.querySelectorAll('[data-drawer-open]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          if (state === 'hidden') set('revealed');
        });
      });
    }

    if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
    window.addEventListener('pageshow', function () {
      measure();
      lastY = window.scrollY;
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
        /* showModal() lands on the first focusable, which is the wordmark —
           a focus ring around the brand mark reads as a defect. Move it to
           the close button: same trap, expected target, ring looks placed. */
        var close = drawer.querySelector('[data-drawer-close]');
        if (close) close.focus();
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
  /* The product page's variant engine — ONE engine for every option, not one
     per control type. Colour swatches, option buttons and the dropdown are
     all just controls that carry an option position and a value; the engine
     keeps the chosen combination and resolves it against the variant list.

     This is why it cannot simply follow the link it was clicked on: with two
     options, picking a size has to keep the colour already chosen, and the
     other control's links then point at the wrong variants. So the state is
     the combination, and every control is re-pointed after each change.

     Without JS none of this runs and each control is still a plain link to a
     real variant URL, which Shopify renders correctly server-side. */
  function initVariantOptions() {
    var root = document.querySelector('[data-product-form]');
    if (!root) return;
    var dataEl = root.querySelector('[data-variant-data]');
    if (!dataEl) return;

    var variants;
    try {
      variants = JSON.parse(dataEl.textContent);
    } catch (error) {
      return;
    }
    if (!variants.length) return;

    var scope = document.querySelector('.main-product') || document;
    var controls = Array.prototype.slice.call(
      scope.querySelectorAll('[data-variant-control], [data-swatch]')
    );
    var selects = Array.prototype.slice.call(scope.querySelectorAll('[data-variant-nav]'));
    if (!controls.length && !selects.length) return;

    var button = root.querySelector('[data-add-button]');
    var label = button && button.querySelector('[data-atc-label]');
    var divider = button && button.querySelector('[data-atc-divider]');
    var price = button && button.querySelector('[data-atc-price]');
    var compareEl = root.querySelector('[data-pdp-compare]');
    var idInput = root.querySelector('[data-variant-id]');
    var heroImg = document.querySelector('.main-product__media-item--hero img');
    var colorLine = document.querySelector('[data-pdp-color]');
    var galleryItems = Array.prototype.slice.call(document.querySelectorAll('[data-gallery-item]'));

    /* current combination, taken from whatever the server rendered as chosen */
    var current = variants.filter(function (v) {
      return idInput && String(v.id) === String(idInput.value);
    })[0] || variants[0];
    var chosen = current.options.slice();

    var findExact = function (combo) {
      for (var i = 0; i < variants.length; i++) {
        var v = variants[i];
        var hit = true;
        for (var j = 0; j < combo.length; j++) {
          if (v.options[j] !== combo[j]) { hit = false; break; }
        }
        if (hit) return v;
      }
      return null;
    };

    /* When the combination the shopper built does not exist, keep the value
       they just touched and fall back to any available variant carrying it,
       rather than silently ignoring the click. */
    var resolve = function (position, value) {
      var combo = chosen.slice();
      combo[position - 1] = value;
      var exact = findExact(combo);
      if (exact) return exact;
      var fallback = null;
      for (var i = 0; i < variants.length; i++) {
        if (variants[i].options[position - 1] !== value) continue;
        if (variants[i].available) return variants[i];
        if (!fallback) fallback = variants[i];
      }
      return fallback;
    };

    var swapImage = function (img, src, alt) {
      if (!img || !src) return;
      /* srcset outranks src, so it has to go before the swap */
      img.removeAttribute('srcset');
      img.removeAttribute('sizes');
      img.src = src;
      if (alt) img.alt = alt;
    };

    var apply = function (variant) {
      if (!variant) return;
      chosen = variant.options.slice();

      controls.forEach(function (el) {
        var pos = parseInt(el.getAttribute('data-option-position'), 10);
        var val = el.getAttribute('data-option-value');
        if (!pos || val === null) return;
        /* mark the chosen one */
        if (chosen[pos - 1] === val) el.setAttribute('aria-current', 'true');
        else el.removeAttribute('aria-current');
        /* re-point at the variant this value now leads to, given the rest */
        var combo = chosen.slice();
        combo[pos - 1] = val;
        var target = findExact(combo);
        if (target) {
          if (target.url) el.setAttribute('href', target.url);
          el.setAttribute('data-variant-id', target.id);
          el.setAttribute('data-variant-available', String(target.available));
          el.classList.toggle('variant-option__button--unavailable', !target.available);
          el.classList.toggle('swatch--unavailable', !target.available && el.hasAttribute('data-swatch'));
        }
      });

      selects.forEach(function (sel) {
        Array.prototype.slice.call(sel.options).forEach(function (opt) {
          var pos = parseInt(opt.getAttribute('data-option-position'), 10);
          var val = opt.getAttribute('data-option-value');
          if (!pos || val === null) return;
          opt.selected = chosen[pos - 1] === val;
          var combo = chosen.slice();
          combo[pos - 1] = val;
          var target = findExact(combo);
          if (target) opt.value = target.url;
        });
      });

      if (idInput) idInput.value = variant.id;
      if (price && variant.price) price.textContent = variant.price;
      if (compareEl) {
        if (variant.compare) {
          compareEl.textContent = variant.compare;
          compareEl.hidden = false;
        } else {
          compareEl.textContent = '';
          compareEl.hidden = true;
        }
      }
      swapImage(heroImg, variant.image, variant.imageAlt);

      /* Gallery: keep the photographs labelled for this variant, plus every
         unlabelled one — those are shared (packaging, scale) and belong to
         all of them. Liquid already did this for the page as it arrived; this
         only re-does it when the shopper switches without a reload. */
      if (galleryItems.length) {
        var chosenLower = chosen.map(function (v) {
          return String(v).toLowerCase();
        });
        galleryItems.forEach(function (item) {
          var label = item.getAttribute('data-variant-label');
          item.hidden = label ? chosenLower.indexOf(label) === -1 : false;
        });
      }

      if (colorLine) {
        /* the Product details block prints the chosen colour by name */
        controls.forEach(function (el) {
          if (!el.hasAttribute('data-swatch')) return;
          var pos = parseInt(el.getAttribute('data-option-position'), 10);
          if (pos) colorLine.textContent = chosen[pos - 1];
        });
      }
      if (button && label && divider && price) {
        button.disabled = !variant.available;
        label.textContent = variant.available ? root.dataset.addText : root.dataset.soldOutText;
        divider.hidden = !variant.available;
        price.hidden = !variant.available;
      }
      if (variant.url && window.history && window.history.replaceState) {
        window.history.replaceState({}, '', variant.url);
      }
    };

    scope.addEventListener('click', function (event) {
      var el = event.target.closest('[data-variant-control], [data-swatch]');
      if (!el || !scope.contains(el)) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      var pos = parseInt(el.getAttribute('data-option-position'), 10);
      var val = el.getAttribute('data-option-value');
      if (!pos || val === null) return;   // a card swatch, or markup without state
      event.preventDefault();
      apply(resolve(pos, val));
    });

    selects.forEach(function (sel) {
      sel.addEventListener('change', function () {
        var opt = sel.options[sel.selectedIndex];
        var pos = parseInt(opt.getAttribute('data-option-position'), 10);
        var val = opt.getAttribute('data-option-value');
        if (!pos || val === null) return;
        apply(resolve(pos, val));
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


  /* SHOP dropdown. The markup is a real <details>, so with no JS the click
     already toggles it — this adds the open/close animation and the
     close-on-click-outside. In the vertical column and the drawer the panel
     animates its own height and pushes the links below it down, the way
     spartan-shop.com does; in the header row it is an overlay under the bar
     that moves nothing (base.css), and a mouse opens it on hover.

     <details> collapses the instant `open` is removed, so closing has to be
     driven the other way round: animate first, drop the attribute on
     transitionend. Height goes 0 -> measured -> auto, because a fixed height
     would stop the panel growing if its content reflows. */
  function initNavDisclosure() {
    var groups = Array.prototype.slice.call(document.querySelectorAll('[data-nav-disclosure]'));
    if (!groups.length) return;

    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* A run can be interrupted — hover out and back in, a second tap — so
       each one cancels the one before it and starts from the height that one
       reached, which also makes a reversal smooth. While a close is running
       the attribute is still there, so "is it open" is the attribute minus a
       close in flight (isOpen below), never the attribute alone. */
    var animate = function (details, panel, opening) {
      var running = panel.hasAttribute('data-animating');
      var start = running ? panel.getBoundingClientRect().height : (opening ? 0 : panel.scrollHeight);
      if (panel._navStop) panel._navStop();
      details._navClosing = !opening;

      if (reduce) {
        if (!opening) details.removeAttribute('open');
        details._navClosing = false;
        return;
      }
      var end = opening ? panel.scrollHeight : 0;

      panel.setAttribute('data-animating', '');
      panel.style.height = start + 'px';
      /* force a reflow so the browser has a from-value to transition from */
      void panel.offsetHeight;
      panel.style.height = end + 'px';

      var timer = null;
      var stop = function () {
        panel.removeEventListener('transitionend', onEnd);
        clearTimeout(timer);
        panel._navStop = null;
        panel.removeAttribute('data-animating');
        panel.style.height = '';
      };
      var finish = function () {
        stop();
        if (!opening) details.removeAttribute('open');
        details._navClosing = false;
      };
      var onEnd = function (event) {
        if (event.target === panel && event.propertyName === 'height') finish();
      };
      panel._navStop = stop;
      panel.addEventListener('transitionend', onEnd);
      /* transitionend never fires if the panel has no height to travel, and
         is skipped if the transition is cut short some other way */
      if (start === end) finish();
      else timer = setTimeout(finish, 700);
    };

    var isOpen = function (details) {
      return details.open && !details._navClosing;
    };

    /* In the header ROW (1200px up) the panel is an overlay (base.css), and
       a mouse opens it on hover the way HEREU's does. Touch keeps the tap,
       which the click handler below already is, and the keyboard keeps the
       native <details>: Enter or Space on SHOP toggles it, Tab walks into the
       panel, and leaving it with Tab closes it. Hover is mouse-only on
       purpose — a tap also fires pointerenter, and opening on that plus
       toggling on the click that follows would shut it again at once. */
    var rowQuery = window.matchMedia ? window.matchMedia('(min-width: 1200px)') : null;
    var inRow = function () {
      return !!(rowQuery && rowQuery.matches);
    };

    groups.forEach(function (details) {
      var summary = details.querySelector('.nav-disclosure__summary');
      var panel = details.querySelector('[data-nav-panel]');
      if (!summary || !panel) return;

      var inBar = !!details.closest('.site-header__nav--primary');
      var openedByHover = false;
      var leaveTimer = null;

      var open = function () {
        details.setAttribute('open', '');
        animate(details, panel, true);
      };
      var close = function () {
        openedByHover = false;
        if (isOpen(details)) animate(details, panel, false);
      };

      summary.addEventListener('click', function (event) {
        event.preventDefault();
        /* A mouse that opened it by hovering and then clicks the label means
           "yes, this" — not "close it". Keyboard clicks carry detail 0. */
        if (openedByHover && event.detail > 0 && inRow()) return;
        if (isOpen(details)) close();
        else open();
      });

      if (!inBar) return;

      details.addEventListener('pointerenter', function (event) {
        if (event.pointerType !== 'mouse' || !inRow()) return;
        clearTimeout(leaveTimer);
        if (isOpen(details)) return;
        openedByHover = true;
        open();
      });

      /* a short grace period, so a pointer that grazes the edge on its way
         into the panel does not shut it */
      details.addEventListener('pointerleave', function (event) {
        if (event.pointerType !== 'mouse' || !inRow()) return;
        clearTimeout(leaveTimer);
        leaveTimer = setTimeout(close, 140);
      });

      details.addEventListener('focusout', function (event) {
        if (!inRow() || !isOpen(details)) return;
        if (event.relatedTarget && details.contains(event.relatedTarget)) return;
        close();
      });
    });

    /* A click anywhere that is not inside an open disclosure closes it. */
    var closeOutside = function (event) {
      groups.forEach(function (details) {
        if (!isOpen(details)) return;
        if (details.contains(event.target)) return;
        var panel = details.querySelector('[data-nav-panel]');
        if (panel) animate(details, panel, false);
      });
    };
    document.addEventListener('click', closeOutside);

    /* In the row it also closes on the press itself, in the capture phase:
       the home slider and other drag surfaces cancel the click a touch would
       make, and the overlay must still shut when someone taps the page. Safe
       there because closing an overlay moves nothing. Not in the column,
       where the panel pushes: closing on press would slide the links below
       it up before the release, and the click would land on another link. */
    document.addEventListener('pointerdown', function (event) {
      if (inRow()) closeOutside(event);
    }, true);

    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      groups.forEach(function (details) {
        if (!isOpen(details)) return;
        var panel = details.querySelector('[data-nav-panel]');
        if (panel) animate(details, panel, false);
        var summary = details.querySelector('.nav-disclosure__summary');
        if (summary) summary.focus();
      });
    });
  }

  /* Colour swatches ON GRID CARDS only. Every swatch is already a link to its
     own variant's URL, so this is pure enhancement: intercept the click and
     move the card to that variant in place — image, price, and where the card
     leads — instead of reloading.

     The product page is NOT handled here. Its swatches are one control among
     several (a product can also have Size), so they belong to the variant
     engine that keeps the whole combination; running both would fight over
     the same clicks. Cards stay simple on purpose: one colour, one card. */
  function initCardSwatches() {
    var groups = Array.prototype.slice.call(
      document.querySelectorAll('[data-product-card] [data-swatches], .image-card [data-swatches]')
    );
    if (!groups.length) return;

    var select = function (group, swatch) {
      group.querySelectorAll('[data-swatch]').forEach(function (other) {
        if (other === swatch) other.setAttribute('aria-current', 'true');
        else other.removeAttribute('aria-current');
      });
    };

    var swapImage = function (img, src, alt) {
      if (!img || !src) return;
      /* srcset outranks src, so it has to go before the swap or the browser
         keeps painting the old candidate */
      img.removeAttribute('srcset');
      img.removeAttribute('sizes');
      img.src = src;
      if (alt) img.alt = alt;
    };

    groups.forEach(function (group) {
      var onCard = group.closest('[data-product-card], .image-card');
      if (!onCard) return;

      group.addEventListener('click', function (event) {
        var swatch = event.target.closest('[data-swatch]');
        if (!swatch || !group.contains(swatch)) return;
        /* let modified clicks (new tab, download) behave normally */
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();

        select(group, swatch);
        var image = swatch.getAttribute('data-variant-image');
        var imageAlt = swatch.getAttribute('data-variant-image-alt');
        var price = swatch.getAttribute('data-variant-price');
        var compare = swatch.getAttribute('data-variant-compare');
        var href = swatch.getAttribute('href');

        /* compare-at can be set on one colour and not another, so the pair
           has to move together — a stale strike-through reads as a lie */
        var setCompare = function (el) {
          if (!el) return;
          if (compare) {
            el.textContent = compare;
            el.hidden = false;
          } else {
            el.textContent = '';
            el.hidden = true;
          }
        };

        swapImage(onCard.querySelector('.product-card__image:not(.product-card__image--hover), .image-card__media'), image, imageAlt);
        /* the stored hover photograph belongs to the colour the card was
           built with, so once another colour is showing it is dropped
           instead of fading in over it */
        if (image) onCard.setAttribute('data-hover-image', 'off');
        var cardPrice = onCard.querySelector('[data-card-price]');
        if (cardPrice && price) cardPrice.textContent = price;
        setCompare(onCard.querySelector('[data-card-compare]'));
        /* the card itself must now open the colour the shopper picked */
        onCard.querySelectorAll('[data-card-link]').forEach(function (link) {
          link.setAttribute('href', href);
        });
      });
    });
  }

  /* The oversized featured tile spans two grid rows, but its own text block
     sits under its image, so the image's bottom edge only lines up with the
     second row of photographs when the featured text happens to be exactly
     as tall as its neighbours' — a different title wrap breaks the line
     (Jenn's screenshot: the big image ran past the row beside it). CSS has
     no way to say "end where the neighbouring image ends" across auto rows,
     so this measures it: the featured image gets an explicit height that
     puts its bottom edge level with the images in the last row it spans.
     offsetTop is used throughout because it ignores the reveal transforms.
     Without JS the CSS stretch fallback stays — close, not exact.

     THERE IS NO CROP BUDGET. The edge lines up at every width, whatever that
     costs the photograph — up past 30% on the narrowest screens, which is
     accepted. Earlier rounds capped the stretch (first at 1.08, then as a
     22% photo-loss limit) and both left a residual step somewhere in the
     range; the step is what reads as broken, so alignment wins outright.

     The one remaining bound is a sanity guard, not a design budget: it only
     stops a miscalculation from producing an absurd height, and sits far
     above anything a real layout asks for (measured worst case is 1.42). */
  var SANITY_MAX_STRETCH = 4;

  function initFeaturedAlign() {
    var grids = document.querySelectorAll('.card-grid.collection-grid');
    if (!grids.length) return;

    var absTop = function (el) {
      var top = 0;
      while (el) {
        top += el.offsetTop;
        el = el.offsetParent;
      }
      return top;
    };

    var alignGrid = function (grid) {
      var featured = grid.querySelector('.product-card--featured');
      if (!featured) return;
      var media = featured.querySelector('.product-card__media');
      if (!media) return;

      /* The CSS fallback lets the featured link grow to fill the two rows it
         spans. Once this function gives the image an explicit height that is
         no longer wanted: the link would keep growing and leave a gap between
         the card's text and its swatches, while every other card has them
         together. So whoever sets the height also stops the growth. */
      var link = featured.querySelector('.product-card__link');
      var release = function () {
        media.style.height = '';
        media.style.flex = '';
        if (link) link.style.flex = '';
      };

      if (window.innerWidth < 750) {
        release();
        return;
      }

      /* Measuring once is not enough. The tile spans two rows, so if its own
         text block is taller than its neighbours', giving the image the
         height that would line it up makes the whole card taller than the
         two rows beside it — the grid then grows those rows to fit, which
         moves the very edge being aimed at. Solving it in closed form would
         hard-code the grid's distribution rules; measuring again instead
         converges, because each pass halves the error (the surplus is split
         between the two spanned rows). Eight passes puts it well under a
         pixel, and it stops as soon as it lands. */
      var shape = 0; // width/height of an ordinary card's image — the house shape
      var landed = false;

      for (var pass = 0; pass < 8; pass++) {
        var featTop = absTop(featured);
        var featBottom = featTop + featured.offsetHeight;
        var target = 0;
        grid.querySelectorAll('.product-card').forEach(function (card) {
          if (card === featured) return;
          var img = card.querySelector('.product-card__media');
          if (img && !shape && img.offsetHeight) shape = img.offsetWidth / img.offsetHeight;
          var top = absTop(card);
          if (top <= featTop + 1 || top >= featBottom) return; // only the 2nd spanned row
          if (!img) return;
          target = Math.max(target, absTop(img) + img.offsetHeight);
        });
        if (!target) {
          if (!landed) release();
          return;
        }

        var height = target - absTop(media);
        if (shape) {
          height = Math.min(height, (media.offsetWidth / shape) * SANITY_MAX_STRETCH);
        }
        if (height <= 0) return;
        if (Math.abs(media.offsetHeight - height) <= 0.5) return; // flush already
        media.style.flex = 'none';
        media.style.height = height + 'px';
        if (link) link.style.flex = 'none';
        landed = true;
      }
    };

    var align = function () {
      grids.forEach(alignGrid);
    };

    align();
    /* alignGrid converges internally; this only catches layout that settles
       a frame later (web fonts, a late image). */
    requestAnimationFrame(align);

    if ('ResizeObserver' in window) {
      grids.forEach(function (grid) {
        new ResizeObserver(align).observe(grid);
      });
    } else {
      window.addEventListener('resize', align);
    }
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(align);
    }
    window.addEventListener('load', align);
  }

  /* Story gallery — the row already scrolls: it is a real scroll container,
     so touch, trackpad, keyboard and assistive tech need nothing from us.
     What a mouse has no gesture for is dragging, and that is all this adds.
     Pointer capture keeps the drag alive when the cursor leaves the row. */
  function initStoryGallery() {
    var tracks = document.querySelectorAll('[data-gallery-track]');
    Array.prototype.forEach.call(tracks, function (track) {
      if (track.dataset.dragReady) return;
      track.dataset.dragReady = '1';

      var startX = 0;
      var startLeft = 0;
      var dragging = false;

      track.addEventListener('pointerdown', function (e) {
        if (e.pointerType !== 'mouse' || e.button !== 0) return;
        dragging = true;
        startX = e.clientX;
        startLeft = track.scrollLeft;
        track.setAttribute('data-dragging', '');
        track.setPointerCapture(e.pointerId);
      });

      track.addEventListener('pointermove', function (e) {
        if (!dragging) return;
        e.preventDefault();
        track.scrollLeft = startLeft - (e.clientX - startX);
      });

      var end = function (e) {
        if (!dragging) return;
        dragging = false;
        track.removeAttribute('data-dragging');
        if (e.pointerId != null && track.hasPointerCapture(e.pointerId)) {
          track.releasePointerCapture(e.pointerId);
        }
      };

      track.addEventListener('pointerup', end);
      track.addEventListener('pointercancel', end);
    });
  }

  /* Story sequence — page scroll becomes sideways travel.

     The markup already works without this: the viewport is a horizontal
     scroller with snap points. This upgrades it to a pinned run by giving the
     scroller the height of the travel and translating the track against the
     page's own scroll, which keeps the browser's scrollbar honest — nothing
     is hijacked, the page really is that tall.

     It declines on narrow screens and under reduced motion. Taking someone's
     scroll direction away is not something to do to a visitor who asked the
     system for less movement, and on a phone a swipe is already the better
     gesture. */
  function initStorySequence() {
    var sections = document.querySelectorAll('[data-sequence-section]');
    if (!sections.length) return;

    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

    Array.prototype.forEach.call(sections, function (section) {
      if (section.dataset.seqReady) return;
      section.dataset.seqReady = '1';

      var scroller = section.querySelector('[data-sequence]');
      var viewport = section.querySelector('.story-sequence__viewport');
      var track = section.querySelector('[data-sequence-track]');
      var bar = section.querySelector('[data-sequence-bar]');
      if (!scroller || !viewport || !track) return;

      var travel = 0;
      var stickyTop = 0;
      var pinned = false;
      var ticking = false;

      var unpin = function () {
        pinned = false;
        section.removeAttribute('data-pinned');
        scroller.style.height = '';
        track.style.transform = '';
        if (bar) bar.style.width = viewport.scrollWidth > viewport.clientWidth ? '0%' : '100%';
      };

      var measure = function () {
        if (reduce.matches || window.innerWidth < 750) {
          unpin();
          return;
        }
        /* Pin FIRST, then measure. Pinning changes the viewport's own height
           (it drops the wordmark's clearance), and a scroller sized from the
           unpinned height overshoots the travel by exactly that much. A
           sticky element still occupies its normal space, so clearing the
           scroller's height here gives its true base. */
        section.setAttribute('data-pinned', '');
        scroller.style.height = '';
        travel = track.scrollWidth - viewport.clientWidth;
        if (travel <= 1) {
          unpin();
          return;
        }
        pinned = true;
        stickyTop = parseFloat(getComputedStyle(viewport).top) || 0;
        scroller.style.height = viewport.offsetHeight + travel + 'px';
        update();
      };

      var update = function () {
        ticking = false;
        if (!pinned) {
          if (bar) {
            var max = viewport.scrollWidth - viewport.clientWidth;
            bar.style.width = (max > 0 ? (viewport.scrollLeft / max) * 100 : 100) + '%';
          }
          return;
        }
        var total = scroller.offsetHeight - viewport.offsetHeight;
        var progress = 0;
        if (total > 0) {
          /* measured against where the viewport parks, not against zero: it
             sticks under the wordmark, so the travel starts that much later */
          progress = Math.min(1, Math.max(0, (stickyTop - scroller.getBoundingClientRect().top) / total));
        }
        track.style.transform = 'translate3d(' + -(progress * travel).toFixed(2) + 'px, 0, 0)';
        if (bar) bar.style.width = (progress * 100).toFixed(2) + '%';
      };

      var request = function () {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(update);
      };

      window.addEventListener('scroll', request, { passive: true });
      viewport.addEventListener('scroll', request, { passive: true });
      window.addEventListener('resize', measure);
      if (reduce.addEventListener) reduce.addEventListener('change', measure);
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
      window.addEventListener('load', measure);

      measure();
    });
  }

  /* PRODUCT STRIP arrows (us.thehoffbrand.com). The track scrolls on its own;
     this only drives the two buttons and keeps them honest about what they
     can still do. One click moves a whole screenful of cards, rounded down to
     a whole number of them, and the snap points land the row on a card edge.

     The arrows stay out of the way when they would be useless: hidden while
     the cards fit without scrolling (a short "You may like" on a small
     category), and disabled — invisible, unclickable, out of the tab order —
     at each end. Without JS the arrows never appear and the row is still
     swipeable, scrollable and tabbable. */
  function initProductStrips() {
    var strips = Array.prototype.slice.call(document.querySelectorAll('[data-product-strip]'));
    if (!strips.length) return;

    var reduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

    strips.forEach(function (strip) {
      /* the customizer re-runs this on every section render, and a strip that
         is already wired must not collect a second set of listeners */
      if (strip.hasAttribute('data-strip-ready')) return;
      strip.setAttribute('data-strip-ready', '');

      var track = strip.querySelector('[data-strip-track]');
      var arrows = strip.querySelector('[data-strip-arrows]');
      var prev = strip.querySelector('[data-strip-prev]');
      var next = strip.querySelector('[data-strip-next]');
      if (!track || !arrows || !prev || !next) return;

      var ticking = false;

      var update = function () {
        ticking = false;
        /* sub-pixel track widths round the wrong way, hence the 2px slack */
        var scrollable = track.scrollWidth - track.clientWidth > 2;
        arrows.hidden = !scrollable;
        if (!scrollable) return;
        prev.disabled = track.scrollLeft <= 1;
        next.disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 1;
      };

      var schedule = function () {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(update);
      };

      var step = function () {
        var item = track.firstElementChild;
        if (!item) return track.clientWidth;
        var gap = parseFloat(getComputedStyle(track).columnGap) || 0;
        var pitch = item.getBoundingClientRect().width + gap;
        if (!pitch) return track.clientWidth;
        return Math.max(pitch, Math.floor(track.clientWidth / pitch) * pitch);
      };

      var move = function (dir) {
        track.scrollBy({
          left: dir * step(),
          behavior: reduce && reduce.matches ? 'auto' : 'smooth'
        });
      };

      prev.addEventListener('click', function () {
        move(-1);
      });
      next.addEventListener('click', function () {
        move(1);
      });
      track.addEventListener('scroll', schedule, { passive: true });
      window.addEventListener('resize', schedule);
      /* images arrive after the first measure and change the track's width */
      window.addEventListener('load', update);
      track.querySelectorAll('img').forEach(function (img) {
        if (!img.complete) img.addEventListener('load', schedule, { once: true });
      });

      update();
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    trackHeaderHeight();
    initHeaderTone();
    initNavDisclosure();
    initDrawer();
    initStickyHeader();
    initAutoplayVideos();
    initCartCount();
    initTabs();
    initCardSwatches();
    initProductStrips();
    initVariantOptions();
    initFeaturedAlign();
    initStoryGallery();
    initStorySequence();
  });

  /* The customizer re-renders one section at a time; both story helpers are
     idempotent, so re-running them only picks up what has just arrived. */
  document.addEventListener('shopify:section:load', function () {
    initStoryGallery();
    initStorySequence();
    initProductStrips();
  });
})();
