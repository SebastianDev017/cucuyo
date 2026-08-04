/*
 * Cucuyo motion (Atelier architecture) — printed and restrained.
 * SAFETY MODEL: nothing is hidden by CSS. All initial states are set by GSAP
 * at init time, and init only runs when GSAP is present, the merchant has
 * scroll animations enabled, and the visitor does NOT prefer reduced motion.
 * No JS / reduced motion / any failure → content simply renders visible.
 * Bottom-anchored elements (footer) are deliberately left out of scroll
 * reveals: their trigger line can be unreachable at max scroll.
 */
(function () {
  'use strict';

  /* Hero intro — gentle fade on first paint. The header is deliberately
     untouched: the fixed white nav renders instantly with no fade of any kind. */
  function initIntro() {
    var heroCells = gsap.utils.toArray('.home-hero__cell');
    if (heroCells.length) {
      gsap.from(heroCells, {
        opacity: 0,
        duration: 1.1,
        ease: 'power2.out',
        stagger: 0.12
      });
    }
  }

  /* Card grids — soft rise as each row enters. `once` + a generous start line;
     cards live mid-page, never at the absolute document bottom. */
  function initCards() {
    var cards = gsap.utils.toArray('.image-card, .image-band');
    if (!cards.length) return;
    cards.forEach(function (el) {
      gsap.from(el, {
        opacity: 0,
        y: 24,
        duration: 0.9,
        ease: 'power2.out',
        scrollTrigger: { trigger: el, start: 'top 92%', once: true }
      });
    });
  }

  /* Image settle — slight scale-down as images enter, printed not springy */
  function initImageSettle() {
    gsap.utils.toArray('.image-card__media, .image-band__media').forEach(function (img) {
      gsap.from(img, {
        scale: 1.06,
        duration: 1.4,
        ease: 'power2.out',
        scrollTrigger: { trigger: img, start: 'top 92%', once: true }
      });
    });
  }

  function init() {
    if (!window.gsap || !window.ScrollTrigger) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (document.body.dataset.scrollAnimations === 'false') return;
    initIntro();
    initCards();
    initImageSettle();
    ScrollTrigger.refresh();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* Theme-editor live preview: recalc trigger positions after section reloads */
  document.addEventListener('shopify:section:load', function () {
    if (window.ScrollTrigger) ScrollTrigger.refresh();
  });
})();
