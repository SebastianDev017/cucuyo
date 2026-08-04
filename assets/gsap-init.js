/*
 * GSAP global init (Atelier architecture) — registers plugins and drives
 * Lenis smooth-scroll through the GSAP ticker so ScrollTrigger and Lenis
 * share ONE rAF loop (two loops would double-advance Lenis and break
 * scrolling). Self-hosted: no external script CDNs.
 */
(function () {
  if (!window.gsap || !window.ScrollTrigger) return;
  gsap.registerPlugin(ScrollTrigger);

  /* Smooth scroll (Lenis) — single instance, owned here. Skipped in the theme
     editor (Lenis fights the editor), under prefers-reduced-motion, and when
     the merchant disables it. */
  var inEditor = !!(window.Shopify && window.Shopify.designMode);
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var disabled = document.body.dataset.smoothScroll === 'false';

  if (window.Lenis && !inEditor && !reduce && !disabled) {
    var lenis = new window.Lenis({
      duration: 1.1,
      easing: function (t) { return Math.min(1, 1.001 - Math.pow(2, -10 * t)); },
      smoothWheel: true,
      wheelMultiplier: 0.9,
      touchMultiplier: 1.5,
      infinite: false
    });
    window.lenis = lenis;

    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add(function (time) { lenis.raf(time * 1000); });
    gsap.ticker.lagSmoothing(0);
  }
})();
