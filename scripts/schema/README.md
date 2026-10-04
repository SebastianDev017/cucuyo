# scripts/schema — the schema generator

Every `{% schema %}` of the theme and `config/settings_schema.json` are generated from a
**manifest** per file plus shared **fragments** (one fragment = one group of editor
controls, e.g. the typography group of an element). The generator validates what it
produces and has a `--check` mode that is the pre-push gate. Design:
EDITOR-ARCHITECTURE.md §5 and §7.

This folder is outside everything Shopify reads: the GitHub integration syncs only the
theme folders at the repository root (`assets blocks config layout locales sections
snippets templates`), the CLI pushes only those, and nothing here is a theme file.
Node 24, standard library only, no `npm install`.

## Commands

```sh
node scripts/schema/build.mjs                         # expand + validate + write every manifest's target
node scripts/schema/build.mjs --check                 # the gate: regenerate in memory, exit 1 on any drift (prints a diff)
node scripts/schema/build.mjs --only sections/home-grid.liquid   # one target (or its manifest path); repeatable
node scripts/schema/build.mjs --lint                  # also validate every schema no manifest generates yet
node scripts/schema/import.mjs sections/home-grid.liquid         # existing schema → manifests/sections/home-grid.json
node --test "scripts/schema/test/*.test.mjs"          # unit tests
```

`build.mjs` options: `--root <dir>` (theme root, default the repository), `--manifests <dir>`,
`--fragments <dir>`, `--styles <file>`, `--diff-lines <n>` (cap per printed diff, default 400,
0 = none), `--json` (machine-readable result), `--quiet`. Exit status: **0** clean, **1** drift
(`--check`), validation error or expansion error, **2** bad usage. When any error is found
nothing is written.

`import.mjs` options: `--out <manifest>` (or `-` for stdout), `--file <path>` (the target
recorded in the manifest), `--kind section|block|theme`, `--root`, `--manifests`, `--force`
(it never overwrites a manifest otherwise).

Tests: Node 24's `node --test <directory>` runs the directory as a module ("Cannot find
module …/scripts/schema"), so pass the glob (quoted, Node expands it) or run `node --test`
from inside `scripts/schema`.

## Folder

```
scripts/schema/
  build.mjs                 generator + --check gate (runBuild() is importable)
  import.mjs                existing {% schema %} → manifest of verbatim settings (importFile())
  lib/schema-io.mjs         schema tag splice, canonical JSON, theme model, manifests, diff
  lib/fragments.mjs         manifest/fragment expansion
  lib/validate.mjs          the validators (+ validateSettingValue for check-templates)
  fragments/*.json          shared control groups — T1.1 writes type, color, image, padding,
                            space, scheme, card, overlay; _example.json is the T0.1 sample
  styles.json               the 23 type styles (T1.1); exposed to fragments as "styles"
  manifests/theme-settings.json        → config/settings_schema.json (T1.1)
  manifests/sections/<name>.json       → sections/<name>.liquid (owner tasks)
  manifests/blocks/<name>.json         → blocks/<name>.liquid (T2.6)
  manifests/sections/_example.json     → test/fixtures/scratch/home-grid.liquid.txt (sample)
  check-templates.mjs       template-compat check — reserved for T3.2 (interface below)
  test/                     node:test suites; fixtures/ holds the scratch copy
```

## Workflow

1. **Start from an exact copy**: `node scripts/schema/import.mjs sections/<name>.liquid`.
   Every setting becomes `{ "ref": "setting", …verbatim… }`; presets and the other
   attributes are copied as they are. The import expands its own result and refuses to
   write unless it is deep-equal to the source.
2. **Edit the manifest**: replace runs of raw settings by fragment refs, add new settings.
   Stored ids stay (fragments reuse them with `$setting` / `alias_*`, see below).
3. **Regenerate**: `node scripts/schema/build.mjs --only sections/<name>.liquid`, then commit
   the manifest *and* the regenerated Liquid together.
4. **Gate** (orchestrator, before every QA push and every push to `main`):
   `node scripts/schema/build.mjs --check` next to `check-bindings`, `check-templates`,
   `shopify theme check` and `validate_theme`. Drift means a Liquid schema was edited by
   hand (or a manifest was not rebuilt): fix the manifest and rebuild, never the reverse.

**Round trip** is defined as JSON deep-equality of the schema (arrays order-sensitive,
object keys order-insensitive) **plus byte-identical Liquid outside the schema tag**. It is
not byte-identity of the file: today's schemas use one-line option objects and the key
order name/tag/settings/max_blocks/blocks/presets, so the first build of each file is a
semantically neutral reformat — reported as `reformat only: the schema JSON is
deep-equal`, accepted inside Stage A.

**Output layout**: the body between `{% schema %}` and `{% endschema %}` is
`JSON.stringify(schema, null, 2)` between two newlines, top-level keys in the order
`name, tag, class, limit, max_blocks, settings, blocks, presets` (then `default, locales,
enabled_on, disabled_on`, then anything else as written). The tag delimiters and every
byte outside them are kept, including CRLF line endings; the generated body uses LF.
`config/settings_schema.json` is written whole, LF, with a final newline. Comparisons
(`--check`, "unchanged") ignore CR/LF differences, so a fresh Windows checkout (CRLF)
is not drift; git normalises line endings on commit (`core.autocrlf=true`), so a body
written with LF never shows as a line-ending change.

## Manifest format

```json
{
  "description": "optional note",
  "file": "sections/home-grid.liquid",
  "schema": {
    "name": "Featured collection", "tag": "section", "max_blocks": 10,
    "settings": [
      { "header": "Heading" },
      { "ref": "setting", "type": "text", "id": "eyebrow", "label": "Eyebrow" },
      { "ref": "type", "prefix": "heading", "style": "section-title", "alias_font": "heading_font" },
      { "ref": "padding", "custom_ids": ["padding_top", "padding_bottom"], "default": "custom" },
      { "ref": "scheme" }
    ],
    "blocks": [ { "type": "card", "name": "Card", "settings": [ { "ref": "card" } ] } ],
    "presets": [ { "name": "Featured collection", "blocks": [ { "type": "card" } ] } ]
  }
}
```

* `file` — the target, relative to the theme root (must stay inside it).
* `schema` — the schema exactly as it should come out, except that every **settings array**
  (section `settings`, each local block's `settings`, a theme block's `settings`, each
  theme-settings panel's `settings`) may hold generator entries:

| Entry | Result |
|---|---|
| `{ "ref": "setting", …}` | the setting verbatim, minus `ref` (what `import.mjs` writes) |
| `{ "type": "…", … }` | the same, without the marker |
| `{ "header": "Text" }`, `{ "paragraph": "Text" }` | `{ "type": "header", "content": "Text" }` (other keys kept: `info`, `visible_if`) |
| `{ "ref": "<fragment>", …parameters… }` | the fragment's settings (below) |
| `{ "$each": …, "as": …, "do": [ … ] }`, `{ "$if": …, "then": …, "else": … }` | templated entries (same rules as inside fragments) |

  Presets, block lists and every other attribute are copied verbatim.
* `kind` (optional) — `section`, `block` or `theme`. Normally detected from the manifest's
  place: `manifests/theme-settings.json` → theme, `manifests/sections/*` → section,
  `manifests/blocks/*` → block (then from the target path). `import.mjs` writes `kind` only
  when neither tells it.
* `manifests/theme-settings.json` holds `"file": "config/settings_schema.json"` and a
  `schema` **array**: the `theme_info` object and the `{ "name", "settings" }` panels.

**visible_if scope** — fragments write their conditions with `{{scope_settings}}`, which the
generator fills from where the ref sits: `section.settings` in a section's settings,
`block.settings` in a local block's settings and in a theme block manifest, `settings` in a
theme-settings panel. A ref can force it with `"visible_if_scope": "section" | "block" |
"theme"`; nested refs inherit it.

## Fragment format

```json
{
  "description": "what the group is",
  "params": {
    "prefix": { "required": true, "type": "string" },
    "style":  { "required": true, "type": "string" },
    "size":   { "default": true, "type": "boolean" },
    "alias_font": { "default": null }
  },
  "lookup": { "s": { "from": "styles", "key": "id", "value": "{{style}}" } },
  "settings": [ …template entries… ]
}
```

* **Parameters**: `{ "required", "default", "type", "enum", "description" }` (or just the
  default value). A ref passing an undeclared parameter is an error, except `alias_*` and
  `visible_if_scope`, which every fragment accepts. The architecture's standard parameters
  are `prefix`, `style`, `alias_*`, `size` (false = no size settings), `hover`, `roles`,
  `custom_ids`, `default` and `visible_if_scope`; a fragment declares the ones it uses.
* **Placeholders** `{{name}}` / `{{name.path}}` — **no spaces inside the braces**. Liquid
  output is always written with spaces (`"{{ section.settings.x }}"`,
  `"{{ settings.colors.accent }}"`) and is never touched, so both nest:
  `"{{ {{scope_settings}}.{{prefix}}_adjust }}"` → `"{{ block.settings.label_adjust }}"`.
  Names: the parameters, `scope_settings`, `visible_if_scope`, `kind`, `lookup` records and
  `$each` loop variables. A value that is exactly one placeholder keeps its type
  (`"default": "{{default}}"` → `100`, `"options": "{{opts}}"` → a list); a property whose
  value comes out `null` (an unset optional parameter) is left out. An unknown placeholder
  is an error that names the fragment and the template position.
* **`$if`** — `{ "$if": "<condition>", "then": …, "else": … }` in a settings list (picks
  entries) or as a value. Conditions: names, `'strings'`, numbers, `true/false/null`, `==`,
  `!=`, `has` (list contains / object has key / substring), `!`, `&&`, `||`, parentheses.
  A name must be a declared parameter (catches typos); falsy = unset, `null`, `false`, `""`,
  `[]` (0 is truthy).
* **`$each`** — `{ "$each": "styles", "as": "s", "where": { "panel": "body-links" }, "do": … }`
  iterates a list parameter or `styles` (scripts/schema/styles.json: an array of records with
  at least `id`, or `{ "styles": [ … ] }`); `<as>_index` is the position. Inside a value list
  it splices: `"options": [ {"value":"inherit","label":"Inherit"}, {"$each":"styles","as":"s",
  "do":{"value":"{{s.id}}","label":"{{s.label}}"}} ]`.
* **`lookup`** — binds one record (`{{s.label}}`, `{{s.size_px}}`…) for info texts such as
  "100% = 13.3px as designed"; `"optional": true` gives `null` instead of an error.
* **`$setting`** — `{ "$setting": "{{alias_font}}", "$append_options": [ … ], "visible_if": … }`
  takes the raw setting with that id from the **same manifest settings array**, verbatim, and
  puts it here (its old position disappears). `$append_options` adds options whose value is
  missing (a kept select gains `inherit` without losing its stored values); other keys are
  merged on top (`null` deletes one). With `$fallback: { …template… }` it creates the setting
  when nothing is kept ("`padding_top` kept where it exists; 0–240 step 4 elsewhere"); without
  one, a missing id is an error. This is how stored ids keep their exact type, options and
  range while moving into a generated group.
* **Nested refs** — `{ "ref": "type", "prefix": "label", "style": "card-label" }` inside a
  fragment (e.g. `card` = image + type + colour…). Parameters are templated first; cycles
  are errors.
* **`alias_<suffix>`** (generic) — the generated id `<prefix>_<suffix>` is renamed to the
  given existing id in the ref's whole output, and `visible_if` references follow. Ids
  taken with `$setting` keep their own id.
* **Call-site escape hatches** — on any ref: `"override": { "<generated id>": { …attributes… } }`
  (`null` deletes an attribute) and `"omit": [ "<generated id>" ]` (refused for kept ids).
* Errors and validator messages carry the **origin**: the manifest entry and the fragment
  template position that produced a setting.

### Worked example 1 — card label, `alias_font: label_font`

`fragments/_example.json` is a trimmed copy of §5.2's typography group (its styles are
listed inline; the real `type.json` reads styles.json). Its face control:

```json
{ "$if": "alias_font",
  "then": { "$setting": "{{alias_font}}",
            "$append_options": [ { "value": "inherit", "label": "As the typography style" } ],
            "visible_if": "{{ {{scope_settings}}.{{prefix}}_adjust }}" },
  "else": { "type": "select", "id": "{{prefix}}_font", "label": "Typeface",
            "options": [ { "value": "inherit", "label": "As the typography style" },
                         { "value": "persona", "label": "Persona" },
                         { "value": "junction", "label": "Junction" } ],
            "default": "inherit",
            "visible_if": "{{ {{scope_settings}}.{{prefix}}_adjust }}" } }
```

A card block's settings in a section manifest (the raw `label_font` is the one `import.mjs`
copied; it may sit anywhere in the same array):

```json
{ "ref": "setting", "type": "select", "id": "label_font", "label": "Label typeface",
  "options": [ { "value": "heading", "label": "Primary" }, { "value": "body", "label": "Secondary" } ],
  "default": "heading" },
{ "ref": "_example", "prefix": "label", "style": "card-label", "alias_font": "label_font" }
```

generates (block scope, so `block.settings`):

```text
label_type     select   options card-label | section-title | nav | body, default "card-label"
label_adjust   checkbox "Fine-tune this element", default false
label_font     select   the kept setting: heading | body | inherit (appended), default "heading",
                        visible_if "{{ block.settings.label_adjust }}"
label_size     range    50–150 %, step 1, default 100, visible_if "{{ block.settings.label_adjust }}"
label_size_m   range    50–150 %, step 1, default 100, visible_if (same)
label_case     select   inherit | uppercase | none, default "inherit", visible_if (same)
```

`label_font` keeps its id, type, stored values and default (so every live template that
stores `"label_font": "heading"` stays valid) and gains `inherit`.

### Worked example 2 — menu links, `size: false`

```json
{ "ref": "_example", "prefix": "nav", "style": "nav", "size": false }
```

in a section's settings generates `nav_type` (default `"nav"`), `nav_adjust`, `nav_font`
(the fragment's own select, since no alias is given) and `nav_case`, the last two with
`"visible_if": "{{ section.settings.nav_adjust }}"`: no `nav_size` / `nav_size_m` — the
style's size comes from elsewhere. With `"alias_size": "menu_size"` instead, the kept px
range (`menu_size`, 13–18 px, default 17) takes the size slot: `nav_type, nav_adjust,
nav_font, menu_size, nav_case`, `menu_size` unchanged except for the added `visible_if`.

### visible_if scope `theme`

The same ref in `manifests/theme-settings.json` (`{ "ref": "_example", "prefix": "type_nav",
"style": "nav", "size": false }`) gives `"visible_if": "{{ settings.type_nav_adjust }}"`.
Whether the theme editor honours `visible_if` in settings_schema.json is T1.1's test (theme
check ships `ValidVisibleIfSettingsSchema`, so it at least parses it).

The sample manifest `manifests/sections/_example.json` applies both patterns to a scratch
copy of `sections/home-grid.liquid` (`test/fixtures/scratch/home-grid.liquid.txt`): the
section heading group with `size: false` and the card label group with `alias_font` plus an
`override`. `build.mjs --check` covers it like any other manifest.

## Validators

Errors fail the build (nothing is written); warnings are printed. Each issue names the
file, the path inside the generated schema and the reason, plus the origin when known.

| Rule | Fails when | Source |
|---|---|---|
| `json` | a manifest, fragment or schema body is not valid JSON / not an object | §7.3.1 |
| `name-length` | schema or local block `name` longer than 25 characters (a `t:` key is resolved through locales/en.default.schema.json when present) | §7.3.1, theme check ValidSchemaName |
| `range` | min/max/step/default not numbers; step ≤ 0 or not a multiple of 0.1; min ≥ max; default outside min–max; `(default − min) % step ≠ 0`; fewer than 3 or more than 101 selectable values ((max − min) / step + 1) — Shopify: "Range settings must have at most 101 steps", so 50–200 by 1 is refused (use step 2 or a narrower range). Warning: max not reachable by the step | §7.3.2 + Shopify upload limits |
| `select-default` | select/radio without options, duplicate option values, malformed options, default not an option value | §7.3.3 |
| `visible-if` | not a single `{{ … }}`; parentheses; a reference to an id that does not exist in its scope (`section.settings.x` in a section or its local blocks, `block.settings.x` in a block, `settings.x` against config/settings_schema.json); `block` from section settings; `section`/`block` in theme settings. Warning: no reference at all | §7.3.3, theme check ValidVisibleIf |
| `unique-ids` | duplicate ids in a settings array (theme settings: across all panels); duplicate local block types | §7.3.4 |
| `header-group` | two headers in a row, or a header that ends the list (empty group) | §7.3.4 |
| `presets` | preset setting ids that do not exist or values that are invalid for the setting; unknown block types; a static block without `id` + `static: true`, or one that matches no `{% content_for 'block', type, id %}` of the Liquid; a statically rendered block whose preset entry lacks `static: true`; more blocks than `max_blocks` / a block `limit`; malformed `block_order` | §7.3.5, theme check SchemaPresetsStaticBlocks |
| `theme-blocks` | a section that lists theme blocks (or renders static ones) and also defines local blocks; a theme block file with local block definitions | §7.3.6, theme check ValidLocalBlocks |
| `private-blocks` | a `_` block used in a preset of a container that does not list it explicitly (`@theme` never covers private blocks); **a `_` block that defines presets and is listed by any section or block — it would appear in that picker** (reported on both sides) | §7.3.6, §3.0 |
| `richtext` | a richtext default or preset value whose top level is not only `<p>`/`<ul>` (the "whole template 404s" gotcha). Warning: inline_richtext wrapped in block tags | §7.3.7 |
| `soft-limits` (warning) | more than 40 top-level settings with an id (theme check's ExcessiveSettingsCount; the limit is read from `.theme-check.yml`), more than 120 settings in the file, file over 200 KB | §7.3.8 |
| `setting-shape` | missing `type`/`id`/`label` or other required attributes, attributes the setting type does not have (theme check's ValidSchema rejects them — includes generator directives left behind and `visible_if` on resource pickers, which do not support it), wrong default types | Shopify theme JSON schemas |
| `block-target` | a listed theme block, preset block or `content_for 'block'` type with no `blocks/<type>.liquid`; a public block in a preset that the container does not allow | theme check ValidBlockTarget / ValidStaticBlockType |
| `static-blocks` | one static block id used for two types (warning: non-literal type/id) | theme check UniqueStaticBlockId |
| `schema-keys` | unknown top-level attributes, invalid `tag`, `limit` ∉ {1, 2}, `max_blocks` ∉ 1–50, theme_info / panel shape | Shopify section/block schema |
| `color-palette` | `color_palette` outside settings_schema.json, more than one, not 1–20 colours, bad names, non-hex or alpha values | §3.0 |
| `color-default` | a dynamic colour default that is not exactly `{{ settings.<palette id>.<key> }}` or names a missing palette colour | §3.0 |

Validators run on every generated file. Cross-file rules read the theme model: every
`sections/*.liquid`, `blocks/*.liquid` and config/settings_schema.json, with the generated
version of the files being built. `--lint` runs the same rules on files no manifest
generates (today's tree: 0 errors, 0 warnings).

## Template-compat check interface (`check-templates.mjs`, reserved for T3.2)

The file name `scripts/schema/check-templates.mjs` is reserved; T3.2 writes it
(EDITOR-ARCHITECTURE.md §7.5). The contract this generator expects:

* **Command**: `node scripts/schema/check-templates.mjs [--root <dir>] [--usage <template-usage.json>] [--json]`;
  exit **0** when every stored value is valid, **1** on any failure, **2** on bad usage.
* **Reads** every `templates/*.json` and `sections/*-group.json` (leading `/* … */` comment
  stripped) and asserts against the **generated** schemas: section type exists; every stored
  setting id exists; every value is valid (select/radio option, range within min–max **and on
  a step**, number type for ranges, boolean for checkboxes, string for selects, richtext with
  `<p>`/`<ul>` top level); every block type exists (local or `blocks/*.liquid`; static
  blocks accepted with `static: true` outside `block_order`), block setting ids/values
  likewise; the editor's own keys `name`, `disabled`, `custom_css` are ignored. It lists
  dynamic sources (`{{ *.metafields.* }}`) **including those inside disabled blocks**, and
  asserts that every id of `../wf1/inv-templates/template-usage.json` still exists.
* **Output**: one line per failure, `ERROR <file> > <json path>: <reason>` (the same shape
  as build.mjs issues), then the dynamic-source report and a summary line.
* **Reuse, don't re-implement**: `loadThemeModel(root)` (all section/block schemas, static
  blocks, theme setting ids), `parseTemplateJSON` / `stripLeadingComment`,
  `findStaticBlockCalls` (lib/schema-io.mjs); `validateSettingValue(setting, value)` and
  `checkRichtext(html)` (lib/validate.mjs) — the same value rules the preset validator uses.
* It is a separate gate: `build.mjs` does not call it.

## Platform facts this tool relies on

* **Theme check reads every `**/*.{liquid,json}` under the root**, scripts/ included, and
  classifies files by their folder name. A `.liquid` file with `{% schema %}` outside
  `sections/` or `blocks/` is a `SchemaSectionOrBlockOnly` error, and one inside a folder
  named `sections`/`blocks` is checked as a real section/block. Hence: no `.liquid` files in
  this folder (the scratch copy is `home-grid.liquid.txt`), only valid JSON files committed
  (broken-JSON fixtures live inside the tests), mini themes for tests are created in the OS
  temp folder.
* Shopify range limits: at most 101 selectable values, default on a step; `min`, `max`,
  `step`, `default` must be numbers; `default` is required.
* Richtext defaults must have `<p>`/`<ul>` top-level elements.
* A private block that defines presets and is listed by a section is addable in that
  section's picker; statically rendered private blocks define no presets.
* Theme check's `ExcessiveSettingsCount` warns above 40 top-level settings per section or
  block; with per-element groups most sections will pass 40, so `.theme-check.yml` needs a
  higher `maxSettings` (see the T0.1 report).
