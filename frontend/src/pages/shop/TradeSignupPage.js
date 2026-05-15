import React, { useState } from 'react';
import { Building2, Percent, Package, Check, Loader2, BadgeCheck } from 'lucide-react';
import { toast } from 'sonner';
import axios from 'axios';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const TradeSignupPage = () => {
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  
  const [formData, setFormData] = useState({
    business_name: '',
    business_type: '',
    vat_number: '',
    contact_name: '',
    email: '',
    phone: '',
    estimated_monthly_spend: '',
    notes: ''
  });

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!formData.business_name || !formData.contact_name || !formData.email) {
      setError('Please fill in all required fields');
      return;
    }
    
    setSubmitting(true);
    setError('');
    
    try {
      // 15 May 2026 — axios instead of fetch (Sentry-body-drain).
      await axios.post(`${API_URL}/api/shop/trade/apply`, formData);
      
      setSubmitted(true);
      toast.success('Application submitted successfully!');
    } catch (err) {
      console.error('Trade application error:', err);
      const msg = err?.response?.data?.detail || err.message || 'Failed to submit application';
      setError(msg);
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="container mx-auto px-4 py-16">
          <div className="max-w-lg mx-auto text-center">
            <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
              <Check className="w-10 h-10 text-green-500" />
            </div>
            <h1 className="text-2xl font-bold text-slate-900 mb-2">Application Submitted!</h1>
            <p className="text-slate-500 mb-8">
              Thank you for applying for a trade account. Our team will review your application and get back to you within 2-3 business days.
            </p>
            <a
              href="/tiles"
              className="inline-flex items-center gap-2 bg-[#333333] hover:bg-[#444444] text-[#F7EA1C] font-semibold px-6 py-3 rounded-lg"
            >
              Continue Shopping
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="container mx-auto px-4 py-8">
        {/* Header */}
        <div className="text-center mb-10">
          <div className="w-16 h-16 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <Building2 className="w-8 h-8 text-amber-600" />
          </div>
          <h1 className="text-2xl md:text-3xl font-bold text-slate-900 mb-2">Trade Account Application</h1>
          <p className="text-slate-500 max-w-xl mx-auto">
            Apply for a trade account and enjoy exclusive discounts on all products.
          </p>
        </div>

        <div className="max-w-4xl mx-auto">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* Benefits */}
            <div className="lg:col-span-1">
              <div className="bg-white rounded-xl p-6 shadow-sm sticky top-24">
                <h2 className="font-semibold text-slate-900 mb-4">Trade Benefits</h2>
                <div className="space-y-4">
                  <div className="flex gap-3">
                    <div className="w-10 h-10 bg-amber-100 rounded-lg flex items-center justify-center flex-shrink-0">
                      <Percent className="w-5 h-5 text-amber-600" />
                    </div>
                    <div>
                      <p className="font-medium text-slate-900">Exclusive Discounts</p>
                      <p className="text-sm text-slate-500">Up to 15% off all products</p>
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <div className="w-10 h-10 bg-amber-100 rounded-lg flex items-center justify-center flex-shrink-0">
                      <Package className="w-5 h-5 text-amber-600" />
                    </div>
                    <div>
                      <p className="font-medium text-slate-900">Volume Discounts</p>
                      <p className="text-sm text-slate-500">Extra savings on bulk orders</p>
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <div className="w-10 h-10 bg-amber-100 rounded-lg flex items-center justify-center flex-shrink-0">
                      <BadgeCheck className="w-5 h-5 text-amber-600" />
                    </div>
                    <div>
                      <p className="font-medium text-slate-900">Priority Support</p>
                      <p className="text-sm text-slate-500">Dedicated account manager</p>
                    </div>
                  </div>
                </div>

                {/* Volume Discount Table */}
                <div className="mt-6 pt-6 border-t">
                  <h3 className="font-medium text-slate-900 mb-3">Volume Discounts</h3>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-slate-500">
                        <th className="text-left pb-2">Quantity</th>
                        <th className="text-right pb-2">Discount</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr><td className="py-1">50+ units</td><td className="text-right text-green-600">5% off</td></tr>
                      <tr><td className="py-1">100+ units</td><td className="text-right text-green-600">10% off</td></tr>
                      <tr><td className="py-1">200+ units</td><td className="text-right text-green-600">15% off</td></tr>
                      <tr><td className="py-1">500+ units</td><td className="text-right text-green-600">20% off</td></tr>
                    </tbody>
                  </table>
                  <p className="text-xs text-slate-500 mt-2">
                    * Volume discounts stack with trade discount (max 35% total)
                  </p>
                </div>
              </div>
            </div>

            {/* Application Form */}
            <div className="lg:col-span-2">
              <div className="bg-white rounded-xl shadow-sm p-6">
                <h2 className="text-lg font-semibold mb-6">Application Form</h2>
                
                <form onSubmit={handleSubmit} className="space-y-6">
                  {/* Business Details */}
                  <div>
                    <h3 className="font-medium text-slate-900 mb-4">Business Details</h3>
                    <div className="space-y-4">
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-1">
                          Business Name *
                        </label>
                        <input
                          name="business_name"
                          type="text"
                          value={formData.business_name}
                          onChange={handleInputChange}
                          required
                          className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-amber-400/20 focus:border-amber-400 outline-none"
                        />
                      </div>
                      
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-slate-700 mb-1">
                            Business Type *
                          </label>
                          <select
                            name="business_type"
                            value={formData.business_type}
                            onChange={handleInputChange}
                            required
                            className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-amber-400/20 focus:border-amber-400 outline-none"
                          >
                            <option value="">Select type...</option>
                            <option value="builder">Builder</option>
                            <option value="contractor">Contractor</option>
                            <option value="retailer">Retailer</option>
                            <option value="interior_designer">Interior Designer</option>
                            <option value="property_developer">Property Developer</option>
                            <option value="other">Other</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-slate-700 mb-1">
                            VAT Number (optional)
                          </label>
                          <input
                            name="vat_number"
                            type="text"
                            value={formData.vat_number}
                            onChange={handleInputChange}
                            placeholder="GB123456789"
                            className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-amber-400/20 focus:border-amber-400 outline-none"
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Contact Details */}
                  <div>
                    <h3 className="font-medium text-slate-900 mb-4">Contact Details</h3>
                    <div className="space-y-4">
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-1">
                          Contact Name *
                        </label>
                        <input
                          name="contact_name"
                          type="text"
                          value={formData.contact_name}
                          onChange={handleInputChange}
                          required
                          className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-amber-400/20 focus:border-amber-400 outline-none"
                        />
                      </div>
                      
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-slate-700 mb-1">
                            Email *
                          </label>
                          <input
                            name="email"
                            type="email"
                            value={formData.email}
                            onChange={handleInputChange}
                            required
                            className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-amber-400/20 focus:border-amber-400 outline-none"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-slate-700 mb-1">
                            Phone *
                          </label>
                          <input
                            name="phone"
                            type="tel"
                            value={formData.phone}
                            onChange={handleInputChange}
                            required
                            className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-amber-400/20 focus:border-amber-400 outline-none"
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Additional Info */}
                  <div>
                    <h3 className="font-medium text-slate-900 mb-4">Additional Information</h3>
                    <div className="space-y-4">
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-1">
                          Estimated Monthly Spend
                        </label>
                        <select
                          name="estimated_monthly_spend"
                          value={formData.estimated_monthly_spend}
                          onChange={handleInputChange}
                          className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-amber-400/20 focus:border-amber-400 outline-none"
                        >
                          <option value="">Select range...</option>
                          <option value="under_500">Under £500</option>
                          <option value="500_1000">£500 - £1,000</option>
                          <option value="1000_2500">£1,000 - £2,500</option>
                          <option value="2500_5000">£2,500 - £5,000</option>
                          <option value="5000_10000">£5,000 - £10,000</option>
                          <option value="over_10000">Over £10,000</option>
                        </select>
                      </div>
                      
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-1">
                          Tell us about your business (optional)
                        </label>
                        <textarea
                          name="notes"
                          value={formData.notes}
                          onChange={handleInputChange}
                          rows={3}
                          placeholder="What type of projects do you work on? Any specific product categories you're interested in?"
                          className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-amber-400/20 focus:border-amber-400 outline-none resize-none"
                        />
                      </div>
                    </div>
                  </div>

                  {error && (
                    <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
                      {error}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={submitting}
                    className="w-full flex items-center justify-center gap-2 bg-[#333333] hover:bg-[#444444] disabled:bg-gray-300 text-[#F7EA1C] font-semibold py-3 rounded-lg transition-colors"
                  >
                    {submitting ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin" />
                        Submitting...
                      </>
                    ) : (
                      <>
                        <Building2 className="w-5 h-5" />
                        Submit Application
                      </>
                    )}
                  </button>
                </form>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TradeSignupPage;
