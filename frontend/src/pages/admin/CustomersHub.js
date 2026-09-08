import React from 'react';
import HubPage from '../../components/HubPage';
import { 
  Users, Building2, Tag, UserPlus, MessageSquare, 
  CreditCard, History
} from 'lucide-react';

export default function CustomersHub() {
  const cards = [
    {
      title: 'Trade Hub',
      description: 'Trade accounts, activity, credit ledger & login links — all in one place',
      icon: Building2,
      link: '/admin/trade',
      color: 'bg-amber-600',
      permission: 'trade_accounts', legacyPermission: 'customers',
    },
    {
      title: 'Customer Pricing',
      description: 'Set custom pricing for customers',
      icon: Tag,
      link: '/admin/pricing',
      color: 'bg-green-600',
      permission: 'customer_pricing', legacyPermission: 'customer_pricing',
    },
    {
      title: 'Invite Customers',
      description: 'Send registration invites',
      icon: UserPlus,
      link: '/admin/invites',
      color: 'bg-purple-600',
      permission: 'customer_invites', legacyPermission: 'customer_invites',
    },
    {
      title: 'Bulk Inquiries',
      description: 'Manage bulk order requests',
      icon: MessageSquare,
      link: '/admin/inquiries',
      color: 'bg-orange-600',
      permission: 'bulk_inquiries', legacyPermission: 'bulk_inquiries',
    },
    {
      title: 'Customer Orders',
      description: 'View all customer orders',
      icon: CreditCard,
      link: '/admin/customer-orders',
      color: 'bg-cyan-600',
      permission: 'orders', legacyPermission: 'orders',
    },
    {
      title: 'Customer History',
      description: 'Purchase history by customer',
      icon: History,
      link: '/admin/customer-history',
      color: 'bg-pink-600',
      permission: 'customers_hub', legacyPermission: 'customers',
    },
  ];

  return (
    <HubPage 
      title="Customers" 
      subtitle="Manage customer accounts and pricing"
      icon={Users}
      cards={cards} 
    />
  );
}
