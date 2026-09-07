"""
Edit existing PDF to:
1. Apply 80% markup to all prices (ex VAT)
2. Remove "SCUDO" and "Harrison Bathrooms" text
3. Remove minimum £750 spend badge
4. Keep original layout and images
"""
import fitz  # PyMuPDF
import re

MARKUP = 0.80  # 80% markup

def apply_markup(price_value):
    """Apply 80% markup to a price"""
    return round(price_value * (1 + MARKUP), 2)

def find_and_replace_prices(page):
    """Find all prices on a page and replace with marked-up values"""
    # Get all text instances
    text_dict = page.get_text("dict")
    
    modifications = []
    
    for block in text_dict.get("blocks", []):
        if block.get("type") == 0:  # Text block
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    text = span.get("text", "")
                    bbox = span.get("bbox")
                    font_size = span.get("size", 10)
                    font_name = span.get("font", "helv")
                    color = span.get("color", 0)
                    
                    # Find price patterns like £47.00 or £1,234.56
                    price_pattern = r'£([\d,]+\.?\d*)'
                    matches = re.findall(price_pattern, text)
                    
                    if matches:
                        new_text = text
                        for match in matches:
                            try:
                                # Remove commas and convert to float
                                original_price = float(match.replace(',', ''))
                                new_price = apply_markup(original_price)
                                # Format with commas if needed
                                if new_price >= 1000:
                                    new_price_str = f"£{new_price:,.2f}"
                                else:
                                    new_price_str = f"£{new_price:.2f}"
                                old_price_str = f"£{match}"
                                new_text = new_text.replace(old_price_str, new_price_str)
                            except ValueError:
                                continue
                        
                        if new_text != text:
                            modifications.append({
                                'bbox': bbox,
                                'old_text': text,
                                'new_text': new_text,
                                'font_size': font_size,
                                'font_name': font_name,
                                'color': color
                            })
    
    return modifications

def remove_text_and_redact(page, texts_to_remove):
    """Remove specific text from page"""
    for text in texts_to_remove:
        # Search for text instances
        text_instances = page.search_for(text, quads=True)
        for inst in text_instances:
            # Create a white rectangle to cover the text
            rect = inst.rect
            # Add redaction annotation
            page.add_redact_annot(rect, fill=(1, 1, 1))  # White fill
    
    # Apply redactions
    page.apply_redactions()

def process_pdf(input_path, output_path):
    """Process the PDF with all modifications"""
    doc = fitz.open(input_path)
    
    texts_to_remove = [
        "SCUDO",
        "Scudo",
        "scudo",
        "Harrison Bathrooms",
        "HARRISON BATHROOMS",
        "harrison bathrooms",
        "Minimum order £750",
        "MINIMUM ORDER £750",
        "minimum order £750",
        "Min order £750",
        "£750 minimum",
        "£750 Minimum",
        "Minimum £750",
        "minimum £750",
        "MIN ORDER £750",
        "Min Order £750"
    ]
    
    print(f"Processing {len(doc)} pages...")
    
    for page_num in range(len(doc)):
        page = doc[page_num]
        print(f"Processing page {page_num + 1}...")
        
        # First, remove unwanted text
        remove_text_and_redact(page, texts_to_remove)
        
        # Reload page after redaction
        page = doc[page_num]
        
        # Find all prices and calculate new values
        text_dict = page.get_text("dict")
        
        for block in text_dict.get("blocks", []):
            if block.get("type") == 0:  # Text block
                for line in block.get("lines", []):
                    for span in line.get("spans", []):
                        text = span.get("text", "")
                        bbox = fitz.Rect(span.get("bbox"))
                        font_size = span.get("size", 10)
                        
                        # Find price patterns
                        price_pattern = r'£([\d,]+\.?\d*)'
                        matches = list(re.finditer(price_pattern, text))
                        
                        if matches:
                            new_text = text
                            for match in matches:
                                try:
                                    price_str = match.group(1)
                                    original_price = float(price_str.replace(',', ''))
                                    new_price = apply_markup(original_price)
                                    
                                    if new_price >= 1000:
                                        new_price_str = f"£{new_price:,.2f}"
                                    else:
                                        new_price_str = f"£{new_price:.2f}"
                                    
                                    old_price_str = f"£{price_str}"
                                    new_text = new_text.replace(old_price_str, new_price_str)
                                except ValueError:
                                    continue
                            
                            if new_text != text:
                                # Redact old text
                                page.add_redact_annot(bbox, fill=(1, 1, 1))
        
        # Apply price redactions
        page.apply_redactions()
        
        # Now re-add the modified prices
        page = doc[page_num]
        text_dict = page.get_text("dict")
        
        # We need to re-insert the new prices
        # This is complex because we've removed the old ones
        # Let's try a different approach - direct text replacement
    
    # Save the modified document
    doc.save(output_path, garbage=4, deflate=True)
    doc.close()
    print(f"PDF saved to: {output_path}")

def process_pdf_v2(input_path, output_path):
    """Alternative approach: overlay new text on existing"""
    doc = fitz.open(input_path)
    
    # Words/phrases to remove
    remove_patterns = [
        r"SCUDO",
        r"Scudo", 
        r"Harrison\s*Bathrooms?",
        r"HARRISON\s*BATHROOMS?",
        r"[Mm]in(imum)?\s*[Oo]rder\s*£\s*750",
        r"£\s*750\s*[Mm]in(imum)?",
        r"[Mm]inimum\s*£\s*750",
        r"MIN\.?\s*ORDER\s*£\s*750",
    ]
    
    print(f"Processing {len(doc)} pages...")
    
    for page_num in range(len(doc)):
        page = doc[page_num]
        print(f"Page {page_num + 1}...")
        
        # Get text blocks for this page
        blocks = page.get_text("dict", flags=fitz.TEXT_PRESERVE_WHITESPACE)["blocks"]
        
        # Find and redact unwanted text
        for pattern in remove_patterns:
            instances = page.search_for(pattern.replace(r"\s*", " ").replace(r"\.?", ""))
            for rect in instances:
                page.add_redact_annot(rect, fill=(1, 1, 1))
        
        # Also search for common variations
        for text in ["SCUDO", "Scudo", "Harrison Bathrooms", "Harrison bathrooms", 
                     "Minimum order £750", "Min order £750", "£750 minimum spend",
                     "Minimum spend £750", "£750 MIN ORDER", "£750 min order"]:
            instances = page.search_for(text)
            for rect in instances:
                page.add_redact_annot(rect, fill=(1, 1, 1))
        
        page.apply_redactions()
        
        # Now handle prices - find all price text and replace
        page = doc[page_num]  # Reload after redaction
        
        # Extract text with positions
        text_page = page.get_text("dict")
        
        price_replacements = []
        
        for block in text_page.get("blocks", []):
            if "lines" not in block:
                continue
            for line in block["lines"]:
                for span in line["spans"]:
                    text = span["text"]
                    # Find prices in format £XX.XX or £X,XXX.XX
                    price_matches = list(re.finditer(r'£([\d,]+(?:\.\d{2})?)', text))
                    
                    if price_matches:
                        bbox = fitz.Rect(span["bbox"])
                        font_size = span["size"]
                        font = span["font"]
                        color = span["color"]
                        
                        new_text = text
                        for match in price_matches:
                            try:
                                price_str = match.group(1)
                                original = float(price_str.replace(',', ''))
                                new_price = apply_markup(original)
                                
                                if new_price >= 1000:
                                    formatted = f"£{new_price:,.2f}"
                                else:
                                    formatted = f"£{new_price:.2f}"
                                
                                new_text = new_text.replace(f"£{price_str}", formatted)
                            except Exception:
                                pass
                        
                        if new_text != text:
                            price_replacements.append({
                                'rect': bbox,
                                'old': text,
                                'new': new_text,
                                'size': font_size,
                                'font': font,
                                'color': color
                            })
        
        # Apply price changes by redacting and re-inserting
        for rep in price_replacements:
            page.add_redact_annot(rep['rect'], fill=(1, 1, 1))
        
        page.apply_redactions()
        
        # Re-insert new prices
        for rep in price_replacements:
            # Determine font color (convert int to RGB tuple)
            c = rep['color']
            if isinstance(c, int):
                r = ((c >> 16) & 255) / 255
                g = ((c >> 8) & 255) / 255
                b = (c & 255) / 255
                text_color = (r, g, b)
            else:
                text_color = (0, 0, 0)
            
            # Insert new text
            page.insert_text(
                rep['rect'].tl,  # Top-left point
                rep['new'],
                fontsize=rep['size'],
                color=text_color
            )
    
    doc.save(output_path, garbage=4, deflate=True)
    doc.close()
    print(f"Saved: {output_path}")

if __name__ == "__main__":
    process_pdf_v2(
        "/app/scripts/original_price_list.pdf",
        "/app/scripts/February_Clearance_80_Markup.pdf"
    )
