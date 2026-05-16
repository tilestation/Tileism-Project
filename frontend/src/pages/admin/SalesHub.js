import React from 'react';
import HubPage from '../../components/HubPage';
import DailyReconciliationCard from '../../components/admin/DailyReconciliationCard';
import EssentialsNeedingPhotosCard from '../../components/admin/EssentialsNeedingPhotosCard';
import RecentCreditEmailsCard from '../../components/admin/RecentCreditEmailsCard';
import { 
  ShoppingBag, Monitor, Banknote, Store, Receipt, 
  FileText, History, CreditCard, Calculator
} from 'lucide-react';

export default function SalesHub() {
  const cards = [
    {
      title: 'EPOS',
      description: 'Point of sale system for processing transactions',
      icon: Monitor,
      link: '/admin/epos',
      color: 'bg-blue-600',
      permission: 'epos', legacyPermission: 'epos',
    },
    {
      title: 'Cash Counter',
      description: 'End of day cash reconciliation',
      icon: Banknote,
      link: '/admin/cash-counter',
      color: 'bg-green-600',
      permission: 'cash_counter', legacyPermission: 'dashboard',
    },
    {
      title: 'Store Dashboard',
      description: 'Real-time store performance metrics',
      icon: Store,
      link: '/admin/showroom-dashboard',
      color: 'bg-purple-600',
      permission: 'showroom_dashboard', legacyPermission: 'dashboard',
    },
    {
      title: 'Invoice History',
      description: 'View and manage all invoices',
      icon: Receipt,
      link: '/admin/invoices',
      color: 'bg-orange-600',
      permission: 'invoice_history', legacyPermission: 'epos',
    },
    {
      title: 'Quotations',
      description: 'Create and manage customer quotes',
      icon: FileText,
      link: '/admin/quotations',
      color: 'bg-cyan-600',
      permission: 'quotation', legacyPermission: 'epos',
    },
    {
      title: 'Deposit Orders',
      description: 'Track orders with deposits',
      icon: CreditCard,
      link: '/admin/deposit-orders',
      color: 'bg-pink-600',
      permission: 'orders', legacyPermission: 'orders',
    },
    {
      title: 'Refunds',
      description: 'Process and track refunds',
      icon: History,
      link: '/admin/refunds',
      color: 'bg-red-600',
      permission: 'refund', legacyPermission: 'epos',
    },
    {
      title: 'Tile Calculator',
      description: 'Calculate tile requirements',
      icon: Calculator,
      link: '/admin/calculator',
      color: 'bg-slate-600',
      // Unguarded — universally useful, no permission needed.
    },
  ];

  return (
    <HubPage 
      title="Sales & EPOS" 
      subtitle="Point of sale and transaction management"
      icon={ShoppingBag}
      cards={cards}
      preCardsContent={
        <div className="space-y-4">
          <DailyReconciliationCard />
          <RecentCreditEmailsCard />
          <EssentialsNeedingPhotosCard />
        </div>
      }
    />
  );
}
