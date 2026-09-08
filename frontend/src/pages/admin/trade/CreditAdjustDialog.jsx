import React, { useState } from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../../../components/ui/dialog';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { Textarea } from '../../../components/ui/textarea';
import { api } from '../../../lib/api';
import { fmtGBP } from './tradeFormat';

export const CreditAdjustDialog = ({ open, onOpenChange, trader, onDone }) => {
  const [direction, setDirection] = useState('add');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [notify, setNotify] = useState(false);
  const [saving, setSaving] = useState(false);

  const balance = Number(trader?.credit_balance) || 0;
  const value = Number(amount) || 0;
  const signed = direction === 'add' ? value : -value;
  const after = Math.round((balance + signed) * 100) / 100;

  const submit = async () => {
    if (value <= 0) { toast.error('Enter an amount greater than £0'); return; }
    if (reason.trim().length < 3) { toast.error('Give a reason — it appears on the ledger'); return; }
    if (after < 0) { toast.error(`Balance can't go below £0 (currently ${fmtGBP(balance)})`); return; }
    setSaving(true);
    try {
      const { data } = await api.adjustTraderCredit(trader.id, { amount: signed, reason: reason.trim(), reference: reference.trim() || null, notify_customer: notify });
      toast.success(`${direction === 'add' ? 'Added' : 'Removed'} ${fmtGBP(value)} — balance now ${fmtGBP(data.balance_after)}`);
      setAmount(''); setReason(''); setReference(''); setNotify(false);
      onOpenChange(false);
      onDone?.(data);
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Adjustment failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="credit-adjust-dialog">
        <DialogHeader>
          <DialogTitle>Adjust trade credit</DialogTitle>
          <DialogDescription>
            {trader?.business_name || trader?.name} · #{trader?.trade_account_number} · balance {fmtGBP(balance)}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <Button type="button" variant={direction === 'add' ? 'default' : 'outline'} onClick={() => setDirection('add')} data-testid="adjust-direction-add">+ Add credit</Button>
            <Button type="button" variant={direction === 'remove' ? 'destructive' : 'outline'} onClick={() => setDirection('remove')} data-testid="adjust-direction-remove">− Remove credit</Button>
          </div>
          <div>
            <Label htmlFor="adj-amount">Amount (£)</Label>
            <Input id="adj-amount" type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" data-testid="adjust-amount-input" />
          </div>
          <div>
            <Label htmlFor="adj-reason">Reason (shown on the trader's statement)</Label>
            <Textarea id="adj-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Refund on INV-2041 — credit clawed back" data-testid="adjust-reason-input" />
          </div>
          <div>
            <Label htmlFor="adj-ref">Reference (invoice / order / refund no.) — optional</Label>
            <Input id="adj-ref" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="INV-2041" data-testid="adjust-reference-input" />
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="accent-emerald-600" data-testid="adjust-notify-checkbox" />
            Email the trader about this change
          </label>
          <div className="rounded-md bg-gray-50 border p-3 text-sm flex justify-between">
            <span className="text-gray-500">New balance</span>
            <span className={`font-semibold ${after < 0 ? 'text-rose-600' : 'text-gray-900'}`} data-testid="adjust-new-balance">{fmtGBP(after)}</span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={saving} data-testid="adjust-submit">{saving ? 'Saving…' : 'Apply adjustment'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
