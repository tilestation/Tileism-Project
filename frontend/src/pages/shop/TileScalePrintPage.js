import React, { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { parseSizeToMm } from '../../utils/sizePill';

/**
 * Printable to-scale tile cheat-sheet.
 * Renders the selected tile at 1:1 physical scale across one or more A4
 * portrait pages with crop marks and a verification ruler. Browser print
 * dialog handles the actual PDF export ("Save as PDF").
 *
 * URL: /shop/tile-scale-print/:size?series=...&color=...&trade=name
 * Example: /shop/tile-scale-print/30x60cm?series=Ridgeway&color=Polished
 *
 * Usable area on A4 (210x297mm) with 10mm margins = 190x277mm per page.
 */

const PAGE_W_MM = 210;
const PAGE_H_MM = 297;
const MARGIN_MM = 10;
const USABLE_W = PAGE_W_MM - 2 * MARGIN_MM;
const USABLE_H = PAGE_H_MM - 2 * MARGIN_MM - 25; // reserve space for header + verification ruler

function PrintStyles() {
  return (
    <style>{`
      @page { size: A4 portrait; margin: 0; }
      @media print {
        body { margin: 0 !important; background: #fff !important; }
        .no-print { display: none !important; }
        .scale-page { page-break-after: always; box-shadow: none !important; margin: 0 !important; }
        .scale-page:last-child { page-break-after: auto; }
      }
      body { background: #f0f0f0; margin: 0; font-family: 'Inter', Arial, sans-serif; }
      .scale-page {
        position: relative;
        width: ${PAGE_W_MM}mm;
        height: ${PAGE_H_MM}mm;
        background: #fff;
        margin: 12mm auto;
        box-shadow: 0 2mm 8mm rgba(0,0,0,.1);
        overflow: hidden;
        page-break-after: always;
      }
      .crop { position: absolute; width: 6mm; height: 6mm; }
      .crop.tl { top: 4mm; left: 4mm; border-left: 0.3mm solid #555; border-top: 0.3mm solid #555; }
      .crop.tr { top: 4mm; right: 4mm; border-right: 0.3mm solid #555; border-top: 0.3mm solid #555; }
      .crop.bl { bottom: 4mm; left: 4mm; border-left: 0.3mm solid #555; border-bottom: 0.3mm solid #555; }
      .crop.br { bottom: 4mm; right: 4mm; border-right: 0.3mm solid #555; border-bottom: 0.3mm solid #555; }
      .header {
        position: absolute;
        top: ${MARGIN_MM}mm;
        left: ${MARGIN_MM}mm;
        right: ${MARGIN_MM}mm;
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        font-size: 3mm;
        color: #333;
        border-bottom: 0.2mm solid #ccc;
        padding-bottom: 1.5mm;
      }
      .header .title { font-weight: 700; font-size: 3.5mm; }
      .header .meta { font-family: monospace; color: #666; font-size: 2.5mm; }
      .tile-area {
        position: absolute;
        top: ${MARGIN_MM + 8}mm;
        left: ${MARGIN_MM}mm;
        width: ${USABLE_W}mm;
        height: ${USABLE_H}mm;
        overflow: hidden;
      }
      .tile {
        background: linear-gradient(135deg, #f3efe7 0%, #e8e1d3 100%);
        border: 0.2mm solid #999;
        position: absolute;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 4mm;
        color: #888;
        font-weight: 600;
        letter-spacing: 0.5mm;
      }
      .ruler {
        position: absolute;
        bottom: ${MARGIN_MM + 4}mm;
        left: ${MARGIN_MM}mm;
        right: ${MARGIN_MM}mm;
        display: flex;
        align-items: center;
        gap: 2mm;
        font-size: 2.4mm;
        color: #555;
      }
      .ruler-bar {
        width: 100mm;
        height: 5mm;
        position: relative;
        border: 0.2mm solid #555;
      }
      .ruler-bar::before {
        content: '';
        position: absolute;
        inset: 0;
        background-image: repeating-linear-gradient(90deg, #555 0 0.2mm, transparent 0.2mm 10mm);
      }
      .ruler-bar::after {
        content: '0           10           20           30           40           50           60           70           80           90          100';
        position: absolute;
        bottom: -3.5mm;
        left: -1mm;
        right: -1mm;
        font-size: 2mm;
        font-family: monospace;
        color: #555;
        white-space: pre;
      }
      .ruler-label { font-weight: 600; }
      .ruler-warning { font-size: 2.2mm; color: #b45309; font-style: italic; }
      .footer {
        position: absolute;
        bottom: 4mm;
        left: ${MARGIN_MM}mm;
        right: ${MARGIN_MM}mm;
        font-size: 2.2mm;
        color: #999;
        text-align: center;
        font-family: monospace;
      }
      .controls {
        position: fixed;
        top: 12px;
        right: 12px;
        background: #fff;
        border: 1px solid #d4d4d4;
        border-radius: 8px;
        padding: 12px 16px;
        box-shadow: 0 4px 12px rgba(0,0,0,.1);
        z-index: 1000;
        font-size: 13px;
        max-width: 320px;
      }
      .controls h3 { font-size: 14px; margin: 0 0 6px; font-weight: 700; }
      .controls p { margin: 4px 0; color: #555; line-height: 1.4; }
      .controls button {
        margin-top: 8px;
        background: #f59e0b;
        color: #fff;
        border: 0;
        padding: 8px 14px;
        border-radius: 6px;
        font-weight: 600;
        cursor: pointer;
        font-size: 13px;
      }
      .controls button:hover { background: #d97706; }
      .controls .tip { font-size: 11px; color: #888; margin-top: 6px; }
    `}</style>
  );
}

const TileScalePrintPage = () => {
  const { size: rawSize } = useParams();
  const [searchParams] = useSearchParams();
  const series = searchParams.get('series') || '';
  const color = searchParams.get('color') || '';
  const trade = searchParams.get('trade') || '';
  // Default: single-page corner view (most customers just want to feel the scale).
  // ?full=1 forces the multi-page tile-across-sheets layout.
  const [fullMode, setFullMode] = useState(searchParams.get('full') === '1');

  const dimsMm = useMemo(() => {
    const d = parseSizeToMm(rawSize);
    if (!d) return null;
    // Orient long side horizontal so wide tiles print landscape-ish across page width
    return [Math.max(d[0], d[1]), Math.min(d[0], d[1])];
  }, [rawSize]);

  // Compute how many A4 pages we need to fit the tile at 1:1.
  const layout = useMemo(() => {
    if (!dimsMm) return null;
    const [tileW, tileH] = dimsMm;
    if (!fullMode) {
      // Single page — clip the visible window to USABLE area, no multi-page tiling.
      return { tileW, tileH, cols: 1, rows: 1, totalPages: 1, isClipped: tileW > USABLE_W || tileH > USABLE_H };
    }
    const cols = Math.max(1, Math.ceil(tileW / USABLE_W));
    const rows = Math.max(1, Math.ceil(tileH / USABLE_H));
    return { tileW, tileH, cols, rows, totalPages: cols * rows, isClipped: false };
  }, [dimsMm, fullMode]);

  // Auto-trigger print dialog when ?print=1
  useEffect(() => {
    if (searchParams.get('print') === '1') {
      const t = setTimeout(() => window.print(), 600);
      return () => clearTimeout(t);
    }
  }, [searchParams]);

  if (!dimsMm || !layout) {
    return (
      <div style={{ padding: 40, fontFamily: 'Inter, Arial, sans-serif' }}>
        <h1>Cannot print this size</h1>
        <p>Size "{rawSize}" could not be parsed. Expected format like "30x60cm" or "300x600mm".</p>
        {/* Always render a back-link — even on the error page — so
            Ahrefs never flags this URL as "no outgoing links". */}
        <p style={{ marginTop: 16, fontSize: 14 }}>
          <Link
            to={series ? `/shop/series/${encodeURIComponent(series)}` : '/shop'}
            style={{ color: '#0E5C99', textDecoration: 'underline' }}
            data-testid="scale-print-back-link"
          >
            ← Back to {series ? `${series}${color ? ` · ${color}` : ''}` : 'shop'}
          </Link>
        </p>
      </div>
    );
  }

  const { tileW, tileH, cols, rows, isClipped } = layout;
  const totalPages = cols * rows;

  // Generate one page per (col, row) — clipping the tile to that section
  const pages = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      pages.push({
        c,
        r,
        // offset into tile in mm
        xOffset: -c * USABLE_W,
        yOffset: -r * USABLE_H,
        pageNum: r * cols + c + 1,
      });
    }
  }

  return (
    <>
      <PrintStyles />
      <div className="controls no-print" data-testid="scale-print-controls">
        <h3>Print at 100% scale</h3>
        {/* 31 May 2026 — back-link added to clear Ahrefs "no outgoing
            links" warning on the 17 indexed /shop/tile-scale-print
            URLs. The series link is the obvious natural target;
            falls back to the main shop if `series` is missing. */}
        <div style={{ marginBottom: 10, fontSize: 12 }} data-testid="scale-print-back-link-wrap">
          <Link
            to={series ? `/shop/series/${encodeURIComponent(series)}` : '/shop'}
            style={{ color: '#0E5C99', textDecoration: 'underline' }}
            data-testid="scale-print-back-link"
          >
            ← Back to {series ? `${series}${color ? ` · ${color}` : ''}` : 'shop'}
          </Link>
        </div>
        <p>1. Click <strong>Print</strong> below.</p>
        <p>2. Set <strong>Scale: 100%</strong> (or <strong>Default</strong>) — <strong>NOT</strong> "Fit to page".</p>
        <p>3. Choose <strong>"Save as PDF"</strong> as the destination.</p>
        <p>4. After printing, hold a ruler against the verification bar — it should read exactly 100mm.</p>
        <button onClick={() => window.print()} data-testid="trigger-print-btn">Print / Save as PDF</button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, fontSize: 12, color: '#555', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={fullMode}
            onChange={(e) => setFullMode(e.target.checked)}
            data-testid="full-tile-mode-checkbox"
            style={{ cursor: 'pointer' }}
          />
          Print full tile across {dimsMm ? Math.max(1, Math.ceil(dimsMm[0] / USABLE_W)) * Math.max(1, Math.ceil(dimsMm[1] / USABLE_H)) : '?'} pages
        </label>
        <div className="tip">
          {fullMode
            ? `${totalPages} A4 page${totalPages > 1 ? 's' : ''} · ${tileW}×${tileH} mm tile`
            : `1 A4 page · ${isClipped ? `${USABLE_W}×${USABLE_H} mm corner of ${tileW}×${tileH} mm tile` : `Full ${tileW}×${tileH} mm tile`}`}
        </div>
      </div>

      {pages.map(({ c, r, xOffset, yOffset, pageNum }) => (
        <div key={`${c}-${r}`} className="scale-page">
          <div className="crop tl"></div>
          <div className="crop tr"></div>
          <div className="crop bl"></div>
          <div className="crop br"></div>

          <div className="header">
            <div>
              <div className="title">{series || 'Tile'} {color ? `· ${color}` : ''} · {rawSize}</div>
              {trade && <div style={{ fontSize: '2.5mm', color: '#666' }}>Quoted for: {trade}</div>}
            </div>
            <div className="meta">
              Page {pageNum} of {totalPages}
              {totalPages > 1 ? ` · row ${r + 1}, col ${c + 1}` : ''}
            </div>
          </div>

          <div className="tile-area">
            <div
              className="tile"
              style={{
                width: `${tileW}mm`,
                height: `${tileH}mm`,
                left: `${xOffset}mm`,
                top: `${yOffset}mm`,
              }}
            >
              {tileW}×{tileH} mm
            </div>
          </div>

          <div className="ruler">
            <span className="ruler-label">Verify scale →</span>
            <div className="ruler-bar"></div>
            <span className="ruler-warning">Ruler must read 100 mm. If not, reprint at 100% scale.</span>
          </div>

          <div className="footer">
            tilestation.co.uk · Print at 100% · {fullMode
              ? (totalPages > 1 ? `Tape pages along crop marks · Sheet ${pageNum}/${totalPages}` : 'Single sheet')
              : (isClipped ? 'Showing corner of tile · Use "Print full tile" for complete layout' : 'Full tile on one page')}
          </div>
        </div>
      ))}
    </>
  );
};

export default TileScalePrintPage;
