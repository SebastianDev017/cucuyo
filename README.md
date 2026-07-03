# CUCUYO HOME — Shopify theme

Custom Shopify OS 2.0 theme for CUCUYO HOME (editorial home decor — artisan, wabi-sabi).

- **Design system:** [docs/STYLE-GUIDE.md](docs/STYLE-GUIDE.md) — extracted from the client-approved mockup, WCAG AA adjusted.
- **Store:** `cucuyo-store.myshopify.com`

## Development

```sh
# live-reload development preview
shopify theme dev --store cucuyo-store

# push as a new unpublished theme (first time)
shopify theme push --store cucuyo-store --unpublished --theme "Cucuyo (dev)"

# push updates to the same theme afterwards
shopify theme push --store cucuyo-store

# lint
shopify theme check
```

## Architecture notes

- All design tokens are CSS variables bound to `config/settings_schema.json` — the client edits everything (colors, fonts, spacing, ratios) from the theme editor.
- Fonts default to Shopify's native font library (`cormorant_n5` + `assistant_n4`); the token layer is ready for custom hosted fonts later.
- Left sidebar navigation is linklist-driven (`main-menu`): sub-items render indented and always expanded, per the mockup.
- Zero border-radius, no shadows — enforced through `--radius: 0`.
