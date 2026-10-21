import React, { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Badge } from '../../components/ui/badge';
import { Switch } from '../../components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { Upload, FileSpreadsheet, CheckCircle, XCircle, Loader2, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const SHOWROOMS = [
  { value: 'gravesend', label: 'Gravesend' },
  { value: 'tonbridge', label: 'Tonbridge' },
  { value: 'sydenham', label: 'Sydenham' },
];

export default function StockImport() {
  const [showroom, setShowroom] = useState('');
  const [file, setFile] = useState(null);
  const [dryRun, setDryRun] = useState(true);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  const handleFileChange = (e) => {
    const selectedFile = e.target.files[0];
    if (selectedFile) {
      if (!selectedFile.name.endsWith('.xlsx')) {
        toast.error('Please upload an Excel file (.xlsx)');
        return;
      }
      setFile(selectedFile);
      setResult(null);
    }
  };

  const handleUpload = async () => {
    if (!showroom) {
      toast.error('Please select a showroom');
      return;
    }
    if (!file) {
      toast.error('Please select a file');
      return;
    }

    setLoading(true);
    setResult(null);

    try {
      const token = localStorage.getItem('token');
      
      if (!token) {
        toast.error('Session expired. Please login again.');
        window.location.href = '/login';
        return;
      }
      
      const formData = new FormData();
      formData.append('file', file);

      // Use XMLHttpRequest for maximum compatibility with file uploads
      const xhr = new XMLHttpRequest();
      
      const response = await new Promise((resolve, reject) => {
        xhr.open('POST', `${API_URL}/api/stock-import/upload?showroom=${showroom}&dry_run=${dryRun}`);
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.timeout = 120000;
        
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              resolve(JSON.parse(xhr.responseText));
            } catch (e) {
              reject(new Error('Invalid response from server'));
            }
          } else {
            try {
              const errorData = JSON.parse(xhr.responseText);
              reject(new Error(errorData.detail || 'Upload failed'));
            } catch (e) {
              reject(new Error(`Upload failed with status ${xhr.status}`));
            }
          }
        };
        
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.ontimeout = () => reject(new Error('Request timeout'));
        
        xhr.send(formData);
      });

      setResult(response);

      if (dryRun) {
        toast.success(`Preview: ${response.matched} products matched, ${response.not_found} not found`);
      } else {
        toast.success(`Updated ${response.updated} products in ${response.showroom}`);
      }
    } catch (error) {
      console.error('Stock import error:', error);
      toast.error('Failed: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container mx-auto py-6 space-y-6" data-testid="stock-import-page">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <FileSpreadsheet className="h-8 w-8 text-blue-600" />
          Stock Import
        </h1>
        <p className="text-muted-foreground">
          Upload stocktake spreadsheets to update showroom stock levels
        </p>
      </div>

      {/* Upload Form */}
      <Card>
        <CardHeader>
          <CardTitle>Upload Stocktake File</CardTitle>
          <CardDescription>
            Excel file should have columns: Supplier, Product, Size(s), Stock Available/Quantity, etc.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <Label htmlFor="showroom">Showroom</Label>
              <Select value={showroom} onValueChange={setShowroom}>
                <SelectTrigger id="showroom" data-testid="showroom-select">
                  <SelectValue placeholder="Select showroom" />
                </SelectTrigger>
                <SelectContent>
                  {SHOWROOMS.map(s => (
                    <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="file">Stocktake File (.xlsx)</Label>
              <Input
                id="file"
                type="file"
                accept=".xlsx"
                onChange={handleFileChange}
                data-testid="file-input"
              />
              {file && (
                <p className="text-sm text-muted-foreground">
                  Selected: {file.name}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between p-4 bg-amber-50 rounded-lg border border-amber-200">
            <div className="flex items-center gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-600" />
              <div>
                <p className="font-medium text-amber-800">Dry Run Mode</p>
                <p className="text-sm text-amber-600">
                  {dryRun 
                    ? "Preview changes without updating the database" 
                    : "Changes will be applied to the database"
                  }
                </p>
              </div>
            </div>
            <Switch
              checked={!dryRun}
              onCheckedChange={(checked) => setDryRun(!checked)}
              data-testid="dry-run-toggle"
            />
          </div>

          <Button 
            onClick={handleUpload} 
            disabled={loading || !showroom || !file}
            className="w-full"
            size="lg"
            data-testid="upload-button"
          >
            {loading ? (
              <>
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                Processing...
              </>
            ) : (
              <>
                <Upload className="mr-2 h-5 w-5" />
                {dryRun ? 'Preview Import' : 'Import Stock'}
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Results */}
      {result && (
        <div className="space-y-4">
          {/* Summary */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {result.dry_run ? (
                  <AlertTriangle className="h-5 w-5 text-amber-600" />
                ) : (
                  <CheckCircle className="h-5 w-5 text-green-600" />
                )}
                {result.dry_run ? 'Preview Results' : 'Import Complete'}
              </CardTitle>
              <CardDescription>
                {result.showroom} - {result.file_name}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="text-center p-4 bg-slate-50 rounded-lg">
                  <p className="text-2xl font-bold">{result.total_items_in_file}</p>
                  <p className="text-sm text-muted-foreground">Items in File</p>
                </div>
                <div className="text-center p-4 bg-green-50 rounded-lg">
                  <p className="text-2xl font-bold text-green-600">{result.matched}</p>
                  <p className="text-sm text-muted-foreground">Matched</p>
                </div>
                <div className="text-center p-4 bg-red-50 rounded-lg">
                  <p className="text-2xl font-bold text-red-600">{result.not_found}</p>
                  <p className="text-sm text-muted-foreground">Not Found</p>
                </div>
                <div className="text-center p-4 bg-blue-50 rounded-lg">
                  <p className="text-2xl font-bold text-blue-600">{result.updated}</p>
                  <p className="text-sm text-muted-foreground">Updated</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Matched Products */}
          {result.updates_preview && result.updates_preview.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <CheckCircle className="h-5 w-5 text-green-600" />
                  Matched Products ({result.matched})
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="max-h-96 overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>SKU</TableHead>
                        <TableHead>DB Product</TableHead>
                        <TableHead>Stocktake Product</TableHead>
                        <TableHead className="text-center">Size</TableHead>
                        <TableHead className="text-center">New Stock</TableHead>
                        <TableHead>Match</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {result.updates_preview.map((u, idx) => (
                        <TableRow key={idx}>
                          <TableCell className="font-mono text-xs">{u.product_sku}</TableCell>
                          <TableCell className="max-w-[200px] truncate" title={u.product_name}>
                            {u.product_name}
                          </TableCell>
                          <TableCell className="max-w-[200px] truncate" title={u.stocktake_name}>
                            {u.stocktake_name}
                          </TableCell>
                          <TableCell className="text-center">
                            <Badge variant="outline">{u.stocktake_size || '-'}</Badge>
                          </TableCell>
                          <TableCell className="text-center">
                            <Badge className="bg-green-600">{u.new_stock}</Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant="secondary" className="text-xs">
                              {u.match_method}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Not Found Products */}
          {result.not_found_items && result.not_found_items.length > 0 && (
            <Card className="border-red-200">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-red-600">
                  <XCircle className="h-5 w-5" />
                  Not Found in Database ({result.not_found})
                </CardTitle>
                <CardDescription>
                  These products from the stocktake file could not be matched to existing products
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <div className="max-h-64 overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Supplier</TableHead>
                        <TableHead>Product</TableHead>
                        <TableHead className="text-center">Size</TableHead>
                        <TableHead className="text-center">Stock</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {result.not_found_items.map((item, idx) => (
                        <TableRow key={idx} className="bg-red-50/50">
                          <TableCell>{item.supplier}</TableCell>
                          <TableCell>{item.product}</TableCell>
                          <TableCell className="text-center">{item.size || '-'}</TableCell>
                          <TableCell className="text-center">{item.stock}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
