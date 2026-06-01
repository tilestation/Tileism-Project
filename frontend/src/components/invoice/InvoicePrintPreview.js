import React from 'react';

// Capitalize first letter of every word (Title Case)
const toTitleCase = (str) => {
  if (!str) return '';
  return str.replace(/\b\w/g, char => char.toUpperCase());
};

export const InvoicePrintPreview = ({
  printRef,
  invoiceData,
  totals,
  calculateLineTotal
}) => {
  return (
    <div ref={printRef} className="bg-white p-8 border rounded-lg" style={{ maxWidth: '850px', margin: '0 auto' }}>
      {/* Invoice Header */}
      <div className="flex justify-between items-start mb-4">
        {/* Invoice Title - Large Left */}
        <div>
          <h1 className="text-4xl font-bold" style={{ fontFamily: 'Georgia, serif' }}>Invoice</h1>
          <div className="mt-2 px-3 py-1 bg-gray-100 border border-gray-300 inline-block rounded">
            <span className="text-lg font-bold" style={{ color: '#000' }}>
              No: {invoiceData.invoiceNo}
            </span>
          </div>
        </div>
        
        {/* Company Details - Right */}
        <div className="text-right text-xs leading-relaxed">
          <p className="font-semibold">{invoiceData.date} {invoiceData.time}</p>
          <p className="font-bold text-sm mt-1">{invoiceData.companyInfo.name}</p>
          <p>{invoiceData.companyInfo.address}</p>
          <p>{invoiceData.companyInfo.city}</p>
          <p>Telephone: {invoiceData.companyInfo.telephone}</p>
          <p>E-mail: {invoiceData.companyInfo.email}</p>
          <p>Company No. {invoiceData.companyInfo.companyNo} / VAT No. {invoiceData.companyInfo.vatNo}</p>
        </div>
      </div>

      {/* Large Logo */}
      <div className="mb-4">
        <h2 className="text-4xl font-black tracking-wider" style={{ 
          fontFamily: 'Impact, Arial Black, sans-serif',
          letterSpacing: '4px'
        }}>
          TILE STATION
        </h2>
      </div>

      {/* Invoice Table */}
      <table className="w-full border-collapse mb-4" style={{ fontSize: '11px' }}>
        <thead>
          <tr style={{ backgroundColor: '#000', color: '#fff' }}>
            <th className="border border-gray-400 px-2 py-2 text-center" style={{ width: '50px' }}>Qty</th>
            <th className="border border-gray-400 px-2 py-2 text-center" style={{ width: '35px' }}>m²</th>
            <th className="border border-gray-400 px-2 py-2 text-left">Product</th>
            <th className="border border-gray-400 px-2 py-2 text-right" style={{ width: '60px' }}>List Price</th>
            <th className="border border-gray-400 px-2 py-2 text-right" style={{ width: '60px' }}>Due Price</th>
            <th className="border border-gray-400 px-2 py-2 text-center" style={{ width: '45px' }}>Disc %</th>
            <th className="border border-gray-400 px-2 py-2 text-right" style={{ width: '55px' }}>Savings</th>
            <th className="border border-gray-400 px-2 py-2 text-right" style={{ width: '60px' }}>Total</th>
          </tr>
        </thead>
        <tbody>
          {invoiceData.lineItems.map((item, index) => {
            const calc = calculateLineTotal(item);
            if (!item.product && !item.qty && !item.price) return null;
            const isReturn = item.isReturn === true;
            const rowStyle = isReturn ? { textDecoration: 'line-through', color: '#dc2626' } : undefined;
            return (
              <tr key={index} style={rowStyle} data-testid={isReturn ? `returned-line-row-${index}` : `line-row-${index}`}>
                <td className="border border-gray-300 px-2 py-1 text-center">{item.qty || ''}</td>
                <td className="border border-gray-300 px-2 py-1 text-center">{item.m2 || '0'}</td>
                <td className="border border-gray-300 px-2 py-1">
                  {isReturn && <span className="font-bold text-red-600 mr-1">(RETURNED)</span>}
                  {toTitleCase(item.product) || ''}
                  {isReturn && item.originalInvoiceNo && (
                    <span className="ml-1 text-xs text-red-700 font-mono">
                      — linked to {item.originalInvoiceNo}
                    </span>
                  )}
                </td>
                <td className="border border-gray-300 px-2 py-1 text-right">£{parseFloat(item.price || 0).toFixed(2)}</td>
                <td className="border border-gray-300 px-2 py-1 text-right">£{calc.duePrice.toFixed(2)}</td>
                <td className="border border-gray-300 px-2 py-1 text-center">{calc.discountPercent > 0 ? `${calc.discountPercent.toFixed(1)}%` : '-'}</td>
                <td className="border border-gray-300 px-2 py-1 text-right">{calc.savings > 0 ? `£${calc.savings.toFixed(2)}` : '-'}</td>
                <td className="border border-gray-300 px-2 py-1 text-right">
                  {isReturn ? `−£${calc.due.toFixed(2)}` : `£${calc.due.toFixed(2)}`}
                </td>
              </tr>
            );
          })}
          {/* Empty rows for manual entry when printed - completely blank for tidy look */}
          {invoiceData.lineItems.filter(i => i.product || i.qty || i.price).length < 12 && 
            [...Array(12 - invoiceData.lineItems.filter(i => i.product || i.qty || i.price).length)].map((_, i) => (
              <tr key={`empty-${i}`}>
                <td className="border border-gray-300 px-2 py-1 text-center">&nbsp;</td>
                <td className="border border-gray-300 px-2 py-1 text-center">&nbsp;</td>
                <td className="border border-gray-300 px-2 py-1">&nbsp;</td>
                <td className="border border-gray-300 px-2 py-1 text-right">&nbsp;</td>
                <td className="border border-gray-300 px-2 py-1 text-right">&nbsp;</td>
                <td className="border border-gray-300 px-2 py-1 text-center">&nbsp;</td>
                <td className="border border-gray-300 px-2 py-1 text-right">&nbsp;</td>
                <td className="border border-gray-300 px-2 py-1 text-right">&nbsp;</td>
              </tr>
            ))
          }
          {/* Customer order use only row */}
          <tr>
            <td colSpan={8} className="border border-gray-300 px-2 py-1 italic text-gray-500 text-xs">
              Customer order use only
            </td>
          </tr>
        </tbody>
      </table>

      {/* Bottom Section - Two Columns */}
      <div className="flex gap-6 text-xs mb-4">
        {/* Left Column - Customer Details */}
        <div className="flex-1">
          <table className="w-full" style={{ fontSize: '11px' }}>
            <tbody>
              <tr>
                <td className="py-1 font-bold w-24">Name</td>
                <td className="py-1 border-b border-gray-400">{invoiceData.customerName || ''}</td>
              </tr>
              <tr>
                <td className="py-1 font-bold">Phone</td>
                <td className="py-1 border-b border-gray-400">{invoiceData.customerPhone || ''}</td>
              </tr>
              <tr>
                <td className="py-1 font-bold">Address</td>
                <td className="py-1 border-b border-gray-400">{invoiceData.customerAddress || ''}</td>
              </tr>
              <tr>
                <td className="py-1 font-bold">Email</td>
                <td className="py-1 border-b border-gray-400">{invoiceData.customerEmail || ''}</td>
              </tr>
              <tr>
                <td className="py-1 font-bold">Sales Person</td>
                <td className="py-1 border-b border-gray-400">{invoiceData.salesPerson || ''}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Right Column - Payment Summary */}
        <div className="w-64">
          {/* Order Type Badge */}
          <div className={`mb-2 px-3 py-2 text-center text-sm font-bold rounded ${
            invoiceData.orderType === 'Special Order' 
              ? 'bg-purple-100 text-purple-800 border-2 border-purple-400' 
              : 'bg-blue-100 text-blue-800 border-2 border-blue-400'
          }`}>
            {invoiceData.orderType || 'Store Order'}
          </div>
          
          {/* Payment Methods Table */}
          <table className="w-full border-collapse" style={{ fontSize: '11px' }}>
            <tbody>
              <tr>
                <td className="border border-gray-400 px-2 py-1 font-bold bg-gray-100" colSpan={2}>Payment Method(s)</td>
                <td className="border border-gray-400 px-2 py-1 font-bold text-right bg-gray-100">Total</td>
              </tr>
              {invoiceData.paymentMethods && invoiceData.paymentMethods.length > 0 ? (
                invoiceData.paymentMethods.filter(pm => pm.method).map((pm, idx) => (
                  <tr key={idx}>
                    <td className="border border-gray-400 px-2 py-1">{pm.method}</td>
                    <td className="border border-gray-400 px-2 py-1 text-right">
                      {pm.amount ? `£ ${parseFloat(pm.amount).toFixed(2)}` : ''}
                    </td>
                    {idx === 0 && (
                      <td className="border border-gray-400 px-2 py-1 text-right font-bold" rowSpan={invoiceData.paymentMethods.filter(pm => pm.method).length}>
                        £ {totals.grossTotal.toFixed(2)}
                      </td>
                    )}
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="border border-gray-400 px-2 py-1">{invoiceData.paymentMethod || '-'}</td>
                  <td className="border border-gray-400 px-2 py-1"></td>
                  <td className="border border-gray-400 px-2 py-1 text-right font-bold">£ {totals.grossTotal.toFixed(2)}</td>
                </tr>
              )}
              <tr>
                <td className="border border-gray-400 px-2 py-1">VAT Total</td>
                <td className="border border-gray-400 px-2 py-1"></td>
                <td className="border border-gray-400 px-2 py-1 text-right">£ {totals.vat.toFixed(2)}</td>
              </tr>
              <tr>
                <td className="border border-gray-400 px-2 py-1 font-bold">Incl. VAT</td>
                <td className="border border-gray-400 px-2 py-1"></td>
                <td className="border border-gray-400 px-2 py-1 text-right font-bold">£ {totals.grossTotal.toFixed(2)}</td>
              </tr>
            </tbody>
          </table>

          {/* Amount Taken & Outstanding Table - Multiple Deposits */}
          <table className="w-full border-collapse mt-2" style={{ fontSize: '11px' }}>
            <thead>
              <tr style={{ backgroundColor: '#000', color: '#fff' }}>
                <th className="border border-gray-400 px-2 py-1 text-center">Date</th>
                <th className="border border-gray-400 px-2 py-1 text-center">Payment Method</th>
                <th className="border border-gray-400 px-2 py-1 text-right">Amount Taken</th>
                <th className="border border-gray-400 px-2 py-1 text-right">Amount Outstanding</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                const validDeposits = invoiceData.deposits.filter(d => d.amount && parseFloat(d.amount) > 0);
                let runningBalance = totals.grossTotal;
                // Treat trade-credit redemption as a payment row alongside cash/card
                // — it's a settled portion of the invoice, not a discount.
                const creditAmount = parseFloat(invoiceData.creditRedeemedAmount) || 0;
                const creditRow = creditAmount > 0 ? {
                  date: invoiceData.date,
                  method: `Trade credit${invoiceData.creditRedeemedAccount ? ` (${invoiceData.creditRedeemedAccount})` : ''}`,
                  amount: creditAmount,
                } : null;
                
                if (validDeposits.length === 0 && !creditRow) {
                  // Get primary payment method from paymentMethods array or fallback to single paymentMethod
                  const primaryMethod = invoiceData.paymentMethods?.find(pm => pm.method)?.method || invoiceData.paymentMethod || '-';
                  return (
                    <tr>
                      <td className="border border-gray-400 px-2 py-1 text-center">{invoiceData.date}</td>
                      <td className="border border-gray-400 px-2 py-1 text-center">{primaryMethod}</td>
                      <td className="border border-gray-400 px-2 py-1 text-right">£ 0.00</td>
                      <td className="border border-gray-400 px-2 py-1 text-right font-semibold">£ {totals.grossTotal.toFixed(2)}</td>
                    </tr>
                  );
                }
                
                return [
                  ...(creditRow ? [creditRow] : []),
                  ...validDeposits,
                ].map((deposit, idx, arr) => {
                  const amount = parseFloat(deposit.amount) || 0;
                  runningBalance -= amount;
                  const isLast = idx === arr.length - 1;
                  // Use note as payment method description, or fallback to payment method
                  const paymentNote = deposit.method || deposit.note || invoiceData.paymentMethods?.find(pm => pm.method)?.method || invoiceData.paymentMethod || '-';
                  return (
                    <tr key={idx}>
                      <td className="border border-gray-400 px-2 py-1 text-center">{deposit.date}</td>
                      <td className="border border-gray-400 px-2 py-1 text-center">{paymentNote}</td>
                      <td className="border border-gray-400 px-2 py-1 text-right">£ {amount.toFixed(2)}</td>
                      <td className={`border border-gray-400 px-2 py-1 text-right ${isLast ? 'font-semibold' : ''} ${isLast && runningBalance > 0 ? 'text-red-600' : ''}`}>
                        £ {runningBalance.toFixed(2)}
                      </td>
                    </tr>
                  );
                });
              })()}
            </tbody>
          </table>
          
          {/* Deposit Order Warning — use half-penny tolerance to avoid floating-point false positives
              (e.g. VAT-inclusive totals like £13.99 can produce tiny positive residuals like 1e-14) */}
          {totals.amountOutstanding > 0.005 && totals.totalDeposits > 0 && (
            <div style={{ marginTop: '8px', padding: '6px 10px', backgroundColor: '#fef3c7', border: '1px solid #f59e0b', borderRadius: '4px' }}>
              <p style={{ fontSize: '11px', color: '#92400e', fontWeight: 'bold', margin: 0 }}>
                ⚠ DEPOSIT ORDER - Outstanding Balance: £{totals.amountOutstanding.toFixed(2)}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Tagline */}
      <div className="text-center text-sm font-semibold mb-4" style={{ letterSpacing: '1px' }}>
        Amazing Tiles - Beautiful Bathrooms - Excellent Service
      </div>

      {/* Terms and Conditions */}
      <div style={{ borderTop: '1px solid #333', paddingTop: '10px' }}>
        <p className="font-bold text-xs mb-1">Terms and conditions:</p>
        <p style={{ fontSize: '10px', lineHeight: '1.4', color: '#333' }}>
          {invoiceData.termsAndConditions}
        </p>
      </div>
    </div>
  );
};
