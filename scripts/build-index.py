# Write templates/index.json from the final Figma homepage: three two-up bands,
# two mixed bands, two rows of four cards and one centred note, in that order.
# The photographs are the design's own, exported as theme draft assets, and the
# card blocks keep a product picker so each one can be pointed at the real
# product once the catalogue is loaded.
import io, json, collections

LOREM3 = ("Lorem ipsum dolor sit amet consectetur. Aliquam faucibus nec\n"
          "facilisis consequat. Ut dolor pharetra vitae imperdiet. Tortor\n"
          "lacus dolor et et. Justo dignissim non nibh eget scelerisque mi.")
LOREM2 = ("Lorem ipsum dolor sit amet consectetur. Rhoncus semper ac lectus tincidunt volutpat ultrices lacus ornare. "
          "Velit ut ullamcorper molestie ultrices phasellus bibendum. Sapien aliquam hac sit nulla. Dictum consequat.")

def card(asset, label, link, tone='dark'):
    return collections.OrderedDict([("type", "card"), ("settings", collections.OrderedDict([
        ("product", ""), ("image_url", ""), ("alt_text", label), ("draft_asset", asset),
        ("label", label), ("label_tone", tone), ("link", link)]))])

def band(blocks, ratio="4 / 5", tone="ink"):
    return collections.OrderedDict([
        ("type", "home-hero"),
        ("blocks", collections.OrderedDict(blocks)),
        ("block_order", [k for k, _ in blocks]),
        ("settings", collections.OrderedDict([("header_tone", tone), ("ratio", ratio)]))])

def half(asset, label='', heading='', body='', cta='', link='', tone='light'):
    return collections.OrderedDict([("type", "image"), ("settings", collections.OrderedDict([
        ("image", ""), ("draft_asset", asset), ("heading", heading), ("body", body),
        ("cta_label", cta), ("label", label), ("label_tone", tone), ("link", link)]))])

def media(asset, alt, heading='', body='', cta='', link='', tone='light'):
    return collections.OrderedDict([("type", "media"), ("settings", collections.OrderedDict([
        ("image", ""), ("draft_asset", asset), ("alt_text", alt), ("heading", heading),
        ("body", body), ("cta_label", cta), ("link", link), ("tone", tone)]))])

def grid(cards, cols=4):
    blocks = collections.OrderedDict(cards)
    return collections.OrderedDict([
        ("type", "home-grid"),
        ("blocks", blocks),
        ("block_order", list(blocks.keys())),
        ("settings", collections.OrderedDict([
            ("eyebrow", ""), ("heading", ""), ("heading_font", "heading"), ("heading_align", "center"),
            ("columns_desktop", cols), ("columns_mobile", "2"), ("flush", False),
            ("show_collection_label", False), ("show_swatches", False),
            ("background_color", ""), ("text_color", ""), ("padding_top", 0), ("padding_bottom", 0),
            ("header_tone", "ink")]))])

def split(media_block, cards, side="left"):
    blocks = collections.OrderedDict([("media", media_block)] + cards)
    return collections.OrderedDict([
        ("type", "home-split"),
        ("blocks", blocks),
        ("block_order", list(blocks.keys())),
        ("settings", collections.OrderedDict([
            ("media_side", side), ("show_collection_label", False), ("header_tone", "ink")]))])

C = {  # the collections the Figma's nav names
    'vases': '/collections/vases-vessels', 'tabletop': '/collections/tabletop',
    'decor': '/collections/decor', 'accessories': '/collections/accessories',
    'seasonal': '/collections/seasonal'}

sections = collections.OrderedDict()

sections['band_one'] = band([
    ('left', half('figma-home-cheetah-sofa.jpg', heading='Vases & Vessels', body=LOREM3,
                  cta='Shop kitchenware', link=C['vases'], tone='light')),
    ('right', half('figma-home-ojo-chair.jpg', cta='Vases', link=C['vases'], tone='light')),
])

sections['split_one'] = split(
    media('figma-home-bene-garden.jpg', 'Bene tote bag in the garden', link=C['accessories'], tone='light'),
    [('c1', card('figma-home-cheetah.jpg', 'Cheetah Pillow', '/products/cheetah-pillow')),
     ('c2', card('figma-home-ojo.jpg', 'Ojo de Liebre Vase', '/products/ojo-de-liebre-vase')),
     ('c3', card('figma-home-bene-garden.jpg', 'Bene Tote Bag', '/products/bene-tote-bag', tone='light')),
     ('c4', card('figma-home-laura.jpg', 'Laura Bandana', '/products/laura-bandana'))])

sections['note'] = collections.OrderedDict([
    ("type", "home-note"),
    ("settings", collections.OrderedDict([
        ("heading", "Vases & Vessels"), ("body", LOREM2),
        ("link_label", "Shop kitchenware"), ("link", C['vases']),
        ("padding_top", 200), ("padding_bottom", 172)]))])

sections['band_two'] = band([
    ('left', half('figma-home-frills-figs.jpg', link='/products/frills-platter', tone='light')),
    ('right', half('figma-home-fish-sea.jpg', link='/products/swimming-fish-vase', tone='light')),
])

sections['row_one'] = grid([
    ('c1', card('figma-home-frills.jpg', 'Frills Platter', '/products/frills-platter')),
    ('c2', card('figma-home-ava.jpg', 'Ava Silverware', '/products/ava-silverware-20pc-set')),
    ('c3', card('figma-home-ghost.jpg', 'Ghost Checker Platter', '/products/ghost-checker-platter')),
    ('c4', card('figma-home-shakers.jpg', 'White Bone S&P Shakers', '/products/batik-bone-salt-and-pepper-shakers')),
])

sections['split_two'] = split(
    media('figma-home-spiders-pumpkin.jpg', 'Clay and wire spiders beside a pumpkin',
          heading='Vases & Vessels', body=LOREM3, link=C['seasonal'], tone='light'),
    [('c1', card('figma-home-pumpkin.jpg', 'Pumpkin Wreath', '/products/pumpkin-wreath')),
     ('c2', card('figma-home-spiders.jpg', 'Clay & Wire Spiders', '/products/clay-and-wire-spiders')),
     ('c3', card('figma-home-nativity.jpg', 'Kenya Soapstone Nativity', '/products/kenya-soapstone-nativity')),
     ('c4', card('figma-home-ornaments.jpg', 'Barro Ornaments', '/products/clay-barro-ornaments'))])

sections['row_two'] = grid([
    ('c1', card('figma-home-swan.jpg', 'Swan Basket', '/products/swan-basket')),
    ('c2', card('figma-home-tezon.jpg', 'Tezon II Bowl', '/products/tezon-ii-bowl')),
    ('c3', card('figma-home-petra.jpg', 'Petra Vessel', '/products/petra-vessel')),
    ('c4', card('figma-home-duck.jpg', 'Duck Woven Baskets', '/products/duck-woven-baskets')),
])

sections['band_three'] = band([
    ('left', half('figma-home-tezon-painting.jpg', heading='Vases & Vessels', body=LOREM3,
                  cta='Shop kitchenware', link=C['vases'], tone='light')),
    ('right', half('figma-home-petra-yellow.jpg', heading='Vases & Vessels', body=LOREM3,
                   link=C['vases'], tone='light')),
], ratio="3 / 4")

doc = collections.OrderedDict([("sections", sections), ("order", list(sections.keys()))])

head = """/*
 * ------------------------------------------------------------
 * IMPORTANT: The contents of this file are auto-generated.
 *
 * This file may be updated by the Shopify admin theme editor
 * or related systems. Please exercise caution as any changes
 * made to this file may be overwritten.
 * ------------------------------------------------------------
 */
"""
io.open('templates/index.json', 'w', encoding='utf-8', newline='\n').write(head + json.dumps(doc, indent=2, ensure_ascii=False) + '\n')
print('secciones:', list(sections.keys()))
