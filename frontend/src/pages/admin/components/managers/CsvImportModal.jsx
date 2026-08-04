/**
 * CsvImportModal — category-tailored bulk CSV import for a Manager.
 *
 * Flow:
 *   1. Download the CSV template button (opens category-specific /csv-template)
 *   2. Drag-drop or Choose file
 *   3. "Preview" runs dry_run=true → shows created/updated counts + first N rows
 *   4. "Import" runs dry_run=false → same endpoint writes to DB
 *   5. Per-row status shown after import (CREATE / UPDATE / SKIPPED / ERROR)
 */

import React, { useState, useRef } from 'react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '../../../../components/ui/dialog';
import { Button } from '../../../../components/ui/button';
import { Badge } from '../../../../components/ui/badge';
import {
  Upload, Download, FileSpreadsheet, RefreshCw, CheckCircle, AlertCircle, X, Sparkles,
} from 'lucide-react';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const CsvImportModal = ({ open, onOpenChange, category, categoryLabel, themeColor = 'orange', onSuccess }) => {
  const [file, setFile] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [previewData, setPreviewData] = useState(null);
  const [importData, setImportData] = useState(null);
  const [running, setRunning] = useState(false);
  const inputRef = useRef(null);

  const themeBtn = {
    orange: 'bg-orange-600 hover:bg-orange-700 text-white',
    blue:   'bg-blue-600   hover:bg-blue-700   text-white',
    amber:  'bg-amber-600  hover:bg-amber-700  text-white',
    cyan:   'bg-cyan-600   hover:bg-cyan-700   text-white',
    red:    'bg-red-600    hover:bg-red-700    text-white',
    slate:  'bg-slate-700  hover:bg-slate-800  text-white',
    purple: 'bg-purple-600 hover:bg-purple-700 text-white',
  }[themeColor] || 'bg-orange-600 hover:bg-orange-700 text-white';

  const reset = () => {
    setFile(null); setPreviewData(null); setImportData(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  const handleFile = (f) => {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith('.csv')) {
      toast.error('Please upload a .csv file');
      return;
    }
    setFile(f);
    setPreviewData(null);
    setImportData(null);
  };

  const downloadTemplate = async () => {
    try {
      const res = await fetch(`${API_URL}/api/managers/${encodeURIComponent(category)}/csv-template`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${category}-import-template.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success('Template downloaded');
    } catch (err) {
      toast.error(`Template download failed: ${err.message}`);
    }
  };

  const runImport = async (dryRun) => {
    if (!file) { toast.error('Choose a CSV file first'); return; }
    setRunning(true);
    try {
      const token = localStorage.getItem('token');
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`${API_URL}/api/managers/${encodeURIComponent(category)}/csv-import?dry_run=${dryRun ? 'true' : 'false'}`, {
        method: 'POST',
        body: fd,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (dryRun) {
        setPreviewData(data);
        toast.success(`Preview ready — ${data.total_rows} row(s) parsed`);
      } else {
        setImportData(data);
        toast.success(`Imported: ${data.created} new + ${data.updated} updated${data.errors?.length > 0 ? ` (${data.errors.length} errors)` : ''}`);
        if (onSuccess) onSuccess(data);
      }
    } catch (err) {
      toast.error(`Import failed: ${err.message}`);
    } finally {
      setRunning(false);
    }
  };

  const currentData = importData || previewData;
  const isImported = !!importData;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!running) { onOpenChange(o); if (!o) reset(); } }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto" data-testid="csv-import-modal">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="w-5 h-5 text-emerald-600" />
            CSV Import — {categoryLabel || category}
          </DialogTitle>
          <p className="text-xs text-gray-500">
            Drop a CSV to preview + import products in bulk. Columns match this Manager&rsquo;s fields — download the template if you need the exact headers.
          </p>
        </DialogHeader>

        {/* Step 1: template */}
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 flex items-center gap-3">
          <Sparkles className="w-4 h-4 text-emerald-600 flex-shrink-0" />
          <div className="flex-1 text-xs text-emerald-800">
            <div className="font-medium">Not sure about the columns?</div>
            <div>Download the {categoryLabel || category} CSV template — it includes an example row you can copy.</div>
          </div>
          <Button size="sm" variant="outline" onClick={downloadTemplate} data-testid="csv-download-template">
            <Download className="w-4 h-4 mr-1" /> Template
          </Button>
        </div>

        {/* Step 2: file drop-zone */}
        <div
          className={`mt-3 border-2 border-dashed rounded-lg p-6 text-center transition ${
            dragOver ? 'border-emerald-500 bg-emerald-50' : 'border-gray-300 bg-gray-50'
          }`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]); }}
          data-testid="csv-dropzone"
        >
          <Upload className="w-8 h-8 mx-auto text-gray-400" />
          <p className="text-sm text-gray-700 mt-2">
            {file ? (
              <span className="font-medium">{file.name} <span className="text-gray-500">({(file.size / 1024).toFixed(1)} KB)</span></span>
            ) : (
              <>Drop a .csv file here or <button onClick={() => inputRef.current?.click()} className="text-blue-600 underline">choose one</button></>
            )}
          </p>
          <input
            ref={inputRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={(e) => handleFile(e.target.files[0])}
            data-testid="csv-file-input"
          />
          {file && (
            <button onClick={reset} className="mt-2 text-xs text-red-500 hover:text-red-700 flex items-center gap-1 mx-auto">
              <X className="w-3 h-3" /> Remove
            </button>
          )}
        </div>

        {/* Step 3: preview / import results */}
        {currentData && (
          <div className="mt-3 border border-gray-200 rounded-lg overflow-hidden">
            <div className="bg-gray-50 border-b border-gray-200 p-2 flex items-center gap-3 text-xs">
              <span className="font-medium text-gray-700">
                {isImported ? 'Import result' : 'Preview'} · {currentData.total_rows} row(s)
              </span>
              <Badge className="bg-emerald-100 text-emerald-800 text-[10px]">
                <CheckCircle className="w-2.5 h-2.5 mr-0.5" /> {currentData.created} created
              </Badge>
              <Badge className="bg-blue-100 text-blue-800 text-[10px]">
                {currentData.updated} updated
              </Badge>
              {currentData.skipped > 0 && (
                <Badge className="bg-yellow-100 text-yellow-800 text-[10px]">{currentData.skipped} skipped</Badge>
              )}
              {currentData.errors?.length > 0 && (
                <Badge className="bg-red-100 text-red-800 text-[10px]">
                  <AlertCircle className="w-2.5 h-2.5 mr-0.5" /> {currentData.errors.length} errors
                </Badge>
              )}
            </div>

            {currentData.errors?.length > 0 && (
              <div className="bg-red-50 border-b border-red-100 p-2 max-h-24 overflow-y-auto">
                {currentData.errors.slice(0, 10).map((e, i) => (
                  <div key={i} className="text-[11px] text-red-700 flex gap-2">
                    <span className="font-mono">Row {e.row}</span>
                    <span>—</span>
                    <span>{e.error}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="max-h-64 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 border-b border-gray-200 sticky top-0">
                  <tr>
                    <th className="px-2 py-1 text-left text-gray-600 font-medium">#</th>
                    <th className="px-2 py-1 text-left text-gray-600 font-medium">SKU</th>
                    <th className="px-2 py-1 text-left text-gray-600 font-medium">Supplier</th>
                    <th className="px-2 py-1 text-left text-gray-600 font-medium">Product Name</th>
                    <th className="px-2 py-1 text-left text-gray-600 font-medium">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {(currentData.preview || []).map(row => (
                    <tr key={row.row} className="border-b border-gray-100" data-testid={`csv-preview-row-${row.row}`}>
                      <td className="px-2 py-1 text-gray-500">{row.row}</td>
                      <td className="px-2 py-1 font-mono">{row.sku}</td>
                      <td className="px-2 py-1">{row.supplier}</td>
                      <td className="px-2 py-1 truncate max-w-[200px]">{row.our_product_name}</td>
                      <td className="px-2 py-1">
                        <Badge
                          variant="outline"
                          className={`text-[10px] py-0 ${
                            row.action === 'CREATE' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
                            row.action === 'UPDATE' ? 'bg-blue-50 text-blue-700 border-blue-200' :
                            'bg-gray-50 text-gray-500 border-gray-200'
                          }`}
                        >
                          {row.action || '—'}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <DialogFooter>
          {isImported ? (
            <Button onClick={() => { reset(); onOpenChange(false); }} className={themeBtn}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={running}>Cancel</Button>
              <Button
                variant="outline"
                onClick={() => runImport(true)}
                disabled={!file || running}
                data-testid="csv-preview-btn"
              >
                {running && !previewData ? <RefreshCw className="w-4 h-4 mr-1 animate-spin" /> : null}
                Preview
              </Button>
              <Button
                onClick={() => runImport(false)}
                disabled={!file || running || !previewData}
                className={themeBtn}
                data-testid="csv-import-btn"
              >
                {running && previewData ? <RefreshCw className="w-4 h-4 mr-1 animate-spin" /> : <Upload className="w-4 h-4 mr-1" />}
                Import {previewData ? `${previewData.total_rows} row(s)` : ''}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default CsvImportModal;
