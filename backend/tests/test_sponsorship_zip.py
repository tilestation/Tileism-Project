"""
Verify the sponsorship-documents.zip served from the frontend public URL.

Checks (per review request):
 1. Publicly downloadable via HTTPS, Content-Type application/zip, Content-Length < 20,000,000
 2. Valid PKZIP archive (testzip() == None)
 3. Contains 138 file entries
 4. Max relative path length inside ZIP <= 200
 5. No outer wrapper folder — top-level dirs are the four expected buckets
 6. Payslip filenames follow shortened pattern; none start with 'TILE STATION LTD - Employee Payslip for'
 7. Every PDF starts with %PDF magic bytes
 8. 5 monthly merged invoice PDFs at Systems/Customer Invoices/invoices_*.pdf each have 600+ pages
"""

import io
import os
import re
import zipfile
import tempfile
import urllib.request
import pytest

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://feature-verification-7.preview.emergentagent.com").rstrip("/")
ZIP_URL = f"{BASE_URL}/sponsorship-documents.zip"


@pytest.fixture(scope="module")
def zip_download():
    """Download the ZIP once and return (headers, bytes)."""
    req = urllib.request.Request(ZIP_URL, headers={"User-Agent": "sponsor-zip-test/1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        headers = dict(resp.headers)
        data = resp.read()
    return headers, data


@pytest.fixture(scope="module")
def zip_file(zip_download):
    _, data = zip_download
    zf = zipfile.ZipFile(io.BytesIO(data))
    yield zf
    zf.close()


# --- Test 1: HTTPS availability, content-type, size ---
def test_zip_url_headers_and_size(zip_download):
    headers, data = zip_download
    ct = headers.get("Content-Type", "").lower()
    assert "application/zip" in ct or "application/octet-stream" in ct, f"Unexpected Content-Type: {ct}"
    # Content-Length header
    cl = headers.get("Content-Length")
    assert cl is not None, "Missing Content-Length header"
    assert int(cl) < 20_000_000, f"Content-Length {cl} >= 20,000,000 bytes"
    # Actual bytes downloaded
    assert len(data) < 20_000_000, f"Downloaded bytes {len(data)} >= 20MB"
    assert len(data) == int(cl), "Content-Length mismatch with actual bytes"


# --- Test 2: Valid PKZIP archive ---
def test_zip_is_valid_pkzip(zip_file):
    bad = zip_file.testzip()
    assert bad is None, f"Corrupted entry: {bad}"


# --- Test 3: 138 file entries ---
def test_zip_has_138_file_entries(zip_file):
    files = [n for n in zip_file.namelist() if not n.endswith("/")]
    assert len(files) == 138, f"Expected 138 files, got {len(files)}"


# --- Test 4: Max path length <= 200 ---
def test_max_relative_path_length(zip_file):
    files = [n for n in zip_file.namelist() if not n.endswith("/")]
    longest = max(files, key=len)
    assert len(longest) <= 200, f"Max path length {len(longest)} > 200: {longest}"


# --- Test 5: Top-level structure — no outer wrapper ---
def test_no_outer_wrapper_folder(zip_file):
    names = zip_file.namelist()
    top_level = set()
    for n in names:
        parts = n.split("/", 1)
        if parts[0]:
            top_level.add(parts[0])
    # Must NOT contain wrapper
    forbidden = "Tile Station Sponsorship Licence Documents"
    assert forbidden not in top_level, f"Outer wrapper folder found: {forbidden}"
    # Must contain the four expected buckets
    expected = {"Bank Statements", "HR Documents", "Staff Documents", "Systems"}
    missing = expected - top_level
    assert not missing, f"Missing expected top-level folders: {missing}. Got: {top_level}"


# --- Test 6: Payslip filenames shortened ---
def test_payslip_filenames_shortened(zip_file):
    payslips = [n for n in zip_file.namelist() if "payslip" in n.lower() and n.lower().endswith(".pdf")]
    assert payslips, "No payslip files found"
    # None should start with old pattern
    bad = [p for p in payslips if os.path.basename(p).startswith("TILE STATION LTD - Employee Payslip for")]
    assert not bad, f"Payslips still using old long name pattern: {bad[:3]}"
    # All must match: Payslip {MMM}-{YYYY} - {Name}.pdf
    pattern = re.compile(r"^Payslip [A-Z][a-z]{2}-\d{4} - .+\.pdf$")
    mismatched = [os.path.basename(p) for p in payslips if not pattern.match(os.path.basename(p))]
    assert not mismatched, f"Payslip filenames not matching pattern (first 5): {mismatched[:5]}"


# --- Test 7: Every PDF starts with %PDF magic bytes ---
def test_every_pdf_valid_magic(zip_file):
    pdfs = [n for n in zip_file.namelist() if n.lower().endswith(".pdf")]
    assert pdfs, "No PDFs in ZIP"
    bad = []
    for name in pdfs:
        with zip_file.open(name) as fh:
            head = fh.read(4)
        if head != b"%PDF":
            bad.append((name, head))
    assert not bad, f"PDFs with invalid magic bytes ({len(bad)}): {bad[:3]}"


# --- Test 8: 5 monthly merged invoice PDFs each 600+ pages ---
def test_merged_invoice_pdfs_page_counts(zip_file):
    import pypdf
    invoice_pdfs = [
        n for n in zip_file.namelist()
        if n.startswith("Systems/Customer Invoices/")
        and os.path.basename(n).startswith("invoices_")
        and n.lower().endswith(".pdf")
    ]
    assert len(invoice_pdfs) == 5, f"Expected 5 monthly invoice PDFs, got {len(invoice_pdfs)}: {invoice_pdfs}"
    low_page = []
    for name in invoice_pdfs:
        with zip_file.open(name) as fh:
            data = fh.read()
        reader = pypdf.PdfReader(io.BytesIO(data))
        pages = len(reader.pages)
        print(f"  {os.path.basename(name)}: {pages} pages")
        if pages < 600:
            low_page.append((name, pages))
    assert not low_page, f"Invoice PDFs below 600 pages: {low_page}"
