import React, { useState, useEffect } from 'react';
import { Save, RefreshCw, Eye, ArrowLeft } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Textarea } from '../../components/ui/textarea';
import { toast } from 'sonner';

const API_URL = process.env.REACT_APP_BACKEND_URL;

// Default content structure
const defaultContent = {
  // Global toggle — when false, "Order Sample" buttons are hidden
  // across the entire storefront (PDP, Collection cards, header etc).
  // The Sample Service landing page itself stays accessible so people
  // can read about the service even if it's currently paused.
  global_enabled: true,
  hero_title: "Our Sample Service",
  hero_subtitle: "See and feel your tiles before you buy. Order up to 3 free samples — and on large-format tiles, choose a £5 Full Size Sample for the best preview.",
  section1_title: "How It Works",
  step1_title: "1. Browse & Select",
  step1_text: "Explore our extensive tile collection and click the 'Free Sample' button on any tile you'd like to try. You can add up to 3 different samples to your basket.",
  step2_title: "2. Checkout",
  step2_text: "Once you've chosen your samples, head to checkout. Your samples are completely free - you only pay £2.99 for delivery to cover postage costs.",
  step3_title: "3. Receive & Compare",
  step3_text: "Your samples will arrive within 3-5 working days. Compare colours, textures and finishes in your own home before making your final decision.",
  section2_title: "Why Order Samples?",
  benefit1_title: "True Colours",
  benefit1_text: "Screen colours can vary. See the actual tile colour in your space with natural lighting.",
  benefit2_title: "Feel the Texture",
  benefit2_text: "Touch and feel the surface finish - matt, gloss, textured or polished.",
  benefit3_title: "Perfect Match",
  benefit3_text: "Match with your existing décor, furniture and fittings before committing.",
  benefit4_title: "No Risk",
  benefit4_text: "Make confident decisions knowing exactly what you're getting.",
  section3_title: "Sample Details",
  detail1: "Samples are cut pieces from full tiles, typically around 10x10cm",
  detail2: "Free samples available on most of our tile range",
  detail3: "Maximum 3 free samples per order",
  detail4: "£2.99 delivery charge covers Royal Mail postage",
  detail5: "Delivered within 3-5 working days",
  cta_title: "Ready to Start?",
  cta_text: "Browse our collection and start selecting your free samples today.",
  cta_button: "Browse Tiles",
  showroom_text: "Prefer to see tiles in person? Visit one of our showrooms in Tonbridge, Gravesend or Sydenham where our expert team can help you find the perfect tiles."
};

const SampleServiceContent = () => {
  const [content, setContent] = useState(defaultContent);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchContent();
  }, []);

  const fetchContent = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/content/sample-service`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        if (data && Object.keys(data).length > 0) {
          setContent({ ...defaultContent, ...data });
        }
      }
    } catch (e) {
      console.log('Using default content');
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (field, value) => {
    setContent(prev => ({ ...prev, [field]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/content/sample-service`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(content)
      });

      if (res.ok) {
        toast.success('Content saved successfully!');
      } else {
        throw new Error('Failed to save');
      }
    } catch (e) {
      toast.error('Failed to save content');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setContent(defaultContent);
    toast.info('Content reset to defaults (not saved yet)');
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-spin w-8 h-8 border-4 border-gray-400 border-t-transparent rounded-full mx-auto"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Header */}
      <div className="bg-white shadow-sm border-b sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => window.history.back()}
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
            <h1 className="text-xl font-bold">Edit Sample Service Page</h1>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => window.open('/shop/sample-service', '_blank')}
            >
              <Eye className="h-4 w-4 mr-2" />
              Preview
            </Button>
            <Button
              variant="outline"
              onClick={handleReset}
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              Reset
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving}
              className="bg-amber-500 hover:bg-amber-600"
            >
              <Save className="h-4 w-4 mr-2" />
              {saving ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-8 space-y-8">
        {/* Global Sample Service toggle — affects "Order Sample" buttons site-wide */}
        <div className="bg-white rounded-lg shadow-sm p-6 border-l-4 border-amber-500">
          <h2 className="text-lg font-semibold mb-2">Sample Service — Storefront Visibility</h2>
          <p className="text-sm text-gray-600 mb-4">
            When OFF, "Order Sample" buttons are hidden everywhere on the storefront
            (product pages, collection cards, basket prompts). The sample service
            landing page itself stays online so customers can still read about the
            service, but they cannot order. Use this if you've run out of sample
            stock or want to pause the service temporarily.
          </p>
          <label className="flex items-center gap-3 cursor-pointer select-none">
            <input
              type="checkbox"
              data-testid="sample-service-global-toggle"
              className="w-5 h-5 accent-amber-500"
              checked={content.global_enabled !== false}
              onChange={(e) => handleChange('global_enabled', e.target.checked)}
            />
            <span className="font-medium">
              {content.global_enabled !== false
                ? '✅ Sample Service is ENABLED on the storefront'
                : '🚫 Sample Service is DISABLED on the storefront'}
            </span>
          </label>
        </div>

        {/* Hero Section */}
        <div className="bg-white rounded-lg shadow-sm p-6">
          <h2 className="text-lg font-semibold mb-4 pb-2 border-b">Hero Section</h2>
          <div className="space-y-4">
            <div>
              <Label htmlFor="hero_title">Page Title</Label>
              <Input
                id="hero_title"
                value={content.hero_title}
                onChange={(e) => handleChange('hero_title', e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="hero_subtitle">Subtitle / Description</Label>
              <Textarea
                id="hero_subtitle"
                value={content.hero_subtitle}
                onChange={(e) => handleChange('hero_subtitle', e.target.value)}
                className="mt-1"
                rows={2}
              />
            </div>
          </div>
        </div>

        {/* How It Works Section */}
        <div className="bg-white rounded-lg shadow-sm p-6">
          <h2 className="text-lg font-semibold mb-4 pb-2 border-b">How It Works Section</h2>
          <div className="space-y-4">
            <div>
              <Label htmlFor="section1_title">Section Title</Label>
              <Input
                id="section1_title"
                value={content.section1_title}
                onChange={(e) => handleChange('section1_title', e.target.value)}
                className="mt-1"
              />
            </div>
            
            <div className="grid md:grid-cols-3 gap-4">
              {/* Step 1 */}
              <div className="space-y-2 p-4 bg-gray-50 rounded-lg">
                <Label htmlFor="step1_title">Step 1 Title</Label>
                <Input
                  id="step1_title"
                  value={content.step1_title}
                  onChange={(e) => handleChange('step1_title', e.target.value)}
                />
                <Label htmlFor="step1_text">Step 1 Text</Label>
                <Textarea
                  id="step1_text"
                  value={content.step1_text}
                  onChange={(e) => handleChange('step1_text', e.target.value)}
                  rows={3}
                />
              </div>
              
              {/* Step 2 */}
              <div className="space-y-2 p-4 bg-gray-50 rounded-lg">
                <Label htmlFor="step2_title">Step 2 Title</Label>
                <Input
                  id="step2_title"
                  value={content.step2_title}
                  onChange={(e) => handleChange('step2_title', e.target.value)}
                />
                <Label htmlFor="step2_text">Step 2 Text</Label>
                <Textarea
                  id="step2_text"
                  value={content.step2_text}
                  onChange={(e) => handleChange('step2_text', e.target.value)}
                  rows={3}
                />
              </div>
              
              {/* Step 3 */}
              <div className="space-y-2 p-4 bg-gray-50 rounded-lg">
                <Label htmlFor="step3_title">Step 3 Title</Label>
                <Input
                  id="step3_title"
                  value={content.step3_title}
                  onChange={(e) => handleChange('step3_title', e.target.value)}
                />
                <Label htmlFor="step3_text">Step 3 Text</Label>
                <Textarea
                  id="step3_text"
                  value={content.step3_text}
                  onChange={(e) => handleChange('step3_text', e.target.value)}
                  rows={3}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Benefits Section */}
        <div className="bg-white rounded-lg shadow-sm p-6">
          <h2 className="text-lg font-semibold mb-4 pb-2 border-b">Benefits Section</h2>
          <div className="space-y-4">
            <div>
              <Label htmlFor="section2_title">Section Title</Label>
              <Input
                id="section2_title"
                value={content.section2_title}
                onChange={(e) => handleChange('section2_title', e.target.value)}
                className="mt-1"
              />
            </div>
            
            <div className="grid md:grid-cols-2 gap-4">
              {[1, 2, 3, 4].map(num => (
                <div key={num} className="space-y-2 p-4 bg-gray-50 rounded-lg">
                  <Label htmlFor={`benefit${num}_title`}>Benefit {num} Title</Label>
                  <Input
                    id={`benefit${num}_title`}
                    value={content[`benefit${num}_title`]}
                    onChange={(e) => handleChange(`benefit${num}_title`, e.target.value)}
                  />
                  <Label htmlFor={`benefit${num}_text`}>Benefit {num} Text</Label>
                  <Textarea
                    id={`benefit${num}_text`}
                    value={content[`benefit${num}_text`]}
                    onChange={(e) => handleChange(`benefit${num}_text`, e.target.value)}
                    rows={2}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Sample Details Section */}
        <div className="bg-white rounded-lg shadow-sm p-6">
          <h2 className="text-lg font-semibold mb-4 pb-2 border-b">Sample Details Section</h2>
          <div className="space-y-4">
            <div>
              <Label htmlFor="section3_title">Section Title</Label>
              <Input
                id="section3_title"
                value={content.section3_title}
                onChange={(e) => handleChange('section3_title', e.target.value)}
                className="mt-1"
              />
            </div>
            
            <div className="space-y-3">
              {[1, 2, 3, 4, 5].map(num => (
                <div key={num}>
                  <Label htmlFor={`detail${num}`}>Detail {num}</Label>
                  <Input
                    id={`detail${num}`}
                    value={content[`detail${num}`]}
                    onChange={(e) => handleChange(`detail${num}`, e.target.value)}
                    className="mt-1"
                  />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* CTA Section */}
        <div className="bg-white rounded-lg shadow-sm p-6">
          <h2 className="text-lg font-semibold mb-4 pb-2 border-b">Call to Action Section</h2>
          <div className="space-y-4">
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="cta_title">CTA Title</Label>
                <Input
                  id="cta_title"
                  value={content.cta_title}
                  onChange={(e) => handleChange('cta_title', e.target.value)}
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="cta_button">Button Text</Label>
                <Input
                  id="cta_button"
                  value={content.cta_button}
                  onChange={(e) => handleChange('cta_button', e.target.value)}
                  className="mt-1"
                />
              </div>
            </div>
            <div>
              <Label htmlFor="cta_text">CTA Description</Label>
              <Textarea
                id="cta_text"
                value={content.cta_text}
                onChange={(e) => handleChange('cta_text', e.target.value)}
                className="mt-1"
                rows={2}
              />
            </div>
          </div>
        </div>

        {/* Showroom Section */}
        <div className="bg-white rounded-lg shadow-sm p-6">
          <h2 className="text-lg font-semibold mb-4 pb-2 border-b">Showroom Section</h2>
          <div>
            <Label htmlFor="showroom_text">Showroom Text</Label>
            <Textarea
              id="showroom_text"
              value={content.showroom_text}
              onChange={(e) => handleChange('showroom_text', e.target.value)}
              className="mt-1"
              rows={3}
            />
          </div>
        </div>

        {/* Save Button (bottom) */}
        <div className="flex justify-end gap-2 pt-4">
          <Button
            variant="outline"
            onClick={handleReset}
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            Reset to Defaults
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving}
            className="bg-amber-500 hover:bg-amber-600"
          >
            <Save className="h-4 w-4 mr-2" />
            {saving ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default SampleServiceContent;
