# CUCUYO HOME — Style Guide

**Source:** client-approved homepage/product mockup (Jenn) · Extracted 2026-07-02 · Status: **v1.1 — VALIDATED 2026-07-02 (WCAG-adjusted accent/muted tones), build authorized**

CUCUYO HOME is an editorial home-decor store: artisan-made, wabi-sabi, sunlit and warm. The design language is quiet — one cream, one bronze, a high-contrast serif, zero rounded corners, and generous whitespace. Nothing decorative that isn't typography or product photography.

---

## 1. Color palette

All values sampled from the approved JPEG mockup, then **adjusted for WCAG AA (≥4.5:1 normal text)** on 2026-07-02: `--color-accent` darkened to the former hover tone, `--color-ink-soft` deepened. Ratios verified programmatically (sRGB relative luminance).

| Token | Hex | Usage in mockup |
|---|---|---|
| `--color-background` | `#F5EFE3` | Page background (warm ivory/cream) — header, body, footer |
| `--color-surface` | `#FCF8EF` | Inputs (newsletter email field), subtle raised panels |
| `--color-accent` | `#7F6222` | Olive/bronze — full-width banner bg, Add-to-cart button, Subscribe button (**5.03:1** vs on-accent ✓) |
| `--color-accent-hover` | `#6A5119` | Darkened accent for button hover/active (**6.59:1** vs on-accent ✓) |
| `--color-on-accent` | `#F6F0E1` | Cream text over accent (banner copy, button labels) |
| `--color-ink` | `#3E3629` | Primary text — logo, sidebar nav, cart, card titles |
| `--color-heading` | `#7D6633` | Bronze-brown headings — product title, section headings ("YOU MAY ALSO LIKE"), product tabs, footer links |
| `--color-ink-soft` | `#6E6450` | Body copy, descriptions, captions, breadcrumb, microcopy (**5.09:1** on background, **5.50:1** on surface ✓) |
| `--color-border` | `#D9CFB8` | 1px hairlines — accordion dividers, input borders |

No shadows anywhere. No pure white, no pure black. Depth comes from photography only.

---

## 2. Typography

### Families

| Role | Mockup identity | Shopify `font_picker` default | Handle |
|---|---|---|---|
| **Display serif** | High-contrast old-style serif, Cormorant/Garamond family | **Cormorant** (Medium) | `cormorant_n5` |
| **Sans (labels/body)** | Small neutral grotesque, uniform stroke | **Assistant** | `assistant_n4` |

- ✅ Verified against the Shopify font library (shopify.dev, 2026-07-02): Cormorant `n3–i7` and Assistant `n2–n8` both available natively. *(The "Cormorant invalid" failure on Atelier was a handle-format issue — library handles omit some underscores, e.g. EB Garamond = `ebgaramond_n4`.)*
- Fallback serif if Cormorant renders too light at small caps sizes: **EB Garamond** `ebgaramond_n5`.
- Structure stays prepared for custom hosted fonts later (client licensing), but defaults ALWAYS via native `font_picker`.

### Hierarchy

Everything display-level is UPPERCASE with wide tracking. Body/microcopy is the only sentence-case text (plus lowercase footer links).

| Style | Family | Size (desktop → mobile) | Weight | Tracking | Line-height | Case |
|---|---|---|---|---|---|---|
| Display (banner) | Serif | `clamp(26px, 2.6vw, 38px)` | 500 | 0.14em | 1.65 | UPPER |
| H1 / Product title | Serif | 22px → 19px | 500 | 0.14em | 1.45 | UPPER |
| Logo | Serif | 24px → 20px | 500 | 0.18em | 1 | UPPER |
| Section heading ("YOU MAY ALSO LIKE") | Serif | 13px | 500 | 0.18em | 1.5 | UPPER |
| Product tabs (Designer \| Materials \| Care) | Serif | 15px | 500 | 0.12em | 1.4 | UPPER |
| Sidebar nav / Cart | Serif | 11px | 500 | 0.18em | 1.9 | UPPER |
| Card title | Serif | 12px | 500 | 0.14em | 1.5 | UPPER |
| Body / descriptions | Sans | 14px | 400 | 0.01em | 1.65 | Sentence |
| Caption (editorial tips) | Sans | 12px | 400 | 0.02em | 1.55 | Sentence |
| Label / breadcrumb / "NOTES" / buttons | Sans | 11px | 400–500 | 0.18em | 1.4 | UPPER |
| Micro (footer legal, newsletter note) | Sans | 10px | 400 | 0.08em | 1.5 | Sentence |
| Footer links | Sans | 12px | 400 | 0.04em | 1.9 | lowercase |

---

## 3. Shape & imagery

**`--radius: 0` — absolute.** Images, buttons, inputs, accordions, drawers: everything is a hard rectangle. No shadows, no outlines except 1px hairline borders.

### Aspect ratios by context (measured from mockup)

| Context | Ratio | Notes |
|---|---|---|
| Product hero / PDP gallery | **3:4** portrait | Large single image, left of product info |
| Product card grid ("You may also like") | **4:5** portrait | 3-up grid, object-fit cover |
| Editorial carousel ("Ideas on how to style") | **5:4** landscape | Horizontal overflow/carousel, bleeds off right edge |
| Olive banner | no image | `min-height: clamp(360px, 55vh, 520px)`, text vertically centered |

Ratios become customizer `select` settings with these as defaults.

---

## 4. Layout system

```
┌──────────────────────────────────────────────┐
│              CUCUYO HOME        CART (0)     │  header: logo centered, cart right
├────────┬─────────────────────────────────────┤
│ SHOP   │                                     │
│  ART / │         page content                │  sidebar: sticky left, ~200px
│  TABLE │         (offset right)              │  desktop ≥1024px
│  ...   │                                     │
│ ABOUT  │                                     │
│ ARCHIVE│                                     │
│ SALE   │                                     │
│ SEARCH │                                     │
├────────┴─────────────────────────────────────┤
│  full-bleed sections (banner) span both      │
└──────────────────────────────────────────────┘
```

- **Header:** 3-zone grid `[1fr auto 1fr]` — logo dead-center, `CART (N)` right. No bottom border. Padding-block ~28px.
- **Sidebar nav (desktop):** sticky under header, `--sidebar-width: 200px`. Hierarchy: top-level items (SHOP, ABOUT, ARCHIVE, SALE, SEARCH); SHOP's subcategories (ART / OBJECT, TABLEWARE, STORAGE, LIGHTING, FURNITURE, MIRRORS, RUGS, LINENS, ALL) indented 16px, always visible (as in mockup). Built from a Shopify `linklist` so Jenn manages it from Navigation.
- **Mobile <1024px:** sidebar becomes off-canvas drawer, hamburger at header-left. Zero-radius drawer, same nav.
- **Content:** `--page-width: 1360px` max, page padding `clamp(20px, 4vw, 48px)`. Full-bleed sections (banner) escape the sidebar offset and span the viewport.
- **Grid:** 3 columns desktop / 2 tablet / 1 mobile, 24px gap.
- **Vertical rhythm:** ~96px between sections desktop, ~56px mobile. Spacing scale: 8 / 16 / 24 / 40 / 64 / 96.

---

## 5. Component inventory

| Component | Spec from mockup |
|---|---|
| **Breadcrumb** | `SHOP > TABLEWARE` — 11px sans caps tracked, ink-soft, `>` separator |
| **Accordions** (Shipping & Returns / Ask a Question) | Native `<details>`. 1px top hairline per row (+bottom on last). 11px caps label, thin chevron right, ~44px row height |
| **Add-to-cart button** | Rectangular accent block, on-accent text, 11px caps 0.18em tracking, **price integrated in label** (`ADD TO CART — $164`), padding ~12×20px |
| **Product tabs** | `DESIGNER \| MATERIALS \| CARE` — 15px serif caps in heading color, thin vertical dividers, active full-opacity / inactive faded, body text panel below |
| **Olive banner** | Full-width accent bg, centered display serif in on-accent cream, copy max-width ~900px |
| **Product card** | 4:5 image + serif caps title below (2-line safe). *Mockup shows NO price on cards* — `show_price` setting, see open questions |
| **Editorial "Ideas on how to style"** | Section heading left (2 lines), horizontal-scroll carousel of 5:4 images, numbered captions (`1` + ~4-line tip, max-width 240px) below |
| **Footer** | Cream bg: stacked/rotated logo mark left (`cuc uyo hom e` lowercase serif block) · 3 columns of lowercase links · newsletter right (bordered input + accent Subscribe button + 10px note) |
| **Header cart** | `CART (0)` — live item count, 11px serif caps |

**Motion philosophy (later phases):** minimal — opacity fades, thin underline reveals on links, smooth scroll. Nothing springy or playful; the theme should feel printed.

---

## 6. Design tokens → Shopify settings map (Phase 2 preview)

Every CSS variable in `assets/base.css` binds to a `settings_schema.json` global, so Jenn edits everything from the customizer:

| CSS variable | Setting id | Type | Default |
|---|---|---|---|
| `--color-background` | `color_background` | color | `#F5EFE3` |
| `--color-surface` | `color_surface` | color | `#FCF8EF` |
| `--color-accent` | `color_accent` | color | `#7F6222` |
| `--color-accent-hover` | `color_accent_hover` | color | `#6A5119` |
| `--color-on-accent` | `color_on_accent` | color | `#F6F0E1` |
| `--color-ink` | `color_ink` | color | `#3E3629` |
| `--color-heading` | `color_heading` | color | `#7D6633` |
| `--color-ink-soft` | `color_ink_soft` | color | `#6E6450` |
| `--color-border` | `color_border` | color | `#D9CFB8` |
| `--font-display` | `type_display_font` | font_picker | `cormorant_n5` |
| `--font-body` | `type_body_font` | font_picker | `assistant_n4` |
| `--page-width` | `page_width` | range 1200–1600 | 1360 |
| `--sidebar-width` | `sidebar_width` | range 160–260 | 200 |
| `--section-spacing` | `section_spacing` | range 48–128 | 96 |
| card ratio | `card_aspect_ratio` | select (4:5 / 1:1 / 3:4) | 4:5 |
| card price | `show_price` | checkbox | `false` (mockup-faithful) |

---

## 7. Validation log (2026-07-02)

| Item | Resolution |
|---|---|
| WCAG contrast | **Adjusted:** accent → `#7F6222` (5.03:1), new hover `#6A5119` (6.59:1), ink-soft → `#6E6450` (5.09:1 bg / 5.50:1 surface). Ink (10.39:1) and heading (4.80:1) untouched. |
| Card prices | `show_price` boolean setting, **default `false`** (mockup-faithful). |
| Cormorant weight | **n5** confirmed (`cormorant_n5`). |
| SHOP subcategories | **Always expanded**, as in mockup — not collapsible for now. |
| Custom fonts | No action; architecture stays ready (native `font_picker` defaults, swap path documented). |

### Pending with Jenn — non-blocking

- **Exact brand hexes**: current values are JPEG-sampled + WCAG-adjusted; confirm against Jenn's brand file when available.
- **`show_price` final default**: shipped `false` per mockup; flip in customizer if Jenn prefers visible prices.
