# Build the homepage and the five category templates from Eugenia's PDFs
# (2026-09-24). Each page is written as the sequence of theme sections it is
# made of; the photographs are the PDFs' own, and every product card points at
# the product in the catalogue.
#
#   python scripts/build-pages.py           (from the theme root)
#
# Inputs live in C:/Users/PC/cucuyo-assets/pdf (renders, estructura.json,
# imagenes.json, cards.json, tienda.json — see the scripts there).
import io, json, os, re, collections
import numpy as np
from PIL import Image

PDF = 'C:/Users/PC/cucuyo-assets/pdf/'
ASSETS = 'assets/'
OD = collections.OrderedDict

imgs = json.load(open(PDF + 'imagenes.json', encoding='utf-8'))['mapa']
cards = {c['label'].strip().lower(): c for c in json.load(open(PDF + 'cards.json', encoding='utf-8'))}
tienda = json.load(open(PDF + 'tienda.json', encoding='utf-8'))
handle_of = {p['t']: p['h'] for p in tienda}

# ------------------------------------------------------------------ geometry
# Three PDFs were drawn on an 1800px artboard because their card strips run
# past the page; their renders are 1440 wide, so the page itself is 80% of the
# render, starting at x0.
GEO = {'landing': (0, 1.0), 'tabletop': (0, 1.0), 'vases-vessels': (0, 1.0),
       'decor': (168, 0.8), 'accessories': (162, 0.8), 'seasonal': (176, 0.8)}

def half(page, side, y0, y1):
    x0, s = GEO[page]
    return (x0, y0, x0 + 717 * s, y1) if side == 'left' else (x0 + 722 * s, y0, x0 + 1440 * s, y1)

def feat(im):
    g = np.asarray(im.convert('L').resize((24, 32))).astype(float); g = (g - g.mean()) / (g.std() + 1e-6)
    c = np.asarray(im.convert('RGB').resize((6, 8))).astype(float).ravel(); c = (c - c.mean()) / (c.std() + 1e-6)
    return np.concatenate([g.ravel(), c * 1.2])

def cover(im, ratio):
    w, h = im.size
    if w / h > ratio:
        nw = h * ratio; return im.crop(((w - nw) / 2, 0, (w + nw) / 2, h))
    nh = w / ratio; return im.crop((0, (h - nh) / 2, w, (h + nh) / 2))

_renders = {}
CHECK = []
def visible_photo(page, cell):
    """The photograph the render shows in this cell: several can be stacked
    in the same frame in Figma, only the top one is visible."""
    if page not in _renders: _renders[page] = Image.open(PDF + page + '.png').convert('RGB')
    x0, y0, x1, y1 = cell
    crop = _renders[page].crop((int(x0), int(y0), int(x1), int(y1)))
    f = feat(crop); ratio = (x1 - x0) / (y1 - y0)
    area = (x1 - x0) * (y1 - y0)
    best = None
    for pl in imgs[page]:
        ix0, iy0, ix1, iy1 = pl['x'], pl['y'], pl['x'] + pl['w'], pl['y'] + pl['h']
        ov = max(0, min(x1, ix1) - max(x0, ix0)) * max(0, min(y1, iy1) - max(y0, iy0))
        if ov < 0.4 * area: continue
        cand = cover(Image.open(PDF + 'img/' + pl['archivo']).convert('RGB'), ratio)
        v = feat(cand); sim = float(np.dot(f, v) / (np.linalg.norm(f) * np.linalg.norm(v)))
        if not best or sim > best[0]: best = (sim, pl['archivo'])
    assert best, 'sin foto en %s %s' % (page, cell)
    CHECK.append((page, cell, best[1], best[0]))
    return best[1], round(best[0], 3)

# ------------------------------------------------------------------ assets
exported = {}
def asset(fn, width):
    """Copy a PDF photograph into the theme, sized for where it is used."""
    out = 'pdf-' + fn[3:] if fn.startswith('cu-') else 'pdf-' + fn
    if out not in exported:
        im = Image.open(PDF + 'img/' + fn).convert('RGB')
        if im.width > width: im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
        im.save(ASSETS + out, 'JPEG', quality=78, optimize=True, progressive=True)
        exported[out] = os.path.getsize(ASSETS + out) // 1024
    return out

# ------------------------------------------------------------------ cards
def card(label, page=None, cell_file=None):
    c = cards.get(label.strip().lower())
    s = OD([('product', ''), ('image_url', ''), ('alt_text', ''), ('draft_asset', ''), ('label', ''), ('label_tone', 'dark'), ('link', '')])
    if c and c['producto']:
        s['product'] = handle_of[c['producto']]
        # the PDF shows a different photograph from the product's main one
        if isinstance(c['sim'], float) and c['sim'] < 0.85:
            s['draft_asset'] = asset(c['archivo'], 900)
            s['alt_text'] = c['producto']
    else:
        fn = c['archivo'] if c else cell_file
        s['draft_asset'] = asset(fn, 900)
        s['label'] = label.title()
        s['alt_text'] = label.title()
    return OD([('type', 'card'), ('settings', s)])

def cards_in(page, y0, y1, n):
    pls = sorted([p for p in imgs[page] if p['label'] and y0 - 20 <= p['y'] <= y1 and p['w'] < 500], key=lambda p: p['x'])
    seen, out = set(), []
    for p in pls:
        if p['x'] in seen: continue
        seen.add(p['x']); out.append(p['label'])
    assert len(out) >= n, '%s %d-%d: %s' % (page, y0, y1, out)
    return out[:n]

# ------------------------------------------------------------------ copy
LOREM3 = ("Lorem ipsum dolor sit amet consectetur. Aliquam faucibus nec\n"
          "facilisis consequat. Ut dolor pharetra vitae imperdiet. Tortor\n"
          "lacus dolor et et. Justo dignissim non nibh eget scelerisque mi.")
LOREM2 = ("Lorem ipsum dolor sit amet consectetur. Aliquam faucibus nec facilisis consequat. Ut dolor pharetra "
          "vitae imperdiet. Tortor lacus dolor et et. Justo dignissim non nibh eget scelerisque mi.")
LOREM2B = ("Lorem ipsum dolor sit amet consectetur. Rhoncus semper ac lectus tincidunt volutpat ultrices lacus ornare. "
           "Velit ut ullamcorper molestie ultrices phasellus bibendum. Sapien aliquam hac sit nulla. Dictum consequat.")
# the store's own collections (the live menu's links)
L = {'all': '/collections/all', 'tabletop': '/collections/tabletop', 'decor': '/collections/decorative',
     'vases': '/collections/vase', 'accessories': '/collections/accessories', 'seasonal': '/collections/decorative-seasonal'}

# ------------------------------------------------------------------ sections
def band(page, y0, y1, left=None, right=None, keep_left_image=''):
    blocks = OD()
    for side, ov in (('left', left), ('right', right)):
        fn, sim = visible_photo(page, half(page, side, y0, y1))
        ov = ov or {}
        s = OD([('image', keep_left_image if side == 'left' and keep_left_image else ''),
                ('draft_asset', asset(fn, 1400)), ('heading', ov.get('h', '')), ('body', ov.get('b', '')),
                ('cta_label', ov.get('cta', '')), ('label', ''), ('label_tone', 'light'), ('link', ov.get('link', '')), ('scrim', False)])
        blocks[side] = OD([('type', 'image'), ('settings', s)])
        log.append('   banda %s %d-%d: %s (%.2f)' % (side, y0, y1, fn, sim))
    return OD([('type', 'home-hero'), ('blocks', blocks), ('block_order', ['left', 'right']),
               ('settings', OD([('header_tone', 'ink'), ('ratio', '756 / 957')]))])

def row(page, y0, y1, n=4):
    blocks = OD(('c%d' % (i + 1), card(l)) for i, l in enumerate(cards_in(page, y0, y1, n)))
    return OD([('type', 'home-grid'), ('blocks', blocks), ('block_order', list(blocks)),
               ('settings', OD([('eyebrow', ''), ('heading', ''), ('heading_font', 'heading'), ('heading_align', 'center'),
                                ('columns_desktop', n), ('columns_mobile', '2'), ('flush', False),
                                ('show_collection_label', False), ('show_swatches', False),
                                ('background_color', ''), ('text_color', ''), ('padding_top', 0), ('padding_bottom', 0),
                                ('header_tone', 'ink')]))])

def strip(page, y0, y1, n=5):
    blocks = OD(('c%d' % (i + 1), card(l)) for i, l in enumerate(cards_in(page, y0, y1, n)))
    return OD([('type', 'card-strip'), ('blocks', blocks), ('block_order', list(blocks)),
               ('settings', OD([('heading', ''), ('per_view', 4)]))])

def split(page, y0, y1, photo_side, ov=None):
    fn, sim = visible_photo(page, half(page, photo_side, y0, y1))
    log.append('   mixta foto %s %d-%d: %s (%.2f)' % (photo_side, y0, y1, fn, sim))
    ov = ov or {}
    media = OD([('type', 'media'), ('settings', OD([('image', ''), ('draft_asset', asset(fn, 1400)), ('alt_text', ''),
               ('heading', ov.get('h', '')), ('body', ov.get('b', '')), ('cta_label', ov.get('cta', '')),
               ('link', ov.get('link', '')), ('tone', 'light'), ('scrim', False)]))])
    other = 'right' if photo_side == 'left' else 'left'
    x0, s = GEO[page]
    cx0 = x0 + (722 * s if other == 'right' else 0)
    cx1 = cx0 + 718 * s
    pls = sorted([p for p in imgs[page] if p['label'] and cx0 - 10 <= p['x'] <= cx1 and y0 - 20 <= p['y'] <= y1 and p['w'] < 500],
                 key=lambda p: (round(p['y'] / 150), p['x']))
    labels = []
    for p in pls:
        if p['label'] not in labels: labels.append(p['label'])
    blocks = OD([('media', media)] + [('c%d' % (i + 1), card(l)) for i, l in enumerate(labels[:4])])
    return OD([('type', 'home-split'), ('blocks', blocks), ('block_order', list(blocks)),
               ('settings', OD([('media_side', photo_side), ('show_collection_label', False), ('header_tone', 'ink')]))])

def image_text(page, y0, y1, photo_side, h='', b='', cta='', link=''):
    fn, sim = visible_photo(page, half(page, photo_side, y0, y1))
    log.append('   texto+imagen foto %s %d-%d: %s (%.2f)' % (photo_side, y0, y1, fn, sim))
    return OD([('type', 'image-text'), ('settings', OD([('image_side', photo_side), ('image', ''), ('draft_asset', asset(fn, 1400)),
               ('alt_text', ''), ('image_link', ''), ('heading', h), ('body', b), ('cta_label', cta), ('link', link)]))])

def note(h, b, cta, link):
    return OD([('type', 'home-note'), ('settings', OD([('heading', h), ('body', b), ('link_label', cta), ('link', link),
               ('padding_top', 208), ('padding_bottom', 208)]))])

def heading():
    return OD([('type', 'mosaic-heading'), ('settings', OD())])

# ------------------------------------------------------------------ pages
log = []
def page_landing():
    P = 'landing'
    return [
        ('band_one', band(P, 62, 973, left={'h': 'Cucuyo section title', 'b': LOREM3, 'cta': 'Shop Cucuyo collection', 'link': L['all']},
                          keep_left_image='shopify://shop_images/CH_PW_02.png')),
        ('row_one', row(P, 967, 1431)),
        ('note_one', note('Gifts for everyone', LOREM2, 'Explore tabletop', L['tabletop'])),
        ('band_two', band(P, 1998, 2909, left={'cta': 'Discover kitchenware', 'link': L['tabletop']})),
        ('row_two', row(P, 2902, 3366)),
        ('vases', image_text(P, 3373, 4284, 'left', 'Vases', LOREM3, 'Shop vases', L['vases'])),
        ('row_three', row(P, 4276, 4740)),
        ('note_two', note('Tis the season title', LOREM2, 'Shop seasonal decor', L['seasonal'])),
        ('band_three', band(P, 5306, 6217, left={'cta': 'Shop seasonal', 'link': L['seasonal']})),
        ('row_four', row(P, 6211, 6674)),
        ('trays', image_text(P, 6699, 7610, 'right', 'Shop trays & storage vessels', LOREM3, 'Shop Cucuyo collection', L['all'])),
        ('row_five', row(P, 7606, 8069)),
    ]

def page_tabletop():
    P = 'tabletop'
    return [
        ('heading', heading()),
        ('split_one', split(P, 62, 973, 'left')),
        ('note', note('Vases & Vessels', LOREM2B, 'Shop kitchenware', L['tabletop'])),
        ('band_one', band(P, 1538, 2449)),
        ('row_one', row(P, 2444, 2908)),
        ('vases', image_text(P, 2918, 3828, 'left', 'Vases', LOREM3, 'Shop vases', L['vases'])),
        ('row_two', row(P, 3822, 4286)),
    ]

def page_decor():
    P = 'decor'
    return [
        ('heading', heading()),
        ('band_one', band(P, 50, 777, left={'h': 'Lighting section title', 'b': LOREM3, 'cta': 'Shop Cucuyo collection', 'link': L['all']})),
        ('row_one', row(P, 773, 1144)),
        ('lanterns', image_text(P, 1149, 1876, 'right', 'Lanterns, planters & candlesticks', LOREM3, 'Shop kitchenware', L['tabletop'])),
        ('band_two', band(P, 1880, 2607)),
        ('strip', strip(P, 2604, 2974)),
        ('band_three', band(P, 3426, 4154)),
    ]

def page_vases():
    P = 'vases-vessels'
    return [
        ('heading', heading()),
        ('opening', image_text(P, 62, 973, 'left', 'Vases & Vessels', LOREM3, 'Shop kitchenware', L['tabletop'])),
        ('row_one', row(P, 967, 1431)),
        ('band_one', band(P, 1438, 2349)),
        ('note', note('Vintage & one-of-a-kind pieces', LOREM2, 'Shop vintage pieces', L['all'])),
        ('split_one', split(P, 2915, 3826, 'right')),
        ('split_two', split(P, 3830, 4741, 'left')),
    ]

def page_accessories():
    P = 'accessories'
    return [
        ('heading', heading()),
        ('band_one', band(P, 50, 778)),
        ('row_one', row(P, 774, 1145)),
        ('ikat', image_text(P, 1150, 1879, 'left', 'Ikat and straw title', LOREM3, 'Shop kitchenware', L['tabletop'])),
        ('row_two', row(P, 1873, 2244)),
        ('band_two', band(P, 2252, 2980)),
        ('bandanas', image_text(P, 2988, 3717, 'left')),
        ('strip', strip(P, 3716, 4086)),
    ]

def page_seasonal():
    P = 'seasonal'
    return [
        ('heading', heading()),
        ('split_one', split(P, 59, 787, 'left', {'h': 'Spooky candlesticks decor', 'b': LOREM3, 'cta': 'Shop Cucuyo collection', 'link': L['all']})),
        ('band_one', band(P, 791, 1519)),
        ('note', note('Festivities & fun title', LOREM2, 'Shop vintage pieces', L['all'])),
        ('row_one', row(P, 1963, 2330)),
        ('band_two', band(P, 2340, 3067, left={'cta': 'Shop kitchenware', 'link': L['tabletop']})),
        ('mission', image_text(P, 3072, 3800, 'right', 'Mission house history?', LOREM3, 'Shop kitchenware', L['tabletop'])),
        ('strip', strip(P, 3797, 4168)),
    ]

HEAD = """/*
 * ------------------------------------------------------------
 * IMPORTANT: The contents of this file are auto-generated.
 *
 * This file may be updated by the Shopify admin theme editor
 * or related systems. Please exercise caution as any changes
 * made to this file may be overwritten.
 * ------------------------------------------------------------
 */
"""
def write(path, secs):
    d = OD([('sections', OD(secs)), ('order', [k for k, _ in secs])])
    io.open(path, 'w', encoding='utf-8', newline='\n').write(HEAD + json.dumps(d, indent=2, ensure_ascii=False) + '\n')

for name, fn in [('templates/index.json', page_landing), ('templates/collection.tabletop.json', page_tabletop),
                 ('templates/collection.decor.json', page_decor), ('templates/collection.vases-vessels.json', page_vases),
                 ('templates/collection.accessories.json', page_accessories), ('templates/collection.seasonal.json', page_seasonal)]:
    log.append('== ' + name)
    secs = fn()
    write(name, secs)
    log.append('   %d secciones' % len(secs))

print('\n'.join(log))
print('\nfotos exportadas al tema: %d, %.1f MB' % (len(exported), sum(exported.values()) / 1024))

# a sheet to check every photograph by eye: the PDF's cell | the file chosen
if os.environ.get('SHEET'):
    from PIL import ImageDraw
    TH = 200
    rows = []
    for page, cell, fn, sim in CHECK:
        a = _renders[page].crop(tuple(int(v) for v in cell)); a.thumbnail((TH, TH))
        ratio = (cell[2] - cell[0]) / (cell[3] - cell[1])
        b = cover(Image.open(PDF + 'img/' + fn).convert('RGB'), ratio); b.thumbnail((TH, TH))
        rows.append((page, fn, sim, a, b))
    cols = 4
    W = cols * (2 * TH + 30); H = ((len(rows) + cols - 1) // cols) * (TH + 24)
    sheet = Image.new('RGB', (W, H), 'white'); d = ImageDraw.Draw(sheet)
    for i, (page, fn, sim, a, b) in enumerate(rows):
        x = (i % cols) * (2 * TH + 30); y = (i // cols) * (TH + 24)
        sheet.paste(a, (x, y)); sheet.paste(b, (x + TH + 4, y))
        d.text((x, y + TH + 4), '%s %.2f %s' % (page[:10], sim, fn[3:20]), fill='black')
    sheet.save(PDF + 'verificacion.png'); print('hoja:', sheet.size)
