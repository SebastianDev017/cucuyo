/*
 * Cucuyo — motion controller (GSAP + ScrollTrigger + Lenis). Single animation
 * library: also owns the accordion smooth-height and add-to-cart feedback that
 * previously loaded Motion.js, so the theme ships one motion stack, not two.
 * Printed, restrained: opacity/position fades, gentle parallax, no spring.
 * Safety: runs only when the head script armed `motion-ready` (i.e. not under
 * prefers-reduced-motion). If anything is missing or throws, it reveals all
 * content via `motion-fallback` so nothing is ever left hidden. The
 * `__cucuyoMotionReady` flag is set only after setup fully succeeds, so a
 * mid-setup error still lets the head fallback timer reveal everything.
 */
(function () {
  'use strict';

  var root = document.documentElement;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function revealAll() {
    root.classList.add('motion-fallback');
  }

  // Bail (and show everything) under reduced motion, if the head guard is
  // absent, or if the head's fallback timer already fired (slow load) — in that
  // last case content is already revealed, so we must NOT re-hide it with the
  // reveal setup below.
  if (
    reduce ||
    !root.classList.contains('motion-ready') ||
    root.classList.contains('motion-fallback')
  ) {
    revealAll();
    return;
  }

  // Libraries are vendored and loaded before this script. If missing, reveal all.
  if (!window.gsap || !window.ScrollTrigger) {
    revealAll();
    return;
  }

  var gsap = window.gsap;
  var ScrollTrigger = window.ScrollTrigger;

  try {
    gsap.registerPlugin(ScrollTrigger);

    /* ---- Lenis smooth scroll, driven by the GSAP ticker so Lenis and
       ScrollTrigger share ONE rAF loop (two loops would double-advance Lenis).
       Config copied verbatim from the Atelier reference (assets/gsap-init.js)
       so the feel is identical. Skipped in the theme editor, where Lenis fights
       the editor's own scroll. ---- */
    var inEditor = !!(window.Shopify && window.Shopify.designMode);
    if (window.Lenis && !inEditor) {
      var lenis = new window.Lenis({
        duration: 1.1,
        easing: function (t) { return Math.min(1, 1.001 - Math.pow(2, -10 * t)); },
        smoothWheel: true,
        wheelMultiplier: 0.9,
        touchMultiplier: 1.5,
        infinite: false
      });
      lenis.on('scroll', ScrollTrigger.update);
      gsap.ticker.add(function (time) { lenis.raf(time * 1000); });
      gsap.ticker.lagSmoothing(0);
      window.CucuyoLenis = lenis;
    }

    /* ---- Generic reveal: fade + gentle rise, staggered per group ----
       start: 'top bottom' fires the moment any part of an element enters the
       viewport. This is deliberate: a higher line (e.g. 'top 88%') can never be
       crossed by an element anchored at the very bottom of the page (the footer
       sits at ~90% of the viewport at max scroll), which would leave it hidden
       forever. 'top bottom' guarantees every element that becomes visible is
       revealed, and reveals above-the-fold content immediately on load. */
    gsap.set('.reveal', { opacity: 0, y: 16 });
    ScrollTrigger.batch('.reveal', {
      start: 'top bottom',
      once: true,
      onEnter: function (batch) {
        gsap.to(batch, {
          opacity: 1,
          y: 0,
          duration: 0.7,
          ease: 'power2.out',
          stagger: 0.08,
          overwrite: true
        });
      }
    });

    /* ---- Editorial images: subtle horizontal parallax on scroll ---- */
    gsap.utils.toArray('.editorial__image').forEach(function (img) {
      var item = img.closest('.editorial__item') || img;
      gsap.fromTo(
        img,
        { xPercent: -3 },
        {
          xPercent: 3,
          ease: 'none',
          scrollTrigger: { trigger: item, start: 'top bottom', end: 'bottom top', scrub: true }
        }
      );
    });

    /* ---- Brand-story image: clip-path wipe reveal (start state set in CSS) ---- */
    document.querySelectorAll('.clip-reveal').forEach(function (img) {
      gsap.to(img, {
        clipPath: 'inset(0 0 0% 0)',
        duration: 1.1,
        ease: 'power2.out',
        scrollTrigger: { trigger: img, start: 'top 82%', once: true }
      });
    });

    /* ---- Header: hairline appears once scrolled past the masthead ---- */
    var header = document.querySelector('.site-header-wrapper');
    if (header) {
      ScrollTrigger.create({
        start: 'top -48',
        end: 'max',
        onUpdate: function (self) {
          header.classList.toggle('is-scrolled', self.scroll() > 48);
        }
      });
    }

    /* ---- PDP scroll-progress rule ---- */
    var progress = document.querySelector('[data-scroll-progress]');
    if (progress) {
      gsap.to(progress, {
        scaleX: 1,
        ease: 'none',
        scrollTrigger: { trigger: document.body, start: 'top top', end: 'bottom bottom', scrub: 0.3 }
      });
    }

    ScrollTrigger.refresh();

    /* ---- Accordions: smooth height with GSAP (replaces the former Motion.js).
       Progressive enhancement — native <details> works without JS and under
       reduced motion, where this controller bails before reaching here. ---- */
    document.querySelectorAll('.accordion').forEach(function (details) {
      var summary = details.querySelector('summary');
      var content = details.querySelector('.accordion__content');
      if (!summary || !content) return;
      summary.addEventListener('click', function (event) {
        event.preventDefault();
        if (details.dataset.busy === '1') return;
        details.dataset.busy = '1';
        if (details.open) {
          gsap.set(content, { height: content.offsetHeight, overflow: 'hidden' });
          gsap.to(content, {
            height: 0,
            opacity: 0,
            duration: 0.3,
            ease: 'power1.inOut',
            onComplete: function () {
              details.open = false;
              gsap.set(content, { clearProps: 'height,opacity,overflow' });
              details.dataset.busy = '';
            }
          });
        } else {
          details.open = true;
          var target = content.offsetHeight;
          gsap.fromTo(
            content,
            { height: 0, opacity: 0, overflow: 'hidden' },
            {
              height: target,
              opacity: 1,
              duration: 0.3,
              ease: 'power1.inOut',
              onComplete: function () {
                gsap.set(content, { clearProps: 'height,opacity,overflow' });
                details.dataset.busy = '';
              }
            }
          );
        }
      });
    });

    /* ---- Add-to-cart: one restrained opacity dip, no bounce (was Motion.js) ---- */
    document.querySelectorAll('[data-add-button]').forEach(function (button) {
      button.addEventListener('click', function () {
        gsap.fromTo(
          button,
          { opacity: 1 },
          { opacity: 0.72, duration: 0.14, ease: 'power1.out', yoyo: true, repeat: 1 }
        );
      });
    });

    // Everything set up without error — tell the head guard it can stand down.
    window.__cucuyoMotionReady = true;
  } catch (error) {
    revealAll();
  }
})();
