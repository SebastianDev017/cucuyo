# scripts/css — CSS binding tools

Two Node 24 scripts (standard library only) for the CSS half of the theme-editor
layer (EDITOR-ARCHITECTURE.md §6, §7.6):

| file | what it does |
|---|---|
| `extract-bindings.mjs` | bindings file(s) → for each owning Liquid file, the complete set of asset rules to re-declare in its `{% stylesheet %}`, with each value rewritten as a `var()` chain whose innermost fallback is today's value |
| `check-bindings.mjs` | reads every `{% stylesheet %}` in `sections/`, `snippets/`, `blocks/` and asserts (a) coverage, (b) fallback, (c) uniqueness, (d) `:root` tokens, the strict findings (cascade order, hover defaults, shared tokens; on by default), plus (e) a report of unknown selectors |
| `lib/css-parse.mjs` | the shared tolerant CSS tokenizer/parser (comments, strings, `url()`, `@media`/`@supports` nesting, selector lists split on top-level commas, `!important`, CRLF) |
| `test/` | `node:test` suites and fixtures |

Neither tool touches the asset CSS. Both read `assets/base.css` plus
`assets/base-pages.css` when it exists, in that order (the cascade order of the two
`<link>`s). On the unsplit theme they read `assets/base.css` alone; the selectors are
the same either way.

```
node scripts/css/extract-bindings.mjs scripts/css/bindings/header.json          # print the rules
node scripts/css/extract-bindings.mjs scripts/css/bindings/header.json --out tmp/css   # tmp/css/sections/header.liquid.css
node scripts/css/extract-bindings.mjs scripts/css/bindings/header.json --write  # fill the marked region in the owner
node scripts/css/extract-bindings.mjs scripts/css/bindings/*.json --check       # every region up to date?
node scripts/css/check-bindings.mjs                                             # the gate (exit 1 on any failure)
node scripts/css/check-bindings.mjs --only sections/header.liquid               # while working on one file
node --test "scripts/css/test/*.test.mjs"                                       # tests (from the repository root)
```

## Why re-declare, and why every variant

Bundles from `{% stylesheet %}` are linked by `content_for_header` **after** the asset
stylesheets. A bundle rule with the same selector therefore beats every asset rule of
equal specificity for that property, including the selector's own mobile and tablet
variants. So for each bound (selector, property), the owner re-declares **every**
asset rule that sets that property for that selector. Each copy keeps its source
order, sits inside its exact `@media` wrapper (copied verbatim: `(max-width: 989px)`,
`(min-width: 750px) and (max-width: 989.98px)` …), and carries the chain form of its
own value (§6.1, §6.3):

```css
.media-overlay__heading {
  font-size: var(--oh-size, var(--t-editorial-title-size, calc(1.528rem * var(--heading-scale, 1))));
}

@media (max-width: 989px) {
  .media-overlay__heading {
    font-size: var(--oh-size-m, var(--oh-size, var(--t-editorial-title-size-m, calc(1.3rem * var(--heading-scale, 1)))));
  }
}
```

With no override and no token set, every chain renders today's value, so the site is
unchanged at defaults. The extractor generates this set mechanically; the checker
proves it.

The same reasoning applies to a *different* selector of equal specificity that the
asset sets later and that can style the same element, such as a BEM modifier
(`.site-header__link--sub` after `.site-header__link`). Once `.site-header__link` is
re-declared, the modifier loses where it used to win. Re-declare the modifier in the
same bundle, after it. Verbatim is enough (see `"var": [], "token": []` below).

## bindings.json

One file per owning task, by convention `scripts/css/bindings/<name>.json`, holding a
JSON array (or `{ "bindings": [...] }`) of entries:

```json
[
  { "file": "sections/header.liquid", "selector": ".site-header__link", "property": "font-size",
    "var": "nav-size", "token": "--t-nav-size" },
  { "file": "sections/header.liquid", "selector": ".site-header__link--sub", "property": "font-size",
    "var": [], "token": [] },
  { "file": "sections/header.liquid", "selector": "html.js .site-header", "property": "--bar-logo",
    "var": "wm-size", "media_var": "wm-size-m", "media_token": "--t-wordmark-size-m" },
  { "file": "snippets/media-overlay.liquid", "selector": ".media-overlay", "property": ["right", "left"],
    "var": "overlay-inset-x", "media_var": "overlay-inset-x-m" },
  { "file": "sections/home-note.liquid", "selector": ".home-note", "property": "padding",
    "template": "var(--section-pt, $1) $2 var(--section-pb, $3)" }
]
```

| field | required | meaning |
|---|---|---|
| `file` | yes | owning file: `sections/<name>.liquid`, `snippets/<name>.liquid` or `blocks/<name>.liquid` |
| `selector` | yes | the selector **exactly as written in the asset CSS**, e.g. `.media-overlay__heading` or `.nav-drawer__nav .site-header__link`. Matching is textual; spacing, comments and attribute quotes are normalised. A comma list (`".image-text__heading, .home-note__heading"`) binds each member; members with identical output are printed as one list again |
| `property` | yes | a property name or an array of them; custom properties (`--bar-logo`) work too |
| `var` | one of `var` / `token` / `template` | the element variable (outer layer, emitted inline by `el-style`); a name or an array of names, outermost first; `--` optional |
| `token` | one of `var` / `token` / `template` | the global token on `:root` (css-variables) or a scheme role token; a name or an array |
| `"var": []` **and** `"token": []` | — | both explicitly empty: **re-declare verbatim**. No control, the rules are only copied so that the cascade order stays as it is today (a modifier after a bound selector). One of them empty and the other missing is an error |
| `media_var` | no | outer variable(s) for the **narrowing** media variants (see below). Default `<var>-m` for each var, **then each `<var>`** (§6.3). `[]` or `false` = none |
| `media_token` | no | token(s) for the narrowing media variants; default `<token>-m` for each token. `[]` or `false` = none |
| `media` | no | per-query override: `{ "<query>": { "var": …, "token": … } }`. The key is a bare media query (`"(min-width: 1200px)"`, matched against the innermost `@media`) or a full wrapper chain (`"@supports (x) >> @media (y)"`). A missing `var`/`token` takes the default for that query; `[]` means none |
| `template` | no | the value to emit instead of a chain, for **partial chains** (a variable inside a shorthand, a multiplier). A string applies to every rule of the binding; an object keyed by query (`""`/`"default"` = top level) applies per rule, and rules without an entry take the `var`/`token` chain, or are copied verbatim when there is none. `$1`…`$n` are today's value's space-separated components (outside parentheses), `$0` the whole value, `$$` a `$`. It must render today's value when its variables are unset (checked: error otherwise). A string template together with `var`/`token`, or with `value`, is an error |
| `value` | no | **Stage B only**: a designed value that replaces the literal (a string, or an object keyed by query; `""`/`"default"` = top level). The rule gets `/* designed (was: …) */`, which check-bindings lists instead of failing |
| `note`, `comment`, `//` | no | free text, ignored |

Which names each re-declared rule reads:

| asset rule sits in | chain |
|---|---|
| no wrapper (top level) | `var(--<var>…, var(--<token>…, <original>))` |
| a `media` entry for that query | that entry's `var` / `token` |
| a **narrowing** query: every wrapper is an `@media` with a `max-width` and no `hover` / `pointer` / `prefers-*` / `forced-colors` / `print` feature (phones and tablets: `(max-width: 989px)`, `(min-width: 750px) and (max-width: 989.98px)` …) | `media_var` (default `<var>-m`, then `<var>`), then `media_token` (default `<token>-m`), then `<original>`: the §6.3 rule `var(--nh-size-m, var(--nh-size, var(--t-…-size-m, …)))`. An element override set for desktop only also applies on phones, until a phone value is set. With several vars, every `-m` name comes first, then the base names |
| any other query (`(min-width: 1200px)`, `(hover: hover) and (pointer: fine)`, `(prefers-reduced-motion: reduce)`, `@supports` …) | the top-level `var` / `token`, with a warning so you can decide |
| a `template` entry for that rule | the template, filled with that rule's value |

Some recipes:

* **Phone value independent of the desktop override** (`-m` only): `"media_var": "<var>-m"`.
  The architecture spells three such chains. The §4.5 overlay insets
  (`var(--overlay-inset-x-m, 24px)`: B1 sets the desktop inset, phones keep 24px) and
  the §4.1 wordmark `--bar-logo` (`var(--wm-size-m, var(--t-wordmark-size-m, …))`)
  need `"media_var": "overlay-inset-x-m"` / `"wm-size-m"`. Section padding whose
  phone rule differs from desktop in `auto` mode (§5.5: home-note ×0.45, footer
  56/48) is the third; see the template recipe below.
* **Keep the order of a modifier** flagged by a cascade-order warning:
  `{ "selector": ".site-header__link--sub", "property": "font-size", "var": [], "token": [] }`
  in the same bindings file as `.site-header__link`. Give it real `var`/`token` instead
  if the merchant should control it too.
* **Scheme colour role** on a selector that has a mobile colour rule: role tokens
  have no `-m` form, so set `"media_token": "--color-link"`. (The token warning below
  points this out.)
* **Shared token**: when one token would drive two rules whose values differ today
  (e.g. `--t-title-size-m` at `(max-width: 989px)` = `calc(1.3rem…)` and at
  `(min-width: 750px) and (max-width: 989.98px)` = `1.4rem`), give the variant its
  own token or none:
  `"media": { "(min-width: 750px) and (max-width: 989.98px)": { "token": [] } }`.
* **Three regimes** (the wordmark: bar size at top level, desktop row in
  `(min-width: 1200px)`, phones through `--bar-logo`): bind the top level with no
  token, and add `"media": { "(min-width: 1200px)": { "var": "wm-size", "token": "--t-wordmark-size" } }`.
* **A variable inside a shorthand** (`.home-note` writes `padding: var(--note-top, 208px)
  var(--page-margin) var(--note-bottom, 208px)` at top level and `padding-top` /
  `padding-bottom` on phones). Binding `padding-top` alone would copy the top-level
  shorthand verbatim, so the control would never reach desktop. The extractor warns
  about this. Bind the shorthand with a template, and the phone longhands with their own:
  ```json
  { "file": "sections/home-note.liquid", "selector": ".home-note", "property": "padding",
    "template": "var(--section-pt, $1) $2 var(--section-pb, $3)" },
  { "file": "sections/home-note.liquid", "selector": ".home-note", "property": "padding-top",
    "template": { "(max-width: 749px)": "var(--section-pt-m, calc(var(--section-pt, var(--note-top, 208px)) * 0.45))" } },
  { "file": "sections/home-note.liquid", "selector": ".home-note", "property": "padding-bottom",
    "template": { "(max-width: 749px)": "var(--section-pb-m, calc(var(--section-pb, var(--note-bottom, 208px)) * 0.45))" } }
  ```
  gives `padding: var(--section-pt, var(--note-top, 208px)) var(--page-margin) var(--section-pb, var(--note-bottom, 208px))`
  and phone rules that keep "×0.45 of the desktop value" until a phone value is set.
  Do not hand-write such a rule outside the generated region while the generator
  also copies the same shorthand. The bundle would then hold it twice, (a) fails, and a
  late copy would beat the phone rules.

## What extract-bindings emits

For every entry it finds **every** asset rule whose selector list contains exactly
that selector and that declares that property, in source order, and emits per owning
file:

* each of those rules with the bound selector (not the rule's other list members:
  `.media-overlay__heading, .image-text__heading, .home-note__heading` belong to
  three different owners), inside its verbatim wrapper chain, with only the bound
  property (the rule's other declarations stay out), the chain value (or the
  template, or the value itself for `"var": [], "token": []`), and `!important` kept;
* **related declarations, verbatim.** A shorthand or longhand of the same selector
  that shares a longhand with a bound property is re-declared verbatim alongside, so
  the cascade between them stays as it is. Binding `padding-top` on `.box` also brings
  `@media (max-width: 749px) { .box { padding: 8px 10px } }`. Without it, the bundle's
  `padding-top` would beat the mobile shorthand.
* rules in asset order across all selectors of the file (merged into one `@media`
  block when consecutive), so two bound selectors of one file keep their relative
  order;
* a first line naming the bindings file(s): `/* Generated by scripts/css/extract-bindings.mjs from … */`.

Output goes to stdout (several files: `/* ---- <file> ---- */` separators), to
`--out <dir>` (`<dir>/<file>.css`), or into the owner itself with `--write`. That
replaces the text between `/* extract-bindings:start */` and
`/* extract-bindings:end */` inside the file's `{% stylesheet %}` and keeps its line
endings. `--check` exits 1 when a region differs from what the bindings generate.
`--css <file>` (repeatable) reads other asset files, `--root <dir>` points at another
theme, `--vars <file>` / `--no-vars` sets the css-variables file used for the token
warnings, and `--quiet` hides warnings.

**Errors (exit 1):** a selector/property the asset never declares. The message lists
what that selector does declare, the shorthand it uses ("sets it only through
padding — bind that property instead"), or longer selectors containing the text.
Also errors: the same (selector, property) twice; one bound in two files; two files
whose re-declarations would share a longhand of one selector; a template that uses a
component the value lacks, has a `var()` without fallback, or does not rebuild
today's value; and malformed entries (unknown field, bad `file`, no
`var`/`token`/`template`, a string template with `var`/`token`, `template` with
`value`). Usage errors exit 2.

**Warnings (exit 0), read them.** The first two are failures in check-bindings
unless it runs with `--lenient`:

* *cascade order*: a later asset rule with the same specificity, on a selector that
  may style the same element (shared class or BEM modifier), sets the same property.
  Today it wins; after the re-declaration it would lose. Typical case:
  `.site-header__link` vs `.site-header__link--sub`. Bind the modifier too, in the
  same file (same file = order kept; `"var": [], "token": []` when it needs no
  control). If it is bound in another file, move both bindings into one file.
* *shared token*: one token that renders at defaults (assigned on `:root` by
  css-variables, or not assigned yet) is read by rules whose values differ today.
  css-variables gives it one value, so all but one change as soon as it is emitted.
  Scheme-only role tokens (assigned only in `[data-color-scheme]` blocks) are skipped:
  they apply only where a merchant picks a scheme, and there a common value is the
  point. Give the variant its own token or none (`media` / `media_token`).
* *sets … only through …, which is re-declared verbatim*: a bound property that one
  context of the selector sets only through a related property (a shorthand at top
  level, longhands on phones). The control does not reach that context; bind the
  related property with a `template` (recipe above) or accept it.
* *re-declared verbatim too*: the related-declaration case above.
* *not a max-width query*: a variant reads the top-level chain; set `media` if the
  control must not reach it (e.g. `(forced-colors: active)`).
* *token … is not assigned in snippets/css-variables.liquid*: the chain falls back to
  the literal there, so nothing changes visually, but the global setting does not
  reach it. Check the name, or set `media_token`.
* *also lists "…::-webkit-…"*: a browser that does not know that pseudo drops the
  whole asset rule, but the re-declared rule (without it) would apply there.
* *declares … more than once in one rule*: with `var()` the last copy always applies
  (the first is no longer a parse-time fallback).
* *template / media["…"] matched no rule*: a query key that no rule of the binding sits in.

## Per-task workflow

1. Write `scripts/css/bindings/<name>.json` for every element value your settings move
   (and that the merchant can override).
2. `node scripts/css/extract-bindings.mjs scripts/css/bindings/<name>.json` and read the
   warnings. Bind the modifiers it points at (verbatim when they need no control),
   give a shared token's variant its own token or none, use a `template` where a
   shorthand hides the property, and set `media` / `media_var` / `media_token` where a
   default name is wrong.
3. Paste the output into the owner's `{% stylesheet %}`, between the markers if you
   want `--write`/`--check` later:
   ```liquid
   {% stylesheet %}
   /* extract-bindings:start */
   …generated…
   /* extract-bindings:end */

   /* hover rules (§6.2), [data-hover-tuned] transitions, new components (blk-*, newsletter*) */
   {% endstylesheet %}
   ```
   Never edit the generated part by hand. Change the bindings and re-run.
4. `node scripts/css/check-bindings.mjs --only <your file>`: it must PASS. Then the full
   `node scripts/css/check-bindings.mjs`, because (c) and shared tokens look across files.
5. Commit the bindings file together with the Liquid file. Before every QA push and
   every push to `main`, the orchestrator runs `check-bindings` (strict is the
   default: cascade-order, hover-default and shared-token findings fail) with the
   generator `--check`, `shopify theme check` and `validate_theme`. A cascade-order
   finding is a real visual change whenever the two selectors meet on one element (a
   browser A/B of an unbound `.media-overlay--light` showed 160 changed properties on
   the home page at every width). It is always fixable by re-declaring the flagged
   selector in the same file, after the bound one. `--lenient` reports the strict
   findings as warnings; use it only to see the rest of a report.

Liquid is not rendered inside `{% stylesheet %}` (the checker fails on `{{ }}` / `{% %}`
there). Values arrive through the inline custom properties that `el-style` and
`section-style` emit.

## What check-bindings asserts

Each bundle declaration is taken per selector member. When an asset rule sets that
member and a property related to the declaration's (same property, or a
shorthand/longhand sharing a longhand), it counts as a re-declaration and must
satisfy:

* **(a) coverage.** For that selector and property group, the bundle holds the same
  sequence of (wrapper chain, property, `!important`) as the asset CSS: every
  variant, in the same order. Failures name the missing variant with its verbatim
  query and asset line (fixture `missing-media`: `sections/hero.liquid:11 .title
  { font-size }: missing @media (min-width: 750px) and (max-width: 989.98px):
  …/fixtures/asset/base.css:63 "font-size: 1.4rem" is not re-declared`), or report
  out-of-order rules, `!important` mismatches, and variants with no counterpart.
  *Added variants*: when the asset sets the property for that selector **at top level
  only**, that value holds at every width. A bundle rule inside a query the asset
  lacks (a §6.3 `-m` override, mobile padding) is then accepted, provided it comes
  after the re-declared top-level rule and renders that value by default. Such rules
  are listed under "added variants".
* **(b) fallback.** With every binding variable unset (all `var()` layers whose name
  the asset value does not use are replaced by their fallbacks), the value equals the
  asset value. That is the innermost fallback of a chain. It also covers asset values
  that are themselves `var()` expressions, and partial chains (templates) such as
  `calc(var(--x, 1.9em) * 0.5)` or `var(--section-pt, 208px) var(--page-margin) …`.
  The comparison ignores whitespace, including around `*` and `/` (`calc(1.3rem*var(--s,1))`
  = `calc(1.3rem * var(--s, 1))`), and the case of units, hex colours, function names
  and CSS-wide keywords (`2REM` = `2rem`). Strings, `url()` contents, custom property
  names and other identifiers compare exactly. A `var()` with no fallback fails. A
  declaration carrying `/* designed … */` is listed, not failed (Stage B only).
* **(c) uniqueness.** No (selector, longhand) is re-declared or bound in two theme
  files: bundle order between files is not guaranteed.
* **(d) `:root`.** Every custom property assigned inside the `:root` blocks of
  `snippets/css-variables.liquid` (`:root` inside `@media` included; Liquid-built names
  like `--t-{{ id }}-size` act as wildcards) must not be declared on `:root` (or
  `html.x`, `html[attr]`, `:is(:root, …)`; not `:not(:root)` or `:where(:root)`) in the
  asset CSS or in any bundle. css-variables renders **before** `base.css`, so such a
  declaration wins and the setting is dead. Allowed exceptions come from the
  allow-list (below). Tokens re-mapped on a non-root selector (today
  `.swatches--pdp[role='list'] { --swatch-size: … }`) are printed as a note.
* **(e) report.** Bundle selectors that match no asset selector and are not new
  components (containing `.blk-`, `.newsletter`, `[data-color-scheme`,
  `[data-hover-tuned`; add markers with `--new`) are listed. `:hover` / `:focus-visible`
  variants of asset selectors are labelled as such. This is a report, not a failure.
* **parse.** A CSS parse error, an unclosed `{% stylesheet %}`, or Liquid inside one
  fails.
* **strict** (on by default; `--lenient` / `--no-strict` lists these under warnings
  instead; skipped when `--checks` selects neither a nor b):
  * *cascade order*: a later asset rule of the same specificity, on a selector that
    may style the same element (shared class or BEM modifier on the subject),
    sets a related property after a re-declared selector. It must be re-declared in
    the same bundle, and the two selectors' rules must interleave in the bundle
    exactly as in the asset CSS. A re-declaration in another file fails, because
    bundle order between files is not guaranteed.
  * *hover default* (§6.2): a new state rule (`:hover`, `:focus-visible`, …) for an
    asset selector must default to today's hover value: the asset's `:hover` rule
    for that selector when there is one, else its normal value. When that value
    differs between media contexts, each state rule is compared with the asset rule
    of its own context (else the top-level one). A context with a different value
    and no state rule is a warning.
  * *shared token*: one token that css-variables assigns on `:root`, read first (all
    binding variables unset) by re-declarations whose values differ today. Tokens
    not assigned on `:root` (scheme roles, element variables, names not emitted yet)
    are not counted. The extractor warns about the not-yet-emitted ones.

Options: `--only <file>` (coverage, fallback, report and the strict findings for that
file; uniqueness conflicts involving it), `--checks a,b,…`, `--allow <spec>`,
`--vars <file>`, `--css <file>` (repeatable), `--new <marker>`, `--lenient`
(`--no-strict`; `--strict` is the default), `--root <dir>`, `--json`.
Exit 0 = pass, 1 = failed assertion, 2 = usage or input error.

On the untouched repository (no `{% stylesheet %}` yet) it reports `bound 0` and,
under (d), exactly the five allow-listed card tokens at `assets/base.css:190–194`.

## The :root allow-list (B1 repair)

Built into `check-bindings.mjs` as `DEFAULT_ROOT_ALLOW`:

```
--card-gap  --card-text-inset  --card-text-start  --card-text-top  --card-text-space
```

These are the five card tokens css-variables emits but `base.css` re-declares on
`:root` (lines 190–194). That makes `card_gap` (live 10) and `card_text_inset`
(live 20) dead settings: the page renders 5px / 18px (§4.4, AMENDMENTS 3). Stage A
keeps them, and any *other* collision fails. Stage B1 (T5.1) deletes the five lines
after the precondition on `main`. From then on run `check-bindings --allow none`
(zero collisions expected), and drop the list from `DEFAULT_ROOT_ALLOW`. Until then,
the report says "allow-list entries with no collision (remove them)" for any entry
that no longer collides.

`--allow` also takes an inline list (`--allow --card-gap,--card-text-inset`), a JSON
file (`["--a", "--b"]` or `{ "names": [...] }`), or a text file with one name per line
(`#` comments).

## Tests

```
node --test "scripts/css/test/*.test.mjs"    # from the repository root
cd scripts/css && node --test                # or bare, from here
```

* `css-parse.test.mjs`: tokenizer cases (comments, strings, `url()` with `;`,
  selector lists, `!important`, CRLF line numbers, nested wrappers, `@keyframes`),
  selector/prelude canonical forms, value normalisation (spacing around `*` `/`,
  case), `var()` chains, `:root` detection (`:not(:root)`, `:is(:root, …)`),
  `{% stylesheet %}` extraction, and the css-variables scanner, including the real
  `snippets/css-variables.liquid`.
* `extract-bindings.test.mjs`: the **golden-file test**: `fixtures/extract/bindings.json`
  against `fixtures/asset/base.css` must reproduce `fixtures/extract/expected/**` byte
  for byte. The fixture holds the §6.3 phone chain, a tablet variant with no token, a
  verbatim modifier, a shorthand brought along verbatim, `!important`, a hover query
  and `@supports > @media`. The suite also covers the structural guarantees, identical
  output for base.css alone / split into base.css + base-pages.css / CRLF, media
  defaults and overrides, verbatim mode, templates and their errors, the shorthand,
  shared-token and cascade-order warnings, designed values, every error case,
  multiple bindings files, and `--check`/`--write`.
* `check-bindings.test.mjs`: the required fixtures under `fixtures/check/`.
  `clean` exits 0 (strict included). `missing-media` (`.title` has a desktop rule and
  two media variants, one not re-declared), `wrong-fallback`, `duplicate-owner`, and
  the `:root` collision (`fixtures/vars/css-variables-collision.liquid.txt`) each exit 1
  with the precise reason. Plus ordering, `!important`, added variants, Liquid in a
  stylesheet, strict by default and `--lenient`, cascade order across one bundle and
  two files, hover defaults per media context, shared tokens, allow-list files,
  `--only`/`--checks`/`--json`, and two real-repo checks.

The Liquid fixtures are stored as **`*.liquid.txt`**. Theme Check lints every
`*.liquid` that sits in a `sections/` or `snippets/` folder anywhere in the
repository, so real names would add offenses to the theme's gate. The tests copy a
scenario into a temporary theme with the real names, and they write only under the OS
temp folder. To run a scenario by hand, do the same:

```
node -e "const fs=require('fs'),p=require('path'),s='scripts/css/test/fixtures/check/missing-media',d=require('os').tmpdir()+'/css-fx';fs.rmSync(d,{recursive:true,force:true});for(const f of fs.readdirSync(s,{recursive:true})){const a=p.join(s,f);if(fs.statSync(a).isFile()){const b=p.join(d,f.replace(/\.txt$/,''));fs.mkdirSync(p.dirname(b),{recursive:true});fs.copyFileSync(a,b)}}console.log(d)"
node scripts/css/check-bindings.mjs --root <printed dir> --css scripts/css/test/fixtures/asset/base.css --vars scripts/css/test/fixtures/vars/css-variables.liquid.txt
```

## Limits

* Matching is by selector **text**. `.a .b` in a bundle matches `.a .b` in the asset,
  not `.x .b` even if both hit one element. That case is what the cascade-order
  finding covers, and it is a heuristic (shared class or BEM modifier on the subject
  compound, same specificity).
* The shared-token finding compares chains (`var(--a, var(--t, …))`). Templates are
  verified by (b) but not counted for shared tokens. A token that css-variables emits
  only inside a media query is treated like any `:root` token.
* CSS nesting inside style rules is skipped with a warning (the asset CSS has none).
* `var()` turns a value the browser cannot parse into "invalid at computed-value time"
  instead of a dropped declaration, so `height: 100vh; height: 100dvh` pairs lose their
  fallback once chained (the extractor warns).
