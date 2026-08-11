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

    var set = function () {
      var bottom = 0;
      if (logo) bottom = logo.getBoundingClientRect().bottom;
      if (nav) {
        var navRect = nav.getBoundingClientRect();
        var gutter = main ? parseFloat(getComputedStyle(main).paddingLeft) : 0;
        if (!gutter || navRect.right > gutter) {
          bottom = Math.max(bottom, navRect.bottom);
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
     already toggles it — this only adds the open/close animation and the
     close-on-click-outside, matching what spartan-shop.com does: the panel
     animates its own height and pushes the column below it down, it never
     floats over the page.

     <details> collapses the instant `open` is removed, so closing has to be
     driven the other way round: animate first, drop the attribute on
     transitionend. Height goes 0 -> measured -> auto, because a fixed height
     would stop the panel growing if its content reflows. */
  function initNavDisclosure() {
    var groups = Array.prototype.slice.call(document.querySelectorAll('[data-nav-disclosure]'));
    if (!groups.length) return;

    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    var animate = function (details, panel, opening) {
      if (reduce) {
        if (!opening) details.removeAttribute('open');
        return;
      }
      var start = opening ? 0 : panel.scrollHeight;
      var end = opening ? panel.scrollHeight : 0;

      panel.setAttribute('data-animating', '');
      panel.style.height = start + 'px';
      /* force a reflow so the browser has a from-value to transition from */
      void panel.offsetHeight;
      panel.style.height = end + 'px';

      var done = function (event) {
        if (event && event.target !== panel) return;
        panel.removeEventListener('transitionend', done);
        panel.removeAttribute('data-animating');
        panel.style.height = '';
        if (!opening) details.removeAttribute('open');
      };
      panel.addEventListener('transitionend', done);
      /* transitionend never fires if the panel has no height to travel */
      if (start === end) done();
    };

    groups.forEach(function (details) {
      var summary = details.querySelector('.nav-disclosure__summary');
      var panel = details.querySelector('[data-nav-panel]');
      if (!summary || !panel) return;

      summary.addEventListener('click', function (event) {
        event.preventDefault();
        if (details.open) {
          animate(details, panel, false);
        } else {
          details.setAttribute('open', '');
          animate(details, panel, true);
        }
      });
    });

    /* A click anywhere that is not inside an open disclosure closes it. */
    document.addEventListener('click', function (event) {
      groups.forEach(function (details) {
        if (!details.open) return;
        if (details.contains(event.target)) return;
        var panel = details.querySelector('[data-nav-panel]');
        if (panel) animate(details, panel, false);
      });
    });

    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      groups.forEach(function (details) {
        if (!details.open) return;
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

        swapImage(onCard.querySelector('.product-card__image, .image-card__media'), image, imageAlt);
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

  document.addEventListener('DOMContentLoaded', function () {
    trackHeaderHeight();
    initHeaderTone();
    initNavDisclosure();
    initDrawer();
    initAutoplayVideos();
    initCartCount();
    initTabs();
    initCardSwatches();
    initVariantOptions();
    initFeaturedAlign();
  });
})();
