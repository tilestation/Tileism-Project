import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { 
  MapPin, 
  Phone, 
  Mail, 
  Clock, 
  ChevronRight,
  Send,
  Building2,
  Navigation,
  MessageSquare,
  Loader2,
  CheckCircle,
  Globe,
  Headphones
} from 'lucide-react';
import { usePageTracking } from '../../hooks/usePageTracking';
import LiveChatWidget from '../../components/shop/LiveChatWidget';
import SeoHead from '../../components/seo/SeoHead';
import { trackConversion } from '../../utils/gtag';

const API_URL = process.env.REACT_APP_BACKEND_URL || '';

export default function ContactPage() {
  const [showrooms, setShowrooms] = useState([]);
  const [loading, setLoading] = useState(true);
  // `contactSettings` holds the advanced multi-email config (orders@,
  // quotes@, general@). `footerSettings` holds the site-wide phone + email
  // managed from Homepage Manager → Footer. We prefer footerSettings as
  // the single source of truth so a single edit cascades to BOTH the
  // site footer AND the Contact page "Call Us" / email cards.
  const [contactSettings, setContactSettings] = useState({ phone: '', whatsapp: '', emails: [] });
  const [footerSettings, setFooterSettings] = useState({ phone: '', email: '' });
  const [chatSettings, setChatSettings] = useState({ enabled: true });
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    phone: '',
    subject: '',
    message: '',
    showroom: ''
  });
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [holidays, setHolidays] = useState([]);
  
  usePageTracking();

  useEffect(() => {
    fetchShowrooms();
    fetchContactSettings();
    fetchFooterSettings();
    fetchChatSettings();
  }, []);

  const fetchShowrooms = async () => {
    try {
      const res = await fetch(`${API_URL}/api/website-admin/showrooms/public`);
      if (res.ok) {
        const data = await res.json();
        setShowrooms(data.showrooms || []);
        setHolidays(data.holidays || []);
      }
    } catch (error) {
      console.error('Error fetching showrooms:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchContactSettings = async () => {
    try {
      const res = await fetch(`${API_URL}/api/website-admin/contact-settings/public`);
      if (res.ok) {
        const data = await res.json();
        setContactSettings(data);
      }
    } catch (error) {
      console.error('Error fetching contact settings:', error);
    }
  };

  // Homepage Manager → Footer is the single source of truth for the
  // customer-facing phone + email. A single edit there now cascades to the
  // site footer (via ShopLayout) AND the Contact page cards below.
  const fetchFooterSettings = async () => {
    try {
      const res = await fetch(`${API_URL}/api/website-admin/footer-settings`);
      if (res.ok) {
        const data = await res.json();
        const s = (data && data.settings) || {};
        setFooterSettings({ phone: s.phone || '', email: s.email || '' });
      }
    } catch (error) {
      console.error('Error fetching footer settings:', error);
    }
  };

  const fetchChatSettings = async () => {
    try {
      const res = await fetch(`${API_URL}/api/live-chat/settings/public`);
      if (res.ok) {
        const data = await res.json();
        setChatSettings(data);
      }
    } catch (error) {
      console.error('Error fetching chat settings:', error);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSending(true);
    await new Promise(resolve => setTimeout(resolve, 1500));
    setSent(true);
    setSending(false);
    setFormData({ name: '', email: '', phone: '', subject: '', message: '', showroom: '' });
    setTimeout(() => setSent(false), 5000);
  };

  const formatOpeningHours = (hours) => {
    if (!hours || Object.keys(hours).length === 0) return null;
    const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
    const weekdayHours = weekdays.map(d => hours[d] || 'Closed');
    const allWeekdaysSame = weekdayHours.every(h => h === weekdayHours[0]);
    
    const result = [];
    if (allWeekdaysSame) {
      result.push({ label: 'Mon - Fri', hours: weekdayHours[0] });
    } else {
      // Group consecutive days with same hours
      let i = 0;
      const shortDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
      while (i < 5) {
        let j = i;
        while (j < 4 && weekdayHours[j + 1] === weekdayHours[i]) j++;
        const label = i === j ? shortDays[i] : `${shortDays[i]} - ${shortDays[j]}`;
        result.push({ label, hours: weekdayHours[i] });
        i = j + 1;
      }
    }
    result.push({ label: 'Saturday', hours: hours.saturday || 'Closed' });
    result.push({ label: 'Sunday', hours: hours.sunday || 'Closed' });
    return result;
  };

  const getTodayHoliday = () => {
    const today = new Date().toISOString().split('T')[0];
    return holidays.find(h => h.date === today);
  };

  // Resolve the customer-facing phone + default email with footer_settings
  // as the primary source of truth (what the admin manages in Homepage
  // Manager → Footer). Fall back to contact_settings only when footer
  // values are blank — so legacy configs still render something sensible.
  const resolvedPhone = footerSettings.phone || contactSettings.phone || '';
  const resolvedEmails = (() => {
    const adminEmails = (contactSettings.emails || []).filter(e => e.visible !== false);
    if (adminEmails.length > 0) return adminEmails;
    if (footerSettings.email) {
      return [{ label: 'General Enquiries', email: footerSettings.email }];
    }
    return [];
  })();
  const hasContactInfo = resolvedPhone || contactSettings.whatsapp || resolvedEmails.length > 0;

  return (
    <div className="min-h-screen bg-gray-50" data-testid="contact-page">
      {/* SEO parity for SPA navigation — Express SSR injects equivalent
          tags on first paint, but client-side route changes need React
          to set the head. Title/desc kept in sync with server-seo.js
          `/shop/contact` EXACT entry. */}
      <SeoHead
        title="Contact Us · Tile Station Tile Showrooms"
        description="Visit our Tonbridge, Chingford, Gravesend or Sydenham tile showrooms, or contact our trade team for project quotes and UK-wide delivery pricing."
        canonical="/shop/contact"
      />
      {/* Hero Section */}
      <div className="relative bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 text-white">
        <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCA2MCA2MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBmaWxsPSJub25lIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiPjxnIGZpbGw9IiNmZmYiIGZpbGwtb3BhY2l0eT0iMC4wMyI+PHBhdGggZD0iTTM2IDM0djItSDI0di0yaDEyek0zNiAyNHYySDI0di0yaDEyeiIvPjwvZz48L2c+PC9zdmc+')] opacity-50"></div>
        <div className="relative max-w-7xl mx-auto px-4 py-20 sm:py-28">
          <div className="text-center">
            <h1 className="text-3xl sm:text-4xl lg:text-6xl font-bold mb-4 sm:mb-6">
              Contact <span className="text-amber-400">Us</span>
            </h1>
            <p className="text-xl text-gray-300 max-w-2xl mx-auto">
              Visit our showrooms, reach out online, or send us a message. 
              Our expert team is ready to help with your project.
            </p>
          </div>
        </div>
        <div className="absolute bottom-0 left-0 right-0">
          <svg viewBox="0 0 1440 120" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M0 120L60 110C120 100 240 80 360 70C480 60 600 60 720 65C840 70 960 80 1080 85C1200 90 1320 90 1380 90L1440 90V120H1380C1320 120 1200 120 1080 120C960 120 840 120 720 120C600 120 480 120 360 120C240 120 120 120 60 120H0Z" fill="#f9fafb"/>
          </svg>
        </div>
      </div>

      {/* Online Enquiries Section */}
      {hasContactInfo && (
        <div className="max-w-7xl mx-auto px-4 pt-16 pb-8" data-testid="online-enquiries-section">
          <div className="text-center mb-10">
            <div className="inline-flex items-center gap-2 bg-amber-100 text-amber-800 px-4 py-1.5 rounded-full text-sm font-semibold mb-4">
              <Headphones className="w-4 h-4" />
              Get In Touch Online
            </div>
            <h2 className="text-3xl font-bold text-gray-900 mb-3">Online Enquiries</h2>
            <p className="text-gray-600 max-w-xl mx-auto">
              Reach the right department directly — whether it's a new order, a quote request, or a general question.
            </p>
          </div>

          <div className="max-w-4xl mx-auto">
            <div className={`grid gap-5 ${
              resolvedPhone && resolvedEmails.length > 0
                ? 'md:grid-cols-2' 
                : 'md:grid-cols-1 max-w-lg mx-auto'
            }`}>
              {/* Phone Card */}
              {resolvedPhone && contactSettings.phone_visible !== false && (
                <a
                  href={`tel:${String(resolvedPhone).replace(/\s+/g, '')}`}
                  className="group bg-white rounded-2xl border border-gray-100 p-6 hover:shadow-lg hover:border-amber-200 transition-all flex items-center gap-5"
                  data-testid="enquiry-phone-card"
                >
                  <div className="w-14 h-14 bg-gradient-to-br from-amber-400 to-orange-500 rounded-2xl flex items-center justify-center flex-shrink-0 group-hover:scale-110 transition-transform">
                    <Phone className="w-6 h-6 text-white" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-500 mb-0.5">Call Us</p>
                    <p className="text-xl font-bold text-gray-900 group-hover:text-amber-600 transition-colors">{resolvedPhone}</p>
                  </div>
                </a>
              )}

              {/* WhatsApp Card */}
              {contactSettings.whatsapp && contactSettings.whatsapp_visible !== false && (
                <a
                  href={`https://wa.me/${contactSettings.whatsapp.replace(/[^0-9+]/g, '')}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group bg-white rounded-2xl border border-gray-100 p-6 hover:shadow-lg hover:border-green-200 transition-all flex items-center gap-5"
                  data-testid="enquiry-whatsapp-card"
                >
                  <div className="w-14 h-14 bg-gradient-to-br from-green-400 to-green-600 rounded-2xl flex items-center justify-center flex-shrink-0 group-hover:scale-110 transition-transform">
                    <svg className="w-6 h-6 text-white" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                    </svg>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-500 mb-0.5">WhatsApp</p>
                    <p className="text-xl font-bold text-gray-900 group-hover:text-green-600 transition-colors">{contactSettings.whatsapp}</p>
                    <p className="text-xs text-gray-400 mt-0.5" data-testid="whatsapp-text-only-note">Text only</p>
                  </div>
                </a>
              )}

              {/* Email Cards */}
              {resolvedEmails.map((entry, i) => (
                <a
                  key={i}
                  href={`mailto:${entry.email}`}
                  className="group bg-white rounded-2xl border border-gray-100 p-6 hover:shadow-lg hover:border-amber-200 transition-all flex items-center gap-5"
                  data-testid={`enquiry-email-card-${i}`}
                >
                  <div className="w-14 h-14 bg-gradient-to-br from-slate-700 to-slate-900 rounded-2xl flex items-center justify-center flex-shrink-0 group-hover:scale-110 transition-transform">
                    <Mail className="w-6 h-6 text-white" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-500 mb-0.5">{entry.label || 'Email'}</p>
                    <p className="text-lg font-bold text-gray-900 group-hover:text-amber-600 transition-colors truncate">{entry.email}</p>
                  </div>
                </a>
              ))}

              {/* Live Chat Card */}
              {chatSettings.enabled && (
                <button
                  onClick={() => {
                    const widget = document.querySelector('[data-testid="chat-widget-button"]');
                    if (widget) { widget.click(); return; }
                    // Fallback: try any chat button
                    const fallback = document.querySelector('.fixed button[class*="rounded-full"]');
                    if (fallback) fallback.click();
                  }}
                  className="group bg-white rounded-2xl border border-gray-100 p-6 hover:shadow-lg hover:border-blue-200 transition-all flex items-center gap-5 text-left"
                  data-testid="enquiry-livechat-card"
                >
                  <div className="w-14 h-14 bg-gradient-to-br from-blue-500 to-blue-700 rounded-2xl flex items-center justify-center flex-shrink-0 group-hover:scale-110 transition-transform">
                    <MessageSquare className="w-6 h-6 text-white" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-500 mb-0.5">Live Chat</p>
                    <p className="text-lg font-bold text-gray-900 group-hover:text-blue-600 transition-colors">Chat with us now</p>
                  </div>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Showrooms Grid */}
      <div className="max-w-7xl mx-auto px-4 py-16" data-testid="showrooms-section">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold text-gray-900 mb-4">Our Showrooms</h2>
          <p className="text-gray-600 max-w-2xl mx-auto">
            Open 7 days a week. Trade & public welcome. Free parking available at all locations.
          </p>
          
          {getTodayHoliday() && (
            <div className="mt-4 inline-flex items-center gap-2 bg-amber-100 text-amber-800 px-4 py-2 rounded-full text-sm font-medium">
              <span>Today is {getTodayHoliday().name} - Check individual stores for holiday hours</span>
            </div>
          )}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
          </div>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-2 gap-8">
            {showrooms.map((showroom) => (
              <ShowroomCard 
                key={showroom.id} 
                showroom={showroom} 
                formatOpeningHours={formatOpeningHours}
                holidays={holidays}
              />
            ))}
          </div>
        )}
      </div>

      {/* Contact Form Section */}
      <div className="bg-white py-16" data-testid="contact-form-section">
        <div className="max-w-7xl mx-auto px-4">
          <div className="grid lg:grid-cols-2 gap-8 lg:gap-12 items-start">
            {/* Form */}
            <div className="bg-gray-50 rounded-2xl p-5 sm:p-8 shadow-sm">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-12 h-12 bg-amber-100 rounded-xl flex items-center justify-center">
                  <MessageSquare className="w-6 h-6 text-amber-600" />
                </div>
                <div>
                  <h3 className="text-2xl font-bold text-gray-900">Send a Message</h3>
                  <p className="text-gray-600">We'd love to hear from you</p>
                </div>
              </div>

              {sent && (
                <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg flex items-center gap-3">
                  <CheckCircle className="w-5 h-5 text-green-600" />
                  <span className="text-green-700">Thank you! We'll get back to you soon.</span>
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4" data-testid="contact-form">
                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Your Name *</label>
                    <input
                      type="text"
                      required
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      className="w-full px-4 py-3 rounded-lg border border-gray-200 focus:ring-2 focus:ring-amber-500 focus:border-amber-500 transition-colors"
                      placeholder="John Smith"
                      data-testid="contact-name"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Email *</label>
                    <input
                      type="email"
                      required
                      value={formData.email}
                      onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                      className="w-full px-4 py-3 rounded-lg border border-gray-200 focus:ring-2 focus:ring-amber-500 focus:border-amber-500 transition-colors"
                      placeholder="john@example.com"
                      data-testid="contact-email"
                    />
                  </div>
                </div>

                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
                    <input
                      type="tel"
                      value={formData.phone}
                      onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                      className="w-full px-4 py-3 rounded-lg border border-gray-200 focus:ring-2 focus:ring-amber-500 focus:border-amber-500 transition-colors"
                      placeholder="07123 456789"
                      data-testid="contact-phone"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Preferred Showroom</label>
                    <select
                      value={formData.showroom}
                      onChange={(e) => setFormData({ ...formData, showroom: e.target.value })}
                      className="w-full px-4 py-3 rounded-lg border border-gray-200 focus:ring-2 focus:ring-amber-500 focus:border-amber-500 transition-colors"
                      data-testid="contact-showroom"
                    >
                      <option value="">Select a showroom</option>
                      {showrooms.filter(s => !s.is_coming_soon).map(s => (
                        <option key={s.id} value={s.name}>{s.name}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Subject *</label>
                  <input
                    type="text"
                    required
                    value={formData.subject}
                    onChange={(e) => setFormData({ ...formData, subject: e.target.value })}
                    className="w-full px-4 py-3 rounded-lg border border-gray-200 focus:ring-2 focus:ring-amber-500 focus:border-amber-500 transition-colors"
                    placeholder="How can we help?"
                    data-testid="contact-subject"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Message *</label>
                  <textarea
                    required
                    rows={5}
                    value={formData.message}
                    onChange={(e) => setFormData({ ...formData, message: e.target.value })}
                    className="w-full px-4 py-3 rounded-lg border border-gray-200 focus:ring-2 focus:ring-amber-500 focus:border-amber-500 transition-colors resize-none"
                    placeholder="Tell us about your project..."
                    data-testid="contact-message"
                  />
                </div>

                <button
                  type="submit"
                  disabled={sending}
                  className="w-full bg-amber-500 hover:bg-amber-600 text-white font-semibold py-4 px-6 rounded-lg transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                  data-testid="contact-submit"
                >
                  {sending ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    <>
                      <Send className="w-5 h-5" />
                      Send Message
                    </>
                  )}
                </button>
              </form>
            </div>

            {/* Info Cards */}
            <div className="space-y-6">
              <div className="bg-gradient-to-br from-amber-50 to-orange-50 rounded-2xl p-8 border border-amber-100">
                <h3 className="text-xl font-bold text-gray-900 mb-4">Why Visit Our Showrooms?</h3>
                <ul className="space-y-3">
                  {[
                    'See and feel tiles before you buy',
                    'Expert advice from our friendly team',
                    'Exclusive trade discounts available',
                    'Free samples to take home',
                    'Large format tile specialists',
                    'Bathroom design consultation'
                  ].map((item, idx) => (
                    <li key={idx} className="flex items-center gap-3">
                      <CheckCircle className="w-5 h-5 text-amber-600 flex-shrink-0" />
                      <span className="text-gray-700">{item}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="bg-gray-900 rounded-2xl p-8 text-white">
                <h3 className="text-xl font-bold mb-4">Trade Customers</h3>
                <p className="text-gray-300 mb-6">
                  Join thousands of trade professionals who trust Tile Station for competitive prices, 
                  reliable stock, and exceptional service.
                </p>
                <Link
                  to="/shop/trade/signup"
                  className="inline-flex items-center gap-2 bg-amber-500 hover:bg-amber-600 text-white px-6 py-3 rounded-lg font-semibold transition-colors"
                >
                  Open Trade Account
                  <ChevronRight className="w-4 h-4" />
                </Link>
              </div>

              <div className="bg-blue-50 rounded-2xl p-8 border border-blue-100">
                <h3 className="text-xl font-bold text-gray-900 mb-2">Need a Quick Quote?</h3>
                <p className="text-gray-600 mb-4">
                  Browse our online collection and request a quote directly from any product page.
                </p>
                <Link
                  to="/tiles"
                  className="inline-flex items-center gap-2 text-blue-600 font-semibold hover:text-blue-700"
                >
                  Browse Tiles
                  <ChevronRight className="w-4 h-4" />
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Footer CTA */}
      <div className="bg-gray-900 py-12">
        <div className="max-w-4xl mx-auto px-4 text-center">
          <h3 className="text-2xl font-bold text-white mb-4">
            Can't Visit? Shop Online 24/7
          </h3>
          <p className="text-gray-400 mb-6">
            Browse thousands of tiles, get instant quotes, and enjoy nationwide delivery.
          </p>
          <Link
            to="/shop"
            className="inline-flex items-center gap-2 bg-amber-500 hover:bg-amber-600 text-white px-8 py-4 rounded-lg font-semibold transition-colors"
          >
            Shop Online
            <ChevronRight className="w-5 h-5" />
          </Link>
        </div>
      </div>
      
      <LiveChatWidget />
    </div>
  );
}

function ShowroomCard({ showroom, formatOpeningHours, holidays = [] }) {
  const hours = formatOpeningHours(showroom.opening_hours);
  
  const getGoogleMapsUrl = () => {
    const query = encodeURIComponent(`${showroom.address}, ${showroom.city} ${showroom.postcode}`);
    return `https://www.google.com/maps/search/?api=1&query=${query}`;
  };

  const getGoogleMapsEmbedUrl = () => {
    const query = encodeURIComponent(`${showroom.name} Tile Station, ${showroom.address}, ${showroom.city} ${showroom.postcode}`);
    return `https://www.google.com/maps?q=${query}&output=embed`;
  };

  const today = new Date().toISOString().split('T')[0];
  const todayHoliday = holidays.find(h => h.date === today);
  const holidayHoursToday = showroom.holiday_hours?.[today];

  const upcomingHolidayHours = holidays.filter(h => {
    const holidayDate = new Date(h.date);
    const thirtyDaysFromNow = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    return holidayDate >= new Date() && holidayDate <= thirtyDaysFromNow && showroom.holiday_hours?.[h.date];
  }).slice(0, 3);

  return (
    <div className={`bg-white rounded-2xl overflow-hidden shadow-sm border border-gray-100 hover:shadow-lg transition-all ${
      showroom.is_coming_soon ? 'opacity-90' : ''
    }`} data-testid={`showroom-card-${showroom.id}`}>
      <div className="relative bg-gray-100">
        {showroom.image_url ? (
          <img 
            src={showroom.image_url} 
            alt={showroom.name}
            className="w-full h-72 object-cover"
            style={{ objectPosition: `${showroom.image_position_x ?? 50}% ${showroom.image_position_y ?? 50}%` }}
          />
        ) : (
          <div className="h-72 bg-gray-100 flex items-center justify-center">
            <Building2 className="w-16 h-16 text-gray-400" />
          </div>
        )}
        
        {showroom.is_coming_soon && (
          <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
            <div className="bg-amber-500 text-white px-6 py-3 rounded-full font-bold text-lg">
              Coming Soon
            </div>
          </div>
        )}
      </div>

      <div className="p-6">
        <h3 className="text-xl font-bold text-gray-900 mb-3">{showroom.name}</h3>
        
        {!showroom.is_coming_soon ? (
          <>
            {todayHoliday && holidayHoursToday && (
              <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                <p className="text-sm font-medium text-amber-800">
                  {todayHoliday.name} Hours: <span className="font-bold">{holidayHoursToday}</span>
                </p>
              </div>
            )}

            <div className="flex items-start gap-3 mb-3">
              <MapPin className="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-gray-700">{showroom.address}</p>
                <p className="text-gray-700">{showroom.city} {showroom.postcode}</p>
              </div>
            </div>

            {showroom.phone && (
              <a 
                href={`tel:${showroom.phone}`}
                className="flex items-center gap-3 mb-3 text-gray-700 hover:text-amber-600 transition-colors"
              >
                <Phone className="w-5 h-5 text-gray-400" />
                <span className="font-medium">{showroom.phone}</span>
              </a>
            )}

            {showroom.email && (
              <a 
                href={`mailto:${showroom.email}`}
                className="flex items-center gap-3 mb-4 text-gray-700 hover:text-amber-600 transition-colors"
              >
                <Mail className="w-5 h-5 text-gray-400" />
                <span>{showroom.email}</span>
              </a>
            )}

            {hours && (
              <div className="mb-4">
                <div className="flex items-center gap-2 mb-2">
                  <Clock className="w-5 h-5 text-gray-400" />
                  <span className="font-medium text-gray-900">Opening Hours</span>
                </div>
                <div className="space-y-1 text-sm">
                  {hours.map(({ label, hours: h }) => (
                    <div key={label} className="flex justify-between">
                      <span className="text-gray-500">{label}</span>
                      <span className="text-gray-700 font-medium">{h}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {upcomingHolidayHours.length > 0 && (
              <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                <p className="text-xs font-medium text-blue-800 mb-2">Upcoming Holiday Hours:</p>
                {upcomingHolidayHours.map(h => (
                  <div key={h.date} className="flex justify-between text-xs text-blue-700">
                    <span>{h.name}</span>
                    <span className="font-medium">{showroom.holiday_hours[h.date]}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="mb-4 rounded-lg overflow-hidden border border-gray-200">
              <iframe
                title={`Map of ${showroom.name}`}
                src={getGoogleMapsEmbedUrl()}
                width="100%"
                height="200"
                style={{ border: 0 }}
                allowFullScreen=""
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
              />
            </div>

            <div className="flex gap-3 pt-4 border-t">
              <a
                href={getGoogleMapsUrl()}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => trackConversion('get_directions')}
                className="flex-1 bg-gray-900 hover:bg-gray-800 text-white py-3 px-4 rounded-lg font-medium flex items-center justify-center gap-2 transition-colors"
                data-testid={`get-directions-btn-${showroom.id || showroom.slug || 'default'}`}
              >
                <Navigation className="w-4 h-4" />
                Get Directions
              </a>
              {showroom.phone && (
                <a
                  href={`tel:${showroom.phone}`}
                  className="bg-amber-500 hover:bg-amber-600 text-white py-3 px-4 rounded-lg font-medium flex items-center justify-center gap-2 transition-colors"
                >
                  <Phone className="w-4 h-4" />
                  Call
                </a>
              )}
            </div>
          </>
        ) : (
          <div className="text-center py-4">
            <p className="text-gray-600 mb-4">We're opening a new showroom in {showroom.city}!</p>
            <p className="text-sm text-gray-500">Stay tuned for more details.</p>
          </div>
        )}
      </div>
    </div>
  );
}
