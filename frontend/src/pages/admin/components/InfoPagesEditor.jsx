import React, { useState, useEffect, useCallback } from 'react';
import { 
  Save, Plus, Trash2, GripVertical, ChevronDown, ChevronUp, Type, 
  Table, HelpCircle, LayoutGrid, Loader2, Eye, EyeOff, Edit2, FileText
} from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { Textarea } from '../../../components/ui/textarea';
import { toast } from 'sonner';

const API_URL = process.env.REACT_APP_BACKEND_URL;

// Default info pages with pre-populated content
const DEFAULT_PAGES = [
  {
    slug: 'delivery',
    title: 'Delivery Information',
    enabled: true,
    sections: [
      {
        id: 'delivery-cards',
        type: 'cards',
        title: 'Delivery Highlights',
        cards: [
          { title: 'Delivery Date', description: 'At the checkout, choose a delivery date that works for you', icon: 'Calendar' },
          { title: 'Truck Access', description: 'Access must be obstacle-free, wide enough and flat for a safe delivery', icon: 'Truck' },
          { title: 'No Loose Surfaces', description: 'Surfaces must be hard and flat; tarmac, concrete or block paving', icon: 'Shield' },
          { title: 'Express Delivery', description: 'Need your tiles quicker? Upgrade to Express Delivery', icon: 'Zap' },
        ]
      },
      {
        id: 'delivery-times',
        type: 'text',
        title: 'Delivery Times',
        content: 'We aim to deliver all orders within 2-3 working days from Monday to Friday excluding Saturday and Sunday.\n\nPlease note that orders containing multiple samples or underfloor heating products will be delivered separately.'
      },
      {
        id: 'delivery-rates',
        type: 'table',
        title: 'Delivery Rates',
        rows: [
          { description: 'UK online orders over £299 (excluding Scotland)', price: 'FREE' },
          { description: 'Free Cut Sample Delivery', price: 'FREE' },
          { description: 'Small Full-Size Sample (Parcel up to 2 KG)', price: '£0.99' },
          { description: 'Small Orders (Less Than 18 Kg)', price: '£11.99' },
          { description: 'Pallet Delivery for orders under £299', price: 'Calculated at checkout' },
        ]
      },
      {
        id: 'delivery-conditions',
        type: 'text',
        title: 'Delivery Conditions',
        content: 'Most deliveries are made on pallets and are delivered "kerbside". This means your tiles will be left secured to the pallet at the nearest external location of your property which has a flat hard surface.\n\nThe pallet is manoeuvred using a hand pump truck that cannot operate on soft ground or loose gravel. The driver will not be able to assist in unloading or bringing goods inside.\n\nSome tile boxes weigh more than 30kg each — we recommend arranging help on the day of delivery.\n\nWe strongly recommend ordering tiles well in advance of your planned installation date.\n\nFailed deliveries will incur a redelivery charge per pallet determined by the logistics company.'
      }
    ]
  },
  {
    slug: 'returns',
    title: 'Returns & Refunds',
    enabled: true,
    sections: [
      {
        id: 'returns-overview',
        type: 'text',
        title: 'Returns Policy',
        content: 'We want you to be completely happy with your purchase. If you are not satisfied, you may return unused products within 30 days of delivery for a full refund.\n\nAll returned items must be in their original, unopened packaging and in resalable condition.'
      },
      {
        id: 'returns-process',
        type: 'cards',
        title: 'How to Return',
        cards: [
          { title: 'Step 1: Contact Us', description: 'Email or call our customer service team to arrange a return', icon: 'Phone' },
          { title: 'Step 2: Pack Securely', description: 'Ensure items are in original packaging and securely wrapped', icon: 'Package' },
          { title: 'Step 3: Collection', description: 'We will arrange collection or provide a drop-off address', icon: 'Truck' },
          { title: 'Step 4: Refund', description: 'Refund processed within 5-10 working days of receiving goods', icon: 'CreditCard' },
        ]
      },
      {
        id: 'returns-conditions',
        type: 'text',
        title: 'Conditions',
        content: 'Items must be unused and in original packaging.\n\nCut samples and items made to order cannot be returned.\n\nReturn shipping costs may apply for change-of-mind returns.\n\nDamaged or faulty items will be replaced or refunded at no extra cost — please report within 48 hours of delivery with photos.'
      }
    ]
  },
  {
    slug: 'faq',
    title: 'Frequently Asked Questions',
    enabled: true,
    sections: [
      {
        id: 'faq-list',
        type: 'faq',
        title: 'Common Questions',
        items: [
          { question: 'How long does delivery take?', answer: 'Standard delivery is 2-3 working days. Express (next day) is available for selected suppliers.' },
          { question: 'Do you offer free delivery?', answer: 'Yes, free delivery on all orders over £299 to UK mainland (excluding Scotland).' },
          { question: 'Can I collect from a showroom?', answer: 'Yes, free store collection is available from all our showrooms.' },
          { question: 'What is your returns policy?', answer: 'Unused items in original packaging can be returned within 30 days for a full refund.' },
          { question: 'Do you offer trade accounts?', answer: 'Yes! Trade accounts receive exclusive discounts, credit back rewards, and priority service.' },
        ]
      }
    ]
  },
  {
    slug: 'contact',
    title: 'Contact Us',
    enabled: true,
    sections: [
      {
        id: 'contact-info',
        type: 'text',
        title: 'Get In Touch',
        content: 'We would love to hear from you. Whether you have a question about products, pricing, delivery, or anything else, our team is ready to help.\n\nPhone: 01732 424242\nEmail: info@tilestation.co.uk\n\nOpening Hours: Monday - Saturday 9am - 5:30pm, Sunday 10am - 4pm'
      },
      {
        id: 'showrooms',
        type: 'cards',
        title: 'Our Showrooms',
        cards: [
          { title: 'Tonbridge', description: 'Open 7 days a week\nMonday - Saturday: 9am - 5:30pm\nSunday: 10am - 4pm', icon: 'MapPin' },
          { title: 'Gravesend', description: 'Open 7 days a week\nMonday - Saturday: 9am - 5:30pm\nSunday: 10am - 4pm', icon: 'MapPin' },
        ]
      }
    ]
  },
  {
    slug: 'track',
    title: 'Track Your Order',
    enabled: true,
    sections: [
      {
        id: 'track-info',
        type: 'text',
        title: 'Order Tracking',
        content: 'Once your order has been dispatched, you will receive a confirmation email with tracking details.\n\nIf you have not received your tracking email, please check your spam folder or contact us with your order number.\n\nFor any delivery queries, please contact our customer service team on 01732 424242.'
      }
    ]
  },
  {
    slug: 'privacy',
    title: 'Privacy Policy',
    enabled: true,
    sections: [
      {
        id: 'privacy-info',
        type: 'text',
        title: 'Privacy Policy',
        content: 'We are committed to protecting your personal information and your right to privacy.\n\nWe collect personal information that you voluntarily provide to us when you register, make a purchase, or contact us.\n\nWe use your information to process orders, communicate with you, and improve our services.\n\nWe do not sell your personal data to third parties.\n\nYou have the right to access, correct, or delete your personal data at any time by contacting us.'
      }
    ]
  },
  {
    slug: 'terms',
    title: 'Terms & Conditions',
    enabled: true,
    sections: [
      {
        id: 'terms-info',
        type: 'text',
        title: 'Terms & Conditions',
        content: 'By using our website and placing an order, you agree to these terms and conditions.\n\nAll prices are inclusive of VAT unless otherwise stated.\n\nWe reserve the right to refuse or cancel any order at our discretion.\n\nImages are for illustration purposes only — actual products may vary slightly in colour and texture.\n\nFor full terms regarding delivery, returns, and warranties, please refer to the relevant information pages.'
      }
    ]
  }
];

const SECTION_TYPES = [
  { value: 'text', label: 'Rich Text', icon: Type, description: 'Paragraphs, headings, lists' },
  { value: 'cards', label: 'Info Cards', icon: LayoutGrid, description: 'Cards with icon, title & description' },
  { value: 'table', label: 'Pricing Table', icon: Table, description: 'Two-column table (item + price)' },
  { value: 'faq', label: 'FAQ Accordion', icon: HelpCircle, description: 'Question & answer pairs' },
];

export default function InfoPagesEditor() {
  const [pages, setPages] = useState([]);
  const [activePage, setActivePage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [expandedSections, setExpandedSections] = useState({});

  const fetchPages = useCallback(async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/info-pages`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.pages && data.pages.length > 0) {
          // Merge defaults with saved pages
          const merged = DEFAULT_PAGES.map(def => {
            const saved = data.pages.find(p => p.slug === def.slug);
            return saved || def;
          });
          setPages(merged);
        } else {
          setPages(DEFAULT_PAGES);
        }
      } else {
        setPages(DEFAULT_PAGES);
      }
    } catch {
      setPages(DEFAULT_PAGES);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchPages(); }, [fetchPages]);

  useEffect(() => {
    if (pages.length > 0 && !activePage) {
      setActivePage(pages[0].slug);
    }
  }, [pages, activePage]);

  const currentPage = pages.find(p => p.slug === activePage);

  const updatePage = (slug, updater) => {
    setPages(prev => prev.map(p => p.slug === slug ? updater(p) : p));
  };

  const savePage = async (slug) => {
    setSaving(true);
    const page = pages.find(p => p.slug === slug);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/info-pages/${slug}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ page })
      });
      if (res.ok) {
        toast.success(`"${page.title}" saved!`);
      } else {
        toast.error('Save failed');
      }
    } catch {
      toast.error('Save failed');
    } finally {
      setSaving(false);
    }
  };

  const addSection = (slug, type) => {
    const id = `section-${Date.now()}`;
    const newSection = { id, type, title: 'New Section' };
    if (type === 'text') newSection.content = '';
    if (type === 'cards') newSection.cards = [{ title: '', description: '', icon: 'Star' }];
    if (type === 'table') newSection.rows = [{ description: '', price: '' }];
    if (type === 'faq') newSection.items = [{ question: '', answer: '' }];
    
    updatePage(slug, p => ({ ...p, sections: [...p.sections, newSection] }));
    setExpandedSections(prev => ({ ...prev, [id]: true }));
  };

  const removeSection = (slug, sectionId) => {
    if (!window.confirm('Delete this section?')) return;
    updatePage(slug, p => ({ ...p, sections: p.sections.filter(s => s.id !== sectionId) }));
  };

  const updateSection = (slug, sectionId, updates) => {
    updatePage(slug, p => ({
      ...p,
      sections: p.sections.map(s => s.id === sectionId ? { ...s, ...updates } : s)
    }));
  };

  const moveSection = (slug, index, direction) => {
    const newIndex = index + direction;
    updatePage(slug, p => {
      const sections = [...p.sections];
      if (newIndex < 0 || newIndex >= sections.length) return p;
      [sections[index], sections[newIndex]] = [sections[newIndex], sections[index]];
      return { ...p, sections };
    });
  };

  const toggleSection = (id) => {
    setExpandedSections(prev => ({ ...prev, [id]: !prev[id] }));
  };

  if (loading) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-gray-400" /></div>;
  }

  return (
    <div className="bg-white rounded-xl shadow-sm" data-testid="info-pages-editor">
      <div className="p-6 border-b">
        <h2 className="text-lg font-bold text-gray-900">Info Pages</h2>
        <p className="text-sm text-gray-500">Manage content for Delivery, Returns, FAQ, Contact, and other information pages linked from the footer</p>
      </div>

      <div className="flex">
        {/* Page Tabs */}
        <div className="w-56 border-r bg-gray-50 flex-shrink-0">
          <nav className="p-2 space-y-0.5">
            {pages.map(page => (
              <button
                key={page.slug}
                onClick={() => setActivePage(page.slug)}
                className={`w-full text-left px-3 py-2.5 rounded-lg text-sm flex items-center justify-between transition-colors ${
                  activePage === page.slug
                    ? 'bg-amber-100 text-amber-900 font-medium'
                    : 'text-gray-600 hover:bg-gray-100'
                }`}
                data-testid={`page-tab-${page.slug}`}
              >
                <span className="truncate">{page.title}</span>
                {page.enabled === false && <EyeOff className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />}
              </button>
            ))}
          </nav>
        </div>

        {/* Page Editor */}
        {currentPage && (
          <div className="flex-1 p-6" data-testid={`page-editor-${currentPage.slug}`}>
            {/* Page Header */}
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <Input
                  value={currentPage.title}
                  onChange={e => updatePage(currentPage.slug, p => ({ ...p, title: e.target.value }))}
                  className="text-lg font-bold border-none shadow-none px-0 focus-visible:ring-0"
                  data-testid="page-title-input"
                />
                <button
                  onClick={() => updatePage(currentPage.slug, p => ({ ...p, enabled: !p.enabled }))}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium ${
                    currentPage.enabled !== false ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                  }`}
                  data-testid="page-toggle"
                >
                  {currentPage.enabled !== false ? 'Visible' : 'Hidden'}
                </button>
              </div>
              <Button onClick={() => savePage(currentPage.slug)} disabled={saving} className="bg-amber-500 hover:bg-amber-600" data-testid="save-page-btn">
                {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Save className="w-4 h-4 mr-1" />}
                Save Page
              </Button>
            </div>

            {/* Sections */}
            <div className="space-y-4">
              {currentPage.sections.map((section, index) => (
                <div key={section.id} className="border rounded-lg overflow-hidden" data-testid={`section-${section.id}`}>
                  {/* Section Header */}
                  <div 
                    className="flex items-center gap-2 px-4 py-3 bg-gray-50 cursor-pointer"
                    onClick={() => toggleSection(section.id)}
                  >
                    <GripVertical className="w-4 h-4 text-gray-400" />
                    <span className="text-xs font-medium uppercase tracking-wide text-gray-400 bg-gray-200 px-2 py-0.5 rounded">
                      {SECTION_TYPES.find(t => t.value === section.type)?.label || section.type}
                    </span>
                    <input
                      value={section.title}
                      onChange={e => { e.stopPropagation(); updateSection(currentPage.slug, section.id, { title: e.target.value }); }}
                      onClick={e => e.stopPropagation()}
                      className="flex-1 text-sm font-medium bg-transparent border-none outline-none"
                    />
                    <div className="flex items-center gap-1">
                      <button onClick={(e) => { e.stopPropagation(); moveSection(currentPage.slug, index, -1); }} disabled={index === 0} className="p-1 text-gray-400 hover:text-gray-600 disabled:opacity-30"><ChevronUp className="w-4 h-4" /></button>
                      <button onClick={(e) => { e.stopPropagation(); moveSection(currentPage.slug, index, 1); }} disabled={index === currentPage.sections.length - 1} className="p-1 text-gray-400 hover:text-gray-600 disabled:opacity-30"><ChevronDown className="w-4 h-4" /></button>
                      <button onClick={(e) => { e.stopPropagation(); removeSection(currentPage.slug, section.id); }} className="p-1 text-gray-400 hover:text-red-500"><Trash2 className="w-4 h-4" /></button>
                      {expandedSections[section.id] ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                    </div>
                  </div>

                  {/* Section Content - Expanded */}
                  {expandedSections[section.id] && (
                    <div className="p-4 space-y-3">
                      {section.type === 'text' && (
                        <Textarea
                          value={section.content || ''}
                          onChange={e => updateSection(currentPage.slug, section.id, { content: e.target.value })}
                          rows={6}
                          placeholder="Enter content... Use blank lines for paragraphs."
                          className="text-sm"
                        />
                      )}

                      {section.type === 'cards' && (
                        <div className="space-y-3">
                          {(section.cards || []).map((card, ci) => (
                            <div key={ci} className="flex gap-2 items-start bg-gray-50 rounded-lg p-3">
                              <div className="w-24">
                                <Label className="text-xs text-gray-500">Icon</Label>
                                <select
                                  value={card.icon || 'Star'}
                                  onChange={e => {
                                    const cards = [...section.cards];
                                    cards[ci] = { ...cards[ci], icon: e.target.value };
                                    updateSection(currentPage.slug, section.id, { cards });
                                  }}
                                  className="w-full text-xs border rounded px-2 py-1.5 mt-1"
                                >
                                  {['Calendar','Truck','Shield','Zap','Phone','Package','CreditCard','MapPin','Star','Clock','Check','Info','AlertCircle','Heart','Home'].map(i => (
                                    <option key={i} value={i}>{i}</option>
                                  ))}
                                </select>
                              </div>
                              <div className="flex-1">
                                <Label className="text-xs text-gray-500">Title</Label>
                                <Input
                                  value={card.title}
                                  onChange={e => {
                                    const cards = [...section.cards];
                                    cards[ci] = { ...cards[ci], title: e.target.value };
                                    updateSection(currentPage.slug, section.id, { cards });
                                  }}
                                  className="text-sm mt-1"
                                  placeholder="Card title"
                                />
                              </div>
                              <div className="flex-[2]">
                                <Label className="text-xs text-gray-500">Description</Label>
                                <Input
                                  value={card.description}
                                  onChange={e => {
                                    const cards = [...section.cards];
                                    cards[ci] = { ...cards[ci], description: e.target.value };
                                    updateSection(currentPage.slug, section.id, { cards });
                                  }}
                                  className="text-sm mt-1"
                                  placeholder="Card description"
                                />
                              </div>
                              <button onClick={() => {
                                const cards = section.cards.filter((_, i) => i !== ci);
                                updateSection(currentPage.slug, section.id, { cards });
                              }} className="mt-5 p-1 text-gray-400 hover:text-red-500"><Trash2 className="w-4 h-4" /></button>
                            </div>
                          ))}
                          <Button variant="outline" size="sm" onClick={() => {
                            const cards = [...(section.cards || []), { title: '', description: '', icon: 'Star' }];
                            updateSection(currentPage.slug, section.id, { cards });
                          }}><Plus className="w-3 h-3 mr-1" /> Add Card</Button>
                        </div>
                      )}

                      {section.type === 'table' && (
                        <div className="space-y-2">
                          <div className="grid grid-cols-[1fr_150px_32px] gap-2 text-xs font-medium text-gray-500 px-1">
                            <span>Description</span><span>Price</span><span></span>
                          </div>
                          {(section.rows || []).map((row, ri) => (
                            <div key={ri} className="grid grid-cols-[1fr_150px_32px] gap-2">
                              <Input value={row.description} onChange={e => {
                                const rows = [...section.rows];
                                rows[ri] = { ...rows[ri], description: e.target.value };
                                updateSection(currentPage.slug, section.id, { rows });
                              }} className="text-sm" placeholder="Item description" />
                              <Input value={row.price} onChange={e => {
                                const rows = [...section.rows];
                                rows[ri] = { ...rows[ri], price: e.target.value };
                                updateSection(currentPage.slug, section.id, { rows });
                              }} className="text-sm" placeholder="£0.00 or FREE" />
                              <button onClick={() => {
                                const rows = section.rows.filter((_, i) => i !== ri);
                                updateSection(currentPage.slug, section.id, { rows });
                              }} className="p-1 text-gray-400 hover:text-red-500"><Trash2 className="w-4 h-4" /></button>
                            </div>
                          ))}
                          <Button variant="outline" size="sm" onClick={() => {
                            const rows = [...(section.rows || []), { description: '', price: '' }];
                            updateSection(currentPage.slug, section.id, { rows });
                          }}><Plus className="w-3 h-3 mr-1" /> Add Row</Button>
                        </div>
                      )}

                      {section.type === 'faq' && (
                        <div className="space-y-3">
                          {(section.items || []).map((item, fi) => (
                            <div key={fi} className="bg-gray-50 rounded-lg p-3 space-y-2">
                              <div className="flex gap-2">
                                <div className="flex-1">
                                  <Label className="text-xs text-gray-500">Question</Label>
                                  <Input value={item.question} onChange={e => {
                                    const items = [...section.items];
                                    items[fi] = { ...items[fi], question: e.target.value };
                                    updateSection(currentPage.slug, section.id, { items });
                                  }} className="text-sm mt-1" placeholder="Question?" />
                                </div>
                                <button onClick={() => {
                                  const items = section.items.filter((_, i) => i !== fi);
                                  updateSection(currentPage.slug, section.id, { items });
                                }} className="mt-5 p-1 text-gray-400 hover:text-red-500"><Trash2 className="w-4 h-4" /></button>
                              </div>
                              <div>
                                <Label className="text-xs text-gray-500">Answer</Label>
                                <Textarea value={item.answer} onChange={e => {
                                  const items = [...section.items];
                                  items[fi] = { ...items[fi], answer: e.target.value };
                                  updateSection(currentPage.slug, section.id, { items });
                                }} rows={2} className="text-sm mt-1" placeholder="Answer..." />
                              </div>
                            </div>
                          ))}
                          <Button variant="outline" size="sm" onClick={() => {
                            const items = [...(section.items || []), { question: '', answer: '' }];
                            updateSection(currentPage.slug, section.id, { items });
                          }}><Plus className="w-3 h-3 mr-1" /> Add Q&A</Button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Add Section */}
            <div className="mt-4 flex items-center gap-2 flex-wrap">
              <span className="text-sm text-gray-500">Add section:</span>
              {SECTION_TYPES.map(type => (
                <Button
                  key={type.value}
                  variant="outline"
                  size="sm"
                  onClick={() => addSection(currentPage.slug, type.value)}
                  className="text-xs"
                  data-testid={`add-section-${type.value}`}
                >
                  <type.icon className="w-3 h-3 mr-1" />
                  {type.label}
                </Button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
