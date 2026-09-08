import React, { Suspense } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Building2, LayoutDashboard, Users, Coins, Settings } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../../components/ui/tabs';
import { useAuth } from '../../../contexts/AuthContext';
import { TradeDashboardTab } from './TradeDashboardTab';
import { TradeCreditTab } from './TradeCreditTab';

const TradeAccounts = React.lazy(() => import('../TradeAccounts'));
const TradeAccountSettings = React.lazy(() => import('../TradeAccountSettings'));

const TABS = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'traders', label: 'Traders', icon: Users },
  { id: 'credit', label: 'Credit', icon: Coins },
  { id: 'settings', label: 'Website settings', icon: Settings, superAdminOnly: true },
];

export default function TradeHub() {
  const [params, setParams] = useSearchParams();
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';
  const tabs = TABS.filter((t) => !t.superAdminOnly || isSuperAdmin);
  const current = tabs.some((t) => t.id === params.get('tab')) ? params.get('tab') : 'dashboard';
  const setTab = (id) => setParams((p) => { const n = new URLSearchParams(p); n.set('tab', id); return n; }, { replace: true });

  return (
    <div className="space-y-6" data-testid="trade-hub-page">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2"><Building2 className="h-7 w-7" />Trade Hub</h1>
        <p className="text-gray-500 text-sm mt-1">One place for every tradesman: accounts, activity, credit, expiry and the trade pages on the website.</p>
      </div>
      <Tabs value={current} onValueChange={setTab}>
        <TabsList className="flex w-full sm:w-auto overflow-x-auto justify-start">
          {tabs.map(({ id, label, icon: Icon }) => (
            <TabsTrigger key={id} value={id} className="flex items-center gap-1.5" data-testid={`trade-hub-tab-${id}`}><Icon className="h-4 w-4" />{label}</TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="dashboard" className="mt-6"><TradeDashboardTab /></TabsContent>
        <TabsContent value="traders" className="mt-6">
          <Suspense fallback={<div className="py-12 text-center text-gray-400">Loading traders…</div>}><TradeAccounts embedded /></Suspense>
        </TabsContent>
        <TabsContent value="credit" className="mt-6"><TradeCreditTab /></TabsContent>
        {isSuperAdmin && (
          <TabsContent value="settings" className="mt-6">
            <Suspense fallback={<div className="py-12 text-center text-gray-400">Loading settings…</div>}><TradeAccountSettings /></Suspense>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
