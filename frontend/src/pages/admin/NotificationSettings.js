import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { toast } from 'sonner';
import { 
  Bell, Mail, Package, Users, ShoppingCart, AlertTriangle,
  CheckCircle, Settings, RefreshCw, Send, Save, Plus, X,
  Inbox, TrendingUp, UserPlus, Clock, FileText, Send as SendIcon
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card } from '../../components/ui/card';
import { Switch } from '../../components/ui/switch';

const CATEGORY_ICONS = {
  orders: ShoppingCart,
  inventory: Package,
  customers: Users,
  staff: UserPlus,
  reports: TrendingUp
};

const CATEGORY_COLORS = {
  orders: 'bg-blue-50 border-blue-200',
  inventory: 'bg-amber-50 border-amber-200',
  customers: 'bg-green-50 border-green-200',
  staff: 'bg-purple-50 border-purple-200',
  reports: 'bg-gray-50 border-gray-200'
};

export const NotificationSettings = () => {
  const [settings, setSettings] = useState({
    enabled: false,
    recipients: [],
    notifications: {},
    low_stock_threshold: 10,
    showroom_specific: true
  });
  const [notificationTypes, setNotificationTypes] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [logs, setLogs] = useState([]);
  const [showLogs, setShowLogs] = useState(false);

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      const [settingsRes, logsRes] = await Promise.all([
        api.getNotificationSettings(),
        api.getNotificationLogs().catch(() => ({ data: [] }))
      ]);
      setSettings(settingsRes.data.settings);
      setNotificationTypes(settingsRes.data.notification_types);
      setLogs(logsRes.data || []);
    } catch (error) {
      console.error('Failed to load settings:', error);
      toast.error('Failed to load notification settings');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.updateNotificationSettings({
        enabled: settings.enabled,
        recipients: settings.recipients,
        notifications: settings.notifications,
        low_stock_threshold: settings.low_stock_threshold,
        showroom_specific: settings.showroom_specific
      });
      toast.success('Notification settings saved');
    } catch (error) {
      toast.error('Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleEnabled = (enabled) => {
    setSettings({ ...settings, enabled });
  };

  const handleToggleNotification = (type, enabled) => {
    setSettings({
      ...settings,
      notifications: {
        ...settings.notifications,
        [type]: enabled
      }
    });
  };

  const handleAddRecipient = () => {
    if (!newEmail || !newEmail.includes('@')) {
      toast.error('Please enter a valid email');
      return;
    }
    if (settings.recipients.includes(newEmail)) {
      toast.error('Email already added');
      return;
    }
    setSettings({
      ...settings,
      recipients: [...settings.recipients, newEmail]
    });
    setNewEmail('');
  };

  const handleRemoveRecipient = (email) => {
    setSettings({
      ...settings,
      recipients: settings.recipients.filter(e => e !== email)
    });
  };

  const handleSendTest = async () => {
    if (settings.recipients.length === 0) {
      toast.error('Add at least one recipient first');
      return;
    }
    
    setTesting(true);
    try {
      await api.sendTestNotification();
      toast.success('Test notification sent!');
      fetchSettings(); // Refresh logs
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to send test');
    } finally {
      setTesting(false);
    }
  };

  // Group notifications by category
  const groupedNotifications = Object.entries(notificationTypes).reduce((acc, [key, value]) => {
    const category = value.category;
    if (!acc[category]) acc[category] = [];
    acc[category].push({ key, ...value });
    return acc;
  }, {});

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="notification-settings-page">
      {/* Channel switcher tabs — 22 Jun 2026
          The Telegram-config page was orphaned (only reachable via
          direct URL) until the owner asked "where do I manage Telegram
          notifications?". This tab strip gives every notification
          channel a discoverable home and a clear way to switch between
          them without leaving the area. Uses Link so the URL changes
          and the routes already wired in App.js do the heavy lifting. */}
      <div
        className="inline-flex p-1 bg-muted/40 rounded-lg gap-1"
        role="tablist"
        data-testid="notification-channel-tabs"
      >
        <button
          type="button"
          role="tab"
          aria-selected="true"
          className="px-4 py-1.5 text-sm font-semibold rounded-md bg-background shadow-sm flex items-center gap-2"
          data-testid="notification-tab-email-active"
        >
          <Mail className="h-4 w-4" /> Email
        </button>
        <Link
          to="/admin/notifications/telegram"
          role="tab"
          aria-selected="false"
          className="px-4 py-1.5 text-sm font-medium rounded-md text-muted-foreground hover:text-foreground hover:bg-background/60 transition-colors flex items-center gap-2"
          data-testid="notification-tab-telegram"
        >
          <SendIcon className="h-4 w-4" /> Telegram
        </Link>
      </div>

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-4xl font-heading font-bold tracking-tightest mb-2">
            Email Notifications
          </h1>
          <p className="text-muted-foreground">
            Configure automated email notifications for your team
          </p>
        </div>
        <div className="flex gap-2">
          <Button 
            variant="outline" 
            onClick={() => setShowLogs(!showLogs)}
          >
            <Clock className="h-4 w-4 mr-2" />
            {showLogs ? 'Hide Logs' : 'View Logs'}
          </Button>
          <Button 
            onClick={handleSave} 
            disabled={saving}
            className="bg-blue-600 hover:bg-blue-700"
          >
            {saving ? (
              <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            Save Settings
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Settings */}
        <div className="lg:col-span-2 space-y-6">
          {/* Master Toggle */}
          <Card className="p-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className={`p-3 rounded-full ${settings.enabled ? 'bg-green-100' : 'bg-gray-100'}`}>
                  <Bell className={`h-6 w-6 ${settings.enabled ? 'text-green-600' : 'text-gray-400'}`} />
                </div>
                <div>
                  <h3 className="font-semibold text-lg">Email Notifications</h3>
                  <p className="text-sm text-muted-foreground">
                    {settings.enabled ? 'Notifications are enabled' : 'Notifications are disabled'}
                  </p>
                </div>
              </div>
              <Switch
                checked={settings.enabled}
                onCheckedChange={handleToggleEnabled}
              />
            </div>
          </Card>

          {/* Notification Types by Category */}
          {settings.enabled && (
            <div className="space-y-4">
              {Object.entries(groupedNotifications).map(([category, notifications]) => {
                const Icon = CATEGORY_ICONS[category] || Bell;
                const colorClass = CATEGORY_COLORS[category] || 'bg-gray-50 border-gray-200';
                
                return (
                  <Card key={category} className={`p-4 border ${colorClass}`}>
                    <div className="flex items-center gap-2 mb-4">
                      <Icon className="h-5 w-5" />
                      <h3 className="font-semibold capitalize">{category}</h3>
                    </div>
                    
                    <div className="space-y-3">
                      {notifications.map(notification => (
                        <div 
                          key={notification.key}
                          className="flex items-center justify-between p-3 bg-white rounded-lg"
                        >
                          <div>
                            <p className="font-medium">{notification.name}</p>
                            <p className="text-sm text-muted-foreground">
                              {notification.description}
                            </p>
                          </div>
                          <Switch
                            checked={settings.notifications[notification.key] || false}
                            onCheckedChange={(checked) => handleToggleNotification(notification.key, checked)}
                          />
                        </div>
                      ))}
                    </div>
                  </Card>
                );
              })}
            </div>
          )}

          {/* Notification Logs */}
          {showLogs && (
            <Card className="p-4">
              <h3 className="font-semibold mb-4 flex items-center gap-2">
                <FileText className="h-4 w-4" />
                Recent Notification Logs
              </h3>
              
              {logs.length === 0 ? (
                <p className="text-muted-foreground text-center py-8">
                  No notifications sent yet
                </p>
              ) : (
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {logs.slice(0, 50).map((log, index) => (
                    <div 
                      key={index}
                      className={`p-3 rounded-lg flex items-start justify-between ${
                        log.success ? 'bg-green-50' : 'bg-red-50'
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        {log.success ? (
                          <CheckCircle className="h-4 w-4 text-green-600 mt-0.5" />
                        ) : (
                          <AlertTriangle className="h-4 w-4 text-red-600 mt-0.5" />
                        )}
                        <div>
                          <p className="font-medium text-sm">{log.subject}</p>
                          <p className="text-xs text-muted-foreground">
                            To: {log.recipients?.join(', ')}
                          </p>
                          {log.error && (
                            <p className="text-xs text-red-600 mt-1">{log.error}</p>
                          )}
                        </div>
                      </div>
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        {new Date(log.sent_at).toLocaleString('en-GB', {
                          day: '2-digit',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit'
                        })}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          {/* Recipients */}
          <Card className="p-4">
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <Mail className="h-4 w-4" />
              Notification Recipients
            </h3>
            <p className="text-sm text-muted-foreground mb-4">
              Emails that will receive notifications
            </p>
            
            <div className="flex gap-2 mb-3">
              <Input
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder="admin@example.com"
                onKeyDown={(e) => e.key === 'Enter' && handleAddRecipient()}
              />
              <Button variant="outline" size="icon" onClick={handleAddRecipient}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            
            <div className="space-y-2">
              {settings.recipients?.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">
                  No recipients added
                </p>
              ) : (
                settings.recipients?.map((email, index) => (
                  <div 
                    key={index}
                    className="flex items-center justify-between p-2 bg-gray-50 rounded"
                  >
                    <span className="text-sm truncate">{email}</span>
                    <button
                      onClick={() => handleRemoveRecipient(email)}
                      className="p-1 hover:bg-gray-200 rounded text-red-500"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </Card>

          {/* Additional Settings */}
          <Card className="p-4">
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <Settings className="h-4 w-4" />
              Additional Settings
            </h3>
            
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-1 block">
                  Low Stock Threshold (m²)
                </label>
                <Input
                  type="number"
                  value={settings.low_stock_threshold || 10}
                  onChange={(e) => setSettings({
                    ...settings,
                    low_stock_threshold: parseInt(e.target.value) || 10
                  })}
                  min="1"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Alert when stock falls below this value
                </p>
              </div>
              
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-sm">Store-specific emails</p>
                  <p className="text-xs text-muted-foreground">
                    Send from showroom email addresses
                  </p>
                </div>
                <Switch
                  checked={settings.showroom_specific || false}
                  onCheckedChange={(checked) => setSettings({
                    ...settings,
                    showroom_specific: checked
                  })}
                />
              </div>
            </div>
          </Card>

          {/* Test Notification */}
          <Card className="p-4 bg-blue-50 border-blue-200">
            <h3 className="font-semibold mb-2 text-blue-800 flex items-center gap-2">
              <Send className="h-4 w-4" />
              Test Notifications
            </h3>
            <p className="text-sm text-blue-700 mb-4">
              Send a test email to verify your settings are working correctly.
            </p>
            <Button 
              onClick={handleSendTest}
              disabled={testing || settings.recipients?.length === 0}
              className="w-full"
              variant="outline"
            >
              {testing ? (
                <>
                  <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <Send className="h-4 w-4 mr-2" />
                  Send Test Email
                </>
              )}
            </Button>
          </Card>

          {/* Quick Stats */}
          <Card className="p-4">
            <h3 className="font-semibold mb-3">Quick Stats</h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Active notifications</span>
                <span className="font-medium">
                  {Object.values(settings.notifications || {}).filter(Boolean).length}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Recipients</span>
                <span className="font-medium">{settings.recipients?.length || 0}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Emails sent (recent)</span>
                <span className="font-medium">{logs.filter(l => l.success).length}</span>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default NotificationSettings;
