"""
Generate PDF price list with 60% markup
Removes "SCUDO" and "Harrison Bathrooms" from all text
"""
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, PageBreak
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
import re

# Markup percentage
MARKUP = 0.80  # 80%

def add_clearance_watermark(canvas, doc):
    """Add CLEARANCE watermark/stamp to each page"""
    canvas.saveState()
    
    # Draw diagonal CLEARANCE watermark
    canvas.setFont('Helvetica-Bold', 60)
    canvas.setFillColor(colors.Color(1, 0, 0, alpha=0.15))  # Red with transparency
    canvas.translate(A4[0]/2, A4[1]/2)
    canvas.rotate(45)
    canvas.drawCentredString(0, 0, "CLEARANCE")
    canvas.restoreState()
    
    # Draw CLEARANCE stamp in corner
    canvas.saveState()
    canvas.setFillColor(colors.HexColor('#dc2626'))
    canvas.roundRect(A4[0] - 95*mm, A4[1] - 25*mm, 80*mm, 15*mm, 3*mm, fill=1, stroke=0)
    canvas.setFillColor(colors.white)
    canvas.setFont('Helvetica-Bold', 14)
    canvas.drawCentredString(A4[0] - 55*mm, A4[1] - 20*mm, "CLEARANCE SALE")
    canvas.restoreState()

def apply_markup(price):
    """Apply 60% markup to a price"""
    return round(price * (1 + MARKUP), 2)

def format_price(price):
    """Format price with £ symbol"""
    return f"£{price:.2f}"

def clean_text(text):
    """Remove SCUDO and Harrison Bathrooms from text"""
    text = re.sub(r'\bSCUDO\b', '', text, flags=re.IGNORECASE)
    text = re.sub(r'\bHarrison Bathrooms?\b', '', text, flags=re.IGNORECASE)
    text = re.sub(r'\s+', ' ', text).strip()
    return text

# Product data extracted from PDF with prices
products_data = [
    # Shower Trays - Square
    {"category": "STONE RESIN SHOWER TRAYS - SQUARE", "items": [
        {"name": "Square Shower Tray 700x700mm (30mm deep)", "sku": "700-700-SQ-WTE", "price": 47.00},
        {"name": "Square Shower Tray 760x760mm (30mm deep)", "sku": "760-760-SQ-WTE", "price": 48.50},
        {"name": "Square Shower Tray 800x800mm (30mm deep)", "sku": "800-800-SQ-WTE", "price": 53.25},
        {"name": "Square Shower Tray 900x900mm (30mm deep)", "sku": "900-900-SQ-WTE", "price": 57.50},
    ]},
    
    # Shower Trays - Rectangle
    {"category": "STONE RESIN SHOWER TRAYS - RECTANGLE", "items": [
        {"name": "Rectangle Shower Tray 900x800mm", "sku": "900-800-REC-WTE", "price": 57.50},
        {"name": "Rectangle Shower Tray 1000x700mm", "sku": "1000-700-REC-WTE", "price": 60.75},
        {"name": "Rectangle Shower Tray 1000x800mm", "sku": "1000-800-REC-WTE", "price": 60.75},
        {"name": "Rectangle Shower Tray 1000x900mm", "sku": "1000-900-REC-WTE", "price": 64.50},
        {"name": "Rectangle Shower Tray 1100x800mm", "sku": "1100-800-REC-WTE", "price": 64.00},
        {"name": "Rectangle Shower Tray 1200x700mm", "sku": "1200-700-REC-WTE", "price": 63.50},
        {"name": "Rectangle Shower Tray 1200x760mm", "sku": "1200-760-REC-WTE", "price": 66.00},
        {"name": "Rectangle Shower Tray 1200x800mm", "sku": "1200-800-REC-WTE", "price": 68.00},
        {"name": "Rectangle Shower Tray 1200x900mm", "sku": "1200-900-REC-WTE", "price": 72.25},
        {"name": "Rectangle Shower Tray 1400x700mm", "sku": "1400-700-REC-WTE", "price": 72.50},
        {"name": "Rectangle Shower Tray 1400x800mm", "sku": "1400-800-REC-WTE", "price": 78.50},
        {"name": "Rectangle Shower Tray 1400x900mm", "sku": "1400-900-REC-WTE", "price": 84.00},
        {"name": "Rectangle Shower Tray 1500x700mm", "sku": "1500-700-REC-WTE", "price": 75.50},
        {"name": "Rectangle Shower Tray 1500x800mm", "sku": "1500-800-REC-WTE", "price": 81.50},
        {"name": "Rectangle Shower Tray 1500x900mm", "sku": "1500-900-REC-WTE", "price": 87.50},
        {"name": "Rectangle Shower Tray 1600x700mm", "sku": "1600-700-REC-WTE", "price": 79.50},
        {"name": "Rectangle Shower Tray 1600x760mm", "sku": "1600-760-REC-WTE", "price": 83.00},
        {"name": "Rectangle Shower Tray 1600x800mm", "sku": "1600-800-REC-WTE", "price": 85.50},
        {"name": "Rectangle Shower Tray 1600x900mm", "sku": "1600-900-REC-WTE", "price": 92.00},
        {"name": "Rectangle Shower Tray 1700x700mm", "sku": "1700-700-REC-WTE", "price": 82.50},
        {"name": "Rectangle Shower Tray 1700x760mm", "sku": "1700-760-REC-WTE", "price": 86.50},
        {"name": "Rectangle Shower Tray 1700x800mm", "sku": "1700-800-REC-WTE", "price": 89.00},
        {"name": "Rectangle Shower Tray 1700x900mm", "sku": "1700-900-REC-WTE", "price": 95.50},
    ]},
    
    # Quadrant
    {"category": "STONE RESIN SHOWER TRAYS - QUADRANT", "items": [
        {"name": "Quadrant Shower Tray 800x800mm", "sku": "800-800-QUAD-WTE", "price": 52.00},
        {"name": "Quadrant Shower Tray 900x900mm", "sku": "900-900-QUAD-WTE", "price": 57.50},
    ]},
    
    # Offset Quadrant
    {"category": "OFFSET QUADRANT SHOWER TRAYS", "items": [
        {"name": "Offset Quadrant LH 900x760mm", "sku": "900-760-OFFLH-WTE", "price": 55.00},
        {"name": "Offset Quadrant LH 1000x800mm", "sku": "1000-800-OFFLH-WTE", "price": 60.00},
        {"name": "Offset Quadrant LH 1200x800mm", "sku": "1200-800-OFFLH-WTE", "price": 66.50},
        {"name": "Offset Quadrant LH 1200x900mm", "sku": "1200-900-OFFLH-WTE", "price": 71.00},
        {"name": "Offset Quadrant RH 900x760mm", "sku": "900-760-OFFRH-WTE", "price": 55.00},
        {"name": "Offset Quadrant RH 1000x800mm", "sku": "1000-800-OFFRH-WTE", "price": 60.00},
        {"name": "Offset Quadrant RH 1200x800mm", "sku": "1200-800-OFFRH-WTE", "price": 66.50},
        {"name": "Offset Quadrant RH 1200x900mm", "sku": "1200-900-OFFRH-WTE", "price": 71.00},
    ]},
    
    # Fitting Kits
    {"category": "LEG SETS & PANELS", "items": [
        {"name": "Fitting Kit A (up to 1000)", "sku": "TRAY-FITTING-KITA", "price": 25.00},
        {"name": "Fitting Kit B (900 + 1700)", "sku": "TRAY-FITTING-KITB", "price": 28.00},
        {"name": "Fitting Kit C (900 + 1200)", "sku": "TRAY-FITTING-KITC", "price": 31.00},
    ]},
    
    # Wastes
    {"category": "WASTES FOR 40MM SHOWER TRAYS", "items": [
        {"name": "Chrome 90mm Fast Flow Waste", "sku": "S0044", "price": 4.00},
        {"name": "Black 90mm Fast Flow Waste", "sku": "S0060", "price": 4.00},
        {"name": "Brushed Brass 90mm Fast Flow Waste", "sku": "S0061", "price": 8.00},
        {"name": "Gunmetal 90mm Fast Flow Waste", "sku": "S0062", "price": 8.00},
        {"name": "Bronze 90mm Fast Flow Waste", "sku": "S0063", "price": 9.50},
        {"name": "Brushed Nickel 90mm Fast Flow Waste", "sku": "S0064", "price": 9.50},
    ]},
    
    # Sanitaryware
    {"category": "SANITARYWARE - CLOSE COUPLED", "items": [
        {"name": "Diva Close Coupled Rimless WC inc Cistern & Soft Close Seat", "sku": "PAN001", "price": 55.00},
        {"name": "Spa Open Back Pan inc Cistern & D Shape Soft Close Seat", "sku": "WC-PAN-001", "price": 73.00},
        {"name": "Choices 600 Open Back Pan inc Cistern & Soft Close Seat", "sku": "SEICENTO-PAN-SEAT", "price": 77.00},
        {"name": "Choices 550 Open Back Pan inc Cistern & Soft Close Seat", "sku": "CHOICES-OPEN-PAN-SEAT", "price": 77.00},
        {"name": "Choices 600 Comfort Height Open Back Pan inc Cistern & Seat", "sku": "CHOICES-COMFORT-PAN-SEAT", "price": 81.00},
        {"name": "Spa Comfort Height Open Back Pan, Cistern & Soft Close Seat", "sku": "SPACE006", "price": 87.40},
    ]},
    
    # Closed Back & Back to Wall
    {"category": "SANITARYWARE - CLOSED BACK & BACK TO WALL", "items": [
        {"name": "Porto Rimless Closed Back Complete Toilet inc Seat", "sku": "PORTO-CLOSEDBACK-PAN-SEAT", "price": 77.00},
        {"name": "Choices 550 Closed Back Pan inc Cistern & Soft Close Seat", "sku": "CHOICES-FULL-PAN-SEAT", "price": 77.00},
        {"name": "Linea Rimless Closed Back Pan & Seat", "sku": "LINEA-FULL-PAN-SEAT", "price": 90.00},
        {"name": "Choices 600 Back to Wall & Soft Close Seat", "sku": "CHOICES-BTW-PAN-SEAT", "price": 55.00},
        {"name": "Spa Rimless Back to Wall Pan & Wrapover Seat", "sku": "BTW-002", "price": 55.00},
    ]},
    
    # Wall Hung
    {"category": "SANITARYWARE - WALL HUNG", "items": [
        {"name": "Spa Wall Hung Pan & D Shape Soft Close Seat", "sku": "SPACE010", "price": 74.00},
        {"name": "Riviera Rimless Round Wall Hung Pan inc Soft Close Seat", "sku": "WH-RD-GW", "price": 70.00},
        {"name": "Riviera Rimless Square Wall Hung Pan inc Soft Close Seat", "sku": "WH-SQ-GW", "price": 70.00},
    ]},
    
    # Complete Sets
    {"category": "COMPLETE SETS", "items": [
        {"name": "Complete Toilet Set Rimless", "sku": "COMPLETE-TOILET-SET-RIMLESS", "price": 40.00},
        {"name": "Complete Back to Wall", "sku": "COMPLETE-BTW-SET-3", "price": 32.00},
        {"name": "Complete Basin & Pedestal", "sku": "COMPLETE-BASIN-PED", "price": 25.00},
    ]},
    
    # Concealed Cisterns
    {"category": "CONCEALED CISTERNS", "items": [
        {"name": "Concealed Cistern Side Inlet", "sku": "CISTERN002W", "price": 12.50},
        {"name": "Concealed Cistern Bottom Inlet", "sku": "CISTERN003W", "price": 12.50},
    ]},
    
    # Pan Connectors
    {"category": "PAN CONNECTORS", "items": [
        {"name": "Wirquin Long Pan Connector 300-630mm", "sku": "PANCON001", "price": 4.45},
        {"name": "Wirquin Short Pan Connector 200-340mm", "sku": "PANCON002", "price": 4.25},
    ]},
    
    # Aubrey Cabinets
    {"category": "BASIN CABINETS - AUBREY 600", "items": [
        {"name": "Aubrey 600 Cabinet Davos Oak inc Basin", "sku": "AUBREY-600-VANITY-OAK", "price": 185.30},
        {"name": "Aubrey 600 Cabinet Dust Grey inc Basin", "sku": "AUBREY-600-VANITY-GREY", "price": 185.30},
        {"name": "Aubrey 600 Cabinet Reed Green inc Basin", "sku": "AUBREY-600-VANITY-GREEN", "price": 185.30},
        {"name": "Aubrey Handle Chrome", "sku": "AUBREY-HANDLE-CHROME", "price": 5.67},
        {"name": "Aubrey Handle Black", "sku": "AUBREY-HANDLE-BLACK", "price": 5.67},
        {"name": "Aubrey Handle Brushed Brass", "sku": "AUBREY-HANDLE-BRBRAS", "price": 5.67},
        {"name": "Aubrey Handle Gunmetal", "sku": "AUBREY-HANDLE-GUN", "price": 5.67},
        {"name": "Aubrey Handle Bronze", "sku": "AUBREY-HANDLE-BZ", "price": 5.67},
    ]},
    
    # Bella 500
    {"category": "FURNITURE - BELLA 500", "items": [
        {"name": "Bella 500 WC Unit High Gloss White", "sku": "BELLA-500WCUNIT-GWTE", "price": 75.00},
        {"name": "Bella 500 WC Unit Matte Grey", "sku": "BELLA-500WCUNIT-MATTGREY", "price": 75.00},
        {"name": "Bella 500 WC Unit Davos Oak", "sku": "BELLA-500WCUNIT-DAVOS", "price": 75.00},
        {"name": "Bella 500 Wall Cabinet High Gloss White inc Basin", "sku": "BELLA-500WALLCAB-GWTE", "price": 154.00},
        {"name": "Bella 500 Wall Cabinet Matte Grey inc Basin", "sku": "BELLA-500WALLCAB-MATTGREY", "price": 154.00},
        {"name": "Bella 500 Wall Cabinet Davos Oak inc Basin", "sku": "BELLA-500WALLCAB-DAVOS", "price": 154.00},
        {"name": "Bella 500 Floor Cabinet High Gloss White inc Basin", "sku": "BELLA-500FLOORCAB-GWTE", "price": 185.00},
        {"name": "Bella 500 Floor Cabinet Matte Grey inc Basin", "sku": "BELLA-500FLOORCAB-MATTGREY", "price": 185.00},
        {"name": "Bella 500 Floor Cabinet Davos Oak inc Basin", "sku": "BELLA-500FLOORCAB-DAVOS", "price": 185.00},
    ]},
    
    # Bella 600
    {"category": "FURNITURE - BELLA 600", "items": [
        {"name": "Bella 600 Wall Cabinet High Gloss White inc Basin", "sku": "BELLA-600WALLCAB-GWTE", "price": 187.00},
        {"name": "Bella 600 Wall Cabinet Matte Grey inc Basin", "sku": "BELLA-600WALLCAB-MATTGREY", "price": 187.00},
        {"name": "Bella 600 Wall Cabinet Davos Oak inc Basin", "sku": "BELLA-600WALLCAB-DAVOS", "price": 187.00},
        {"name": "Bella 600 Floor Cabinet High Gloss White inc Basin", "sku": "BELLA-600FLOORCAB-GWTE", "price": 222.00},
        {"name": "Bella 600 Floor Cabinet Matte Grey inc Basin", "sku": "BELLA-600FLOORCAB-MATTGREY", "price": 222.00},
        {"name": "Bella 600 Floor Cabinet Davos Oak inc Basin", "sku": "BELLA-600FLOORCAB-DAVOS", "price": 222.00},
    ]},
    
    # Bella 900 & 1500
    {"category": "FURNITURE - BELLA 900 & TALL", "items": [
        {"name": "Bella 900 Wall Cabinet High Gloss White inc Basin", "sku": "PAINT-BELLA-900WALLCAB-GWTE", "price": 225.00},
        {"name": "Bella 900 Floor Cabinet Matte Grey inc Basin", "sku": "BELLA-900FLOORCAB-MATTGREY", "price": 284.00},
        {"name": "Bella 1500 Tall Cabinet High Gloss White", "sku": "BELLA-1500TALLBOY-GWTE", "price": 137.00},
        {"name": "Bella 1500 Tall Cabinet Matte Grey", "sku": "BELLA-1500TALLBOY-MATTGREY", "price": 137.00},
        {"name": "Bella 1500 Tall Cabinet Davos Oak", "sku": "BELLA-1500TALLBOY-DAVOS", "price": 137.00},
    ]},
    
    # Empire
    {"category": "FURNITURE - EMPIRE 600", "items": [
        {"name": "Empire 600 Vanity Unit Matte Twilight Blue inc Basin", "sku": "600CAB-LILI-BLUE", "price": 100.00},
        {"name": "Empire 600 Vanity Unit Matte Sage Green inc Basin", "sku": "600CAB-LILI-GREEN", "price": 100.00},
        {"name": "Empire 600 Vanity Unit Matte Anthracite inc Basin", "sku": "600CAB-LILI-ANTHRACITE", "price": 100.00},
    ]},
    
    # Lanza Cloakroom
    {"category": "FURNITURE - LANZA CLOAKROOM", "items": [
        {"name": "Lanza Cloakroom Floor Cabinet White inc Basin", "sku": "LANZAFLOOR", "price": 49.00},
        {"name": "Lanza Cloakroom Wall Cabinet White inc Basin", "sku": "LANZAWALL", "price": 44.00},
    ]},
    
    # Lanza Floor Cabinets
    {"category": "FURNITURE - LANZA FLOOR CABINETS", "items": [
        {"name": "Lanza 450 Floor Cabinet Polar White inc Basin", "sku": "POLAR-450-BASINUNIT", "price": 77.00},
        {"name": "Lanza 550 Floor Cabinet Polar White inc Basin", "sku": "POLAR-550-BASINUNIT", "price": 84.00},
        {"name": "Lanza 650 Floor Cabinet Polar White inc Basin", "sku": "POLAR-650-BASINUNIT", "price": 103.00},
        {"name": "Lanza 750 Floor Cabinet Polar White inc Basin", "sku": "POLAR-750-BASINUNIT", "price": 132.00},
        {"name": "Lanza 850 Floor Cabinet Polar White inc Basin", "sku": "POLAR-850-BASINUNIT", "price": 155.00},
        {"name": "Lanza 950 Floor Cabinet Polar White inc Basin", "sku": "POLAR-950-BASINUNIT", "price": 195.00},
        {"name": "Lanza 500 WC Unit Polar White", "sku": "POLAR-500-WCUNIT", "price": 63.00},
        {"name": "Lanza 600 WC Unit Polar White", "sku": "POLAR-600WCUNIT", "price": 66.00},
        {"name": "Lanza 350 Drawer Unit Polar White", "sku": "POLAR-DRAWERUNIT", "price": 79.00},
        {"name": "Lanza Tall Unit Polar White", "sku": "POLAR-TALLUNIT", "price": 138.00},
    ]},
    
    # Lili
    {"category": "FURNITURE - LILI", "items": [
        {"name": "Lili 2 Door 600 Vanity Unit Gloss White inc Basin", "sku": "600CAB-LILI-WTE", "price": 92.00},
        {"name": "Lili 2 Door 600 Vanity Unit Matte Grey inc Basin", "sku": "600CAB-LILI-MATTGREY", "price": 92.00},
        {"name": "Lili 500 WC Unit Gloss White", "sku": "LILI-500WCUNIT-GWTE", "price": 67.00},
        {"name": "Lili 500 WC Unit Matte Grey", "sku": "LILI-500WCUNIT-MATTGREY", "price": 82.00},
    ]},
    
    # Rossini
    {"category": "FURNITURE - ROSSINI", "items": [
        {"name": "Rossini Floor Standing 500 Vanity Unit White inc Basin", "sku": "ROSSINI02", "price": 119.00},
        {"name": "Rossini Floor Standing 600 Vanity Unit White inc Basin", "sku": "ROSSINI01", "price": 138.00},
        {"name": "Rossini Back to Wall Unit White", "sku": "ROSSINI07", "price": 53.33},
        {"name": "Rossini Floor Standing 500 Vanity Unit Wolf Grey inc Basin", "sku": "ROSSINI05", "price": 119.00},
        {"name": "Rossini Floor Standing 600 Vanity Unit Wolf Grey inc Basin", "sku": "ROSSINI06", "price": 138.00},
        {"name": "Rossini Back to Wall Unit Wolf Grey", "sku": "ROSSINI09", "price": 53.33},
        {"name": "Rossini Floor Standing 500 Vanity Unit Pebble Grey inc Basin", "sku": "ROSSINI03", "price": 119.00},
        {"name": "Rossini Floor Standing 600 Vanity Unit Pebble Grey inc Basin", "sku": "ROSSINI04", "price": 138.00},
        {"name": "Rossini Back to Wall Unit Pebble Grey", "sku": "ROSSINI08", "price": 53.33},
    ]},
    
    # Waterguard
    {"category": "WATERGUARD WATERPROOF FURNITURE", "items": [
        {"name": "Waterguard 500 Vanity Unit inc Basin", "sku": "WATERGUARD-500VANITY-GWTE", "price": 110.00},
        {"name": "Waterguard 600 Vanity Unit inc Basin", "sku": "WATERGUARD-600VANITY-GWTE", "price": 134.00},
        {"name": "Waterguard Cloakroom Cabinet inc Basin", "sku": "WATERGUARD-CLOAKROOM-GWTE", "price": 80.00},
        {"name": "Waterguard WC Unit", "sku": "WATERGUARD-500WC-GWTE", "price": 84.00},
    ]},
    
    # Bath Panels
    {"category": "WATERPROOF BATH PANELS", "items": [
        {"name": "1700mm Front Panel", "sku": "FRONT1700PANEL001", "price": 33.00},
        {"name": "1800mm Front Panel", "sku": "FRONT1800PANEL", "price": 36.00},
        {"name": "700mm End Panel", "sku": "ENDPANEL001", "price": 14.00},
        {"name": "800mm End Panel", "sku": "ENDPANEL800", "price": 17.00},
    ]},
    
    # Forte Wetroom
    {"category": "FORTE WETROOM PANELS - CHROME PROFILE", "items": [
        {"name": "Forte Wetroom Panel 600mm Chrome", "sku": "S8-WET600CHR", "price": 52.00},
        {"name": "Forte Wetroom Panel 700mm Chrome", "sku": "S8-WET700CHR", "price": 58.00},
        {"name": "Forte Wetroom Panel 760mm Chrome", "sku": "S8-WET760CHR", "price": 62.00},
        {"name": "Forte Wetroom Panel 800mm Chrome", "sku": "S8-WET800CHR", "price": 64.00},
        {"name": "Forte Wetroom Panel 900mm Chrome", "sku": "S8-WET900CHR", "price": 70.00},
        {"name": "Forte Wetroom Panel 1000mm Chrome", "sku": "S8-WET1000CHR", "price": 76.00},
        {"name": "Forte Wetroom Panel 1100mm Chrome", "sku": "S8-WET1100CHR", "price": 82.00},
        {"name": "Forte Wetroom Panel 1200mm Chrome", "sku": "S8-WET1200CHR", "price": 89.00},
        {"name": "Support Post 3000mm", "sku": "SCUDPOST", "price": 50.00},
        {"name": "Scud Join", "sku": "SCUDJOIN", "price": 4.50},
        {"name": "Flipper Panel 275mm", "sku": "S8-FLIPPER", "price": 40.00},
    ]},
    
    # Minos Framed Wetroom
    {"category": "MINOS FRAMED WETROOM - MATTE BLACK", "items": [
        {"name": "Minos Framed Wetroom 700x2000 Matte Black", "sku": "MINFRAME700BLK", "price": 80.00},
        {"name": "Minos Framed Wetroom 760x2000 Matte Black", "sku": "MINFRAME760BLK", "price": 82.00},
        {"name": "Minos Framed Wetroom 800x2000 Matte Black", "sku": "MINFRAME800BLK", "price": 84.00},
        {"name": "Minos Framed Wetroom 900x2000 Matte Black", "sku": "MINFRAME900BLK", "price": 86.00},
        {"name": "Minos Framed Wetroom 1000x2000 Matte Black", "sku": "MINFRAME1000BLK", "price": 88.00},
        {"name": "Minos Framed Wetroom 1100x2000 Matte Black", "sku": "MINFRAME1100BLK", "price": 90.00},
        {"name": "Minos Framed Wetroom 1200x2000 Matte Black", "sku": "MINFRAME1200BLK", "price": 92.00},
    ]},
    
    # Minos Brushed Brass
    {"category": "MINOS FRAMED WETROOM - BRUSHED BRASS", "items": [
        {"name": "Minos Framed Wetroom 700x2000 Brushed Brass", "sku": "MINFRAME700BB", "price": 125.00},
        {"name": "Minos Framed Wetroom 760x2000 Brushed Brass", "sku": "MINFRAME760BB", "price": 128.00},
        {"name": "Minos Framed Wetroom 800x2000 Brushed Brass", "sku": "MINFRAME800BB", "price": 131.00},
        {"name": "Minos Framed Wetroom 900x2000 Brushed Brass", "sku": "MINFRAME900BB", "price": 134.00},
        {"name": "Minos Framed Wetroom 1000x2000 Brushed Brass", "sku": "MINFRAME1000BB", "price": 140.00},
        {"name": "Minos Framed Wetroom 1100x2000 Brushed Brass", "sku": "MINFRAME1100BB", "price": 150.00},
        {"name": "Minos Framed Wetroom 1200x2000 Brushed Brass", "sku": "MINFRAME1200BB", "price": 160.00},
    ]},
    
    # Fast Fix Enclosures
    {"category": "ENCLOSURES - FAST FIX", "items": [
        {"name": "Fast Fix 800 Quad Chrome", "sku": "FF-800-QUAD-CHR", "price": 80.00},
        {"name": "Fast Fix 900 Quad Chrome", "sku": "FF-900-QUAD-CHR", "price": 85.00},
    ]},
    
    # Bath Screens
    {"category": "BATH SCREENS", "items": [
        {"name": "Mono Square Edge 6mm Bath Screen", "sku": "LS888B", "price": 39.90},
        {"name": "Black Grid 6mm Bath Screen", "sku": "GRIDBATHSCREEN", "price": 39.90},
        {"name": "P Shaped Bath Screen", "sku": "SCREEN002", "price": 42.86},
        {"name": "L Shaped Bath Screen", "sku": "SCREEN003", "price": 42.86},
        {"name": "Black Square 900mm Pivot Bath Screen & Fixed Panel", "sku": "SCREEN007", "price": 50.00},
        {"name": "Square Edge 6mm Bath Screen", "sku": "LS099N", "price": 30.00},
        {"name": "Radius Edge 6mm Bath Screen", "sku": "LS010N", "price": 30.00},
        {"name": "Black Profile Square Edge 6mm Bath Screen", "sku": "BLACKSCREEN099", "price": 32.00},
        {"name": "L Shape Black Profile Square Edge 6mm Bath Screen", "sku": "BLACKSCREEN003", "price": 47.50},
        {"name": "Black Profile Edge 6mm Bath Screen", "sku": "BLACKSCREEN010", "price": 34.20},
    ]},
    
    # Rigid Riser Showers
    {"category": "SHOWERING - RIGID RISER SHOWERS", "items": [
        {"name": "Chrome Round Rigid Riser Shower", "sku": "RR-ROUND-CHROME", "price": 46.00},
        {"name": "Black Round Rigid Riser Shower", "sku": "RR-ROUND-BLACK", "price": 56.00},
        {"name": "Brushed Brass Round Rigid Riser Shower", "sku": "RR-ROUND-BRASS", "price": 56.00},
        {"name": "Chrome Square Rigid Riser Shower", "sku": "RR-SQUARE-CHROME", "price": 56.00},
        {"name": "Black Square Rigid Riser Shower", "sku": "RR-SQUARE-BLACK", "price": 65.00},
        {"name": "Brushed Brass Square Rigid Riser Shower", "sku": "RR-SQUARE-BRASS", "price": 65.00},
    ]},
    
    # Mirrors
    {"category": "MIRRORS", "items": [
        {"name": "Vivid LED Mirror with Demister 500x700mm", "sku": "MIRROR06", "price": 45.00},
        {"name": "Mosca LED Mirror with Demister & Shaver Socket 500x700mm", "sku": "MIRROR001", "price": 65.00},
        {"name": "Mosca LED Mirror with Demister & Shaver Socket 600x800mm", "sku": "MIRROR002", "price": 75.00},
        {"name": "Mosca LED Mirror with Demister & Shaver Socket 1200x600mm", "sku": "MIRROR003", "price": 95.00},
        {"name": "Mosca Bluetooth Speaker LED Mirror 500x700mm", "sku": "MIRROR004USB", "price": 90.00},
        {"name": "Macie Led Mirror Brushed Brass 600mm", "sku": "MACIE-600RND-BB", "price": 68.00},
        {"name": "Macie Led Mirror Matte Black 600mm", "sku": "MACIE-600RND-BLACK", "price": 68.00},
        {"name": "Belini Round LED Mirror 600mm", "sku": "BELINI-LED-600", "price": 70.00},
        {"name": "Lunar LED Mirror with Demister 600mm", "sku": "LUNAR60", "price": 80.00},
        {"name": "Lunar LED Mirror with Demister 800mm", "sku": "LUNAR80", "price": 99.99},
    ]},
    
    # LED Cabinets
    {"category": "LED MIRROR CABINETS", "items": [
        {"name": "Mia LED Cabinet Single Door 500x700mm", "sku": "MIA-500x700-CAB", "price": 120.00},
        {"name": "Mia LED Cabinet Double Door 600x700mm", "sku": "MIA-600x700-CAB", "price": 150.00},
        {"name": "Mia LED Cabinet Double Door 800x700mm", "sku": "MIA-800x700-CAB", "price": 175.00},
    ]},
    
    # Baths
    {"category": "BATHING", "items": [
        {"name": "Choices Freestanding Bath White 1700x700", "sku": "BATH-006", "price": 350.00},
        {"name": "Labyrinth Fluted Back To Wall Bath White 1700x780", "sku": "BATH-003", "price": 430.00},
        {"name": "Form Freestanding Bath Gloss White 1650x700", "sku": "BATH-FORM", "price": 330.00},
        {"name": "Onyx Freestanding Bath Gloss White 1555x750", "sku": "BATH-DE1555", "price": 330.00},
        {"name": "Onyx Freestanding Bath Gloss White 1655x750", "sku": "BATH-DE1655", "price": 330.00},
        {"name": "Onyx Freestanding Bath Gloss White 1850x800", "sku": "BATH-DE1800", "price": 330.00},
        {"name": "Aruba Freestanding Bath Gloss White 1700x780", "sku": "BATH-ARUBA", "price": 370.00},
        {"name": "Porto Back To Wall Bath 1700x800 White", "sku": "BATH-005", "price": 330.00},
        {"name": "Labyrinth Fluted Freestanding Bath White 1700x800", "sku": "BATH-002", "price": 430.00},
        {"name": "Coral Freestanding Bath White 1700x750", "sku": "BATH-004", "price": 420.00},
    ]},
]

def generate_pdf():
    """Generate the price list PDF with 80% markup and CLEARANCE stamp"""
    doc = SimpleDocTemplate(
        "/app/scripts/February_Clearance_Sale.pdf",
        pagesize=A4,
        rightMargin=15*mm,
        leftMargin=15*mm,
        topMargin=25*mm,
        bottomMargin=20*mm
    )
    
    styles = getSampleStyleSheet()
    
    # Custom styles
    title_style = ParagraphStyle(
        'Title',
        parent=styles['Heading1'],
        fontSize=28,
        spaceAfter=5,
        alignment=TA_CENTER,
        textColor=colors.HexColor('#dc2626')
    )
    
    subtitle_style = ParagraphStyle(
        'Subtitle',
        parent=styles['Heading2'],
        fontSize=18,
        spaceAfter=20,
        alignment=TA_CENTER,
        textColor=colors.HexColor('#1a365d')
    )
    
    category_style = ParagraphStyle(
        'Category',
        parent=styles['Heading2'],
        fontSize=14,
        spaceBefore=15,
        spaceAfter=8,
        textColor=colors.HexColor('#2d3748'),
        backColor=colors.HexColor('#fef2f2'),
        borderPadding=5
    )
    
    note_style = ParagraphStyle(
        'Note',
        parent=styles['Normal'],
        fontSize=9,
        textColor=colors.HexColor('#718096'),
        alignment=TA_CENTER,
        spaceBefore=5,
        spaceAfter=10
    )
    
    elements = []
    
    # Title
    elements.append(Paragraph("CLEARANCE SALE", title_style))
    elements.append(Paragraph("February Special Offers", subtitle_style))
    elements.append(Paragraph("All prices marked up 80% | Limited Stock Available", note_style))
    elements.append(Spacer(1, 10*mm))
    
    # Table style - red accent for clearance
    table_style = TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#dc2626')),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
        ('ALIGN', (2, 0), (2, -1), 'RIGHT'),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 0), (-1, 0), 10),
        ('FONTSIZE', (0, 1), (-1, -1), 9),
        ('BOTTOMPADDING', (0, 0), (-1, 0), 8),
        ('TOPPADDING', (0, 0), (-1, 0), 8),
        ('BOTTOMPADDING', (0, 1), (-1, -1), 5),
        ('TOPPADDING', (0, 1), (-1, -1), 5),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#fca5a5')),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#fef2f2')]),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
    ])
    
    for category_data in products_data:
        category = clean_text(category_data["category"])
        items = category_data["items"]
        
        elements.append(Paragraph(category, category_style))
        
        # Table header
        data = [['Product', 'SKU', 'Price (inc VAT)']]
        
        for item in items:
            name = clean_text(item["name"])
            sku = item["sku"]
            original_price = item["price"]
            marked_up_price = apply_markup(original_price)
            
            data.append([
                Paragraph(name, styles['Normal']),
                sku,
                format_price(marked_up_price)
            ])
        
        col_widths = [110*mm, 45*mm, 25*mm]
        table = Table(data, colWidths=col_widths, repeatRows=1)
        table.setStyle(table_style)
        elements.append(table)
        elements.append(Spacer(1, 5*mm))
    
    # Footer note
    footer_style = ParagraphStyle(
        'Footer',
        parent=styles['Normal'],
        fontSize=8,
        textColor=colors.HexColor('#718096'),
        alignment=TA_CENTER,
        spaceBefore=20
    )
    elements.append(Paragraph("CLEARANCE SALE - All prices exclude delivery. Limited stock while supplies last. February 2026.", footer_style))
    
    # Build with watermark on every page
    doc.build(elements, onFirstPage=add_clearance_watermark, onLaterPages=add_clearance_watermark)
    print("PDF generated successfully: /app/scripts/February_Clearance_Sale.pdf")

if __name__ == "__main__":
    generate_pdf()
