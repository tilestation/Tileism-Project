"""
TILE STATION - BUSINESS RULES CONFIGURATION
============================================
This file contains ALL business rules and settings for product management.
These rules MUST be applied consistently across all suppliers and imports.

IMPORTANT: Do not modify without explicit instruction from the user.
Last Updated: March 2026


# ================================================================================
# WHATSAPP CLOUD API CONFIGURATION
# ================================================================================
#
# Provider: Meta WhatsApp Cloud API (graph.facebook.com)
# App Name: Business - Tile Station (App ID: 1458810845977735)
# WhatsApp Business Account ID: 21695813138144486
# Phone Number ID: 1082646658258693 (Test number: +1 555-147-0312)
# Token Type: Permanent System User Token (does NOT expire)
# Token generated from: Meta Business Settings → System Users → Generate Token
#   - Permissions: whatsapp_business_management, whatsapp_business_messaging
#
# Environment Variables (stored in backend/.env):
#   WHATSAPP_PHONE_NUMBER_ID=1082646658258693
#   WHATSAPP_ACCESS_TOKEN=<permanent system user token>
#
# Templates configured on Meta:
#   - "hello_world" (pre-approved, for testing)
#   - "welcome" (custom, for trade account welcome messages)
#   - "custom_message" (body: {{1}}, for custom/order update messages) — CREATE THIS
#
# Features using WhatsApp:
#   1. Auto welcome message to new trade registrations (scheduler in whatsapp_scheduler.py)
#   2. Manual send from Trade Accounts page (individual + bulk)
#   3. Custom message composer from Trade Accounts page
#   4. Order status notifications (email + WhatsApp on status change)
#
# Test recipient (sandbox mode): +44 7379 562631 (Qasim)
# To add more test recipients: Meta Developer Portal → App → WhatsApp → API Setup → "To" field
#
# To switch to real business number:
#   1. Meta WhatsApp Manager → Phone Numbers → Add Phone Number
#   2. Enter your Tile Station WhatsApp Business number
#   3. Verify via SMS/call
#   4. Update WHATSAPP_PHONE_NUMBER_ID in .env with the new ID
#
# ================================================================================


================================================================================
STOREFRONT VARIANT DISPLAY RULES
================================================================================

When displaying product variants (colour/finish/size swatches) on the
Collection Detail page, the following rules apply IN ORDER:

  COLOUR SWATCHES
  ---------------
  Rule 1: ONLY use explicitly saved colours from the database field `color`.
          NEVER extract or guess colours from the product name.
          If `product.color` is empty/null, that product has NO colour.

  Rule 2: Products WITHOUT a saved colour show the FIRST WORD of their
          display name as the swatch label instead.
          Example: "Windemere Oak Golden Brushed..." → swatch label = "Windemere"

  Rule 3: Both colour-based and name-based swatches appear in the same picker.

  FINISH TABS
  -----------
  Rule 4: When a colour/variant is selected, HIDE all finish tabs that have
          no matching product. Do NOT show them faded/disabled — remove entirely.

  Rule 5: When a finish is selected, HIDE only finish tabs that have no matching
          product for the selected variant. Variants themselves are ALWAYS visible —
          they are the collection's top-level navigation. Clicking a variant whose
          current finish/size isn't available auto-switches the finish/size to one
          that IS available for that variant.

  SIZE TABS
  ---------
  Rule 6: Only show sizes available for the current colour+finish selection.
          Hide unavailable sizes entirely.

  GENERAL
  -------
  Rule 7: The variant picker label dynamically shows "Colour" when products
          have saved colours, or "Variant" when using first-word-of-name swatches.

  Rule 8: These rules apply to ALL product groups (Tiles, Materials, Flooring,
          Accessories, etc.) — no group-specific exceptions.


================================================================================
PRODUCT DISPLAY CLASSIFICATION
================================================================================

Products are classified into 2 display groups based on their SIZE field.
This determines which features are shown on the customer-facing product page.

  SURFACE PRODUCTS
  ----------------
  Detection: Size field contains a dimensional pattern (e.g. "60x60cm", "30x60", "300x600mm")
             i.e. number × number format
  Examples:  All regular tiles, mosaics (sheet size), glass tiles, flooring planks
  Page shows: Tile Calculator, Technical Specifications, Installation Guide, Maintenance Tips,
              Volume Pricing tiers, m² / box quantity selectors

  UNIT PRODUCTS
  -------------
  Detection: Size field is empty, missing, OR contains non-dimensional values
             (e.g. "1L", "3kg", "5m", "20kg")
  Examples:  Adhesives, grouts, sealers, tools, flooring accessories, UFH accessories
  Page shows: Simple quantity selector (units), product description, delivery info
  Page hides: Tile Calculator, Technical Specifications, Installation Guide, Maintenance Tips

  NOTE: Product group alone (tiles, flooring, materials, etc.) is NOT reliable
        for this classification because tile groups can contain accessories
        and material groups can contain dimensional products.

================================================================================
PRODUCT NAMING LOGIC - IMPLEMENTATION GUIDE FOR NEW SUPPLIERS
================================================================================

FORMAT: {unique_name} {colour} {size} {finish} {characteristics}

EXAMPLE:
    Original: "Terra Ghr Crema 80x120" (Wallcano) with finish="Matt"
    Result:   "Verona Crema 80x120 Matt"
    
    Original: "Kandla Grey 30x60 Matt" (Wallcano)
    Result:   "Florence Grey 30x60 Matt"

HOW THE NAMING WORKS:
1. Series name (e.g., "Terra", "Kandla") is mapped to unique name (e.g., "Verona", "Florence")
2. Colour is extracted from product name (e.g., "Grey", "Crema")
3. Size is extracted (e.g., "30x60", "80x120")
4. Finish is taken from product data's finish field OR extracted from name
5. All combined in order: unique_name + colour + size + finish

================================================================================
TO ADD A NEW SUPPLIER:
================================================================================

STEP 1: Add supplier to TILING_SUPPLIERS list in get_display_name() function
        Location: Line ~2175
        
        TILING_SUPPLIERS = [
            "Splendour", "Ceramica Impex", "Wallcano", "Verona", 
            "Le Porce", "H Martin", "Tilebase", "Bloomstone", 
            "Boyden", "Eagle",
            "YOUR_NEW_SUPPLIER"  # <-- Add here
        ]

STEP 2: Add series mappings to SPLENDOUR_SERIES_TO_UNIQUE_NAME dictionary
        Location: Line ~1313
        
        # Example for new supplier "MySupplier":
        "SeriesName1": "ItalianName1",  # MySupplier series
        "SeriesName2": "ItalianName2",  # MySupplier series

STEP 3: Add alternative names to ALTERNATIVE_SERIES_NAMES for duplicate handling
        Location: Line ~1602
        
        "SeriesName1": ["ItalianName1", "Alternative1", "Alternative2", ...],

STEP 4: In your sync service/endpoint, call get_display_name with finish:
        
        from business_config.business_rules import get_display_name
        
        product_name = get_display_name(
            raw_name=product.get('name'),
            supplier="YourSupplier",
            finish=product.get('finish')  # IMPORTANT: Always pass finish!
        )
        product_data["product_name"] = product_name

================================================================================
SUPPLIERS WITH NAMING TRANSFORMATION:
================================================================================
- Splendour
- Ceramica Impex
- Wallcano
- Verona
- Le Porce
- H Martin
- Tilebase
- Bloomstone
- Boyden
- Eagle

================================================================================
SUPPLIERS EXCLUDED FROM NAMING (keep original names):
================================================================================
- Tile Rite
- Ultra Tile
- Trimline
- Regulus

================================================================================
"""

import os
import re

# =============================================================================
# PRODUCT DISPLAY CLASSIFICATION
# =============================================================================
# Detect whether a product is a "Surface Product" or "Unit Product"
# based on its size field. See docstring at top for full explanation.
# =============================================================================

DIMENSIONAL_SIZE_PATTERN = re.compile(r'\d+\s*x\s*\d+', re.IGNORECASE)

def is_surface_product(product: dict) -> bool:
    """Returns True if product is a Surface Product (tiles, flooring, mosaics).
    Returns False if product is a Unit Product (adhesives, tools, accessories).
    Detection: size field contains a dimensional pattern like '60x60cm'."""
    size = product.get('size') or ''
    if not size and product.get('attributes'):
        size = product['attributes'].get('size') or ''
    return bool(DIMENSIONAL_SIZE_PATTERN.search(str(size)))


# =============================================================================
# KNOWN PRODUCT SERIES NAMES FOR SEARCH-BASED SYNC
# =============================================================================
# These series names are used by the search-based sync feature to find products
# that might be missed by category navigation. Add new series names here when
# you notice products missing from sync.
#
# The sync will automatically search for each of these names on supplier websites.
# =============================================================================

KNOWN_SERIES_NAMES = [
    # Italian Cities & Regions (very common tile naming pattern)
    "Roma", "Milano", "Venezia", "Firenze", "Torino", "Verona", "Napoli",
    "Bologna", "Cremona", "Palermo", "Orvieto", "Siena", "Pisa", "Genoa",
    "Sicily", "Tuscany", "Umbria", "Amalfi", "Capri", "Portofino",
    
    # Common Supplier Series Names
    "Brook", "Spectra", "Terra", "Kandla", "Bosco", "Luna", "Sol", "Stella",
    "Nova", "Vega", "Aria", "Mira", "Zara", "Dune", "Mesa", "Ridge",
    "Canyon", "Valley", "Summit", "Peak", "Crest", "Wave", "Reef",
    
    # Stone Types & Materials
    "Carrara", "Calacatta", "Statuario", "Onyx", "Travertine", "Limestone",
    "Slate", "Granite", "Sandstone", "Quartzite", "Basalt", "Dolomite",
    "Marble", "Porcelain", "Ceramic", "Terracotta", "Quarry",
    
    # Effects & Patterns
    "Wood", "Concrete", "Cement", "Stone", "Terrazzo", "Brick", "Metal",
    "Metro", "Subway", "Hexagon", "Mosaic", "Arabesque", "Herringbone",
    "Chevron", "Diamond", "Scale", "Zellige", "Encaustic", "Victorian",
    
    # Nature Inspired
    "Sahara", "Desert", "Ocean", "Forest", "Arctic", "Alpine", "Coastal",
    "Mountain", "River", "Lake", "Meadow", "Prairie", "Savanna", "Tundra",
    "Pearl", "Crystal", "Diamond", "Opal", "Jade", "Amber", "Coral",
    
    # Colors (for color-specific series)
    "White", "Grey", "Black", "Beige", "Cream", "Ivory", "Taupe",
    "Brown", "Sand", "Charcoal", "Silver", "Gold", "Bronze", "Copper",
    
    # Style Names
    "Classic", "Modern", "Contemporary", "Traditional", "Rustic", "Vintage",
    "Industrial", "Urban", "Nordic", "Scandinavian", "Mediterranean", "Colonial",
    
    # Premium/Brand Series
    "Signature", "Premium", "Luxury", "Elite", "Select", "Designer",
    "Artisan", "Heritage", "Legacy", "Prestige", "Imperial", "Royal",
    
    # Size-Related (for large format searches)
    "Grande", "Maxi", "Jumbo", "XL", "XXL", "Slab",
]

# Supplier-specific series names that should always be searched
SUPPLIER_SPECIFIC_SERIES = {
    "Wallcano": [
        "Brook", "Spectra", "Terra", "Kandla", "Ghr", "Endless", 
        "Urban", "Metro", "Stone", "Wood", "Cement"
    ],
    "Splendour": [
        "Signature", "Premium", "Classic", "Contemporary",
        "Marble", "Wood", "Stone", "Concrete", "Terrazzo"
    ],
    "Ceramica Impex": [
        "Roma", "Milano", "Carrara", "Calacatta", "Travertine",
        "Limestone", "Granite", "Porcelain", "Amani", "Genesis",
        "Ordino", "Eden", "Sahara", "Onyx", "Breccia", "Botticino",
        "Pietra", "Pulpis", "Statuario", "Marquina", "Concrete",
        "Cement", "Stone", "Marble", "Wood", "Slate", "Sand",
        "Terracotta", "Sandstone", "Quartzite", "Basalt"
    ],
    "Verona": [
        # Verona uses extension, series names TBD
    ]
}

# =============================================================================
# 1. PRODUCT NAME FORMAT RULES
# =============================================================================
# FORMAT: UNIQUE NAME + COLOUR + SIZE + FINISH + CHARACTERISTICS
#
# EXAMPLE:
#   Supplier Name: "Cedar Grey Glass/Stone/Metal Mix Mosaic 15x15mm"
#   Our Unique Name: "Pewter" (AUTO-GENERATED - not supplier name!)
#   Result: "Pewter Grey 300x300 Mix Glass/Stone/Metal Mosaic 15x15mm"
#
# RULE BREAKDOWN:
#   - UNIQUE NAME: AUTO-GENERATED from name lists below (NOT supplier name!)
#   - COLOUR: From the 'color' field
#   - SIZE: From the 'size' field (without 'mm')
#   - FINISH: From the 'finish' field (EXCEPT for Flooring products - NO finish!)
#   - CHARACTERISTICS: Product type (Wall Tile, Mosaic, etc.)
#
# FLOORING EXCEPTION: Do NOT include Finish in Flooring product names

PRODUCT_NAME_RULES = {
    # Order of elements in product name
    "format": "{unique_name} {colour} {size} {finish} {characteristics}",
    
    # Words to REMOVE from product names
    "remove_words": ["The"],
    
    # Size MUST come BEFORE finish
    "size_before_finish": True,
    
    # Remove duplicate words (case-insensitive)
    "remove_duplicates": True,
    
    # Categories/products where FINISH should be REMOVED from name
    "remove_finish_for": ["Flooring"],
    
    # Characteristic patterns to extract from supplier name
    "characteristic_patterns": [
        "Click SPC Rigid Plank Flooring", "Click SPC Tile Flooring", "Click SPC Herringbone Flooring",
        "Wall & Floor Tile", "Wall Tile", "Floor Tile", 
        "Porcelain Mosaic", "Marble Mosaic", "Glass Mosaic", "Stone Mosaic", "Wall Mosaic",
        "Splitface Cladding", "Mosaic", "Tile"
    ],
    
    # Finish options
    "finishes": [
        "Matt", "Gloss", "Polished", "Polish", "Satin", "Satin Matt",
        "Lappato", "Natural", "Textured", "Anti-Slip", "Slate", "Sparkle", "Silk", "Mix"
    ]
}

# =============================================================================
# AUTO-GENERATED UNIQUE NAME LISTS
# =============================================================================
# These names are AUTO-ASSIGNED to products. They replace supplier names.
# Example: Supplier "Bosco" -> Our name "Cosmo"

# For Wall Tiles, Wall & Floor Tiles, Mosaic, Outdoor, etc. (Cities/Places/Landmarks)
TILE_UNIQUE_NAMES = [
    "Atlas", "Everest", "Sahara", "Amazon", "Olympus", "Aurora", "Cairo", "Venice",
    "Milan", "Roma", "Vienna", "Monaco", "Paris", "Oslo", "Geneva", "Zurich",
    "Tokyo", "Sydney", "Denver", "Austin", "Phoenix", "Dallas", "Boston", "Miami",
    "Aspen", "Malibu", "Capri", "Amalfi", "Riviera", "Santorini", "Mykonos", "Crete",
    "Cascade", "Summit", "Ridge", "Canyon", "Mesa", "Terra", "Luna", "Nova",
    "Stella", "Cosmo", "Zenith", "Apex", "Prime", "Elite", "Luxe", "Regal",
    "Crystal", "Onyx", "Pearl", "Ivory", "Obsidian", "Granite", "Quartz", "Slate",
    "Harbor", "Marina", "Cove", "Bay", "Coast", "Shore", "Cliff", "Dune",
    "Horizon", "Eclipse", "Solstice", "Equinox", "Vega", "Orion", "Polaris", "Sirius",
    "Metro", "Urban", "Civic", "Plaza", "Avenue", "Boulevard", "Strada", "Piazza",
    "Artisan", "Studio", "Gallery", "Atelier", "Loft", "Soho", "Chelsea", "Tribeca",
    "Nordic", "Alpine", "Baltic", "Celtic", "Tuscan", "Aegean", "Adriatic", "Pacific",
    "Majestic", "Imperial", "Royal", "Noble", "Grand", "Premier", "Prestige", "Legacy",
    "Essence", "Pure", "Serene", "Tranquil", "Harmony", "Balance", "Zen", "Oasis",
    "Palermo", "Florence", "Siena", "Naples", "Bologna", "Torino", "Genoa",
    "Barcelona", "Madrid", "Seville", "Valencia", "Lisbon", "Porto", "Athens", "Rhodes"
]

# For Flooring (SPC, LVT) - Forest & Landscape names
FLOORING_UNIQUE_NAMES = [
    "Sequoia", "Redwood", "Oakwood", "Birchwood", "Cedarwood", "Pinewood", "Maplewood",
    "Ashwood", "Elmwood", "Willowbrook", "Hickory", "Walnutgrove", "Cherrywood", "Teakwood",
    "Meadow", "Prairie", "Valley", "Glen", "Grove", "Forest", "Woodland", "Timberland",
    "Lakeside", "Riverside", "Brookside", "Streamwood", "Ferndale", "Mossy", "Evergreen",
    "Autumn", "Harvest", "Rustic", "Country", "Farmhouse", "Cottage", "Cabin", "Lodge",
    "Aspen", "Spruce", "Cypress", "Juniper", "Hemlock", "Fir", "Larch", "Alder"
]

# For Natural Stone Splitface - Rock/Cliff names
STONE_UNIQUE_NAMES = [
    "Rockfall", "Cliffside", "Quarry", "Boulder", "Pebble", "Cobble", "Flagstone",
    "Ledge", "Crag", "Bluff", "Escarpment", "Outcrop", "Bedrock", "Strata",
    "Granite", "Basalt", "Slate", "Shale", "Sandstone", "Limestone", "Travertine", "Onyx"
]

# =============================================================================
# CRITICAL RULE 1: SAME SERIES = SAME UNIQUE NAME
# =============================================================================
# ALL products from the SAME supplier series MUST have the SAME unique name.
#
# Example:
#   Supplier Series "Earthsong" has multiple products:
#     - Earthsong Natural Porcelain Mosaic
#     - Earthsong White Porcelain Mosaic
#     - Earthsong Natural Wall & Floor Tile (300x600)
#     - Earthsong White Wall & Floor Tile (600x600)
#
#   ALL of these get the SAME unique name, e.g., "Miami":
#     - Miami Natural 300x300 Matt Porcelain Mosaic
#     - Miami White 300x300 Matt Porcelain Mosaic
#     - Miami Natural 300x600 Matt Wall & Floor Tile
#     - Miami White 600x600 Matt Wall & Floor Tile
#
# Implementation:
#   1. Extract series name from supplier name (first word)
#   2. Create a mapping: series -> unique_name
#   3. All products in same series get the same unique name
#
# series_name_map = {}
# def get_unique_name_for_series(series, category):
#     if series in series_name_map:
#         return series_name_map[series]
#     # Assign new name from appropriate list
#     name = TILE_NAMES[next_idx] or FLOORING_NAMES[next_idx]
#     series_name_map[series] = name
#     return name

SAME_SERIES_SAME_NAME_RULE = {
    "enabled": True,
    "extract_series_from": "first_word",  # First word of supplier name is the series
    "consistent_across_sizes": True,      # Same name regardless of size (300x300, 600x600, etc.)
    "consistent_across_types": True,      # Same name for Wall Tile, Floor Tile, Mosaic in same series
}

# =============================================================================
# CRITICAL RULE 2: NO NUMBERED NAMES
# =============================================================================
# NEVER add number suffixes to names (e.g., Atlas2, Summit3).
# Instead, ensure enough unique names exist for all series.
#
# Required name counts:
#   - Tile names: 200+ (for ~187 series)
#   - Flooring names: 30+ (forest/tree names)
#   - Stone names: 15+ (rock/cliff names)

NO_NUMBERED_NAMES_RULE = {
    "enabled": True,
    "forbidden_patterns": [r"\d+$"],  # No numbers at end of name
}

# =============================================================================
# CRITICAL RULE 3: PROPER NAME CATEGORIES
# =============================================================================
# Names must be appropriate for product type:
#   - Tiles: Cities, places, landmarks (Milan, Paris, Everest, etc.)
#   - Flooring: Forest/tree names (Sequoia, Oakwood, Meadow, etc.)
#   - Natural Stone: Rock/cliff names (Rockfall, Quarry, Ledge, etc.)
#
# FORBIDDEN: Fabric names (Leather, Suede, Cashmere, Silk, Velvet, etc.)

PROPER_NAME_CATEGORIES_RULE = {
    "tiles": "cities_places_landmarks",
    "flooring": "forest_tree_landscape",
    "natural_stone": "rock_cliff_quarry",
    "forbidden": ["Leather", "Suede", "Cashmere", "Silk", "Velvet", "Satin", "Cotton", "Linen", "Wool"],
}


# =============================================================================
# 2. UNIQUE NAME RULES (Series/Range Names)
# =============================================================================
# All products from the SAME supplier series get the SAME unique name

UNIQUE_NAME_RULES = {
    # All products in same series have same unique name
    "consistent_per_series": True,
    
    # Use supplier's original series/range name
    "use_supplier_series_name": True,
    
    # Remove "The" prefix
    "remove_the_prefix": True,
    
    # Preserve product type identifiers
    "preserve_types": [
        "Wall Tile", "Floor Tile", "Wall & Floor Tile",
        "Mosaic", "Hexagon", "Hex", "Marble", "Porcelain", "Stone"
    ]
}


# =============================================================================
# 3. SKU CODE FORMAT RULES
# =============================================================================
# Format: TS + Supplier Initial + Code Type Letter + Last 4 digits
# Example: P14274 → TSVP4274 (Wall Tile)
#          A14274 → TSVA4274 (Accessory)
#          L10090 → TSVL0090 (Flooring)

SKU_RULES = {
    "prefix": "TS",  # Tile Station
    "include_supplier_initial": True,
    "include_code_type_letter": True,  # P/A/L etc to avoid collisions
    "last_digits_count": 4,
}

# Supplier initials
SUPPLIER_INITIALS = {
    "Verona": "V",
    "Splendour": "S",
    "Ceramica Impex": "C",
    "Tiles Direct": "T",
    "Tile Rite": "R",
    "Ultra Tile": "U",
    "Wallcano": "W",
    "Le Porce": "L",
    "H Martin": "H",
    "Trimline": "M",
    "Tilebase": "B",
    "Bloomstone": "O",
    "Boyden": "Y",
    "Regulus": "G",
    "Eagle": "E",
}


# =============================================================================
# 4. PRICING RULES
# =============================================================================
# List Price = Cost × Markup × VAT, then ROUND TO .99p

PRICING_RULES = {
    "markup_percentage": 130,  # 130% markup on cost
    "markup_multiplier": 2.30,
    "vat_percentage": 20,  # 20% VAT
    "vat_multiplier": 1.20,
    
    # ALWAYS round prices to end in .99p
    "round_to_99": True,
}


# =============================================================================
# 5. UNIT TYPES
# =============================================================================
# Products sold by m² vs each

UNIT_RULES = {
    # Categories sold by "each" (not m²)
    "each_categories": [
        "Essentials",
        "Flooring Accessories"
    ],
    
    # Default unit for tiles
    "default_unit": "m2"
}


# =============================================================================
# 6. EXCLUDED CATEGORIES
# =============================================================================
# Categories to EXCLUDE from name transformations

EXCLUDED_CATEGORIES = [
    "Essentials",
    "Flooring Accessories"
]


# =============================================================================
# 7. NON-TILE PRODUCT EXCLUSION RULES - ALL SYNCS
# =============================================================================
# These rules define which products should be AUTOMATICALLY SKIPPED during sync.
# Applies to: Verona Extension, Splendour Server Sync, Ceramica Impex Server Sync
#
# REASON: We only want to sync TILES (wall tiles, floor tiles, mosaics, etc.)
#         Non-tile products like adhesives, grout, tools, etc. are excluded.

NON_TILE_EXCLUSION_RULES = {
    # Categories to EXCLUDE (case-insensitive matching)
    # NOTE: Flooring and Flooring Accessories are INCLUDED (not in this list)
    "excluded_categories": [
        "Adhesive",
        "Adhesives",
        "Grout",
        "Grouts",
        "Sealant",
        "Sealants",
        "Tools",
        "Tool",
        "Levelling",
        "Leveling",
        "Underlay",
        "Underlays",
        "Trims",
        "Trim",
        "Profiles",
        "Profile",
        "Cleaning",
        "Cleaner",
        "Cleaners",
        "Maintenance",
        "Installation",
        "Fixings",
        "Membrane",
        "Membranes",
        "Primer",
        "Primers",
        "Screed",
        "Screeds",
        "Heating",
        "Underfloor Heating",
        "Bathroom Accessories",
        "Shower Accessories",
        "Consumables",
        "Sundries",
        "Spacers",
        "Crosses",
        "Wedges",
        "Trowels",
        "Cutters",
        "Blades",
    ],
    
    # Keywords in product NAME to exclude (case-insensitive)
    # NOTE: "flooring" keywords are NOT excluded
    "excluded_name_keywords": [
        "adhesive",
        "grout",
        "sealant",
        "silicone",
        "primer",
        "cleaner",
        "cleaning",
        "levelling",
        "leveling",
        "spacer",
        "trowel",
        "cutter",
        "blade",
        "underlay",
        "membrane",
        "screed",
        "heating mat",
        "thermostat",
        "tanking",
        "waterproofing",
        "tape",
        "bucket",
        "mixing",
        "applicator",
        "spreader",
        "float",
        "sponge",
        "knee pad",
        "safety",
        "gloves",
        "goggles",
        "mask",
        "dust sheet",
    ],
    
    # Keywords that CONFIRM it's a tile/flooring product (override exclusion if present)
    # Includes flooring products
    "tile_confirm_keywords": [
        "tile",
        "tiles",
        "mosaic",
        "porcelain",
        "ceramic",
        "marble",
        "travertine",
        "slate",
        "limestone",
        "granite",
        "quartzite",
        "onyx",
        "terrazzo",
        "cladding",
        "splitface",
        "wall tile",
        "floor tile",
        "decor",
        "feature",
        "border",
        "listello",
        # Flooring products - INCLUDED
        "flooring",
        "spc",
        "lvt",
        "laminate",
        "vinyl",
        "plank",
        "herringbone",
        "click",
        "wood effect",
        "wood look",
        "parquet",
    ],
    
    # URL patterns to exclude
    # NOTE: /flooring is NOT excluded
    "excluded_url_patterns": [
        "/adhesive",
        "/grout",
        "/tools",
        "/installation",
        "/cleaning",
        "/maintenance",
    ],
    
    # Categories/keywords to ALWAYS INCLUDE (override any exclusion)
    "always_include_keywords": [
        "flooring",
        "floor",
        "spc",
        "lvt",
        "laminate",
        "vinyl plank",
        "click flooring",
        "flooring accessories",
        "flooring accessory",
        "trim",  # Flooring trims are included
        "profile",  # Flooring profiles are included
        "underlay",  # Flooring underlay is included
    ],
    
    # Log skipped products for debugging
    "log_skipped": True,
    "skip_reason_field": "skip_reason"
}

def is_non_tile_product(product_name: str, category: str = "", url: str = "") -> tuple:
    """
    Check if a product should be excluded from sync.
    
    Args:
        product_name: The product name/title
        category: The product category (optional)
        url: The product URL (optional)
    
    Returns:
        tuple: (should_skip: bool, reason: str)
    
    IMPORTANT: Flooring and Flooring Accessories are ALWAYS INCLUDED.
    """
    rules = NON_TILE_EXCLUSION_RULES
    name_lower = product_name.lower() if product_name else ""
    category_lower = category.lower() if category else ""
    url_lower = url.lower() if url else ""
    
    # FIRST: Check if it's a flooring product - ALWAYS INCLUDE
    for keyword in rules.get("always_include_keywords", []):
        if keyword in name_lower or keyword in category_lower or keyword in url_lower:
            return (False, "")  # It's flooring, don't skip
    
    # Check if it's definitely a tile/flooring (has tile-confirming keywords)
    for keyword in rules["tile_confirm_keywords"]:
        if keyword in name_lower:
            return (False, "")  # It's a tile/flooring, don't skip
    
    # Check excluded categories
    for exc_cat in rules["excluded_categories"]:
        if exc_cat.lower() in category_lower:
            return (True, f"Excluded category: {exc_cat}")
    
    # Check excluded name keywords
    for keyword in rules["excluded_name_keywords"]:
        if keyword in name_lower:
            return (True, f"Excluded keyword in name: {keyword}")
    
    # Check excluded URL patterns
    for pattern in rules["excluded_url_patterns"]:
        if pattern in url_lower:
            return (True, f"Excluded URL pattern: {pattern}")
    
    return (False, "")  # Product is OK to sync


# =============================================================================
# HELPER FUNCTIONS
# =============================================================================

import re
import math


def generate_sku(supplier_code: str, supplier_name: str) -> str:
    """Generate standardized SKU code."""
    initial = SUPPLIER_INITIALS.get(supplier_name, supplier_name[0].upper() if supplier_name else "X")
    
    if '-' in supplier_code:
        code_part = supplier_code.split('-')[1]
    else:
        code_part = supplier_code
    
    code_type = code_part[0] if code_part else "X"
    last_digits = code_part[-SKU_RULES["last_digits_count"]:]
    if len(last_digits) < SKU_RULES["last_digits_count"]:
        last_digits = last_digits.zfill(SKU_RULES["last_digits_count"])
    
    return f"{SKU_RULES['prefix']}{initial}{code_type}{last_digits}"


def calculate_list_price(cost: float) -> float:
    """Calculate list price with markup, VAT, and round to .99p"""
    if cost and cost > 0:
        raw_price = cost * PRICING_RULES["markup_multiplier"] * PRICING_RULES["vat_multiplier"]
        
        if PRICING_RULES["round_to_99"]:
            whole = math.ceil(raw_price)
            return whole - 0.01
        return round(raw_price, 2)
    return 0


def clean_product_name(name: str, size: str, finish: str) -> str:
    """Clean and format product name according to rules."""
    result = name
    
    # Remove specified words
    for word in PRODUCT_NAME_RULES["remove_words"]:
        result = re.sub(rf'^{word}\s+', '', result, flags=re.IGNORECASE)
        result = re.sub(rf'\s+{word}\s+', ' ', result, flags=re.IGNORECASE)
    
    # Remove duplicate words
    if PRODUCT_NAME_RULES["remove_duplicates"]:
        words = result.split()
        seen = set()
        unique = []
        for word in words:
            if word.lower() not in seen:
                seen.add(word.lower())
                unique.append(word)
        result = ' '.join(unique)
    
    return result.strip()


def get_unique_name_for_series(supplier_series_name: str) -> str:
    """Get consistent unique name for a product series."""
    result = supplier_series_name
    
    if UNIQUE_NAME_RULES["remove_the_prefix"] and result.startswith("The "):
        result = result[4:]
    
    return result


def get_unit_type(category: str) -> str:
    """Determine if product is sold by m² or each."""
    if category in UNIT_RULES["each_categories"]:
        return "each"
    return UNIT_RULES["default_unit"]


# =============================================================================
# 7. SPLENDOUR BROWSER EXTENSION RULES
# =============================================================================
# These rules define EXACTLY how the Splendour sync extension must behave.
# The extension MUST follow this crawling logic to extract accurate data.
#
# Website: https://www.splendourtiles.co.uk
# Login Required: YES (Trade Account)
#
# CREDENTIALS:
#   Email: accounts@tilestation.co.uk
#   Password: <see env: SPLENDOUR_PORTAL_PASSWORD>

SPLENDOUR_EXTENSION_RULES = {
    # Website configuration
    "base_url": "https://www.splendourtiles.co.uk",
    "login_url": "https://www.splendourtiles.co.uk/customer/account/login/",
    
    # API endpoint for syncing
    "sync_api": "https://tile-station-production.up.railway.app/api/supplier-sync/splendour/products",
    
    # Main categories to crawl (in order)
    "main_categories": [
        "/wall-tiles",
        "/floor-tiles",
        "/outdoor-tiles"
    ],
    
    # CRAWLING LOGIC - MUST BE FOLLOWED EXACTLY:
    #
    # STEP 1: Go to main category page (e.g., /wall-tiles)
    #         - This page shows subcategory tiles (Alaska, Agora, Balance, etc.)
    #
    # STEP 2: Find ALL subcategories in ORDER
    #         - Subcategory URLs look like: /wall-tiles/alaska, /wall-tiles/agora
    #         - Pattern: /{category}/{subcategory-name}
    #         - Must process in the order they appear on the page
    #
    # STEP 3: Within each subcategory, find ALL product URLs
    #         - Product URLs contain dimensions: alaska-brillo-60x60, balance-silver-300x600
    #         - Pattern: URL contains /\d+x\d+/ (numbers x numbers)
    #         - Collect ALL unique product URLs before processing
    #
    # STEP 4: Visit EACH product detail page to extract data
    #         - MUST visit the actual product page to get accurate stock/price
    #         - Stock and price are NOT visible on listing pages
    #         - Extract: SKU, Name, Price, Stock, Images
    #
    # STEP 5: Sync each product to the production API
    #         - Send to: /api/supplier-sync/splendour/products
    #         - Include: name, sku, price, stock_m2, in_stock, images, url
    
    "crawl_steps": [
        {
            "step": 1,
            "action": "navigate_to_main_category",
            "description": "Go to main category page (e.g., /wall-tiles, /floor-tiles)",
            "example_url": "https://www.splendourtiles.co.uk/wall-tiles"
        },
        {
            "step": 2,
            "action": "find_subcategories",
            "description": "Find ALL subcategory links in ORDER",
            "url_pattern": r"^https://www\.splendourtiles\.co\.uk/(wall|floor|outdoor)-tiles/[a-z0-9-]+$",
            "example_urls": [
                "https://www.splendourtiles.co.uk/wall-tiles/alaska",
                "https://www.splendourtiles.co.uk/wall-tiles/agora",
                "https://www.splendourtiles.co.uk/wall-tiles/balance"
            ]
        },
        {
            "step": 3,
            "action": "find_product_urls",
            "description": "Within each subcategory, find ALL product URLs (contain dimensions)",
            "url_pattern": r"\d+x\d+",
            "example_urls": [
                "https://www.splendourtiles.co.uk/alaska-brillo-60x60",
                "https://www.splendourtiles.co.uk/balance-silver-matte-300x600"
            ]
        },
        {
            "step": 4,
            "action": "extract_from_product_page",
            "description": "Visit EACH product detail page and extract data",
            "extract_fields": {
                "name": {
                    "selector": "h1",
                    "description": "Product name from h1 element"
                },
                "sku": {
                    "pattern": r"SKU[:\s]+([A-Z0-9]+)",
                    "description": "SKU code from page text (e.g., 'SKU: ECOALASKA6060B')"
                },
                "price": {
                    "pattern": r"£\s*([\d.]+)\s*/\s*SQM",
                    "description": "Price per SQM (e.g., '£17.37/SQM')"
                },
                "stock": {
                    "pattern": r"(\d[\d,]*)\s*SQM\s*[Ii]n\s*[Ss]tock",
                    "description": "Stock level in SQM (e.g., '377 SQM in Stock')"
                },
                "out_of_stock": {
                    "pattern": r"out\s*of\s*stock",
                    "description": "Check if product is out of stock"
                },
                "images": {
                    "selector": "img[src*='m2wholesale']",
                    "pattern": r"(https://m2wholesale[^\s&\?]+)",
                    "description": "Extract real image URLs from proxy URLs, skip thumbnails (56x56, 48x48)"
                }
            }
        },
        {
            "step": 5,
            "action": "sync_to_api",
            "description": "Send product data to production API",
            "endpoint": "/api/supplier-sync/splendour/products",
            "payload_format": {
                "products": [
                    {
                        "name": "Alaska Brillo 60x60",
                        "sku": "ECOALASKA6060B",
                        "price": 17.37,
                        "stock_m2": 377,
                        "in_stock": True,
                        "images": ["https://m2wholesale.../image.webp"],
                        "url": "https://www.splendourtiles.co.uk/alaska-brillo-60x60"
                    }
                ],
                "source": "browser_extension"
            }
        }
    ],
    
    # IMPORTANT NOTES:
    # 1. Stock and price are ONLY visible on product detail pages, NOT on listing pages
    # 2. Must be logged in to see trade prices
    # 3. Process categories in order: Wall Tiles first, then Floor Tiles, then Outdoor
    # 4. Skip already-synced products to avoid duplicates
    # 5. Images use a proxy URL format: /_ipx/.../https://m2wholesale...
    #    Extract the real URL starting with https://m2wholesale
    
    "notes": [
        "Stock and price are ONLY visible on individual product detail pages",
        "Must be logged in with trade account to see prices",
        "Process Wall Tiles → Floor Tiles → Outdoor Tiles in order",
        "Skip products that have already been synced (track by URL or SKU)",
        "Images use proxy URLs - extract the real m2wholesale URL",
        "Skip thumbnail images (56x56, 48x48 in URL)"
    ]
}

# Production API URL
PRODUCTION_API_URL = "https://tile-station-production.up.railway.app"

# =============================================================================
# TILE STATION ADMIN CREDENTIALS
# Passwords moved to backend/.env (Feb 2026 security cleanup) — set
# TILESTATION_ADMIN_PASSWORD, SPLENDOUR_PORTAL_PASSWORD,
# CERAMICA_PORTAL_PASSWORD, WALLCANO_PORTAL_PASSWORD in env vars.
# =============================================================================
TILE_STATION_ADMIN = {
    "email": "qasim@tilestation.co.uk",
    "password": os.environ.get("TILESTATION_ADMIN_PASSWORD", ""),
    "role": "super_admin"
}

# =============================================================================
# SUPPLIER CREDENTIALS
# =============================================================================

SPLENDOUR_CREDENTIALS = {
    "email": "accounts@tilestation.co.uk",
    "password": os.environ.get("SPLENDOUR_PORTAL_PASSWORD", ""),
    "base_url": "https://www.splendourtiles.co.uk",
    "login_url": "https://www.splendourtiles.co.uk/customer/account/login/"
}

CERAMICA_IMPEX_CREDENTIALS = {
    "email": "qasim@tilestation.co.uk",
    "password": os.environ.get("CERAMICA_PORTAL_PASSWORD", ""),
    "base_url": "https://portal.ceramicaimpex.co.uk",
    "login_url": "https://portal.ceramicaimpex.co.uk/login/default.aspx"
}

WALLCANO_CREDENTIALS = {
    "email": "accounts@tilestation.co.uk",
    "password": os.environ.get("WALLCANO_PORTAL_PASSWORD", ""),
    "base_url": "https://www.wallcanotiles.com",
    "login_url": "https://www.wallcanotiles.com/login"
}

# =============================================================================
# WALLCANO SYNC CONFIGURATION - SPECIAL NOTES
# =============================================================================
# IMPORTANT: Wallcano does NOT have prices on their trade portal!
# The sync extracts: name, SKU, stock, images, size, category, finish
# Prices must be set MANUALLY after sync.
#
# Portal URL: https://www.wallcanotiles.com
# Login: accounts@tilestation.co.uk / <see env: WALLCANO_PORTAL_PASSWORD>
#
# Navigation Flow:
#   1. Login -> /dealers/home (Dashboard)
#   2. Go to /dealers/createOrder -> Shows CATEGORIES (cards)
#   3. Click category -> /dealers/product_list -> Shows PRODUCTS (cards)
#   4. Click product -> /dealers/product_details/{id} -> Shows DETAILS
#
# Data extracted per product:
#   - name: From product card title
#   - sku: Generated as WLC + product_id (e.g., WLC14, WLC128)
#   - stock_m2: From "Available Quantity: X m2" on detail page
#   - images: Product image URL
#   - size: Parsed from name (e.g., "30X45 Cm" -> "30x45")
#   - category: From category clicked
#   - finish: Parsed from name (Matt, Gloss, Polished, etc.)
#
# Sync process:
#   1. Run deep sync to populate products (no prices captured)
#   2. User manually sets cost prices in the admin interface
#   3. List prices are calculated using the standard pricing formula
#
# This is specific to Wallcano only - other suppliers have prices on their portals.
#
# Last successful sync: 2026-02-24
#   - 67 products synced across 5 categories
#   - Categories: Polished (27), Feature Tiles (16), Outdoor (14), High Gloss (7), Matt (3)
#   - Duration: ~13 minutes

WALLCANO_SYNC_CONFIG = {
    "has_prices_on_portal": False,  # Wallcano does NOT show prices on portal
    "price_note": "Prices must be set manually - not available on Wallcano portal",
    "supported_modes": ["deep"],  # Only deep mode (no light mode since no prices to update)
    "extracts": ["name", "sku", "stock_m2", "images", "size", "category", "finish"],
    "does_not_extract": ["price", "cost_price"],  # NOT available on portal
    "estimated_duration": "10-15 minutes for ~80 products",
    "portal_url": "https://www.wallcanotiles.com",
    "categories_page": "/dealers/createOrder",
    "product_list_page": "/dealers/product_list",
    "product_detail_page": "/dealers/product_details/{id}"
}

# =============================================================================
# SERVER-SIDE SYNC CONFIGURATION - ALL SUPPLIERS
# =============================================================================
# This section defines the sync modes and logic for all server-side syncs.
# The sync system supports TWO modes: DEEP and LIGHT (Quick)
#
# DEEP SYNC:
#   - Full crawl of ALL categories and subcategories
#   - Visits EVERY product page
#   - Extracts COMPLETE data: name, SKU, price, stock, images, size, material, finish
#   - Duration: 30-60 minutes depending on catalog size
#   - Use for: Initial database population, adding new products, monthly full refresh
#
# LIGHT SYNC (Quick):
#   - Only syncs products ALREADY in database
#   - Skips category crawling (uses known product URLs from DB)
#   - Only updates: price, stock_m2, in_stock
#   - Duration: 10-15 minutes
#   - Use for: Daily/weekly inventory updates, price checks

SYNC_MODE_CONFIG = {
    "deep": {
        "description": "Full sync with ALL product data including images",
        "when_to_use": [
            "Initial database population",
            "Adding new products",
            "Monthly full refresh",
            "After supplier catalog updates"
        ],
        "extracts": ["name", "sku", "price", "stock", "images", "size", "material", "finish", "url"],
        "estimated_duration": "30-60 minutes",
        "crawls_categories": True,
        "visits_product_pages": True
    },
    "light": {
        "description": "Fast sync for stock and price updates only",
        "when_to_use": [
            "Daily inventory updates",
            "Weekly price checks", 
            "Quick stock verification"
        ],
        "extracts": ["sku", "price", "stock_m2", "in_stock"],
        "estimated_duration": "10-15 minutes",
        "crawls_categories": False,
        "visits_product_pages": True,
        "requires_existing_products": True
    }
}

# =============================================================================
# LIGHT SYNC PRESERVATION RULES - CRITICAL
# =============================================================================
# When running a LIGHT SYNC, the system MUST preserve ALL existing product data
# and ONLY update the specific fields designated for light sync.
#
# LIGHT SYNC: Only updates these fields (PRESERVES everything else):
#   - price (or cost_price for B2B suppliers)
#   - stock_m2 (quantity available)
#   - in_stock (boolean availability)
#   - synced_at (timestamp of sync)
#   - sync_source (marked as "light_stock_price_sync")
#
# LIGHT SYNC: Does NOT touch these fields (PRESERVED from deep sync):
#   - name / display_name / original_name
#   - images (array of image URLs)
#   - size / dimensions
#   - material / finish / color
#   - category / subcategory
#   - description
#   - attributes / specifications
#   - url / product_url
#   - Any custom fields added during naming/processing
#
# IMPLEMENTATION DETAIL:
# Light sync uses MongoDB $set operator on ONLY the designated fields.
# This ensures all other fields remain untouched.
#
# Example (in code):
#   update_fields = {
#       "stock_m2": product.get('stock_m2', 0),
#       "in_stock": product.get('in_stock', False),
#       "synced_at": datetime.now(timezone.utc),
#       "sync_source": "light_stock_price_sync"
#   }
#   if product.get('price'):
#       update_fields["price"] = product['price']
#   
#   db.sync_staging.update_one(
#       {"supplier": supplier, "sku": product['sku']},
#       {"$set": update_fields}  # ONLY these fields updated
#   )

LIGHT_SYNC_RULES = {
    "fields_updated": [
        "price",           # Selling price (Splendour)
        "cost_price",      # Cost price (B2B suppliers like Ceramica Impex)
        "stock_m2",        # Stock quantity in m²
        "in_stock",        # Boolean: is product available?
        "synced_at",       # Timestamp of last sync
        "sync_source"      # Marked as "light_stock_price_sync"
    ],
    "fields_preserved": [
        "name",
        "display_name",
        "original_name",
        "images",
        "image_urls",
        "size",
        "dimensions",
        "material",
        "finish",
        "color",
        "category",
        "subcategory",
        "description",
        "attributes",
        "specifications",
        "url",
        "product_url",
        "sku",            # Never changed (used as identifier)
        "supplier"        # Never changed (used as identifier)
    ],
    "mongodb_operator": "$set",
    "warning": "NEVER use $unset, replaceOne, or upsert with full document in light sync"
}


# =============================================================================
# PAUSE/STOP SYNC FUNCTIONALITY - ALL SYNCS
# =============================================================================
# All sync processes (Server-Side and Browser Extension) support pause/stop.
#
# SERVER-SIDE SYNC (Splendour, Ceramica Impex, etc.):
# ------------------------------------------------
# How to Stop:
#   - Click the "Stop" button in the Sync Hub UI
#   - API: POST /api/supplier-sync/{supplier}/server-sync/stop
#
# What happens on Stop:
#   1. Sets stop_requested = True in sync state
#   2. Current product finishes processing (graceful stop)
#   3. Progress is saved to MongoDB `sync_progress` collection
#   4. Sync state shows phase="stopped" with can_resume=True
#   5. Products already synced are saved - no data loss
#
# How to Resume after Stop:
#   - Start a new sync - it will automatically detect incomplete sync
#   - Resumes from last saved position (skips already-synced products)
#   - API: POST /api/supplier-sync/{supplier}/server-sync/start?mode=deep
#
# VERONA BROWSER EXTENSION:
# -------------------------
# How to Stop:
#   - Click "Stop Sync" button in the extension popup
#   - Or close the tab being synced
#
# What happens on Stop:
#   1. Sets syncState.isRunning = false
#   2. Current product finishes processing
#   3. Synced products are saved in chrome.storage.local
#   4. Status shows how many were synced before stop
#
# How to Resume after Stop:
#   - Click "Sync This Page" again
#   - Already-synced products are automatically skipped (Smart Sync)
#   - Continue from where you left off
#
# IMPORTANT NOTES:
# - Stop is GRACEFUL - current product always completes
# - NO DATA LOSS - all synced products are saved before stop
# - RESUMABLE - can continue from where stopped
# - Progress saved every 10 products (server-side)

SYNC_STOP_CONFIG = {
    "graceful_stop": True,              # Always finish current product before stopping
    "save_progress_on_stop": True,      # Save to DB/storage on stop
    "allow_resume_after_stop": True,    # Can resume from stopped position
    "stop_signal_check_interval": 1,    # Check stop signal every N products
    
    # Server-side stop endpoints
    "stop_endpoints": {
        "splendour": "/api/supplier-sync/splendour/server-sync/stop",
        "ceramica_impex": "/api/supplier-sync/ceramica-impex/server-sync/stop",
        "wallcano": "/api/supplier-sync/wallcano/server-sync/stop",
        "verona": "/api/supplier-sync/verona/server-sync/stop"
    },
    
    # Status after stop
    "stopped_state": {
        "phase": "stopped",
        "is_running": False,
        "can_resume": True,
        "message": "Sync stopped by user. Progress saved. Can resume."
    }
}

# =============================================================================
# RESUME & SKIP CAPABILITY - ALL SUPPLIERS
# =============================================================================
# The sync system has built-in resume and skip functionality to handle
# interruptions gracefully (network errors, server restarts, timeouts).
#
# HOW RESUME WORKS:
# 1. Progress is saved to MongoDB `sync_progress` collection every 10 products
# 2. Saves: all_product_urls, synced_urls, phase, mode, job_id
# 3. On restart, checks for incomplete sync and resumes from last position
# 4. Already-synced products are SKIPPED automatically
#
# HOW SKIP WORKS:
# 1. Each synced product URL is added to `synced_urls` set
# 2. Before processing a product, checks if URL is in synced_urls
# 3. If already synced, SKIPS to next product (no duplicate processing)
#
# ERROR HANDLING:
# - Max 10 consecutive failures before auto-pause
# - On pause: saves progress, sets can_resume=True
# - User can manually resume or start fresh

SYNC_RESUME_CONFIG = {
    "enabled": True,
    "collection": "sync_progress",
    "saves_every": 10,  # Save progress every N products
    "fields_saved": [
        "job_id",
        "supplier",
        "mode",
        "phase",
        "all_product_urls",
        "synced_urls",
        "synced_count",
        "updated_at",
        "status"
    ],
    "skip_already_synced": True,
    "auto_resume_on_restart": True,
    "max_consecutive_failures": 10,
    "action_on_max_failures": "pause_and_save_progress"
}

# Pricing Formula applied to ALL suppliers
# List Price = (Cost × 1.90) × 1.20, rounded UP, minus 0.01
SYNC_PRICING_FORMULA = {
    "markup_multiplier": 2.30,  # 130% markup
    "vat_multiplier": 1.20,     # 20% VAT
    "round_strategy": "ceil_minus_01",  # Round up, then subtract 0.01
    "formula_text": "List Price = ceil((Cost × 1.90) × 1.20) - 0.01"
}


# =============================================================================
# 8. SPLENDOUR SERVER-SIDE SYNC - COMPLETE LOGIC (February 2026)
# =============================================================================
# This section documents the COMPLETE server-side sync logic for Splendour.
# The sync is implemented in: /app/backend/services/splendour_sync.py
#
# IMPORTANT: This is the definitive reference for how the sync MUST work.
# Any future modifications should follow these principles.

SPLENDOUR_SERVER_SYNC = {
    # =========================================================================
    # SYNC MODES
    # =========================================================================
    "modes": {
        "deep": {
            "description": "Full sync with ALL product data including images",
            "when_to_use": "Initial database population, adding new products",
            "duration": "40-60 minutes for full catalog",
            "extracts": ["name", "sku", "price", "stock", "images", "size", "material", "finish"]
        },
        "quick": {
            "description": "Fast sync for stock and price updates only",
            "when_to_use": "Daily/weekly inventory updates",
            "duration": "10-15 minutes",
            "extracts": ["sku", "price", "stock"]
        }
    },
    
    # =========================================================================
    # CATEGORIES TO CRAWL
    # =========================================================================
    # These are the main categories that MUST be crawled
    # NOTE: Essentials and Adhesive-Grout are EXCLUDED (not tile products)
    "categories": [
        "/wall-tiles",           # Wall tiles
        "/floor-tiles",          # Floor tiles
        "/outdoor-tiles",        # Outdoor/patio tiles
        "/new-collections",      # NEW COLLECTIONS - Critical for new products!
    ],
    
    # Categories EXCLUDED from sync (not tile products)
    "excluded_categories": [
        "/adhesive-grout",       # Adhesives and grouts - NOT synced
        "/essentials",           # Tile essentials - NOT synced
    ],
    
    # =========================================================================
    # PRODUCT DISCOVERY METHODS
    # =========================================================================
    # The sync uses MULTIPLE methods to ensure ALL products are captured
    "discovery_methods": {
        
        # METHOD 1: Category Crawling
        "category_crawling": {
            "description": "Navigate through all categories and subcategories",
            "steps": [
                "1. Go to main category page (e.g., /wall-tiles)",
                "2. Click 'LOAD NEXT' to load all subcategories",
                "3. Extract all subcategory URLs",
                "4. Visit each subcategory",
                "5. Click 'LOAD MORE' to load all products",
                "6. Extract product URLs using PRODUCT CARD selectors"
            ]
        },
        
        # METHOD 2: Search Discovery (NEW - February 2026)
        "search_discovery": {
            "description": "Search the entire catalog using alphabet and common terms",
            "why_needed": "Catches products not in standard category structure",
            "search_terms": [
                "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m",
                "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z",
                "1", "2", "3", "4", "5", "6", "7", "8", "9", "0",
                "marble", "wood", "stone", "metro", "terrazzo", "vintage", "signature"
            ],
            "steps": [
                "1. For each search term, go to /search?q={term}",
                "2. Click 'LOAD MORE' to load all results",
                "3. Extract product URLs from product cards",
                "4. Deduplicate with products found via category crawling"
            ]
        }
    },
    
    # =========================================================================
    # PRODUCT URL DETECTION - CRITICAL FIX (February 2026)
    # =========================================================================
    # The OLD method was WRONG and missed many products!
    "product_url_detection": {
        
        # OLD METHOD (BROKEN - DO NOT USE)
        "old_method_broken": {
            "pattern": r"\d+x\d+",  # Only matched URLs with dimension patterns
            "problem": "Many products don't have dimensions in URL!",
            "examples_missed": [
                "vintage-blue-wood-effect-wall-and-floor-tiles",
                "terrazzo-dark-blue",
                "fs-star-blue",
                "candy-pistachio"
            ]
        },
        
        # NEW METHOD (CORRECT - USE THIS)
        "new_method_correct": {
            "use_selectors": [
                "[data-testid='product-card']",
                ".product-card",
                ".product-item",
                "article[class*='product']"
            ],
            "description": "Use product CARD ELEMENTS to find products, not URL patterns",
            "steps": [
                "1. Find all product card elements on the page",
                "2. Extract the <a> link from each card",
                "3. Get the href attribute",
                "4. Filter out navigation links (/customer/, /cart/, etc.)"
            ],
            "fallback": "If no product cards found, try price container method"
        }
    },
    
    # =========================================================================
    # DATA EXTRACTION FROM PRODUCT PAGES
    # =========================================================================
    "extraction": {
        "name": {
            "selector": "h1",
            "required": True
        },
        "sku": {
            "patterns": [
                r"SKU[:\s]+([A-Z0-9]+)",
                r"Product ID[:\s]+([A-Z0-9]+)"
            ],
            "fallback": "Generate from URL slug if not found",
            "required": False  # Changed! SKU is now optional
        },
        "price": {
            "pattern": r"£\s*([\d.]+)\s*/\s*SQM",
            "required": False
        },
        "stock": {
            "in_stock_pattern": r"(\d[\d,]*)\s*SQM\s*[Ii]n\s*[Ss]tock",
            "out_of_stock_pattern": r"out\s*of\s*stock",
            "required": False
        },
        "images": {
            "selectors": [
                "a[href*='m2wholesale']",  # High-res links
                "img[src*='m2wholesale']"   # Fallback to img tags
            ],
            "prefer_sizes": ["2300X2300", "650X650"],
            "exclude_sizes": ["100X100", "56x56", "48x48", "video_thumbnail"]
        },
        "size": {
            "patterns": [
                r"Size[:\s]+(\d+x\d+(?:x\d+)?mm)",
                r"(\d+x\d+)"  # From product name
            ]
        }
    },
    
    # =========================================================================
    # PAGINATION HANDLING
    # =========================================================================
    "pagination": {
        "selectors": [
            "button:has-text('LOAD MORE')",
            "button:has-text('Load More')",
            "button:has-text('Show More')",
            "button:has-text('View More')",
            "button:has-text('LOAD NEXT')",
            "button:has-text('Load Next')",
            "a:has-text('LOAD MORE')",
            "a:has-text('LOAD NEXT')"
        ],
        "max_clicks": 100,
        "wait_after_click": 1.5  # seconds
    },
    
    # =========================================================================
    # RESUME CAPABILITY
    # =========================================================================
    "resume": {
        "enabled": True,
        "collection": "sync_progress",
        "saves_every": 10,  # Save progress every 10 products
        "fields_saved": [
            "all_product_urls",
            "synced_urls",
            "phase",
            "mode"
        ]
    },
    
    # =========================================================================
    # ERROR HANDLING
    # =========================================================================
    "error_handling": {
        "max_consecutive_failures": 10,
        "action_on_max_failures": "pause_and_save_progress",
        "timeout_per_page": 30000  # ms
    },
    
    # =========================================================================
    # API ENDPOINTS
    # =========================================================================
    "api_endpoints": {
        "start_deep_sync": "POST /api/supplier-sync/splendour/server-sync/start?mode=deep",
        "start_quick_sync": "POST /api/supplier-sync/splendour/server-sync/start?mode=quick",
        "check_status": "GET /api/supplier-sync/splendour/server-sync/status",
        "stop_sync": "POST /api/supplier-sync/splendour/server-sync/stop"
    }
}

# =============================================================================
# 9. LESSONS LEARNED - WHY PRODUCTS WERE MISSED (February 2026)
# =============================================================================
# This documents the investigation into why 131+ products were missed by the
# original sync and how they were recovered.

SYNC_LESSONS_LEARNED = {
    "investigation_date": "2026-02-19",
    
    "root_causes": {
        "cause_1": {
            "description": "Product URL detection only looked for dimension patterns",
            "old_code": "if href and re.search(r'\\d+x\\d+', href)",
            "impact": "Missed products without dimensions in URL",
            "examples": ["vintage-blue-wood-effect-tiles", "terrazzo-dark-blue"]
        },
        "cause_2": {
            "description": "Limited category coverage",
            "old_categories": ["/wall-tiles", "/floor-tiles", "/outdoor-tiles"],
            "missing_categories": ["/adhesive-grout", "/essentials", "/new-collections"]
        },
        "cause_3": {
            "description": "No search-based discovery",
            "impact": "Products not in standard category structure were missed"
        }
    },
    
    "recovery_methods_used": {
        "method_1_url_matching": {
            "description": "Convert product names to URL slugs and check if they exist",
            "products_found": 29
        },
        "method_2_deep_search": {
            "description": "Search for each missing SKU, extract ALL results",
            "products_found": 102,
            "insight": "Even if SKU isn't found, search shows related products!"
        }
    },
    
    "total_products_recovered": 131,
    
    "recommendation": "Always use PRODUCT CARD selectors, never URL pattern matching"
}



# =============================================================================
# 9. SPLENDOUR SERIES → UNIQUE NAME MAPPING (USED FOR ALL TILING SUPPLIERS)
# =============================================================================
# This mapping is used for ALL tiling suppliers (not just Splendour)
# Add new supplier series names here with unique Italian-themed names
#
# HOW TO ADD NEW SERIES:
#   "SupplierSeriesName": "UniqueItalianName",
#
# EXAMPLE - Adding a new Wallcano series:
#   "NewWallcanoSeries": "Napoli",
#
# GUIDELINES FOR UNIQUE NAMES:
#   - Use Italian city/region names: Venice, Milan, Rome, Florence, etc.
#   - Use Italian words: Bianco, Nero, Grigio, etc.
#   - Ensure the name isn't already used by another series
#
# Applied to all 857 Splendour products on 20 Feb 2026
# Format: {UNIQUE_NAME} {COLOUR} {SIZE} {FINISH} {CHARACTERISTICS}
# Original supplier name preserved as subtitle with SKU: "Original Name [SKU]"

SPLENDOUR_SERIES_TO_UNIQUE_NAME = {
    "Agora": "Atlas",
    "Alaska": "Everest",
    "Alda": "Sahara",
    "Ancona": "Amazon",
    "Apennine": "Olympus",
    "Aragon": "Aurora",
    "Arcano": "Cairo",
    "Armony": "Venice",
    "Artan": "Milan",
    "Ashland": "Roma",
    "Asly": "Vienna",
    "Astra": "Monaco",
    "Atrium": "Paris",
    "Auric": "Oslo",
    "Austral": "Geneva",
    "Azuma": "Zurich",
    "Balance": "Tokyo",
    "Behobia": "Sydney",
    "Bello": "Denver",
    "Belvedere": "Austin",
    "Beyond": "Phoenix",
    "Bohemy": "Dallas",
    "Borgogna": "Boston",
    "Bouquet": "Miami",
    "Bourton": "Aspen",
    "Bowness": "Malibu",
    "Breeze": "Capri",
    "Bricks": "Amalfi",
    "Bumpy": "Riviera",
    "Burlington": "Santorini",
    "Calacatta": "Mykonos",
    "Candy": "Crete",
    "Carmo": "Cascade",
    "Carnaby": "Summit",
    "Carrara": "Ridge",
    "Casa": "Canyon",
    "Cement": "Mesa",
    "Cemento": "Terra",
    "Ceppo": "Luna",
    "Cielo": "Nova",
    "Cipriani": "Stella",
    "Civic": "Cosmo",
    "Clay": "Zenith",
    "Clemence": "Apex",
    "Colorado": "Prime",
    "Comapedrosa": "Elite",
    "Concrete": "Luxe",
    "Coralina": "Regal",
    "Country": "Crystal",
    "Crossover": "Onyx",
    "Detroit": "Pearl",
    "Devonstone": "Ivory",
    "Dix": "Obsidian",
    "Doblo": "Granite",
    "Eternal": "Quartz",
    "Eternity": "Slate",
    "Etna": "Harbor",
    "Everest": "Marina",
    "Fluted": "Cove",
    "Forall": "Bay",
    "Forest": "Coast",
    "Fossil": "Shore",
    "Fresno": "Cliff",
    "Fulham": "Dune",
    "Gems": "Horizon",
    "Genova": "Eclipse",
    "Gloss": "Solstice",
    "Granby": "Equinox",
    "Grand": "Vega",
    "Grava": "Orion",
    "Hand": "Polaris",
    "Harbour": "Sirius",
    "Helena": "Metro",
    "Hexagon": "Urban",
    "Imperial": "Civic",
    "Infinity": "Plaza",
    "Ingot": "Avenue",
    "Invisible": "Boulevard",
    "Irun": "Strada",
    "Jarel": "Piazza",
    "Juvel": "Artisan",
    "Kai": "Studio",
    "Kalahari": "Gallery",
    "Kashmir": "Atelier",
    "Keystone": "Loft",
    "Kitkat": "Soho",
    "Klavier": "Chelsea",
    "Kuni": "Tribeca",
    "LTP": "Nordic",
    "Lancaster": "Baltic",
    "Langdale": "Celtic",
    "Ledgestone": "Tuscan",
    "Lenk": "Aegean",
    "Levante": "Adriatic",
    "Leviglass": "Pacific",
    "Liso": "Majestic",
    "Loft": "Imperial",
    "Lucia": "Royal",
    "Lux": "Noble",
    "Magma": "Grand",
    "Magnetic": "Premier",
    "Makrana": "Prestige",
    "Manhattan": "Legacy",
    "Mare": "Essence",
    "Marmo": "Pure",
    "Marshall": "Serene",
    "Materia": "Tranquil",
    "Maximum": "Harmony",
    "Melrose": "Balance",
    "Merbau": "Zen",
    "Merlot": "Oasis",
    "Metallique": "Palermo",
    "Metro": "Florence",
    "Milos": "Siena",
    "Mistral": "Naples",
    "Modern": "Bologna",
    "Mojo": "Torino",
    "Monocolour": "Genoa",
    "Mumble": "Barcelona",
    "Muralla": "Madrid",
    "Mystone": "Seville",
    "Nairobi": "Valencia",
    "Neutra": "Lisbon",
    "New Pietra": "Porto",
    "Newstone": "Athens",
    "Night Time": "Rhodes",
    "Nikea": "Kyoto",
    "Nkr": "Beijing",
    "Northbay": "Shanghai",
    "Old Manor": "Mumbai",
    "Omnia": "Dubai",
    "Onix": "Istanbul",
    "Opal": "Prague",
    "Open": "Budapest",
    "Palatina": "Warsaw",
    "Pavilion": "Moscow",
    "Pickett": "Stockholm",
    "Pixel": "Helsinki",
    "Plaster": "Copenhagen",
    "Pleasure": "Amsterdam",
    "Polaris": "Brussels",
    "Pompeya": "Edinburgh",
    "Poole": "Dublin",
    "Porto": "Cork",
    "Prismatics": "Glasgow",
    "Provence": "Cardiff",
    "Proxi": "Belfast",
    "Pulse": "Manchester",
    "Pure": "Liverpool",
    "Rapolano": "Berlin",
    "Retro": "Munich",
    "Riad": "Hamburg",
    "Rialto": "Frankfurt",
    "Riva": "Cologne",
    "Rock-Tite": "Dusseldorf",
    "Rodas": "Leipzig",
    "Rodeno": "Dresden",
    "Roma": "Lyon",
    "Roof": "Marseille",
    "Safari": "Nice",
    "Sahara": "Cannes",
    "Sahn": "Bordeaux",
    "Samba": "Toulouse",
    "Satin": "Nantes",
    "Selva": "Strasbourg",
    "Shadow": "Verona",
    "Signature": "Pisa",
    "Silk": "Como",
    "Sirocco": "Sorrento",
    "Snow": "Positano",
    "Sovereign": "Ravello",
    "Splendours": "Taormina",
    "Springwood": "Orvieto",
    "Star": "Cordoba",
    "Stardust": "Granada",
    "Stoneart": "Malaga",
    "Stoneline": "Bilbao",
    "Stracciatella": "Santiago",
    "Strato": "Pamplona",
    "Sublime": "Toledo",
    "Sumum": "Segovia",
    "Sunset": "Sintra",
    "Super": "Cascais",
    "Tanger": "Braga",
    "Tapa": "Coimbra",
    "Tarima": "Faro",
    "Tempo": "Lagos",
    "Terrazzo": "Tavira",
    "Timeless": "Evora",
    "Tosca": "Luxor",
    "Touch": "Petra",
    "Toulouse": "Bali",
    "Tranquil": "Fiji",
    "Travertino": "Tahiti",
    "Unaway": "Havana",
    "Uptown": "Kingston",
    "Valley": "Nassau",
    "Venato": "Bermuda",
    "Venice": "Cancun",
    "Vermont": "Acapulco",
    "Versailles": "Cabo",
    "Victorian": "Monterey",
    "Vintage": "Sedona",
    "Vita": "Taos",
    "White": "Vail",
    "Windsor": "Telluride",
    "Yuri": "Whistler",
    "Zebra": "Banff",
    # Additional common series names
    "Royal": "Armani",
    "Salt": "Ravenna",
    "Pepper": "Siena",
    "Imperial": "Versace",
    "Loft": "Imperial",
    "Urban": "Metro",
    "Mineral": "Quarry",
    "Antiqua": "Vintage",
    "Portland": "Harbor",
    "Virginia": "Colonial",
    "Roma": "Roman",
    "Bodo": "Nordic",
    "Relief": "Cascade",
    "Super": "Premium",
    # Multi-word series (handled specially)
    "Salt And Pepper": "Terrazzo",
    
    # ==========================================================================
    # ADDITIONAL SPLENDOUR SERIES (Mar 5, 2026) - 56 new mappings
    # ==========================================================================
    "Colonial": "Savannah",
    "Continuum": "Horizon",
    "Costa": "Riviera",
    "Dazzle": "Sparkle",
    "Delray": "Venice",
    "Divine": "Celestial",
    "Dolomite": "Alpine",
    "Eiffel": "Lyon",
    "Elite": "Prestige",
    "Emporio": "Boutique",
    "Euro": "Europa",
    "Evolve": "Genesis",
    "Exotica": "Tropica",
    "Fiorino": "Florentine",
    "Flora": "Botanica",
    "Forrest": "Woodland",
    "Fortuna": "Fortune",
    "Geneva": "Swiss",
    "Geo": "Terra",
    "Gris": "Grigio",
    "Harlem": "Manhattan",
    "Harmony": "Serenity",
    "Helios": "Solar",
    "Heritage": "Legacy",
    "Ibiza": "Majorca",
    "Icon": "Iconic",
    "Indiana": "Prairie",
    "Isola": "Island",
    "Kyoto": "Tokyo",
    "Lagoon": "Laguna",
    "Liberty": "Freedom",
    "Loft": "Atelier",
    "Lunar": "Luna",
    "Luxor": "Pharaoh",
    "Marbella": "Costa",
    "Maremma": "Tuscan",
    "Marina": "Porto",
    "Marquina": "Bilbao",
    "Metro": "Urban",
    "Milano": "Lombardy",
    "Monaco": "Riviera",
    "Montage": "Collage",
    "Monte": "Summit",
    "Nordic": "Scandic",
    "Nova": "Stellar",
    "Oasis": "Mirage",
    "Oceania": "Pacific",
    "Olympia": "Athens",
    "Oxford": "Cambridge",
    "Palace": "Royal",
    "Palermo": "Sicily",
    "Paris": "Parisien",
    "Pearl": "Perla",
    "Pietra": "Stone",
    "Plaza": "Piazza",
    "Porto": "Lisboa",
    "Premier": "Prime",
    "Prime": "Elite",
    "Pulpis": "Marble",
    
    # ==========================================================================
    # WALLCANO-SPECIFIC SERIES (Mar 4, 2026)
    # ==========================================================================
    # These are series names unique to Wallcano that need transformation
    "Terra": "Verona",
    "Splitface": "Ravenna",
    "Sandstone": "Siena",
    "Kandla": "Florence",
    "Moonstone": "Lucca",
    "Ghr": "Pisa",
    "Mint": "Mint",  # Keep as is (it's a color)
    "Pink": "Pink",  # Keep as is (it's a color)
    "Anthrecite": "Anthracite",  # Fix spelling
    "Crema": "Crema",  # Keep as is (it's a color)
    # Wallcano Glass Series (Mar 5, 2026)
    "Thunder": "Murano",
    "Scoria": "Positano",
    "Magnum": "Portofino",
    "Hurricane": "Taormina",
    "Burnt": "Tropea",
    # Wallcano Additional Series (Mar 5, 2026) - ALL 45 series mapped
    "Alfresco": "Sorrento",
    "Allure": "Capri",
    "Brickstone": "Assisi",
    "Brook": "Orvieto",
    "Calacatta": "Carrara",
    "Cementino": "Perugia",
    "Cemslate": "Terni",
    "Classic": "Spoleto",
    "Elegant": "Gubbio",
    "Emerald": "Ancona",
    "Emporia": "Pesaro",
    "Eteranal": "Urbino",  # Typo in original
    "Eternal": "Urbino",
    "Gloucous": "Fano",
    "Grande": "Rimini",
    "Hard": "Riccione",
    "Hardwood": "Cesena",
    "Imperial": "Ferrara",
    "Jaisalmer": "Modena",
    "Magic": "Parma",
    "Newton": "Reggio",
    "Ondulato": "Piacenza",
    "Onix": "Onice",  # Already Italian
    "Onyx": "Onice",
    "Pacific": "Genova",
    "Real": "Como",
    "Romelini": "Bergamo",
    "Ruby": "Brescia",
    "Saffire": "Verona",
    "Sparos": "Mantova",
    "Spectra": "Cremona",
    "Splendor": "Pavia",
    "Stoneage": "Lodi",
    "Tuscan": "Monza",
    "Urban": "Torino",
    # Additional Wallcano series found in production
    "Mykonos": "Bari",       # Greek island -> Italian city
    "Istanbul": "Lecce",     # Turkish city -> Italian city
}

# Function to get unique name for Splendour series
def get_splendour_unique_name(supplier_series_name):
    """
    Get the unique product name for a Splendour series.
    Returns the mapped unique name or the original if not found.
    """
    return SPLENDOUR_SERIES_TO_UNIQUE_NAME.get(supplier_series_name, supplier_series_name)


# =============================================================================
# 10. CERAMICA IMPEX SERVER-SIDE SYNC LOGIC
# =============================================================================
# This section documents the server-side sync logic for Ceramica Impex.
# The sync is implemented in: /app/backend/services/ceramica_impex_sync.py
#
# Portal: https://portal.ceramicaimpex.co.uk
# Login: ASP.NET form-based authentication
# Last Synced: 2026-02-20 (255 products)

# =============================================================================
# NAMING LOGIC FOR ALL TILING SUPPLIERS
# =============================================================================
# ALL tiling suppliers now use SPLENDOUR_SERIES_TO_UNIQUE_NAME mapping.
# This provides 200+ series → unique name transformations.
# 
# When duplicates are detected, ALTERNATIVE_SERIES_NAMES provides different
# unique names for the same series to ensure NO duplicate product names.
#
# Tiling Suppliers WITH naming transformation:
# - Splendour, Ceramica Impex, Wallcano, Verona
# - Le Porce, H Martin, Tilebase, Bloomstone, Boyden, Eagle
#
# Suppliers EXCLUDED (keep original names):
# - Tile Rite, Ultra Tile, Trimline, Regulus
#
# How it works:
# 1. Split product name into parts
# 2. Check each part against SPLENDOUR_SERIES_TO_UNIQUE_NAME
# 3. Replace first matching series with unique name
# 4. If duplicate found, use next name from ALTERNATIVE_SERIES_NAMES
# 5. Apply Title Case and cleanup (remove Tile, Tiles, Porcelain, etc.)
# =============================================================================

# Alternative names for series - used when duplicates are detected
# Each series has multiple unique names to choose from
ALTERNATIVE_SERIES_NAMES = {
    # Common series with multiple alternatives
    "Cement": ["Mesa", "Mosca", "London", "Tulip", "Berlin", "Prague", "Warsaw", "Dublin"],
    "Calacatta": ["Mykonos", "Santorini", "Capri", "Portofino", "Positano", "Sorrento", "Taormina", "Ravello"],
    "Carrara": ["Ridge", "Alpine", "Nordic", "Arctic", "Polar", "Glacier", "Frost", "Crystal"],
    "Marble": ["Marble", "Marmo", "Pietra", "Roccia", "Sasso", "Marmol", "Marbella", "Petra"],
    "Travertino": ["Tahiti", "Bali", "Fiji", "Samoa", "Tonga", "Vanuatu", "Moorea", "Palau"],
    "Concrete": ["Luxe", "Metro", "Urban", "Civic", "Centro", "District", "Quarter", "Borough"],
    "Snow": ["Positano", "Capri", "Ischia", "Procida", "Anacapri", "Ravello", "Maiori", "Minori"],
    "Wood": ["Rovere", "Quercia", "Faggio", "Noce", "Acero", "Olmo", "Castagno", "Ciliegio"],
    "Stone": ["Petra", "Rocca", "Sasso", "Pietra", "Kamen", "Stein", "Roca", "Pedra"],
    "Grey": ["Grigio", "Cenere", "Fumo", "Piombo", "Ardesia", "Grafite", "Argento", "Acciaio"],
    "White": ["Bianco", "Neve", "Latte", "Perla", "Avorio", "Gesso", "Candido", "Puro"],
    "Black": ["Nero", "Carbone", "Ebano", "Inchiostro", "Notte", "Ombra", "Pece", "Corvino"],
    "Beige": ["Sabbia", "Crema", "Vaniglia", "Cammello", "Caramello", "Miele", "Ambra", "Ocra"],
    "Grand": ["Vega", "Sirius", "Rigel", "Altair", "Deneb", "Antares", "Spica", "Arcturus"],
    "Onyx": ["Onice", "Gemma", "Giada", "Opale", "Topazio", "Zaffiro", "Rubino", "Smeraldo"],
    "Slate": ["Ardesia", "Lavagna", "Schisto", "Tegola", "Piastrella", "Scaglia", "Lastrone", "Lastra"],
    "Sand": ["Dune", "Sahara", "Deserto", "Gobi", "Kalahari", "Namib", "Atacama", "Mojave"],
    "Terracotta": ["Cotto", "Argilla", "Terracotta", "Mattone", "Laterizio", "Tegola", "Coppo", "Embrice"],
    "Limestone": ["Lecce", "Trani", "Vicenza", "Comiso", "Noto", "Ragusa", "Modica", "Scicli"],
    "Porcelain": ["Porcellana", "Ceramica", "Maiolica", "Faenza", "Deruta", "Vietri", "Caltagirone", "Montelupo"],
    "Matt": ["Opaco", "Satinato", "Velvet", "Silk", "Suede", "Matte", "Soft", "Smooth"],
    "Gloss": ["Lucido", "Brillante", "Specchio", "Cristallo", "Vetro", "Lustro", "Splendente", "Radiante"],
    "Polished": ["Levigato", "Lucidato", "Lappato", "Specchiato", "Riflesso", "Lustrato", "Brillato", "Sfavillante"],
    # Additional common series
    "Royal": ["Armani", "Gucci", "Prada", "Versace", "Dior", "Chanel", "Fendi", "Hermes"],
    "Salt": ["Ravenna", "Bologna", "Parma", "Modena", "Ferrara", "Rimini", "Cesena", "Forli"],
    "Imperial": ["Versace", "Dynasty", "Regal", "Crown", "Monarch", "Sovereign", "Majestic", "Royal"],
    "Loft": ["Imperial", "Industrial", "Studio", "Atelier", "Workshop", "Factory", "Mill", "Warehouse"],
    "Urban": ["Metro", "City", "Downtown", "Central", "Civic", "Municipal", "Borough", "District"],
    "Mineral": ["Quarry", "Mine", "Ore", "Crystal", "Geode", "Boulder", "Bedrock", "Stratum"],
    "Antiqua": ["Vintage", "Heritage", "Classic", "Retro", "Antique", "Timeless", "Legacy", "Heirloom"],
    # Wallcano-specific series (Mar 4, 2026)
    "Terra": ["Verona", "Padua", "Vicenza", "Treviso", "Udine", "Trieste", "Gorizia", "Pordenone"],
    "Splitface": ["Ravenna", "Rimini", "Cesena", "Forli", "Faenza", "Imola", "Lugo", "Cervia"],
    "Sandstone": ["Siena", "Arezzo", "Cortona", "Montepulciano", "Chiusi", "Pienza", "Montalcino", "Grosseto"],
    "Kandla": ["Florence", "Fiesole", "Empoli", "Prato", "Pistoia", "Lucca", "Viareggio", "Livorno"],
    "Moonstone": ["Lucca", "Carrara", "Massa", "Viareggio", "Forte", "Pietrasanta", "Camaiore", "Seravezza"],
    # Wallcano Glass series (Mar 5, 2026)
    "Thunder": ["Murano", "Venezia", "Burano", "Torcello", "Lido", "Chioggia", "Jesolo", "Caorle"],
    "Scoria": ["Positano", "Sorrento", "Amalfi", "Praiano", "Furore", "Conca", "Maiori", "Minori"],
    "Magnum": ["Portofino", "Rapallo", "Nervi", "Camogli", "Sestri", "Levanto", "Monterosso", "Riomaggiore"],
    "Hurricane": ["Taormina", "Cefalù", "Siracusa", "Ragusa", "Modica", "Noto", "Scicli", "Catania"],
    "Burnt": ["Tropea", "Pizzo", "Scilla", "Reggio", "Gerace", "Stilo", "Crotone", "Cosenza"],
}

# Legacy alias for backwards compatibility
CERAMICA_IMPEX_SERIES_TO_NAME = SPLENDOUR_SERIES_TO_UNIQUE_NAME

CERAMICA_IMPEX_SERVER_SYNC = {
    # =========================================================================
    # SYNC MODES
    # =========================================================================
    "modes": {
        "deep": {
            "description": "Full sync with ALL product data including images",
            "when_to_use": "Initial database population, adding new products, monthly refresh",
            "duration": "30-45 minutes for full catalog",
            "extracts": ["name", "sku", "price", "stock", "images", "size", "material", "finish"]
        },
        "light": {
            "description": "Fast sync for stock and price updates only",
            "when_to_use": "Daily/weekly inventory updates",
            "duration": "10-15 minutes",
            "extracts": ["sku", "price", "stock_m2", "in_stock"]
        }
    },
    
    # =========================================================================
    # NAMING LOGIC
    # =========================================================================
    "naming": {
        "format": "{Series} {Color} {Size} {Finish}",
        "examples": [
            {"original": "355 POLISHED 60X60", "new": "Mirror 60x60 Polished"},
            {"original": "4405 RELIEF SUPER WHITE 20x25", "new": "Alpine White 20x25 Relief"},
            {"original": "ALASKA GRAPHITE 80X80", "new": "Slate Graphite 80x80"}
        ],
        "series_mapping": "See CERAMICA_IMPEX_SERIES_TO_NAME dictionary"
    },
    
    # =========================================================================
    # API ENDPOINTS
    # =========================================================================
    "api_endpoints": {
        "start_deep_sync": "POST /api/supplier-sync/ceramica-impex/server-sync/start?mode=deep",
        "start_light_sync": "POST /api/supplier-sync/ceramica-impex/server-sync/start?mode=light",
        "check_status": "GET /api/supplier-sync/ceramica-impex/server-sync/status",
        "stop_sync": "POST /api/supplier-sync/ceramica-impex/server-sync/stop"
    },
    
    # =========================================================================
    # DATA EXTRACTION
    # =========================================================================
    "extraction": {
        "name": {
            "selectors": ["h1", ".product-title", ".product-name"],
            "required": True
        },
        "sku": {
            "patterns": [
                r"Stock\s*Code[:\s]+([A-Z0-9-]+)",
                r"SKU[:\s]+([A-Z0-9-]+)",
                r"Product\s*Code[:\s]+([A-Z0-9-]+)"
            ],
            "fallback": "Generate from URL slug if not found"
        },
        "price": {
            "patterns": [
                r"£\s*([\d.]+)\s*(?:per\s*)?(?:SQM|sqm|m²)",
                r"Price[:\s]*£\s*([\d.]+)"
            ],
            "note": "This is the COST price. List price is calculated using the pricing formula."
        },
        "stock": {
            "in_stock_patterns": [
                r"(\d[\d,]*)\s*(?:SQM|sqm|m²)\s*(?:in\s*stock|available)",
                r"Stock[:\s]*(\d[\d,]*)"
            ],
            "out_of_stock_patterns": [r"out\s*of\s*stock|unavailable"]
        },
        "images": {
            "selectors": [
                "img[src*='product']",
                "img[src*='image']",
                ".product-image img"
            ],
            "exclude": ["thumb", "icon", "32x32"]
        }
    },
    
    # =========================================================================
    # PRICING FORMULA
    # =========================================================================
    "pricing": {
        "formula": "List Price = ceil((Cost × 1.90) × 1.20) - 0.01",
        "markup_multiplier": 1.90,  # 90% markup
        "vat_multiplier": 1.20,     # 20% VAT
        "rounding": "ceil_minus_01",
        "example": "Cost £10.00 → £10 × 1.90 = £19 × 1.20 = £22.80 → ceil = £23 - 0.01 = £22.99"
    }
}


# =============================================================================
# 11. VERONA BROWSER EXTENSION SYNC RULES (v4.0 Enhanced)
# =============================================================================
# Extension Location: /app/browser-extension/
# Portal: https://www.veronaceramics.com (trade portal)
# Updated: 2026-02-20 - Added multiple images, size, material, finish, color

VERONA_EXTENSION_CONFIG = {
    # =========================================================================
    # EXTENSION VERSION & FILES
    # =========================================================================
    "version": "4.0",
    "files": {
        "popup": "/app/browser-extension/popup.html",
        "background": "/app/browser-extension/background.js",
        "popup_js": "/app/browser-extension/popup.js",
        "manifest": "/app/browser-extension/manifest.json"
    },
    
    # =========================================================================
    # SYNC MODES
    # =========================================================================
    "modes": {
        "full_sync": {
            "description": "Visit each product page for complete details",
            "when_to_use": "Initial database population, monthly refresh",
            "extracts": ["name", "sku", "price", "stock", "images", "size", "material", "finish", "color"]
        },
        "quick_sync": {
            "description": "Extract from listing page (faster, less details)",
            "when_to_use": "Daily stock updates",
            "extracts": ["name", "sku", "price", "stock"]
        }
    },
    
    # =========================================================================
    # DATA EXTRACTION SELECTORS & PATTERNS
    # =========================================================================
    "extraction": {
        "name": {
            "selectors": ["h1.page-title", "h1[itemprop='name']", ".product-info-main h1", "h1"],
            "required": True
        },
        "sku": {
            "method": "table_search",
            "fallback": "url_regex",
            "url_pattern": r"/([a-z])(\d+)"
        },
        "price": {
            "patterns": [
                r"£([\d.]+)\s*per\s*m²",
                r"£([\d.]+)\s*per\s*m2",
                r"£([\d.]+)\s*/\s*m²",
                r"£([\d.]+)\s*/m²",
                r"£([\d.]+)\s*m²"
            ]
        },
        "stock": {
            "in_stock_patterns": [
                r"in\s*stock[:\s]+(\d[\d,]*)\s*\((\d+)\s*m²?\)",
                r"in\s*stock[:\s]+(\d[\d,]*)"
            ],
            "out_of_stock_patterns": [r"out\s*of\s*stock"],
            "default_if_not_found": "out_of_stock"
        },
        "images": {
            "selectors": [
                ".fotorama__img",
                ".gallery-placeholder__image",
                ".product-image-photo",
                ".product-image img",
                "img[src*='catalog/product']",
                "img[src*='media/catalog']",
                ".product-gallery img",
                "[data-gallery-role='gallery'] img"
            ],
            "max_images": 5,
            "exclude": ["thumbnail", "small_image"],
            "data_attributes": ["data-src", "data-lazy", "data-full"]
        },
        "size": {
            "patterns": [
                r"(\d+)\s*[xX×]\s*(\d+)(?:\s*[xX×]\s*(\d+))?\s*(?:mm|cm)?",
                r"Size[:\s]*(\d+)\s*[xX×]\s*(\d+)",
                r"Dimensions?[:\s]*(\d+)\s*[xX×]\s*(\d+)"
            ]
        },
        "material": {
            "patterns": {
                "Porcelain": r"\bPorcelain\b",
                "Ceramic": r"\bCeramic\b",
                "Natural Stone": r"\bNatural\s*Stone\b",
                "Marble": r"\bMarble\b",
                "Granite": r"\bGranite\b",
                "Slate": r"\bSlate\b",
                "Travertine": r"\bTravertine\b",
                "Limestone": r"\bLimestone\b",
                "Glass": r"\bGlass\s*(?:Tile|Mosaic)?\b",
                "Mosaic": r"\bMosaic\b"
            }
        },
        "finish": {
            "patterns": {
                "Polished": r"\bPolish(?:ed)?\b",
                "Matt": r"\bMatt(?:e)?\b",
                "Gloss": r"\bGloss(?:y)?\b",
                "Satin": r"\bSatin\b",
                "Lappato": r"\bLappato\b",
                "Honed": r"\bHoned\b",
                "Textured": r"\bTexture[d]?\b",
                "Anti-Slip": r"\bAnti[- ]?Slip\b",
                "Rustic": r"\bRustic\b",
                "Riven": r"\bRiven\b",
                "Tumbled": r"\bTumbled\b"
            }
        },
        "color": {
            "patterns": {
                "White": r"\bWhite\b",
                "Black": r"\bBlack\b",
                "Grey": r"\bGr[ae]y\b",
                "Beige": r"\bBeige\b",
                "Cream": r"\bCream\b",
                "Brown": r"\bBrown\b",
                "Blue": r"\bBlue\b",
                "Green": r"\bGreen\b",
                "Ivory": r"\bIvory\b",
                "Graphite": r"\bGraphite\b",
                "Anthracite": r"\bAnthracite\b",
                "Sand": r"\bSand\b",
                "Taupe": r"\bTaupe\b",
                "Charcoal": r"\bCharcoal\b"
            }
        }
    },
    
    # =========================================================================
    # PRICING FORMULA (Applied on Backend)
    # =========================================================================
    "pricing": {
        "formula": "List Price = ceil((Cost × 1.90) × 1.20) - 0.01",
        "markup_multiplier": 1.90,
        "vat_multiplier": 1.20,
        "rounding": "ceil_minus_01",
        "applied_on": "backend_receive_endpoint"
    },
    
    # =========================================================================
    # SKIP & RESUME
    # =========================================================================
    "skip_resume": {
        "skip_already_synced": True,
        "storage_type": "local_storage",
        "storage_key": "tileStationSyncHistory",
        "clear_history_button": True
    },
    
    # =========================================================================
    # API ENDPOINTS
    # =========================================================================
    "api_endpoints": {
        "receive_products": "POST /api/supplier-sync/verona/receive",
        "extension_download": "GET /api/supplier-sync/verona/extension/download"
    }
}


# =============================================================================
# 12. SINGLE PRODUCT SYNC (URL-Based Addition)
# =============================================================================
# Add ANY product from ANY supplier website using just the URL.
# Location: /app/backend/services/single_product_sync.py
# Updated: 2026-02-20

SINGLE_PRODUCT_SYNC_CONFIG = {
    # =========================================================================
    # DESCRIPTION
    # =========================================================================
    "description": "Add a single product from ANY supplier website using just the product URL",
    "version": "2.0",
    "file": "/app/backend/services/single_product_sync.py",
    
    # =========================================================================
    # FEATURES (Same as Server-Side Sync)
    # =========================================================================
    "features": {
        "auto_supplier_detection": True,  # Detects supplier from URL domain
        "auto_supplier_creation": True,   # Creates new supplier if not exists
        "works_with_any_website": True,   # Generic extraction for unknown sites
        "extracts": [
            "name",
            "sku",
            "price",         # Cost price from supplier
            "list_price",    # Calculated using pricing formula
            "stock_m2",
            "in_stock",
            "images",        # Multiple images (up to 5)
            "size",          # e.g., "60x60"
            "width",         # Tile width in mm
            "height",        # Tile height in mm
            "material",      # Porcelain, Ceramic, etc.
            "finish",        # Polished, Matt, Gloss, etc.
            "color",         # White, Grey, Beige, etc.
            "usage",         # Indoor, Outdoor, Indoor/Outdoor
            "suitability",   # Wall, Floor, Wall & Floor
            "url"
        ]
    },
    
    # =========================================================================
    # SUPPLIER DETECTION
    # =========================================================================
    "supplier_detection": {
        "known_suppliers": {
            "Splendour": ["splendourtiles.co.uk", "splendour"],
            "Ceramica Impex": ["ceramicaimpex.co.uk", "portal.ceramicaimpex"],
            "Wallcano": ["wallcanotiles.com", "wallcano"],
            "Verona": ["veronaceramics.com", "verona"]
        },
        "unknown_supplier_handling": {
            "extract_from_domain": True,
            "clean_name": True,  # Remove 'tiles', 'ceramics' from name
            "create_in_database": True,
            "track_product_count": True
        }
    },
    
    # =========================================================================
    # EXTRACTION PATTERNS
    # =========================================================================
    "extraction": {
        "name": {
            "selectors": [
                "h1.product-title",
                "h1.product_title",
                "h1.product-name",
                "h1[class*='product']",
                "h1[class*='title']",
                ".product-title h1",
                ".product-name",
                ".product-header h1",
                "h1"
            ],
            "fallback": "page_title"
        },
        "sku": {
            "patterns": [
                r"SKU[:\s]*([A-Z0-9\-_]+)",
                r"Stock\s*Code[:\s]*([A-Z0-9\-_]+)",
                r"Product\s*Code[:\s]*([A-Z0-9\-_]+)",
                r"Item\s*(?:Code|No|Number)[:\s]*([A-Z0-9\-_]+)",
                r"Code[:\s]*([A-Z0-9\-_]+)",
                r"Ref[:\s]*([A-Z0-9\-_]+)"
            ],
            "fallback": "generate_from_url"
        },
        "price": {
            "patterns": [
                r"£\s*([\d,]+\.?\d*)\s*(?:per\s*)?(?:m²|sqm|sq\.?\s*m)",
                r"£\s*([\d,]+\.?\d*)\s*/\s*(?:m²|sqm)",
                r"(?:Price|Cost)[:\s]*£\s*([\d,]+\.?\d*)",
                r"£\s*([\d,]+\.?\d*)",
                r"GBP\s*([\d,]+\.?\d*)"
            ]
        },
        "stock": {
            "in_stock_patterns": [
                r"(\d+(?:\.\d+)?)\s*(?:m²|sqm|sq\.?\s*m)\s*(?:in\s*stock|available)",
                r"Stock[:\s]*(\d+(?:\.\d+)?)\s*(?:m²|sqm)",
                r"Available[:\s]*(\d+(?:\.\d+)?)",
                r"(\d+)\s*(?:boxes?|pcs?|pieces?)\s*(?:in\s*stock|available)"
            ],
            "out_of_stock_patterns": [
                r"out\s*of\s*stock",
                r"unavailable",
                r"sold\s*out",
                r"no\s*stock",
                r"currently\s*unavailable"
            ],
            "default": {"in_stock": True, "stock_m2": 100}
        },
        "size": {
            "patterns": [
                r"(\d+)\s*[xX×]\s*(\d+)(?:\s*[xX×]\s*(\d+))?\s*(?:mm|cm)?",
                r"Size[:\s]*(\d+)\s*[xX×]\s*(\d+)",
                r"Dimensions?[:\s]*(\d+)\s*[xX×]\s*(\d+)"
            ]
        },
        "material": {
            "patterns": {
                "Porcelain": r"\bPorcelain\b",
                "Ceramic": r"\bCeramic\b",
                "Natural Stone": r"\bNatural\s*Stone\b",
                "Marble": r"\bMarble\b",
                "Granite": r"\bGranite\b",
                "Slate": r"\bSlate\b",
                "Travertine": r"\bTravertine\b",
                "Limestone": r"\bLimestone\b",
                "Glass": r"\bGlass\b",
                "Mosaic": r"\bMosaic\b",
                "Quarry": r"\bQuarry\b",
                "Terracotta": r"\bTerracotta\b"
            }
        },
        "finish": {
            "patterns": {
                "Polished": r"\bPolish(?:ed)?\b",
                "Matt": r"\bMatt(?:e)?\b",
                "Gloss": r"\bGloss(?:y)?\b",
                "Satin": r"\bSatin\b",
                "Lappato": r"\bLappato\b",
                "Honed": r"\bHoned\b",
                "Textured": r"\bTexture[d]?\b",
                "Anti-Slip": r"\bAnti[- ]?Slip\b",
                "Rustic": r"\bRustic\b",
                "Natural": r"\bNatural\b",
                "Brushed": r"\bBrushed\b"
            }
        },
        "color": {
            "patterns": {
                "White": r"\bWhite\b",
                "Black": r"\bBlack\b",
                "Grey": r"\bGr[ae]y\b",
                "Beige": r"\bBeige\b",
                "Cream": r"\bCream\b",
                "Brown": r"\bBrown\b",
                "Blue": r"\bBlue\b",
                "Green": r"\bGreen\b",
                "Red": r"\bRed\b",
                "Yellow": r"\bYellow\b",
                "Orange": r"\bOrange\b",
                "Pink": r"\bPink\b",
                "Ivory": r"\bIvory\b",
                "Graphite": r"\bGraphite\b",
                "Anthracite": r"\bAnthracite\b"
            }
        },
        "images": {
            "selectors": [
                ".product-gallery img",
                ".product-image img",
                ".product-images img",
                ".woocommerce-product-gallery img",
                "[class*='gallery'] img",
                "[class*='product'] img[src*='product']",
                "[class*='product'] img[src*='image']",
                "img[src*='product']",
                "img[data-src*='product']",
                ".main-image img",
                "#product-image img"
            ],
            "data_attributes": ["src", "data-src", "data-lazy-src"],
            "max_images": 5,
            "exclude": ["thumb", "icon", "32x32", "50x50"],
            "url_cleanup": "remove_size_suffix"  # Remove -300x300. from URLs
        }
    },
    
    # =========================================================================
    # NAMING LOGIC
    # =========================================================================
    "naming": {
        "ceramica_impex": {
            "style": "italian_themed",
            "mapping": "CERAMICA_IMPEX_SERIES_TO_NAME"
        },
        "other_suppliers": {
            "style": "title_case_cleanup"
        }
    },
    
    # =========================================================================
    # PRICING FORMULA (Same as Server-Side Sync)
    # =========================================================================
    "pricing": {
        "formula": "List Price = ceil((Cost × 1.90) × 1.20) - 0.01",
        "markup_multiplier": 1.90,
        "vat_multiplier": 1.20,
        "rounding": "ceil_minus_01"
    },
    
    # =========================================================================
    # DATABASE OPERATIONS
    # =========================================================================
    "database": {
        "check_existing": True,
        "update_if_exists": True,
        "collections": {
            "suppliers": "suppliers",
            "supplier_products": "supplier_products",
            "products": "products"
        },
        "auto_add_to_products": True
    },
    
    # =========================================================================
    # API ENDPOINT
    # =========================================================================
    "api": {
        "endpoint": "POST /api/supplier-sync/single-product",
        "request_body": {
            "url": "required - Product page URL",
            "supplier": "optional - Auto-detected if not provided"
        },
        "response": {
            "success": "boolean",
            "action": "added | updated",
            "supplier": "Detected/provided supplier name",
            "supplier_info": {
                "name": "Supplier name",
                "is_new": "boolean - True if new supplier was created",
                "domain": "Supplier domain"
            },
            "product": {
                "id": "Product UUID",
                "sku": "Product SKU",
                "original_name": "Name from supplier website",
                "display_name": "Cleaned/transformed name",
                "cost_price": "Cost from supplier",
                "list_price": "Calculated selling price",
                "stock_m2": "Stock in square meters",
                "in_stock": "boolean",
                "images_count": "Number of images extracted",
                "size": "e.g., 60x60",
                "material": "e.g., Porcelain",
                "finish": "e.g., Polished",
                "color": "e.g., Grey"
            }
        }
    }
}


# =============================================================================
# DISPLAY NAME TRANSFORMATION
# =============================================================================
# Transforms raw supplier product names into clean display names
# Used during sync to show users the final name that will be saved

def get_display_name(raw_name: str, supplier: str, finish: str = None) -> str:
    """
    Transform a raw supplier product name into a clean display name.
    Format: {unique_name} {colour} {size} {finish} {characteristics}
    
    Args:
        raw_name: The original product name from the supplier
        supplier: The supplier name (Splendour, Ceramica Impex, Wallcano, Verona, etc.)
        finish: The finish from product data (e.g., "Matt") - used if not in raw_name
    
    Returns:
        The transformed display name
    """
    import re
    
    # List of tiling product suppliers that should use naming transformation
    # Excluded: Tile Rite, Ultra Tile, Trimline, Regulus (keep original names)
    TILING_SUPPLIERS = [
        "Splendour", "Ceramica Impex", "Wallcano", "Verona", 
        "Le Porce", "H Martin", "Tilebase", "Bloomstone", 
        "Boyden", "Eagle"
    ]
    
    if not raw_name:
        return raw_name
    
    # For non-tiling suppliers, just clean up the name
    if supplier not in TILING_SUPPLIERS:
        name = ' '.join(raw_name.split())
        return sanitise_display_name(name.title())
    
    # Define keywords - NOTE: "glass" means "gloss" in some supplier products!
    FINISH_KEYWORDS = [
        'matt', 'matte', 'polished', 'polish', 'gloss', 'glossy', 'glass', 'satin', 
        'lappato', 'natural', 'textured', 'anti-slip', 'antislip', 'honed',
        'structured', 'rectified', 'grip', 'silk', 'mix'
    ]
    
    # Map variant finish words to standard finish names
    FINISH_NORMALIZE = {
        'glass': 'Gloss',
        'glossy': 'Gloss',
        'matte': 'Matt',
        'polish': 'Polished',
    }
    
    COLOUR_KEYWORDS = [
        'white', 'black', 'grey', 'gray', 'beige', 'cream', 'ivory', 'crema',
        'brown', 'taupe', 'sand', 'bone', 'gold', 'silver', 'bronze',
        'blue', 'green', 'red', 'pink', 'yellow', 'orange', 'purple',
        'anthracite', 'anthrecite', 'charcoal', 'nero', 'bianco', 'grigio',
        'noce', 'dark', 'light', 'medium', 'mint', 'natural', 'pearl',
        'rose', 'coral', 'amber', 'copper', 'graphite', 'slate', 'ash',
        'smoke', 'storm', 'fog', 'mist', 'ocean', 'sky', 'navy',
        'burgundy', 'wine', 'ruby', 'rust', 'terracotta', 'sienna',
        'caramel', 'mocha', 'coffee', 'espresso', 'chocolate', 'walnut',
        'almond', 'vanilla', 'latte', 'cappuccino', 'oat', 'wheat', 'honey',
        'stone', 'cement', 'concrete', 'marble', 'granite', 'limestone',
        'travertine', 'onyx', 'jade', 'emerald', 'sapphire', 'topaz'
    ]
    
    # Clean up the name
    name = ' '.join(raw_name.split())
    parts = name.split()
    
    # Extract components
    unique_name = None
    colours = []
    finishes = []
    size = None
    other_parts = []
    
    for part in parts:
        part_clean = part.strip('[](){}')
        part_lower = part_clean.lower()
        part_title = part_clean.title()
        
        # Extract size (e.g., 30x60, 80x120, 600x600)
        if re.match(r'^\d+[xX]\d+$', part_clean):
            size = part_clean.lower().replace('X', 'x')
            continue
        
        # Check for series mapping - BUT skip if it's a common color word
        # (Some color words like "Black" are in ALTERNATIVE_SERIES_NAMES but should be treated as colors)
        if not unique_name and part_title in SPLENDOUR_SERIES_TO_UNIQUE_NAME:
            # Don't treat common colors as series names
            if part_lower not in COLOUR_KEYWORDS:
                unique_name = SPLENDOUR_SERIES_TO_UNIQUE_NAME[part_title]
                continue
        
        # Check for alternative series mapping - same color check
        if not unique_name and part_title in ALTERNATIVE_SERIES_NAMES:
            # Don't treat common colors as series names
            if part_lower not in COLOUR_KEYWORDS:
                unique_name = ALTERNATIVE_SERIES_NAMES[part_title][0]
                continue
        
        # Extract finish - normalize variants like "glass" -> "Gloss"
        if part_lower in FINISH_KEYWORDS:
            normalized_finish = FINISH_NORMALIZE.get(part_lower, part_title)
            finishes.append(normalized_finish)
            continue
        
        # Extract colour
        if part_lower in COLOUR_KEYWORDS:
            colours.append(part_title)
            continue
        
        # Skip common junk
        if part_lower in ['tile', 'tiles', 'porcelain', 'ceramic', 'cm', 'mm', 'new', 'ghr']:
            continue
        
        # Skip SKU codes in brackets
        if part.startswith('[') or part.startswith('('):
            continue
        
        # Keep other meaningful parts (2+ chars, not just numbers)
        if len(part_clean) > 2 and not part_clean.isdigit():
            other_parts.append(part_title)
    
    # If no finish extracted from name but finish parameter provided, use it
    if not finishes and finish:
        finish_clean = finish.strip().title()
        if finish_clean and finish_clean.lower() in FINISH_KEYWORDS:
            finishes.append(finish_clean)
    
    # Build name in correct order: {unique_name} {colour} {size} {finish}
    name_parts = []
    
    # 1. Unique name
    if unique_name:
        name_parts.append(unique_name)
    elif other_parts:
        name_parts.append(other_parts.pop(0))
    
    # 2. Colours
    name_parts.extend(colours)
    
    # 3. Size
    if size:
        name_parts.append(size)
    
    # 4. Finishes
    name_parts.extend(finishes)
    
    # Build final name
    return sanitise_display_name(' '.join(name_parts) if name_parts else raw_name.title())


def strip_duplicate_size_tokens(name: str) -> str:
    """Remove a trailing mm-size token when a matching cm-form is already present
    earlier in the name.

    Protects against supplier feeds / admin edits that accidentally write both
    representations of the same dimension into the display string, e.g.:
        "Costa Stone Bianco 30x60cm Matt 600x300x7mm" -> "Costa Stone Bianco 30x60cm Matt"

    Safe for names with only the mm form (e.g. "Herringbone 90x300x14/3mm") —
    those are left untouched because no matching cm form appears earlier.
    """
    import re as _re
    if not name or not isinstance(name, str):
        return name
    # Trailing "WxHxDmm" or "WxHxD/Dmm" token, with or without an mm suffix
    trailing = _re.compile(
        r"\s+(\d+)x(\d+)(?:x[\d./]+(?:mm)?)(?:\s*mm)?\s*$",
        _re.IGNORECASE,
    )
    m = trailing.search(name)
    if not m:
        return name
    try:
        na, nb = int(m.group(1)), int(m.group(2))
    except (TypeError, ValueError):
        return name
    # Only treat numbers that could plausibly be mm dimensions (>= 100 mm each side)
    if na < 100 or nb < 100:
        return name
    ca, cb = na / 10, nb / 10
    # Format without trailing zeros: 60.0 -> "60"
    def _f(v):
        return f"{v:g}"
    before = name[: m.start()].lower()
    cm_forms = [
        f"{_f(ca)}x{_f(cb)}cm", f"{_f(cb)}x{_f(ca)}cm",
        f"{_f(ca)}x{_f(cb)}",   f"{_f(cb)}x{_f(ca)}",
    ]
    if any(f in before for f in cm_forms):
        return name[: m.start()].rstrip()
    return name


# Finish / property words that should be title-cased when they appear as
# whole words in a product name. Conservative list — brand / colour names are
# NOT forced so user-entered casing like "Bianco" / "Bone" is preserved.
_NORMALISED_WORDS = {
    "matt", "matte", "polished", "gloss", "glossy", "satin", "lappato",
    "natural", "honed", "rustic", "textured", "brushed", "structured",
    "embossed", "decor", "bocciardato", "tumbled", "flamed", "sandblasted",
    "grip", "outdoor", "smooth", "oiled", "lacquered", "limed",
}


def sanitise_display_name(name: str) -> str:
    """Master display-name cleaner. Applies a safe pipeline of rules:

    1. Drop duplicate cm/mm size tokens (see `strip_duplicate_size_tokens`).
    2. Collapse consecutive whitespace into single spaces and trim edges.
    3. Normalise size unit casing ("MM"/"Mm" -> "mm", "CM"/"Cm" -> "cm")
       and the ``x`` separator in dimensions ("30X60" -> "30x60").
    4. Strip stray trailing / leading punctuation (commas, dashes, semicolons,
       slashes, brackets) and double-punctuation patterns ("- -" -> "-").
    5. Collapse immediate duplicate words ("Matt Matt" -> "Matt", case-insensitive).
    6. Title-case known finish/property words when mixed-case found in-string,
       preserving surrounding branding. E.g. "Costa Stone Bianco 30x60cm matt"
       -> "Costa Stone Bianco 30x60cm Matt".

    Conservative: only touches patterns proven to be safe across all supplier feeds.
    Returns the input unchanged when it's None / empty / not a string.
    """
    import re as _re
    if not name or not isinstance(name, str):
        return name

    out = name

    # 1. Duplicate cm/mm size
    out = strip_duplicate_size_tokens(out)

    # 2. Collapse whitespace & trim
    out = _re.sub(r"\s+", " ", out).strip()

    # 3. Normalise size-unit casing and the 'x' separator in dimensions.
    # Match a W x H optional x D (with optional unit) token even if 'X' is uppercase.
    def _normalise_dim(match):
        token = match.group(0)
        # Lowercase 'x'/'X' between digits; lowercase mm/cm suffix.
        token = _re.sub(r"(\d)\s*[xX×]\s*(\d)", r"\1x\2", token)
        token = _re.sub(r"(?i)(\d)\s*(mm|cm)\b", lambda m: f"{m.group(1)}{m.group(2).lower()}", token)
        return token

    out = _re.sub(
        r"\b\d+\s*[xX×]\s*\d+(?:\s*[xX×]\s*[\d./]+)?\s*(?:mm|cm|MM|CM|Mm|Cm)?\b",
        _normalise_dim,
        out,
    )

    # 4. Strip stray punctuation runs.
    out = _re.sub(r"\s*[-–—]\s*[-–—]\s*", " - ", out)   # collapse "-- " / "– –"
    out = _re.sub(r"\s+,", ",", out)                      # " ," -> ","
    out = _re.sub(r"[,;]{2,}", ",", out)                  # ",," / ";;" -> ","
    out = _re.sub(r"^[\s,;\-–—/]+", "", out)              # leading punctuation
    out = _re.sub(r"[\s,;\-–—/]+$", "", out)              # trailing punctuation

    # 5. Collapse immediate duplicate words (case-insensitive).
    # "Matt matt" -> "Matt"; "Oak Oak" -> "Oak". Stops after two-word window.
    out = _re.sub(r"\b(\w+)(\s+\1)+\b", r"\1", out, flags=_re.IGNORECASE)

    # 6. Title-case known finish / property words (only where mixed casing found).
    def _titlecase_finishes(match):
        word = match.group(0)
        return word[:1].upper() + word[1:].lower()

    if _NORMALISED_WORDS:
        pattern = r"\b(" + "|".join(_re.escape(w) for w in _NORMALISED_WORDS) + r")\b"
        out = _re.sub(pattern, _titlecase_finishes, out, flags=_re.IGNORECASE)

    # Final whitespace tidy in case cleanup introduced doubles
    out = _re.sub(r"\s+", " ", out).strip()
    return out



# =============================================================================
# UNIQUE PRODUCT NAME GENERATION
# =============================================================================
# Generates unique product names when adding new products to the database
# Ensures no duplicate names exist across all suppliers

def generate_unique_product_name(raw_name: str, supplier: str, sku: str, db=None, finish: str = None) -> str:
    """
    Generate a unique product name following the format:
    {unique_name} {colour} {size} {finish} {characteristics}
    
    Example: ROYAL PULPIS BONE RECTIFIED POLISHED 80X80 
         --> Armani Pulpis Bone 80x80 Polished
    
    Uses SPLENDOUR_SERIES_TO_UNIQUE_NAME mapping for ALL tiling suppliers.
    When duplicates are detected, uses ALTERNATIVE_SERIES_NAMES.
    
    Args:
        raw_name: Original product name from supplier
        supplier: Supplier name
        sku: Product SKU
        db: Database connection for duplicate checking
        finish: Finish value from product data (e.g., "Matt", "Polished") - used if not in raw_name
    """
    import re
    
    # List of tiling product suppliers that should use naming transformation
    # Excluded: Tile Rite, Ultra Tile, Trimline, Regulus (keep original names)
    TILING_SUPPLIERS = [
        "Splendour", "Ceramica Impex", "Wallcano", "Verona", 
        "Le Porce", "H Martin", "Tilebase", "Bloomstone", 
        "Boyden", "Eagle"
    ]
    
    # Define finish keywords - NOTE: "glass" means "gloss" in Wallcano products!
    FINISH_KEYWORDS = [
        'polished', 'matt', 'matte', 'lappato', 'gloss', 'glossy', 'glass',
        'satin', 'honed', 'natural', 'rustic', 'textured', 'anti-slip',
        'antislip', 'rectified', 'non-rectified', 'grip', 'r10', 'r11', 'r9'
    ]
    
    # Map variant finish words to standard finish names
    FINISH_NORMALIZE = {
        'glass': 'Gloss',      # Wallcano uses "Glass" to mean "Gloss"
        'glossy': 'Gloss',
        'matte': 'Matt',
        'high-gloss': 'Gloss',
    }
    
    # Define colour keywords - comprehensive list
    COLOUR_KEYWORDS = [
        'white', 'black', 'grey', 'gray', 'beige', 'cream', 'ivory',
        'brown', 'taupe', 'sand', 'bone', 'gold', 'silver', 'bronze',
        'blue', 'green', 'red', 'pink', 'yellow', 'orange', 'purple',
        'anthracite', 'anthrecite', 'charcoal', 'nero', 'bianco', 'grigio', 'crema',
        'noce', 'dark', 'light', 'medium', 'mint', 'natural',
        'rose', 'coral', 'amber', 'copper', 'graphite', 'slate', 'ash',
        'pearl', 'smoke', 'storm', 'fog', 'mist', 'ocean', 'sky', 'navy',
        'forest', 'olive', 'sage', 'moss', 'jade', 'teal', 'aqua', 'cyan',
        'burgundy', 'wine', 'ruby', 'rust', 'terracotta', 'sienna', 'umber',
        'caramel', 'mocha', 'coffee', 'espresso', 'chocolate', 'walnut', 'mahogany',
        'almond', 'vanilla', 'latte', 'cappuccino', 'oat', 'wheat', 'honey',
        'stone', 'cement', 'concrete', 'marble', 'granite', 'limestone',
        'travertine', 'onyx', 'emerald', 'sapphire', 'topaz'
    ]
    
    # Define characteristic keywords (stone/pattern types)
    CHARACTERISTIC_KEYWORDS = [
        'pulpis', 'statuario', 'marquina', 'carrara', 'calacatta', 'onyx',
        'emperador', 'travertine', 'travertino', 'marble', 'granite', 
        'slate', 'limestone', 'sandstone', 'quartzite', 'terrazzo',
        'concrete', 'cement', 'wood', 'oak', 'walnut', 'teak', 'stone',
        'veined', 'vein', 'effect', 'look', 'style'
    ]
    
    if not raw_name:
        return f"{supplier} {sku}" if sku else f"{supplier} Product"
    
    # Step 1: Clean up the name
    original_name = ' '.join(raw_name.split()).upper()
    original_name_title = original_name.title()
    
    # Step 2: Check for multi-word series names first (e.g., "Salt And Pepper")
    multi_word_match = None
    for series_name in SPLENDOUR_SERIES_TO_UNIQUE_NAME.keys():
        if ' ' in series_name:  # Multi-word series
            if series_name.upper() in original_name or series_name in original_name_title:
                multi_word_match = series_name
                break
    
    # Step 3: Extract components from original name
    parts = original_name.split()
    
    unique_name = None
    characteristics = []
    colours = []
    size = None
    finishes = []
    other_parts = []
    skip_parts = set()  # Parts to skip because they're part of multi-word match
    
    # If multi-word match found, mark those parts to skip
    if multi_word_match:
        unique_name = SPLENDOUR_SERIES_TO_UNIQUE_NAME[multi_word_match]
        for word in multi_word_match.upper().split():
            skip_parts.add(word)
    
    # Size pattern (e.g., 60X60, 80x80, 120X60)
    size_pattern = re.compile(r'(\d+)[Xx](\d+)')
    
    for part in parts:
        # Skip parts that are part of multi-word match
        if part in skip_parts:
            continue
            
        part_lower = part.lower()
        part_title = part.title()
        
        # Check if it's a size
        if size_pattern.match(part):
            size = part.lower().replace('x', 'x')
            continue
        
        # Check if it's a finish - normalize variants like "glass" -> "Gloss"
        if part_lower in FINISH_KEYWORDS:
            normalized_finish = FINISH_NORMALIZE.get(part_lower, part_title)
            finishes.append(normalized_finish)
            continue
        
        # Check if it's a colour
        if part_lower in COLOUR_KEYWORDS:
            colours.append(part_title)
            continue
        
        # Check if it's a series that should be transformed
        # BUT skip if it's a common color word (already handled above)
        if supplier in TILING_SUPPLIERS and unique_name is None:
            if part_title in SPLENDOUR_SERIES_TO_UNIQUE_NAME:
                # Double-check it's not a color
                if part_lower not in COLOUR_KEYWORDS:
                    unique_name = SPLENDOUR_SERIES_TO_UNIQUE_NAME[part_title]
                    continue
            if part_title in ALTERNATIVE_SERIES_NAMES:
                # Double-check it's not a color
                if part_lower not in COLOUR_KEYWORDS:
                    unique_name = ALTERNATIVE_SERIES_NAMES[part_title][0]
                    continue
        
        # Check if it's a characteristic
        if part_lower in CHARACTERISTIC_KEYWORDS:
            characteristics.append(part_title)
            continue
        
        # Otherwise, it might be a characteristic or other descriptor
        # Skip numbers, single letters, and common junk
        if len(part) > 2 and not part.isdigit() and part_lower not in ['new', 'cm', 'mm', 'tile', 'tiles']:
            other_parts.append(part_title)
    
    # Step 3: Build the product name
    # Format: {unique_name} {colour} {size} {finish} {characteristics}
    # Example: "Florence Grey 30x60 Matt" or "Ravenna Anthracite 30x60 Matt"
    
    # If no finish was extracted from name but finish parameter was provided, use it
    if not finishes and finish:
        finish_clean = finish.strip().title()
        if finish_clean and finish_clean.lower() in [f.lower() for f in FINISH_KEYWORDS]:
            finishes.append(finish_clean)
    
    name_parts = []
    
    # 1. Add unique name (or first other part if no series matched)
    if unique_name:
        name_parts.append(unique_name)
    elif other_parts:
        name_parts.append(other_parts.pop(0))
    
    # 2. Add colours (e.g., Grey, Crema, Anthracite)
    name_parts.extend(colours)
    
    # 3. Add size (e.g., 30x60, 80x120)
    if size:
        name_parts.append(size)
    
    # 4. Add finishes (e.g., Matt, Polished, Gloss)
    name_parts.extend(finishes)
    
    # 5. Add characteristics (stone type, pattern, etc.) - LAST
    name_parts.extend(characteristics)
    
    # Note: other_parts (like "Ghr") are intentionally excluded as they're often junk text
    
    # Build final name
    name = ' '.join(name_parts)
    
    # Clean up - remove redundant words and fix formatting
    redundant_patterns = [
        r'\bTile\b', r'\bTiles\b', r'\bPorcelain\b', 
        r'\bCeramic\b', r'\bCm\b', r'\bMm\b', r'\bNew\b',
        r'\bRectified\b',  # Remove rectified from name (it's a characteristic, not needed)
    ]
    for pattern in redundant_patterns:
        name = re.sub(pattern, '', name, flags=re.IGNORECASE)
    
    # Clean up multiple spaces
    name = ' '.join(name.split()).strip()
    
    # If no proper name could be built, use title case of original
    if not name or len(name) < 5:
        name = raw_name.title()
        name = re.sub(r'(\d+)X(\d+)', lambda m: f"{m.group(1)}x{m.group(2)}", name, flags=re.IGNORECASE)
        name = ' '.join(name.split())
    
    # Step 4: Check for duplicates and use alternative names if needed
    if db is not None and supplier in TILING_SUPPLIERS:
        # Find the series that was matched to get alternatives
        matched_series_key = None
        for part in original_name.split():
            part_title = part.title()
            if part_title in ALTERNATIVE_SERIES_NAMES:
                matched_series_key = part_title
                break
        
        alternatives = ALTERNATIVE_SERIES_NAMES.get(matched_series_key, []) if matched_series_key else []
        alt_index = 0
        base_name = name
        
        supplier_codes = {
            "Splendour": "SPL", "Ceramica Impex": "CI", "Wallcano": "WC",
            "Verona": "VRN", "Le Porce": "LP", "H Martin": "HM",
            "Tilebase": "TB", "Bloomstone": "BS", "Boyden": "BY", "Eagle": "EG"
        }
        
        while True:
            # Check if name exists
            existing = db.supplier_products.find_one({"product_name": name})
            if not existing:
                existing = db.products.find_one({"product_name": name})
            
            if existing:
                # Check if same product
                if existing.get("sku") == sku and existing.get("supplier") == supplier:
                    break
                
                # Try alternative name
                if alt_index < len(alternatives):
                    # Rebuild name with alternative unique name - SAME FORMAT
                    # {unique_name} {colour} {size} {finish} {characteristics}
                    alt_name_parts = [alternatives[alt_index]]
                    alt_name_parts.extend(colours)
                    if size:
                        alt_name_parts.append(size)
                    alt_name_parts.extend(finishes)
                    alt_name_parts.extend(characteristics)
                    name = ' '.join(alt_name_parts)
                    alt_index += 1
                else:
                    # No more alternatives - add supplier code
                    code = supplier_codes.get(supplier, supplier[:2].upper())
                    suffix_num = alt_index - len(alternatives) + 1
                    if suffix_num == 1:
                        name = f"{base_name} ({code})"
                    else:
                        name = f"{base_name} ({code}-{suffix_num})"
                    alt_index += 1
                
                if alt_index > 50:
                    name = f"{base_name} {sku}"
                    break
            else:
                break
    
    return name


def apply_unique_naming_to_product(product_data: dict, db=None) -> dict:
    """
    Apply unique naming to a product dictionary before saving to database.
    
    This should be called when adding new products from sync staging.
    
    Args:
        product_data: Dictionary containing product information
        db: Database connection for duplicate checking
    
    Returns:
        Updated product_data with unique product_name
    """
    raw_name = product_data.get("name") or product_data.get("product_name", "")
    supplier = product_data.get("supplier", "Unknown")
    sku = product_data.get("sku", "")
    finish = product_data.get("finish", "")  # Get finish from product data
    
    # Generate unique name - pass finish for proper formatting
    unique_name = generate_unique_product_name(raw_name, supplier, sku, db, finish)
    
    # Update the product data
    product_data["product_name"] = unique_name
    product_data["original_name"] = raw_name  # Keep original for reference
    
    return product_data


def construct_complete_name(name: str, size: str = None, finish: str = None) -> str:
    """
    Construct a complete product name by combining name, size, and finish.
    This ensures the 'name' field stored in the database has all required information.
    
    Format: {name} {size} {finish}
    
    Args:
        name: The base product name (e.g., "Lenk Honey Oak Wood Effect Tiles")
        size: The size field (e.g., "195x1215x10mm" or "600x600")
        finish: The finish field (e.g., "Matt", "Polished")
    
    Returns:
        Complete name with size and finish appended if not already present
        e.g., "Lenk Honey Oak Wood Effect Tiles 195x1215 Matt"
    """
    import re
    
    if not name:
        return name
    
    # Clean the name
    complete_name = ' '.join(name.split())
    name_lower = complete_name.lower()
    
    # Check if size already in name (e.g., "30x60", "600x600", "1200 x 1200")
    # Match patterns like: 30x60, 600x600, 1200 x 1200, 80X80
    has_size_in_name = bool(re.search(r'\d+\s*[xX×]\s*\d+', complete_name))
    
    # Add size if provided and not already in name
    if size and not has_size_in_name:
        # Clean size: remove thickness (e.g., "195x1215x10mm" -> "195x1215")
        size_clean = re.sub(r'[xX×]\d+mm$', '', size)  # Remove thickness like x10mm
        size_clean = re.sub(r'mm$', '', size_clean)    # Remove trailing mm
        size_clean = size_clean.strip()
        
        # Normalize the size for comparison (remove spaces around x)
        size_normalized = re.sub(r'\s*[xX×]\s*', 'x', size_clean).lower()
        name_normalized = re.sub(r'\s*[xX×]\s*', 'x', complete_name).lower()
        
        # Only add if size not already present (after normalization)
        if size_normalized and size_normalized not in name_normalized:
            complete_name = f"{complete_name} {size_clean}"
    
    # Check if finish already in name
    finish_keywords = ['matt', 'matte', 'polished', 'gloss', 'glossy', 'satin', 'lappato', 'natural', 'honed']
    has_finish_in_name = any(f in name_lower for f in finish_keywords)
    
    # Add finish if provided and not already in name
    if finish and not has_finish_in_name:
        finish_clean = finish.strip().title()
        if finish_clean.lower() in finish_keywords:
            complete_name = f"{complete_name} {finish_clean}"
    
    # Final sanitiser — drops duplicate cm/mm size tokens, collapses whitespace,
    # normalises units, fixes title-casing of finish words, etc.
    return sanitise_display_name(complete_name)



# =============================================================================
# DISPLAY CODE GENERATION
# =============================================================================
# Generates a unique display code from the display name
# Format: TS + First letter of series + First letter of color + Size digits + First letter of finish
# Example: "Dolomite Blue 60x60cm Polished" → TSDB66P

# Finish letter mapping
FINISH_CODE_MAP = {
    'polished': 'P',
    'polish': 'P',
    'matt': 'M',
    'matte': 'M',
    'gloss': 'G',
    'glossy': 'G',
    'satin': 'S',
    'lappato': 'L',
    'natural': 'N',
    'textured': 'T',
    'anti-slip': 'A',
    'antislip': 'A',
    'honed': 'H',
    'rustic': 'R',
    'structured': 'U',
    'grip': 'G',
    'silk': 'K',
    'riven': 'V',
    'tumbled': 'B',
}

# Color keywords for identification
DISPLAY_CODE_COLORS = [
    'white', 'black', 'grey', 'gray', 'beige', 'cream', 'ivory', 'crema',
    'brown', 'taupe', 'sand', 'bone', 'gold', 'silver', 'bronze',
    'blue', 'green', 'red', 'pink', 'yellow', 'orange', 'purple',
    'anthracite', 'charcoal', 'nero', 'bianco', 'grigio',
    'noce', 'dark', 'light', 'natural', 'pearl',
    'rose', 'coral', 'amber', 'copper', 'graphite', 'slate', 'ash',
    'smoke', 'storm', 'fog', 'mist', 'ocean', 'sky', 'navy',
    'burgundy', 'wine', 'ruby', 'rust', 'terracotta', 'sienna',
    'caramel', 'mocha', 'coffee', 'espresso', 'chocolate', 'walnut',
    'almond', 'vanilla', 'latte', 'cappuccino', 'honey',
    'stone', 'cement', 'concrete', 'marble', 'granite', 'limestone',
    'travertine', 'onyx', 'jade', 'emerald', 'sapphire', 'topaz'
]


def generate_display_code(display_name: str) -> str:
    """
    Generate a display code from the display name.
    
    Format: TS + Series Initial + Color Initial + Size Digits + Finish Initial
    
    Example: 
        "Dolomite Blue 60x60cm Polished" → "TSDB66P"
        "Alpine White 30x60 Matt" → "TSAW36M"
        "Carrara Grey 80x80cm Gloss" → "TSCG88G"
    
    Args:
        display_name: The display name to generate code from
        
    Returns:
        The generated display code (e.g., "TSDB66P")
    """
    import re
    
    if not display_name:
        return "TS0000"
    
    # Clean up the name
    name = ' '.join(display_name.split())
    parts = name.split()
    
    # Initialize components
    series_initial = ''
    color_initial = ''
    size_digits = ''
    finish_initial = ''
    
    for part in parts:
        part_clean = part.strip('[](){}').lower()
        part_original = part.strip('[](){}')
        
        # Extract size (e.g., 30x60, 60x60cm, 80x120)
        size_match = re.match(r'^(\d+)[xX](\d+)', part_clean)
        if size_match:
            # Take first digit of each dimension: 60x60 → 66, 30x60 → 36, 80x120 → 81
            dim1 = size_match.group(1)
            dim2 = size_match.group(2)
            size_digits = dim1[0] + dim2[0]
            continue
        
        # Check for finish
        if part_clean in FINISH_CODE_MAP:
            finish_initial = FINISH_CODE_MAP[part_clean]
            continue
        
        # Check for color
        if part_clean in DISPLAY_CODE_COLORS:
            if not color_initial:
                color_initial = part_original[0].upper()
            continue
        
        # First meaningful word is the series name
        if not series_initial and len(part_clean) > 1 and not part_clean.isdigit():
            # Skip common words
            if part_clean not in ['tile', 'tiles', 'porcelain', 'ceramic', 'cm', 'mm', 'wall', 'floor']:
                series_initial = part_original[0].upper()
    
    # Build the code: TS + Series + Color + Size + Finish
    code = "TS"
    code += series_initial or "X"
    code += color_initial or "X"
    code += size_digits or "00"
    code += finish_initial or "X"
    
    return code


def parse_display_name_components(display_name: str) -> dict:
    """
    Parse a display name into its components for preview purposes.
    
    Args:
        display_name: The display name to parse
        
    Returns:
        Dictionary with series, color, size, finish components
    """
    import re
    
    if not display_name:
        return {"series": "", "color": "", "size": "", "finish": ""}
    
    name = ' '.join(display_name.split())
    parts = name.split()
    
    components = {
        "series": "",
        "color": "",
        "size": "",
        "finish": ""
    }
    
    for part in parts:
        part_clean = part.strip('[](){}').lower()
        part_original = part.strip('[](){}')
        
        # Extract size
        size_match = re.match(r'^(\d+)[xX](\d+)', part_clean)
        if size_match:
            components["size"] = part_original
            continue
        
        # Check for finish
        if part_clean in FINISH_CODE_MAP:
            components["finish"] = part_original
            continue
        
        # Check for color
        if part_clean in DISPLAY_CODE_COLORS:
            if not components["color"]:
                components["color"] = part_original
            continue
        
        # First meaningful word is the series
        if not components["series"] and len(part_clean) > 1 and not part_clean.isdigit():
            if part_clean not in ['tile', 'tiles', 'porcelain', 'ceramic', 'cm', 'mm', 'wall', 'floor']:
                components["series"] = part_original
    
    return components



# =============================================================================
# QUANTITY-BASED TIER PRICING SYSTEM
# =============================================================================
# Customers get discounts based on the quantity (m²) they purchase
# Configurable globally and per-product/series

# Global tier thresholds (m²) - can be overridden per product/series
QUANTITY_TIER_THRESHOLDS = [10, 50, 100]  # 0-10, 10-50, 50-100, 100+

# Global tier discounts (%) - can be overridden per product/series
QUANTITY_TIER_DISCOUNTS = [0, 5, 10, 15]  # Tier 1: 0%, Tier 2: 5%, Tier 3: 10%, Tier 4: 15%

# Custom quote threshold - show "Big Project? Request a Quote" above this quantity
CUSTOM_QUOTE_THRESHOLD = 120  # m²

# Trade account default discount (additional % off tier prices)
TRADE_DISCOUNT_DEFAULT = 5  # %

# Credit back rate for trade accounts (% of order value)
TRADE_CREDIT_BACK_DEFAULT = 2  # %

# ============ UNIT-BASED PRICING (for adhesives, grout, tools, etc.) ============
# Tier thresholds for individual unit products
UNIT_TIER_THRESHOLDS = [10, 25, 50]  # 0-10 units, 10-25, 25-50, 50+
UNIT_TIER_DISCOUNTS = [0, 3, 7, 10]  # Tier 1: 0%, Tier 2: 3%, Tier 3: 7%, Tier 4: 10%
UNIT_QUOTE_THRESHOLD = 200  # units - show quote request for large orders


def get_unit_tier_pricing(unit_price: float, quantity: int,
                          custom_thresholds: list = None,
                          custom_discounts: list = None,
                          is_trade: bool = False,
                          trade_discount: float = None,
                          trade_discount_type: str = "percent") -> dict:
    """
    Calculate tier pricing for unit-based products (adhesives, grout, tools).
    Similar to m² pricing but with different thresholds and "per unit" labels.
    
    Args:
        unit_price: Price per unit (e.g., per bag, per box)
        quantity: Number of units
        custom_thresholds: Optional custom tier thresholds
        custom_discounts: Optional custom tier discounts
        is_trade: Whether customer is a trade account
        trade_discount: Custom trade discount value (percentage OR flat £/unit,
                        interpretation depends on trade_discount_type)
        trade_discount_type: "percent" (default) applies trade_discount as a %,
                             "fixed" applies it as a flat £/unit deducted from
                             the tier-discounted price.
    """
    thresholds = custom_thresholds or UNIT_TIER_THRESHOLDS
    discounts = custom_discounts or UNIT_TIER_DISCOUNTS
    td_type = "fixed" if str(trade_discount_type).lower() == "fixed" else "percent"
    
    # Ensure we have one more discount than thresholds
    if len(discounts) < len(thresholds) + 1:
        discounts = discounts + [discounts[-1]] * (len(thresholds) + 1 - len(discounts))
    
    # Determine current tier
    current_tier = 1
    for i, threshold in enumerate(thresholds):
        if quantity >= threshold:
            current_tier = i + 2
    
    # Get discount for current tier
    tier_idx = min(current_tier - 1, len(discounts) - 1)
    current_discount = discounts[tier_idx]
    
    # Calculate price per unit with tier discount
    price_per_unit = unit_price * (1 - current_discount / 100)
    
    # Apply trade discount if applicable
    trade_disc_value = trade_discount if trade_discount is not None else TRADE_DISCOUNT_DEFAULT
    trade_price_per_unit = None
    trade_total_price = None
    
    def _apply_trade(tier_price: float) -> float:
        if td_type == "fixed":
            return max(0.0, tier_price - trade_disc_value)
        return tier_price * (1 - trade_disc_value / 100)
    
    if is_trade:
        trade_price_per_unit = _apply_trade(price_per_unit)
        trade_total_price = round(trade_price_per_unit * quantity, 2)
    
    # Build tier breakdown
    tiers = []
    trade_tiers = []
    prev_threshold = 0
    
    for i, discount in enumerate(discounts):
        if i < len(thresholds):
            threshold = thresholds[i]
            label = f"{prev_threshold} - {threshold} units"
        else:
            label = f"{thresholds[-1] if thresholds else 0}+ units"
        
        tier_price = unit_price * (1 - discount / 100)
        
        tier_info = {
            "tier": i + 1,
            "label": label,
            "min_quantity": prev_threshold,
            "max_quantity": thresholds[i] if i < len(thresholds) else None,
            "discount_percent": discount,
            "price_per_unit": round(tier_price, 2),
            "savings_label": f"Save {discount}%" if discount > 0 else "List Price"
        }
        tiers.append(tier_info)
        
        # Build trade tier
        if is_trade:
            trade_tier_price = _apply_trade(tier_price)
            if td_type == "fixed":
                savings_label = f"Save {discount}% + £{trade_disc_value:.2f}" if discount > 0 else f"Save £{trade_disc_value:.2f}"
                total_discount = None
            else:
                total_discount = discount + trade_disc_value - (discount * trade_disc_value / 100)
                savings_label = f"Save {round(total_discount, 1)}%"
            trade_tiers.append({
                **tier_info,
                "price_per_unit": round(trade_tier_price, 2),
                "trade_discount": trade_disc_value,
                "trade_discount_type": td_type,
                "trade_discount_percent": trade_disc_value if td_type == "percent" else None,
                "total_discount_percent": round(total_discount, 1) if total_discount is not None else None,
                "savings_label": savings_label
            })
        
        if i < len(thresholds):
            prev_threshold = thresholds[i]
    
    # Check if should show quote option
    show_custom_quote = quantity >= UNIT_QUOTE_THRESHOLD
    
    result = {
        "pricing_unit": "unit",
        "base_price": unit_price,
        "quantity": quantity,
        "thresholds": thresholds,
        "discounts": discounts,
        "tiers": tiers,
        "current_tier": current_tier,
        "current_discount_percent": current_discount,
        "current_price_per_unit": round(price_per_unit, 2),
        "total_price": round(price_per_unit * quantity, 2),
        "show_custom_quote": show_custom_quote,
        "custom_quote_threshold": UNIT_QUOTE_THRESHOLD,
        "is_trade": is_trade
    }
    
    if is_trade:
        result["trade_discount"] = trade_disc_value
        result["trade_discount_type"] = td_type
        result["trade_discount_percent"] = trade_disc_value if td_type == "percent" else None
        result["trade_tiers"] = trade_tiers
        result["trade_current_price_per_unit"] = round(trade_price_per_unit, 2)
        result["trade_total_price"] = trade_total_price
    
    return result


def get_quantity_tier_pricing(base_price: float, quantity: float, 
                               custom_thresholds: list = None, 
                               custom_discounts: list = None,
                               is_trade: bool = False,
                               trade_discount: float = None,
                               trade_discount_type: str = "percent",
                               was_price: float = None,
                               sale_active: bool = False) -> dict:
    """
    Calculate tier pricing based on quantity.
    
    Args:
        base_price: The base/list price per m² (current selling price, may include sale discount)
        quantity: The quantity in m²
        custom_thresholds: Optional custom tier thresholds for this product/series
        custom_discounts: Optional custom tier discounts for this product/series
        is_trade: Whether the customer is a trade account
        trade_discount: Custom trade discount value (uses default if None).
                        Interpreted as % when trade_discount_type == "percent" (default),
                        or as a flat £/m² when trade_discount_type == "fixed".
        trade_discount_type: "percent" | "fixed" — controls how trade_discount is applied.
        was_price: Original price before sale (for accurate total savings calculation)
        sale_active: Whether the product is currently on sale
    
    Returns:
        Dictionary with tier pricing info
    """
    thresholds = custom_thresholds or QUANTITY_TIER_THRESHOLDS
    discounts = custom_discounts or QUANTITY_TIER_DISCOUNTS
    trade_disc = trade_discount if trade_discount is not None else TRADE_DISCOUNT_DEFAULT
    td_type = "fixed" if str(trade_discount_type).lower() == "fixed" else "percent"
    
    def _apply_trade(tier_price: float) -> float:
        """Apply trade discount stacked on top of the tier-discounted price."""
        if td_type == "fixed":
            return max(0.0, tier_price - trade_disc)
        return tier_price * (1 - trade_disc / 100)
    
    # Build tier pricing table dynamically (supports any number of tiers)
    tiers = []
    num_thresholds = len(thresholds)
    num_discounts = len(discounts)
    
    # Tier 1: 0 to first threshold
    # Helper: format threshold as clean integer when possible (10 not 10.0)
    def fmt(v):
        return str(int(v)) if v == int(v) else str(v)
    
    if num_thresholds > 0 and num_discounts > 0:
        tiers.append({
            "tier": 1,
            "min_qty": 0,
            "max_qty": thresholds[0],
            "label": f"0 - {fmt(thresholds[0])}m\u00b2",
            "discount_percent": discounts[0],
            "price_per_m2": round(base_price * (1 - discounts[0] / 100), 2),
            "savings_label": "List Price" if discounts[0] == 0 else f"Save {discounts[0]}%"
        })
    
    # Middle tiers: between thresholds
    for i in range(num_thresholds - 1):
        if i + 1 < num_discounts:
            tiers.append({
                "tier": i + 2,
                "min_qty": thresholds[i],
                "max_qty": thresholds[i + 1],
                "label": f"{fmt(thresholds[i])} - {fmt(thresholds[i + 1])}m\u00b2",
                "discount_percent": discounts[i + 1],
                "price_per_m2": round(base_price * (1 - discounts[i + 1] / 100), 2),
                "savings_label": f"Save {discounts[i + 1]}%"
            })
    
    # Last tier: above last threshold (open-ended)
    last_discount_idx = min(num_thresholds, num_discounts - 1)
    if num_thresholds > 0 and last_discount_idx >= 0 and last_discount_idx < num_discounts:
        tiers.append({
            "tier": num_thresholds + 1,
            "min_qty": thresholds[-1],
            "max_qty": None,
            "label": f"{fmt(thresholds[-1])}m\u00b2+",
            "discount_percent": discounts[last_discount_idx],
            "price_per_m2": round(base_price * (1 - discounts[last_discount_idx] / 100), 2),
            "savings_label": f"Save {discounts[last_discount_idx]}%"
        })
    
    # Fallback: if no tiers were built, create a single tier with no discount
    if not tiers:
        tiers.append({
            "tier": 1,
            "min_qty": 0,
            "max_qty": None,
            "label": "Any quantity",
            "discount_percent": 0,
            "price_per_m2": base_price,
            "savings_label": "List Price"
        })
    
    # Determine current tier based on quantity
    num_tiers = len(tiers)
    current_tier = 1
    for i, threshold in enumerate(thresholds):
        if quantity >= threshold:
            current_tier = i + 2
    current_tier = min(current_tier, num_tiers)
    
    # Calculate current price
    current_discount = discounts[current_tier - 1]
    current_price = round(base_price * (1 - current_discount / 100), 2)
    
    # Apply trade discount if applicable
    trade_tiers = None
    trade_current_price = None
    if is_trade:
        trade_tiers = []
        for tier in tiers:
            trade_tier_price = round(_apply_trade(tier["price_per_m2"]), 2)
            if td_type == "fixed":
                savings_label = (
                    f"Save {tier['discount_percent']}% + £{trade_disc:.2f}"
                    if tier["discount_percent"] > 0
                    else f"Save £{trade_disc:.2f}"
                )
                total_discount = None
            else:
                total_discount = tier["discount_percent"] + trade_disc
                savings_label = f"Save {total_discount}%"
            trade_tiers.append({
                **tier,
                "price_per_m2": trade_tier_price,
                "total_discount_percent": total_discount,
                "savings_label": savings_label
            })
        trade_current_price = round(_apply_trade(current_price), 2)
    
    # Check if should show custom quote prompt
    show_custom_quote = quantity >= CUSTOM_QUOTE_THRESHOLD
    
    return {
        "base_price": base_price,
        "quantity": quantity,
        "thresholds": thresholds,
        "discounts": discounts,
        "tiers": tiers,
        "current_tier": current_tier,
        "current_discount_percent": current_discount,
        "current_price_per_m2": current_price,
        "total_price": round(current_price * quantity, 2),
        # Trade pricing
        "is_trade": is_trade,
        "trade_discount": trade_disc if is_trade else None,
        "trade_discount_type": td_type if is_trade else None,
        "trade_discount_percent": (trade_disc if td_type == "percent" else None) if is_trade else None,
        "trade_tiers": trade_tiers,
        "trade_current_price_per_m2": trade_current_price,
        "trade_total_price": round(trade_current_price * quantity, 2) if trade_current_price is not None else None,
        # Custom quote
        "show_custom_quote": show_custom_quote,
        "custom_quote_threshold": CUSTOM_QUOTE_THRESHOLD
    }


def get_tier_pricing_config() -> dict:
    """Get the current tier pricing configuration"""
    return {
        "thresholds": QUANTITY_TIER_THRESHOLDS,
        "discounts": QUANTITY_TIER_DISCOUNTS,
        "custom_quote_threshold": CUSTOM_QUOTE_THRESHOLD,
        "trade_discount_default": TRADE_DISCOUNT_DEFAULT,
        "credit_back_default": TRADE_CREDIT_BACK_DEFAULT
    }
