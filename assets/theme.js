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

  /* Colour swatches. Every swatch is already a link to its own variant's URL,
     so this is pure enhancement: intercept the click and move the page to
     that variant in place — price, image and address bar — instead of
     reloading. Without JS the same links simply navigate, and Shopify
     renders the page with the variant selected. */
  function initSwatches() {
    var groups = Array.prototype.slice.call(document.querySelectorAll('[data-swatches]'));
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
      var form = document.querySelector('[data-product-form]');

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

        if (onCard) {
          swapImage(onCard.querySelector('.product-card__image, .image-card__media'), image, imageAlt);
          var cardPrice = onCard.querySelector('[data-card-price]');
          if (cardPrice && price) cardPrice.textContent = price;
          setCompare(onCard.querySelector('[data-card-compare]'));
          /* the card itself must now open the colour the shopper picked */
          onCard.querySelectorAll('[data-card-link]').forEach(function (link) {
            link.setAttribute('href', href);
          });
          return;
        }

        /* product page */
        swapImage(document.querySelector('.main-product__media-item--hero img'), image, imageAlt);
        /* the Product details block prints the selected colour by name */
        var colorLine = document.querySelector('[data-pdp-color]');
        var optionName = swatch.getAttribute('data-variant-option');
        if (colorLine && optionName) colorLine.textContent = optionName;
        var atcPrice = document.querySelector('[data-atc-price]');
        if (atcPrice && price) atcPrice.textContent = price;
        setCompare(document.querySelector('[data-pdp-compare]'));
        var idInput = form ? form.querySelector('[data-variant-id]') : null;
        if (idInput) idInput.value = swatch.getAttribute('data-variant-id');
        var available = swatch.getAttribute('data-variant-available') === 'true';
        var button = form ? form.querySelector('[data-add-button]') : null;
        if (button && form) {
          var label = button.querySelector('[data-atc-label]');
          var divider = button.querySelector('[data-atc-divider]');
          button.disabled = !available;
          if (label) {
            label.textContent = available ? form.dataset.addText : form.dataset.soldOutText;
          }
          if (divider) divider.hidden = !available;
          if (atcPrice) atcPrice.hidden = !available;
        }
        if (href && window.history && window.history.replaceState) {
          window.history.replaceState({}, '', href);
        }
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
     Without JS the CSS stretch fallback stays — close, not exact. */
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

      if (window.innerWidth < 750) {
        media.style.height = '';
        media.style.flex = '';
        return;
      }

      var featTop = absTop(featured);
      var featBottom = featTop + featured.offsetHeight;
      var target = 0;
      grid.querySelectorAll('.product-card').forEach(function (card) {
        if (card === featured) return;
        var top = absTop(card);
        if (top <= featTop + 1 || top >= featBottom) return; // only the 2nd spanned row
        var img = card.querySelector('.product-card__media');
        if (!img) return;
        target = Math.max(target, absTop(img) + img.offsetHeight);
      });
      if (!target) {
        media.style.height = '';
        media.style.flex = '';
        return;
      }

      var height = target - absTop(media);
      if (height > 0 && Math.abs(media.offsetHeight - height) > 1) {
        media.style.flex = 'none';
        media.style.height = height + 'px';
      }
    };

    var align = function () {
      grids.forEach(alignGrid);
    };

    align();
    /* A second pass after the set: if the featured text is taller than its
       neighbours', the explicit height can grow the spanned rows slightly,
       which moves the target — remeasuring once settles it. The 1px guard
       above stops this from ping-ponging. */
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
    initProductForms();
    initTabs();
    initSwatches();
    initFeaturedAlign();
  });
})();
