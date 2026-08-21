import React from 'react';
import { Plus, Trash2, Calendar, CreditCard, StickyNote, Lock } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

const paymentMethodOptions = ['Card', 'Cash', 'Bank Transfer', 'Link Payment', 'Online', 'Cheque'];

export const InvoiceDepositsSection = ({
  deposits,
  totals,
  onAddDeposit,
  onUpdateDeposit,
  onRemoveDeposit,
  applyVat = true,
  onToggleVat = null,
  cashOnly = false,  // When true, locks payment method to "Cash" only (for Cash Quotation conversions)
  isSuperAdmin = false  // Only show VAT toggle for super admin
}) => {
  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-lg">Payments Received</h3>
          {/* Cash Only Badge - shown for Cash Quotation conversions */}
          {cashOnly && (
            <span className="px-3 py-1 bg-green-100 text-green-800 rounded-full text-sm font-medium flex items-center gap-1" data-testid="cash-only-badge">
              <Lock className="h-3 w-3" />
              Cash Only
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {/* VAT Toggle - only show if onToggleVat is provided, not cashOnly, and user is super admin */}
          {onToggleVat && !cashOnly && isSuperAdmin && (
            <label className="flex items-center gap-2 cursor-pointer" data-testid="vat-toggle">
              <input
                type="checkbox"
                checked={applyVat}
                onChange={(e) => onToggleVat(e.target.checked)}
                className="w-4 h-4 accent-blue-600"
              />
              <span className="text-sm text-gray-600">Apply VAT (20%)</span>
            </label>
          )}
          {/* No VAT indicator when VAT is disabled */}
          {!applyVat && !onToggleVat && (
            <span className="px-3 py-1 bg-gray-100 text-gray-600 rounded-full text-sm font-medium" data-testid="no-vat-badge">
              No VAT Applied
            </span>
          )}
          {/* Cash Quotation - No VAT indicator */}
          {cashOnly && (
            <span className="px-3 py-1 bg-gray-100 text-gray-600 rounded-full text-sm font-medium" data-testid="no-vat-badge">
              No VAT (Cash Quotation)
            </span>
          )}
          {/* Deposit Order Status Badge */}
          {totals.amountOutstanding > 0 && totals.totalDeposits > 0 && (
            <span className="px-3 py-1 bg-amber-100 text-amber-800 rounded-full text-sm font-medium flex items-center gap-1" data-testid="deposit-order-badge">
              <span className="w-2 h-2 bg-amber-500 rounded-full"></span>
              Deposit Order
            </span>
          )}
          <Button type="button" variant="outline" size="sm" onClick={onAddDeposit} data-testid="add-deposit-btn">
            <Plus className="h-4 w-4 mr-1" />
            Add Payment
          </Button>
        </div>
      </div>
      
      {/* Payment rows header */}
      <div className="hidden md:grid md:grid-cols-12 gap-2 px-3 py-2 bg-gray-100 rounded-t-lg text-xs font-medium text-gray-600">
        <div className="col-span-3 flex items-center gap-1">
          <Calendar className="h-3 w-3" /> Payment Date
        </div>
        <div className="col-span-3 flex items-center gap-1">
          <CreditCard className="h-3 w-3" /> Payment Method *
        </div>
        <div className="col-span-3">Amount (£) *</div>
        <div className="col-span-2 flex items-center gap-1">
          <StickyNote className="h-3 w-3" /> Note
        </div>
        <div className="col-span-1"></div>
      </div>
      
      <div className="space-y-2 border border-t-0 rounded-b-lg p-2">
        {deposits.map((deposit, index) => (
          <div key={index} className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center p-2 bg-gray-50 rounded-lg" data-testid={`deposit-row-${index}`}>
            <div className="col-span-3">
              <label className="text-xs text-muted-foreground md:hidden">Payment Date</label>
              <Input
                type="text"
                value={deposit.date}
                onChange={(e) => onUpdateDeposit(index, 'date', e.target.value)}
                placeholder="DD/MM/YYYY"
                className="h-9"
                data-testid={`deposit-date-${index}`}
              />
            </div>
            <div className="col-span-3">
              <label className="text-xs text-muted-foreground md:hidden">Payment Method *</label>
              {cashOnly ? (
                /* Locked to Cash Only for Cash Quotation conversions */
                <div className="relative">
                  <select
                    className="w-full px-3 py-2 h-9 border rounded-md text-sm bg-gray-100 cursor-not-allowed"
                    value="Cash"
                    disabled
                    data-testid={`deposit-method-locked-${index}`}
                  >
                    <option value="Cash">Cash</option>
                  </select>
                  <Lock className="absolute right-8 top-1/2 -translate-y-1/2 h-3 w-3 text-gray-500" />
                </div>
              ) : (
                /* Normal payment method dropdown */
                <select
                  className={`w-full px-3 py-2 h-9 border rounded-md text-sm bg-white ${!deposit.method ? 'border-red-300' : ''}`}
                  value={deposit.method || ''}
                  onChange={(e) => {
                    onUpdateDeposit(index, 'method', e.target.value);
                    // Do NOT copy method to note - note is for user notes only
                  }}
                  required
                  data-testid={`deposit-method-${index}`}
                >
                  <option value="">Select Method *</option>
                  {paymentMethodOptions.map(method => (
                    <option key={method} value={method}>{method}</option>
                  ))}
                </select>
              )}
            </div>
            <div className="col-span-3">
              <label className="text-xs text-muted-foreground md:hidden">Amount (£) *</label>
              <Input
                type="number"
                step="0.01"
                value={deposit.amount}
                onChange={(e) => onUpdateDeposit(index, 'amount', e.target.value)}
                placeholder="0.00"
                className="h-9"
                data-testid={`deposit-amount-${index}`}
              />
            </div>
            <div className="col-span-2">
              <label className="text-xs text-muted-foreground md:hidden">Note</label>
              <Input
                type="text"
                value={deposit.customNote || ''}
                onChange={(e) => onUpdateDeposit(index, 'customNote', e.target.value)}
                placeholder="Optional note"
                className="h-9"
                data-testid={`deposit-note-${index}`}
              />
            </div>
            <div className="col-span-1 flex justify-center">
              <button
                type="button"
                onClick={() => onRemoveDeposit(index)}
                className="p-2 text-red-500 hover:bg-red-50 rounded"
                title="Remove payment"
                data-testid={`remove-deposit-${index}`}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Summary */}
      <div className="mt-4 grid grid-cols-4 gap-4">
        <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
          <p className="text-xs text-green-700 font-medium">Total Received</p>
          <p className="text-xl font-bold text-green-800">£{totals.totalDeposits.toFixed(2)}</p>
          {totals.creditRedeemed > 0 && (
            <p className="text-[10px] text-emerald-700 mt-0.5" data-testid="deposits-credit-applied-line">
              + £{totals.creditRedeemed.toFixed(2)} trade credit
            </p>
          )}
        </div>
        <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg">
          <p className="text-xs text-gray-600 font-medium">Subtotal</p>
          <p className="text-lg font-bold text-gray-800">£{totals.totalDue.toFixed(2)}</p>
          {applyVat ? (
            <p className="text-xs text-gray-500">+ VAT (20%): £{totals.vat.toFixed(2)}</p>
          ) : (
            <p className="text-xs text-gray-400">No VAT</p>
          )}
        </div>
        <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
          <p className="text-xs text-blue-700 font-medium">Invoice Total</p>
          <p className="text-xl font-bold text-blue-800">£{totals.grossTotal.toFixed(2)}</p>
        </div>
        <div className={`p-3 rounded-lg ${totals.amountOutstanding > 0 ? 'bg-amber-50 border border-amber-200' : 'bg-gray-50 border border-gray-200'}`}>
          <p className={`text-xs font-medium ${totals.amountOutstanding > 0 ? 'text-amber-700' : 'text-gray-600'}`}>Amount Outstanding</p>
          <p className={`text-xl font-bold ${totals.amountOutstanding > 0 ? 'text-amber-800' : 'text-gray-800'}`}>£{totals.amountOutstanding.toFixed(2)}</p>
        </div>
      </div>
    </div>
  );
};
