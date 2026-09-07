"""
Script to import historical sales data from Excel for Gravesend store
"""
import requests
import os
import pandas as pd
from datetime import datetime
import sys

# Configuration
API_URL = "https://feature-verification-7.preview.emergentagent.com/api"
EXCEL_URL = "https://customer-assets.emergentagent.com/job_57c90f8c-a940-4503-bf40-6ca7423cba5a/artifacts/8prnzsgh_Gravesend%20-%20Daily%20Sales%20Record%20-%202025.xlsx"

# First, we need to get the Gravesend showroom ID
def get_showroom_id():
    """Get the Gravesend showroom ID"""
    try:
        # Login first
        login_resp = requests.post(f"{API_URL}/auth/login", json={
            "email": "qasim@tilestation.co.uk",
            "password": os.environ.get("TILESTATION_ADMIN_PASSWORD", "")
        })
        token = login_resp.json().get("token")
        
        # Get showrooms
        headers = {"Authorization": f"Bearer {token}"}
        showrooms_resp = requests.get(f"{API_URL}/showrooms", headers=headers)
        showrooms = showrooms_resp.json()
        
        for showroom in showrooms:
            if "gravesend" in showroom.get("name", "").lower():
                return showroom.get("id"), showroom.get("name"), token
        
        return None, None, token
    except Exception as e:
        print(f"Error getting showroom: {e}")
        return None, None, None

def parse_excel_data():
    """Parse the Excel file and extract sales data"""
    try:
        # Read Excel file
        df = pd.read_excel(EXCEL_URL, sheet_name=None)
        
        # The Excel has multiple sheets, one per month
        all_records = []
        
        for sheet_name, sheet_df in df.items():
            print(f"Processing sheet: {sheet_name}")
            
            # Skip if empty
            if sheet_df.empty:
                continue
            
            # Get column names
            cols = sheet_df.columns.tolist()
            print(f"Columns: {cols[:10]}...")
            
            # Process each row
            for idx, row in sheet_df.iterrows():
                try:
                    # Try to extract date from first column
                    date_val = row.iloc[0] if len(row) > 0 else None
                    
                    # Skip header rows and empty rows
                    if pd.isna(date_val) or str(date_val).strip() == "":
                        continue
                    
                    # Check if it's a date
                    if isinstance(date_val, datetime):
                        date_str = date_val.strftime("%d/%m/%Y")
                        day_of_week = date_val.strftime("%A")
                    elif isinstance(date_val, str):
                        # Try to parse string date
                        try:
                            parsed = pd.to_datetime(date_val)
                            date_str = parsed.strftime("%d/%m/%Y")
                            day_of_week = parsed.strftime("%A")
                        except Exception:
                            continue
                    else:
                        continue
                    
                    # Extract sales figures
                    cash_sale = float(row.iloc[1]) if len(row) > 1 and pd.notna(row.iloc[1]) else 0
                    card_sale = float(row.iloc[2]) if len(row) > 2 and pd.notna(row.iloc[2]) else 0
                    bank_transfer = float(row.iloc[3]) if len(row) > 3 and pd.notna(row.iloc[3]) else 0
                    cash_refund = float(row.iloc[4]) if len(row) > 4 and pd.notna(row.iloc[4]) else 0
                    card_refund = float(row.iloc[5]) if len(row) > 5 and pd.notna(row.iloc[5]) else 0
                    bank_refund = float(row.iloc[6]) if len(row) > 6 and pd.notna(row.iloc[6]) else 0
                    total_daily = float(row.iloc[7]) if len(row) > 7 and pd.notna(row.iloc[7]) else 0
                    
                    record = {
                        "date": date_str,
                        "day_of_week": day_of_week,
                        "cash_sale": cash_sale,
                        "card_sale": card_sale,
                        "bank_transfer": bank_transfer,
                        "cash_refund": cash_refund,
                        "card_refund": card_refund,
                        "bank_refund": bank_refund,
                        "total_daily_sale": total_daily
                    }
                    all_records.append(record)
                    
                except Exception as e:
                    continue
        
        return all_records
    except Exception as e:
        print(f"Error parsing Excel: {e}")
        return []

def import_data():
    """Main import function"""
    print("Getting Gravesend showroom ID...")
    showroom_id, showroom_name, token = get_showroom_id()
    
    if not showroom_id:
        print("Could not find Gravesend showroom!")
        return False
    
    print(f"Found showroom: {showroom_name} (ID: {showroom_id})")
    
    print("Parsing Excel data...")
    records = parse_excel_data()
    print(f"Parsed {len(records)} records")
    
    if not records:
        print("No records to import!")
        return False
    
    print("Importing data...")
    headers = {"Authorization": f"Bearer {token}"}
    
    response = requests.post(
        f"{API_URL}/historical-sales/import",
        json={
            "showroom_id": showroom_id,
            "showroom_name": showroom_name,
            "records": records
        },
        headers=headers
    )
    
    if response.status_code == 200:
        result = response.json()
        print(f"Success! Imported {result.get('count', 0)} records")
        return True
    else:
        print(f"Error: {response.status_code} - {response.text}")
        return False

if __name__ == "__main__":
    import_data()
