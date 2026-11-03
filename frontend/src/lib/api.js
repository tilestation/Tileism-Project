import axios from 'axios';

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${BACKEND_URL}/api`;

const getAuthHeader = () => {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
};

export { getAuthHeader };

export const api = {
  // Generic HTTP methods for flexible API calls
  get: (url, config = {}) => 
    axios.get(url.startsWith('/') ? `${API}${url}` : url, { 
      ...config, 
      headers: { ...getAuthHeader(), ...config.headers } 
    }),
  
  post: (url, data, config = {}) => 
    axios.post(url.startsWith('/') ? `${API}${url}` : url, data, { 
      ...config, 
      headers: { ...getAuthHeader(), ...config.headers } 
    }),
  
  put: (url, data, config = {}) => 
    axios.put(url.startsWith('/') ? `${API}${url}` : url, data, { 
      ...config, 
      headers: { ...getAuthHeader(), ...config.headers } 
    }),
  
  delete: (url, config = {}) => 
    axios.delete(url.startsWith('/') ? `${API}${url}` : url, { 
      ...config, 
      headers: { ...getAuthHeader(), ...config.headers } 
    }),

  // Health check (no auth required)
  healthCheck: () => axios.get(`${API}/health`),

  // Auth
  changePassword: (data) =>
    axios.post(`${API}/auth/change-password`, data, { headers: getAuthHeader() }),
  
  forgotPassword: (email, account_type) =>
    axios.post(`${API}/auth/forgot-password`, { email, account_type }),
  
  resetPassword: (token, new_password) =>
    axios.post(`${API}/auth/reset-password`, { token, new_password }),
  
  verifyResetToken: (token) =>
    axios.get(`${API}/auth/verify-reset-token`, { params: { token } }),

  // Products
  getProducts: (params = {}) => 
    axios.get(`${API}/products`, { headers: getAuthHeader(), params }),
  
  // EPOS Product Search - searches both products and supplier_products
  // Allows searching by supplier's original name but returns internal product name
  searchProductsForEpos: (search) =>
    axios.get(`${API}/products/epos/search`, { headers: getAuthHeader(), params: { search } }),
  
  getProduct: (id) => 
    axios.get(`${API}/products/${id}`, { headers: getAuthHeader() }),
  
  createProduct: (data) => 
    axios.post(`${API}/products`, data, { headers: getAuthHeader() }),
  
  updateProduct: (id, data) => 
    axios.put(`${API}/products/${id}`, data, { headers: getAuthHeader() }),
  
  bulkUpdateProducts: (data) =>
    axios.put(`${API}/products/bulk-update`, data, { headers: getAuthHeader() }),
  
  bulkDeleteProducts: (productIds) =>
    axios.post(`${API}/products/bulk-delete`, { product_ids: productIds }, { headers: getAuthHeader() }),
  
  deleteProduct: (id) => 
    axios.delete(`${API}/products/${id}`, { headers: getAuthHeader() }),

  // Product Ticket Settings
  saveProductTicketSettings: (productId, settings) =>
    axios.put(`${API}/products/${productId}/ticket-settings`, { product_id: productId, ...settings }, { headers: getAuthHeader() }),
  
  getProductTicketSettings: (productId) =>
    axios.get(`${API}/products/${productId}/ticket-settings`, { headers: getAuthHeader() }),

  // Store Stock Allocation
  getProductStoreStock: (productId) =>
    axios.get(`${API}/products/${productId}/showroom-stock`, { headers: getAuthHeader() }),
  
  updateProductStoreStock: (productId, allocations) =>
    axios.put(`${API}/products/${productId}/showroom-stock`, { allocations }, { headers: getAuthHeader() }),
  
  transferStock: (productId, fromStoreId, toStoreId, quantity) =>
    axios.post(`${API}/products/${productId}/transfer-stock`, { 
      from_showroom_id: fromStoreId, 
      to_showroom_id: toStoreId, 
      quantity 
    }, { headers: getAuthHeader() }),

  uploadImage: (file) => {
    const formData = new FormData();
    formData.append('file', file);
    return axios.post(`${API}/upload-image`, formData, {
      headers: {
        ...getAuthHeader(),
        'Content-Type': 'multipart/form-data'
      }
    });
  },

  // Categories
  getCategories: () => 
    axios.get(`${API}/categories`, { headers: getAuthHeader() }),
  
  createCategory: (data) => 
    axios.post(`${API}/categories`, data, { headers: getAuthHeader() }),

  // Orders
  getOrders: () => 
    axios.get(`${API}/orders`, { headers: getAuthHeader() }),
  
  createOrder: (data) => 
    axios.post(`${API}/orders`, data, { headers: getAuthHeader() }),
  
  // OTP for orders
  requestOTP: (orderData, phoneNumber) => 
    axios.post(`${API}/orders/request-otp`, { order_data: orderData, phone_number: phoneNumber }, { headers: getAuthHeader() }),
  
  verifyOTPAndCreateOrder: (orderData, otp, phoneNumber) => 
    axios.post(`${API}/orders/verify-otp`, { order_data: orderData, otp, phone_number: phoneNumber }, { headers: getAuthHeader() }),
  
  updateOrderStatus: (id, status) => 
    axios.put(`${API}/orders/${id}/status`, { status }, { headers: getAuthHeader() }),

  // Dashboard
  getDashboardStats: () => 
    axios.get(`${API}/dashboard/stats`, { headers: getAuthHeader() }),

  // Tasks & Notes
  getTasks: (params = {}) =>
    axios.get(`${API}/tasks`, { headers: getAuthHeader(), params }),
  
  getTask: (id) =>
    axios.get(`${API}/tasks/${id}`, { headers: getAuthHeader() }),
  
  getTaskStats: (params = {}) =>
    axios.get(`${API}/tasks/stats`, { headers: getAuthHeader(), params }),
  
  createTask: (data) =>
    axios.post(`${API}/tasks`, data, { headers: getAuthHeader() }),
  
  updateTask: (id, data) =>
    axios.put(`${API}/tasks/${id}`, data, { headers: getAuthHeader() }),
  
  deleteTask: (id) =>
    axios.delete(`${API}/tasks/${id}`, { headers: getAuthHeader() }),
  
  addTaskNote: (taskId, data) =>
    axios.post(`${API}/tasks/${taskId}/notes`, data, { headers: getAuthHeader() }),
  
  updateTaskNote: (noteId, data) =>
    axios.put(`${API}/tasks/notes/${noteId}`, data, { headers: getAuthHeader() }),
  
  deleteTaskNote: (noteId) =>
    axios.delete(`${API}/tasks/notes/${noteId}`, { headers: getAuthHeader() }),

  // Customer Pricing
  createCustomerPricing: (data) =>
    axios.post(`${API}/customer-pricing`, data, { headers: getAuthHeader() }),
  
  getCustomerPricing: (customerEmail) =>
    axios.get(`${API}/customer-pricing/${customerEmail}`, { headers: getAuthHeader() }),
  
  deleteCustomerPricing: (id) =>
    axios.delete(`${API}/customer-pricing/${id}`, { headers: getAuthHeader() }),

  bulkImportPricing: (items) =>
    axios.post(`${API}/customer-pricing/bulk-import`, { items }, { headers: getAuthHeader() }),
  
  getPricingTemplate: () =>
    axios.get(`${API}/customer-pricing/template`, { headers: getAuthHeader() }),

  getProductsWithCustomPricing: () =>
    axios.get(`${API}/products-with-custom-pricing`, { headers: getAuthHeader() }),

  // Customer email suggestions for auto-complete
  getCustomerEmailSuggestions: (search = '') =>
    axios.get(`${API}/customers/email-suggestions`, { 
      params: { search }, 
      headers: getAuthHeader() 
    }),

  // Bulk Inquiries
  createBulkInquiry: (data) =>
    axios.post(`${API}/bulk-inquiries`, data, { headers: getAuthHeader() }),
  
  getBulkInquiries: (status = null) =>
    axios.get(`${API}/bulk-inquiries`, { headers: getAuthHeader(), params: status ? { status } : {} }),
  
  updateBulkInquiry: (id, data) =>
    axios.put(`${API}/bulk-inquiries/${id}`, data, { headers: getAuthHeader() }),
  
  deleteBulkInquiry: (id) =>
    axios.delete(`${API}/bulk-inquiries/${id}`, { headers: getAuthHeader() }),

  // Customer Invites
  createInvite: (data) =>
    axios.post(`${API}/invites`, data, { headers: getAuthHeader() }),
  
  getInvites: () =>
    axios.get(`${API}/invites`, { headers: getAuthHeader() }),
  
  validateInvite: (code) =>
    axios.get(`${API}/invites/validate/${code}`),
  
  deleteInvite: (id) =>
    axios.delete(`${API}/invites/${id}`, { headers: getAuthHeader() }),
  
  sendInviteEmail: (data) =>
    axios.post(`${API}/invites/send-email`, data, { headers: getAuthHeader() }),

  // Stores
  getStores: (includeInactive = false) =>
    axios.get(`${API}/showrooms${includeInactive ? '?include_inactive=true' : ''}`, { headers: getAuthHeader() }),
  
  getShowrooms: (includeInactive = false) =>
    axios.get(`${API}/showrooms${includeInactive ? '?include_inactive=true' : ''}`, { headers: getAuthHeader() }),
  
  createStore: (data) =>
    axios.post(`${API}/showrooms`, data, { headers: getAuthHeader() }),
  
  updateStore: (id, data) =>
    axios.put(`${API}/showrooms/${id}`, data, { headers: getAuthHeader() }),
  
  setStoreStatus: (id, isActive) =>
    axios.patch(`${API}/showrooms/${id}/status`, { is_active: isActive }, { headers: getAuthHeader() }),
  
  deleteStore: (id) =>
    axios.delete(`${API}/showrooms/${id}`, { headers: getAuthHeader() }),

  // Suppliers
  getSuppliers: (activeOnly = true) =>
    axios.get(`${API}/suppliers`, { headers: getAuthHeader(), params: { active_only: activeOnly } }),
  
  // Get supplier products (for EPOS search)
  getSupplierProducts: (params = {}) =>
    axios.get(`${API}/supplier-sync/products`, { params }),
  
  // Add supplier product to main products database
  addSupplierProductToDb: (sku, supplier, product_id) =>
    axios.post(`${API}/supplier-sync/products/add-to-database`, { sku, supplier, product_id }, { headers: getAuthHeader() }),
  
  createSupplier: (data) =>
    axios.post(`${API}/suppliers`, data, { headers: getAuthHeader() }),
  
  updateSupplier: (id, data) =>
    axios.put(`${API}/suppliers/${id}`, data, { headers: getAuthHeader() }),
  
  deleteSupplier: (id) =>
    axios.delete(`${API}/suppliers/${id}`, { headers: getAuthHeader() }),
  
  updateProductSupplierStock: (productId, allocations) =>
    axios.put(`${API}/products/${productId}/supplier-stock`, { allocations }, { headers: getAuthHeader() }),

  // Trade Accounts
  getTradeAccounts: (params = {}) =>
    axios.get(`${API}/trade-accounts`, { headers: getAuthHeader(), params }),
  
  getTradeAccount: (id) =>
    axios.get(`${API}/trade-accounts/${id}`, { headers: getAuthHeader() }),
  
  createTradeAccount: (data) =>
    axios.post(`${API}/trade-accounts`, data, { headers: getAuthHeader() }),
  
  updateTradeAccount: (id, data) =>
    axios.put(`${API}/trade-accounts/${id}`, data, { headers: getAuthHeader() }),
  
  deleteTradeAccount: (id) =>
    axios.delete(`${API}/trade-accounts/${id}`, { headers: getAuthHeader() }),

  sendTradeLoginLink: (id) =>
    axios.post(`${API}/trade-accounts/${id}/send-login-link`, {}, { headers: getAuthHeader() }),
  bulkSendTradeLoginLinks: (ids) =>
    axios.post(`${API}/trade-accounts/send-login-links`, { ids }, { headers: getAuthHeader() }),

  // Trade Hub — dashboard, 360 timeline, unified credit ledger, adjustments, expiry, nudges
  getTradeHubSummary: (days = 30) =>
    axios.get(`${API}/trade-hub/summary`, { params: { days }, headers: getAuthHeader() }),
  getTraderTimeline: (id) =>
    axios.get(`${API}/trade-hub/traders/${id}/timeline`, { headers: getAuthHeader() }),
  getTraderLoginCheck: (id) =>
    axios.get(`${API}/trade-hub/traders/${id}/login-check`, { headers: getAuthHeader() }),
  getTradeLoginActivity: (days = 14) =>
    axios.get(`${API}/trade-hub/logins/activity`, { params: { days }, headers: getAuthHeader() }),
  getTraderLedger: (id) =>
    axios.get(`${API}/trade-hub/traders/${id}/ledger`, { headers: getAuthHeader() }),
  adjustTraderCredit: (id, body) =>
    axios.post(`${API}/trade-hub/traders/${id}/credit-adjust`, body, { headers: getAuthHeader() }),
  setTraderCreditExpiry: (id, expires_at) =>
    axios.put(`${API}/trade-hub/traders/${id}/credit-expiry`, { expires_at }, { headers: getAuthHeader() }),
  bulkSetTraderCreditExpiry: (ids, expires_at) =>
    axios.post(`${API}/trade-hub/credit-expiry/set-bulk`, { ids, expires_at }, { headers: getAuthHeader() }),
  remindTraderCreditExpiry: (id) =>
    axios.post(`${API}/trade-hub/traders/${id}/credit-expiry/remind`, {}, { headers: getAuthHeader() }),
  expireTraderCreditNow: (id) =>
    axios.post(`${API}/trade-hub/traders/${id}/credit-expiry/expire-now`, {}, { headers: getAuthHeader() }),
  sendDormantNudge: (ids) =>
    axios.post(`${API}/trade-hub/engagement/dormant-nudge`, { ids }, { headers: getAuthHeader() }),
  setTraderNotes: (id, body) =>
    axios.put(`${API}/trade-hub/traders/${id}/notes`, body, { headers: getAuthHeader() }),
  getCreditMovements: (days = 30, limit = 300) =>
    axios.get(`${API}/trade-hub/credit/movements`, { params: { days, limit }, headers: getAuthHeader() }),
  getShowroomIps: () =>
    axios.get(`${API}/trade-hub/showroom-ips`, { headers: getAuthHeader() }),
  saveShowroomIps: (ips) =>
    axios.put(`${API}/trade-hub/showroom-ips`, { ips }, { headers: getAuthHeader() }),
  getMyIp: () =>
    axios.get(`${API}/trade-hub/my-ip`, { headers: getAuthHeader() }),
  
  getTradeTypes: () =>
    axios.get(`${API}/trade-accounts/trade-types`, { headers: getAuthHeader() }),
  
  getPricingTiers: () =>
    axios.get(`${API}/trade-accounts/pricing-tiers`, { headers: getAuthHeader() }),

  // WhatsApp messaging
  sendWhatsAppToCustomer: (customerId, templateName) =>
    axios.post(`${API}/whatsapp/send-to-customer`, { customer_id: customerId, template_name: templateName }, { headers: getAuthHeader() }),

  bulkSendWhatsApp: (customerIds, templateName) =>
    axios.post(`${API}/whatsapp/bulk-send`, { customer_ids: customerIds, template_name: templateName }, { headers: getAuthHeader() }),

  sendCustomWhatsApp: (customerIds, message) =>
    axios.post(`${API}/whatsapp/send-custom`, { customer_ids: customerIds, message }, { headers: getAuthHeader() }),

  getCustomerWhatsAppHistory: (customerId) =>
    axios.get(`${API}/whatsapp/customer-history/${customerId}`, { headers: getAuthHeader() }),
  
  getTradeAccountOrders: (id, params = {}) =>
    axios.get(`${API}/trade-accounts/${id}/orders`, { headers: getAuthHeader(), params }),

  // Users (for staff assignment)
  getUsers: () =>
    axios.get(`${API}/auth/users`, { headers: getAuthHeader() }),

  // Customers
  getCustomers: (params = {}) =>
    axios.get(`${API}/customers`, { headers: getAuthHeader(), params }),

  // Unified search across in-store users + online shop_customers for the
  // EPOS Invoice "Search online accounts" feature.
  unifiedCustomerSearch: (q, limit = 20) =>
    axios.get(`${API}/customers/unified-search`, {
      headers: getAuthHeader(),
      params: { q, limit },
    }),

  // EPOS feature flags (super-admin toggles). Read by anyone with EPOS;
  // write super-admin only. Defaults are returned even before the doc exists.
  getEposFeatureFlags: () =>
    axios.get(`${API}/customers/epos-feature-flags`, { headers: getAuthHeader() }),
  updateEposFeatureFlags: (flags) =>
    axios.put(`${API}/customers/epos-feature-flags`, { flags }, { headers: getAuthHeader() }),
  
  assignCustomerStore: (email, showroomId) =>
    axios.put(`${API}/customers/${email}/showroom`, null, { 
      headers: getAuthHeader(), 
      params: { showroom_id: showroomId } 
    }),

  // Marketing Campaigns
  getCampaigns: () =>
    axios.get(`${API}/marketing/campaigns`, { headers: getAuthHeader() }),
  
  createCampaign: (data) =>
    axios.post(`${API}/marketing/campaigns`, data, { headers: getAuthHeader() }),
  
  sendCampaign: (id) =>
    axios.post(`${API}/marketing/campaigns/${id}/send`, {}, { headers: getAuthHeader() }),
  
  deleteCampaign: (id) =>
    axios.delete(`${API}/marketing/campaigns/${id}`, { headers: getAuthHeader() }),
  
  getMarketingStats: () =>
    axios.get(`${API}/marketing/stats`, { headers: getAuthHeader() }),

  // Invoices
  saveInvoice: (data) =>
    axios.post(`${API}/invoices`, data, { headers: getAuthHeader() }),
  
  getInvoices: (params = {}) =>
    axios.get(`${API}/invoices`, { 
      headers: { ...getAuthHeader(), 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' }, 
      params: { ...params, _t: Date.now() } 
    }),
  
  getInvoice: (id) =>
    axios.get(`${API}/invoices/${id}`, { headers: getAuthHeader() }),
  
  updateInvoice: (id, data) =>
    axios.put(`${API}/invoices/${id}`, data, { headers: getAuthHeader() }),
  
  updateInvoiceStatus: (id, status) =>
    axios.patch(`${API}/invoices/${id}/status?status=${status}`, {}, { headers: getAuthHeader() }),
  
  updateInvoiceStore: (id, data) =>
    axios.patch(`${API}/invoices/${id}/showroom`, data, { headers: getAuthHeader() }),
  
  updateInvoiceStaff: (id, data) =>
    axios.patch(`${API}/invoices/${id}/staff`, data, { headers: getAuthHeader() }),
  
  bulkTransferInvoices: (data) =>
    axios.post(`${API}/invoices/bulk-transfer`, data, { headers: getAuthHeader() }),
  
  deleteInvoice: (id) =>
    axios.delete(`${API}/invoices/${id}`, { headers: getAuthHeader() }),
  
  getMisDatedDepositInvoices: () =>
    axios.get(`${API}/invoices/audit/mis-dated-deposits`, { headers: getAuthHeader() }),
  
  syncDepositDates: (invoice_ids = null) =>
    axios.post(`${API}/invoices/audit/sync-deposit-dates`,
      invoice_ids ? { invoice_ids } : {},
      { headers: getAuthHeader() }),

  // One-click "Add Final Payment" — POST /api/invoices/{id}/payments
  // Server stamps date as today. We deliberately don't accept a date
  // arg so the caller can never set the wrong day.
  addInvoicePayment: (id, { amount, method, note = '' }) =>
    axios.post(`${API}/invoices/${id}/payments`,
      { amount, method, note },
      { headers: getAuthHeader() }),

  // Oldest N outstanding-balance invoices for the EPOS widget
  getOutstandingBalances: (limit = 5) =>
    axios.get(`${API}/invoices/outstanding-balances?limit=${limit}`,
      { headers: getAuthHeader() }),
  
  downloadInvoicePdf: (id) =>
    axios.get(`${API}/invoices/${id}/pdf`, { 
      headers: getAuthHeader(), 
      responseType: 'blob' 
    }),
  
  emailInvoicePdf: (id, email, message = '', senderName = '') =>
    axios.post(`${API}/invoices/${id}/email`, { email, message, sender_name: senderName }, { headers: getAuthHeader() }),

  // Quotations
  getQuotations: (params = {}) =>
    axios.get(`${API}/quotations`, { headers: getAuthHeader(), params }),
  
  getQuotation: (id) =>
    axios.get(`${API}/quotations/${id}`, { headers: getAuthHeader() }),
  
  saveQuotation: (data) =>
    axios.post(`${API}/quotations`, data, { headers: getAuthHeader() }),
  
  updateQuotation: (id, data) =>
    axios.put(`${API}/quotations/${id}`, data, { headers: getAuthHeader() }),
  
  deleteQuotation: (id) =>
    axios.delete(`${API}/quotations/${id}`, { headers: getAuthHeader() }),
  
  convertQuotationToInvoice: (id, invoice_id = null) =>
    axios.post(`${API}/quotations/${id}/convert-to-invoice`, { invoice_id }, { headers: getAuthHeader() }),
  
  revertQuotationToActive: (id) =>
    axios.post(`${API}/quotations/${id}/revert-to-active`, {}, { headers: getAuthHeader() }),
  
  getOrphanConvertedQuotations: () =>
    axios.get(`${API}/quotations/audit/orphans`, { headers: getAuthHeader() }),

  searchInvoicesForLinking: (q, limit = 30) =>
    axios.get(`${API}/quotations/audit/search-invoices`, {
      params: { q, limit },
      headers: getAuthHeader(),
    }),

  linkInvoiceToQuotation: (quotationId, invoiceId) =>
    axios.post(`${API}/quotations/${quotationId}/link-invoice`,
      { invoice_id: invoiceId },
      { headers: getAuthHeader() },
    ),
  
  reassignQuotationShowroom: (id, showroomId) =>
    axios.post(`${API}/quotations/${id}/reassign-showroom`,
      { showroom_id: showroomId },
      { headers: getAuthHeader() },
    ),

  downloadQuotationPdf: (id) =>
    axios.get(`${API}/quotations/${id}/pdf`, { 
      headers: getAuthHeader(), 
      responseType: 'blob' 
    }),
  
  emailQuotationPdf: (id, email, message = '', subject = '') =>
    axios.post(`${API}/quotations/${id}/email`, { email, message, subject }, { headers: getAuthHeader() }),

  // Cash Quotations (No VAT)
  getCashQuotations: (params = {}) =>
    axios.get(`${API}/cash-quotations`, { headers: getAuthHeader(), params }),
  
  getCashQuotation: (id) =>
    axios.get(`${API}/cash-quotations/${id}`, { headers: getAuthHeader() }),
  
  saveCashQuotation: (data) =>
    axios.post(`${API}/cash-quotations`, data, { headers: getAuthHeader() }),
  
  updateCashQuotation: (id, data) =>
    axios.put(`${API}/cash-quotations/${id}`, data, { headers: getAuthHeader() }),
  
  deleteCashQuotation: (id) =>
    axios.delete(`${API}/cash-quotations/${id}`, { headers: getAuthHeader() }),
  
  convertCashQuotationToInvoice: (id) =>
    axios.post(`${API}/cash-quotations/${id}/convert-to-invoice`, {}, { headers: getAuthHeader() }),
  
  revertCashQuotationToActive: (id) =>
    axios.post(`${API}/cash-quotations/${id}/revert-to-active`, {}, { headers: getAuthHeader() }),
  
  downloadCashQuotationPdf: (id) =>
    axios.get(`${API}/cash-quotations/${id}/pdf`, { 
      headers: getAuthHeader(), 
      responseType: 'blob' 
    }),
  
  emailCashQuotationPdf: (id, email, message = '', subject = '') =>
    axios.post(`${API}/cash-quotations/${id}/email`, { email, message, subject }, { headers: getAuthHeader() }),
  
  getCashQuotationSalesSummary: (params = {}) =>
    axios.get(`${API}/cash-quotations/summary/sales`, { headers: getAuthHeader(), params }),

  // SMS Notifications
  getSmsStatus: () =>
    axios.get(`${API}/sms/status`, { headers: getAuthHeader() }),
  
  getSmsTemplates: () =>
    axios.get(`${API}/sms/templates`, { headers: getAuthHeader() }),
  
  sendSms: (data) =>
    axios.post(`${API}/sms/send`, data, { headers: getAuthHeader() }),
  
  createSmsTemplate: (data) =>
    axios.post(`${API}/sms/templates`, data, { headers: getAuthHeader() }),
  
  deleteSmsTemplate: (id) =>
    axios.delete(`${API}/sms/templates/${id}`, { headers: getAuthHeader() }),
  
  getSmsLogs: (limit = 50) =>
    axios.get(`${API}/sms/logs`, { headers: getAuthHeader(), params: { limit } }),

  // Refunds
  getRefunds: (params = {}) =>
    axios.get(`${API}/refunds`, { headers: getAuthHeader(), params }),
  
  getRefund: (id) =>
    axios.get(`${API}/refunds/${id}`, { headers: getAuthHeader() }),
  
  createRefund: (data) =>
    axios.post(`${API}/refunds`, data, { headers: getAuthHeader() }),
  
  updateRefund: (id, data) =>
    axios.put(`${API}/refunds/${id}`, data, { headers: getAuthHeader() }),
  
  deleteRefund: (id) =>
    axios.delete(`${API}/refunds/${id}`, { headers: getAuthHeader() }),
  
  getRefundStats: (params = {}) =>
    axios.get(`${API}/refunds/summary/stats`, { headers: getAuthHeader(), params }),

  sendRefundEmail: (id, email) =>
    axios.post(`${API}/refunds/${id}/send-email`, { email }, { headers: getAuthHeader() }),

  // Credit Notes
  getCreditNotes: (params = {}) =>
    axios.get(`${API}/credit_notes`, { headers: getAuthHeader(), params }),
  
  getCreditNote: (id) =>
    axios.get(`${API}/credit_notes/${id}`, { headers: getAuthHeader() }),
  
  createCreditNote: (data) =>
    axios.post(`${API}/credit_notes`, data, { headers: getAuthHeader() }),
  
  updateCreditNote: (id, data) =>
    axios.put(`${API}/credit_notes/${id}`, data, { headers: getAuthHeader() }),
  
  deleteCreditNote: (id) =>
    axios.delete(`${API}/credit_notes/${id}`, { headers: getAuthHeader() }),
  
  getCreditNoteStats: (params = {}) =>
    axios.get(`${API}/credit_notes/summary/stats`, { headers: getAuthHeader(), params }),
  
  downloadCreditNotePdf: (id) =>
    axios.get(`${API}/credit_notes/${id}/pdf`, { headers: getAuthHeader(), responseType: 'blob' }),

  // Staff PINs
  getStaffPins: () =>
    axios.get(`${API}/staff-pins`, { headers: getAuthHeader() }),
  
  createStaffPin: (data) =>
    axios.post(`${API}/staff-pins`, data, { headers: getAuthHeader() }),
  
  updateStaffPin: (id, data) =>
    axios.put(`${API}/staff-pins/${id}`, data, { headers: getAuthHeader() }),
  
  deleteStaffPin: (id) =>
    axios.delete(`${API}/staff-pins/${id}`, { headers: getAuthHeader() }),
  
  verifyStaffPin: (pin) =>
    axios.post(`${API}/staff-pins/verify`, { pin }, { headers: getAuthHeader() }),

  // User Management (Super Admin)
  getAdminUsers: () =>
    axios.get(`${API}/admin/users`, { headers: getAuthHeader() }),
  
  getAvailablePermissions: () =>
    axios.get(`${API}/admin/permissions`, { headers: getAuthHeader() }),
  
  createAdminUser: (data) =>
    axios.post(`${API}/admin/users`, data, { headers: getAuthHeader() }),
  
  updateUserPermissions: (email, data) =>
    axios.put(`${API}/admin/users/${encodeURIComponent(email)}/permissions`, data, { headers: getAuthHeader() }),
  
  deleteAdminUser: (email) =>
    axios.delete(`${API}/admin/users/${encodeURIComponent(email)}`, { headers: getAuthHeader() }),

  // Staff Invites (Super Admin)
  getStaffInvites: () =>
    axios.get(`${API}/staff-invites`, { headers: getAuthHeader() }),
  
  createStaffInvite: (data) =>
    axios.post(`${API}/staff-invites`, data, { headers: getAuthHeader() }),
  
  deleteStaffInvite: (id) =>
    axios.delete(`${API}/staff-invites/${id}`, { headers: getAuthHeader() }),
  
  validateStaffInvite: (code) =>
    axios.get(`${API}/staff-invites/${code}/validate`),
  
  registerWithStaffInvite: (code, data) =>
    axios.post(`${API}/staff-invites/${code}/register`, data),
  
  sendStaffInviteEmail: (data) =>
    axios.post(`${API}/staff-invites/send-email`, data, { headers: getAuthHeader() }),

  // Manual Email
  sendManualEmail: (data) =>
    axios.post(`${API}/emails/send`, data, { headers: getAuthHeader() }),
  
  getEmailHistory: (limit = 100) =>
    axios.get(`${API}/emails/history`, { headers: getAuthHeader(), params: { limit } }),

  // Email Inbox
  getInbox: (params = {}) =>
    axios.get(`${API}/emails/inbox`, { headers: getAuthHeader(), params }),
  
  getInboxStats: () =>
    axios.get(`${API}/emails/inbox/stats`, { headers: getAuthHeader() }),
  
  getInboxEmail: (id) =>
    axios.get(`${API}/emails/inbox/${id}`, { headers: getAuthHeader() }),
  
  updateInboxEmail: (id, data) =>
    axios.patch(`${API}/emails/inbox/${id}`, null, { headers: getAuthHeader(), params: data }),
  
  bulkUpdateInbox: (emailIds, data) =>
    axios.patch(`${API}/emails/inbox/bulk`, emailIds, { headers: getAuthHeader(), params: data }),
  
  deleteInboxEmail: (id) =>
    axios.delete(`${API}/emails/inbox/${id}`, { headers: getAuthHeader() }),
  
  replyToEmail: (id, data) =>
    axios.post(`${API}/emails/inbox/${id}/reply`, data, { headers: getAuthHeader() }),

  // Notification Settings
  getNotificationSettings: () =>
    axios.get(`${API}/notifications/settings`, { headers: getAuthHeader() }),
  
  updateNotificationSettings: (data) =>
    axios.patch(`${API}/notifications/settings`, data, { headers: getAuthHeader() }),
  
  getNotificationLogs: (limit = 100) =>
    axios.get(`${API}/notifications/logs`, { headers: getAuthHeader(), params: { limit } }),
  
  sendTestNotification: () =>
    axios.post(`${API}/notifications/test`, {}, { headers: getAuthHeader() }),

  // Store Analytics
  getStoreAnalytics: (params = {}) =>
    axios.get(`${API}/analytics/showrooms`, { headers: getAuthHeader(), params }),

  // Best Selling Products
  getBestSellers: (params = {}) =>
    axios.get(`${API}/dashboard/best-sellers`, { headers: getAuthHeader(), params }),

  // Staff Sales Summary (daily, weekly, monthly with targets)
  getStaffSalesSummary: (params = {}) =>
    axios.get(`${API}/staff/sales-summary`, { headers: getAuthHeader(), params }),

  // Manual Monthly Revenue (Historical Sales)
  getManualRevenueEntries: (params = {}) =>
    axios.get(`${API}/historical-sales/manual-entries`, { headers: getAuthHeader(), params }),
  
  createManualRevenueEntry: (data) =>
    axios.post(`${API}/historical-sales/manual-entry`, data, { headers: getAuthHeader() }),
  
  updateManualRevenueEntry: (entryId, data) =>
    axios.put(`${API}/historical-sales/manual-entry/${entryId}`, data, { headers: getAuthHeader() }),
  
  toggleManualRevenueVisibility: (entryId) =>
    axios.patch(`${API}/historical-sales/manual-entry/${entryId}/visibility`, {}, { headers: getAuthHeader() }),
  
  deleteManualRevenueEntry: (entryId) =>
    axios.delete(`${API}/historical-sales/manual-entry/${entryId}`, { headers: getAuthHeader() }),

  // Audit Logs (Super Admin only)
  getAuditLogs: (params = {}) =>
    axios.get(`${API}/audit-logs`, { headers: getAuthHeader(), params }),
  
  getAuditLogDetail: (logId) =>
    axios.get(`${API}/audit-logs/${logId}`, { headers: getAuthHeader() }),
  
  getAuditStats: () =>
    axios.get(`${API}/audit-logs/stats`, { headers: getAuthHeader() }),

  // Trash/Deleted Documents (Super Admin only)
  getTrash: () =>
    axios.get(`${API}/trash`, { headers: getAuthHeader() }),
  
  cleanupTrash: () =>
    axios.post(`${API}/trash/cleanup`, {}, { headers: getAuthHeader() }),
  
  restoreInvoice: (id) =>
    axios.post(`${API}/invoices/${id}/restore`, {}, { headers: getAuthHeader() }),
  
  permanentDeleteInvoice: (id) =>
    axios.delete(`${API}/invoices/${id}/permanent`, { headers: getAuthHeader() }),
  
  restoreQuotation: (id) =>
    axios.post(`${API}/quotations/${id}/restore`, {}, { headers: getAuthHeader() }),
  
  permanentDeleteQuotation: (id) =>
    axios.delete(`${API}/quotations/${id}/permanent`, { headers: getAuthHeader() }),
  
  restoreCashQuotation: (id) =>
    axios.post(`${API}/cash-quotations/${id}/restore`, {}, { headers: getAuthHeader() }),
  
  permanentDeleteCashQuotation: (id) =>
    axios.delete(`${API}/cash-quotations/${id}/permanent`, { headers: getAuthHeader() }),
  
  restoreRefund: (id) =>
    axios.post(`${API}/refunds/${id}/restore`, {}, { headers: getAuthHeader() }),
  
  permanentDeleteRefund: (id) =>
    axios.delete(`${API}/refunds/${id}/permanent`, { headers: getAuthHeader() }),
  
  restoreCreditNote: (id) =>
    axios.post(`${API}/credit_notes/${id}/restore`, {}, { headers: getAuthHeader() }),
  
  permanentDeleteCreditNote: (id) =>
    axios.delete(`${API}/credit_notes/${id}/permanent`, { headers: getAuthHeader() }),

  // Sales Targets
  getSalesTargets: (params = {}) =>
    axios.get(`${API}/sales-targets`, { headers: getAuthHeader(), params }),
  
  getCurrentSalesTarget: (showroomId = null) =>
    axios.get(`${API}/sales-targets/current`, { 
      headers: getAuthHeader(), 
      params: showroomId ? { showroom_id: showroomId } : {} 
    }),
  
  getAllTargetTypes: (showroomId = null, month = null, year = null) =>
    axios.get(`${API}/sales-targets/all-types`, { 
      headers: getAuthHeader(), 
      params: { 
        ...(showroomId && { showroom_id: showroomId }),
        ...(month && { month }),
        ...(year && { year })
      } 
    }),
  
  // Get targets for ALL showrooms at once
  getAllShowroomTargets: (month = null, year = null) =>
    axios.get(`${API}/sales-targets/all-showrooms`, { 
      headers: getAuthHeader(), 
      params: { 
        ...(month && { month }),
        ...(year && { year })
      } 
    }),
  
  // Get daily/weekly/monthly breakdown per showroom (Super Admin only)
  getShowroomsBreakdown: () =>
    axios.get(`${API}/analytics/showrooms-breakdown`, { headers: getAuthHeader() }),
  
  getTargetsHistory: (showroomId = null) =>
    axios.get(`${API}/sales-targets/history`, {
      headers: getAuthHeader(),
      params: showroomId ? { showroom_id: showroomId } : {}
    }),
  
  getTargetsReport: (month, year, showroomId = null) =>
    axios.get(`${API}/sales-targets/report`, {
      headers: getAuthHeader(),
      params: { month, year, ...(showroomId && { showroom_id: showroomId }) }
    }),
  
  createSalesTarget: (data) =>
    axios.post(`${API}/sales-targets`, data, { headers: getAuthHeader() }),
  
  deleteSalesTarget: (id) =>
    axios.delete(`${API}/sales-targets/${id}`, { headers: getAuthHeader() }),

  // Export endpoints
  exportCustomerPricingCsv: () =>
    axios.get(`${API}/export/customer-pricing/csv`, { 
      headers: getAuthHeader(), 
      responseType: 'blob' 
    }),
  
  exportAuditLogsCsv: (params = {}) =>
    axios.get(`${API}/export/audit-logs/csv`, { 
      headers: getAuthHeader(), 
      params,
      responseType: 'blob' 
    }),
  
  exportProfitReportCsv: (params = {}) =>
    axios.get(`${API}/export/profit-report/csv`, { 
      headers: getAuthHeader(), 
      params,
      responseType: 'blob' 
    }),

  // ============ DEVICE APPROVALS API ============
  
  getDeviceApprovals: () =>
    axios.get(`${API}/device-approvals`, { headers: getAuthHeader() }),
  
  approveDevice: (approvalId) =>
    axios.post(`${API}/device-approvals/${approvalId}/approve`, {}, { headers: getAuthHeader() }),
  
  rejectDevice: (approvalId) =>
    axios.post(`${API}/device-approvals/${approvalId}/reject`, {}, { headers: getAuthHeader() }),
  
  getApprovedDevices: () =>
    axios.get(`${API}/approved-devices`, { headers: getAuthHeader() }),
  
  revokeDevice: (deviceId) =>
    axios.delete(`${API}/approved-devices/${deviceId}`, { headers: getAuthHeader() }),

  // ============ SHOP E-COMMERCE API ============
  
  // Shop Products (Public - no auth required)
  shopGetProducts: (params = {}) =>
    axios.get(`${API}/shop/products`, { params }),
  
  shopGetProduct: (id) =>
    axios.get(`${API}/shop/products/${id}`),
  
  shopGetCategories: () =>
    axios.get(`${API}/shop/categories`),
  
  shopGetFeatured: (limit = 8) =>
    axios.get(`${API}/shop/featured`, { params: { limit } }),
  
  shopGetStores: () =>
    axios.get(`${API}/shop/stores`),
  
  // Shop Auth
  shopLogin: (data) =>
    axios.post(`${API}/shop/auth/login`, data),
  
  shopRegister: (data) =>
    axios.post(`${API}/shop/auth/register`, data),
  
  shopGetProfile: (token) =>
    axios.get(`${API}/shop/auth/me`, { headers: { Authorization: `Bearer ${token}` } }),
  
  // Shop Cart
  shopGetCart: (token) =>
    axios.get(`${API}/shop/cart`, { headers: { Authorization: `Bearer ${token}` } }),
  
  shopAddToCart: (token, item) =>
    axios.post(`${API}/shop/cart/add`, item, { headers: { Authorization: `Bearer ${token}` } }),
  
  shopUpdateCart: (token, productId, quantity) =>
    axios.put(`${API}/shop/cart/update`, null, { 
      headers: { Authorization: `Bearer ${token}` },
      params: { product_id: productId, quantity }
    }),
  
  shopRemoveFromCart: (token, productId) =>
    axios.delete(`${API}/shop/cart/remove/${productId}`, { headers: { Authorization: `Bearer ${token}` } }),
  
  shopClearCart: (token) =>
    axios.delete(`${API}/shop/cart/clear`, { headers: { Authorization: `Bearer ${token}` } }),
  
  // Shop Wishlist
  shopGetWishlist: (token) =>
    axios.get(`${API}/shop/wishlist`, { headers: { Authorization: `Bearer ${token}` } }),
  
  shopAddToWishlist: (token, productId) =>
    axios.post(`${API}/shop/wishlist/add/${productId}`, {}, { headers: { Authorization: `Bearer ${token}` } }),
  
  shopRemoveFromWishlist: (token, productId) =>
    axios.delete(`${API}/shop/wishlist/remove/${productId}`, { headers: { Authorization: `Bearer ${token}` } }),
  
  // Shop Orders
  shopCreateOrder: (token, data) =>
    axios.post(`${API}/shop/orders`, data, { headers: { Authorization: `Bearer ${token}` } }),
  
  shopGetOrders: (token) =>
    axios.get(`${API}/shop/orders`, { headers: { Authorization: `Bearer ${token}` } }),
  
  shopGetOrder: (token, orderId) =>
    axios.get(`${API}/shop/orders/${orderId}`, { headers: { Authorization: `Bearer ${token}` } }),
  
  // Shop Checkout (Stripe)
  shopCreateCheckoutSession: (token, data) =>
    axios.post(`${API}/shop/checkout/create-session`, data, { headers: { Authorization: `Bearer ${token}` } }),
  
  shopGetCheckoutStatus: (sessionId) =>
    axios.get(`${API}/shop/checkout/status/${sessionId}`),

  // Guest Checkout (no auth required)
  shopCreateGuestOrder: (data) =>
    axios.post(`${API}/shop/guest/orders`, data),
  
  shopCreateGuestCheckoutSession: (data) =>
    axios.post(`${API}/shop/guest/checkout/create-session`, data),

  // Order Tracking (public)
  shopTrackOrder: (orderNumber, email) =>
    axios.get(`${API}/shop/track/${orderNumber}`, { params: { email } }),

  // Shop Order Status (admin)
  shopUpdateOrderStatus: (orderId, data) =>
    axios.put(`${API}/shop/orders/${orderId}/status`, data, { headers: getAuthHeader() }),

  // Product Reviews
  shopGetProductReviews: (productId, params = {}) =>
    axios.get(`${API}/shop/products/${productId}/reviews`, { params }),
  
  shopCreateProductReview: (token, productId, data) =>
    axios.post(`${API}/shop/products/${productId}/reviews`, data, { headers: { Authorization: `Bearer ${token}` } }),
  
  shopMarkReviewHelpful: (reviewId) =>
    axios.post(`${API}/shop/reviews/${reviewId}/helpful`),

  // Tile Calculator
  shopCalculateTiles: (data) =>
    axios.post(`${API}/shop/calculator/tiles`, data),
  
  shopQuickEstimate: (length, width, wastage = 10) =>
    axios.get(`${API}/shop/calculator/estimate`, { params: { length, width, wastage } }),

  // ============ PRODUCT DOCUMENTS API ============
  getProductDocuments: (supplier, sku) =>
    axios.get(`${API}/product-documents/by-product/${encodeURIComponent(supplier)}/${encodeURIComponent(sku)}`),

  getProductDocumentsBulk: (productKeys) =>
    axios.post(`${API}/product-documents/by-products`, { product_keys: productKeys }, { headers: getAuthHeader() }),

  uploadProductDocument: (formData) =>
    axios.post(`${API}/product-documents/upload`, formData, {
      headers: { ...getAuthHeader(), 'Content-Type': 'multipart/form-data' },
    }),

  deleteProductDocument: (docId) =>
    axios.delete(`${API}/product-documents/${docId}`, { headers: getAuthHeader() }),

  updateProductDocument: (docId, data) =>
    axios.patch(`${API}/product-documents/${docId}`, data, { headers: getAuthHeader() }),

  attachProductDocument: (docId, productKeys) =>
    axios.post(`${API}/product-documents/${docId}/attach`, { product_keys: productKeys }, { headers: getAuthHeader() }),

  detachProductDocument: (docId, productKeys) =>
    axios.post(`${API}/product-documents/${docId}/detach`, { product_keys: productKeys }, { headers: getAuthHeader() }),

  getDocumentTypes: () =>
    axios.get(`${API}/product-documents/types/list`),
};