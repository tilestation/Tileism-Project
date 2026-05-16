import React from 'react';
import HubPage from '../../components/HubPage';
import { 
  BarChart3, TrendingUp, History, PieChart, 
  FileBarChart, Calendar, DollarSign
} from 'lucide-react';

export default function ReportsHub() {
  const cards = [
    {
      title: 'Analytics',
      description: 'Business analytics and insights',
      icon: TrendingUp,
      link: '/admin/analytics',
      color: 'bg-blue-600',
      permission: 'analytics', legacyPermission: 'reports',
    },
    {
      title: 'Sales Reports',
      description: 'Detailed sales reporting',
      icon: BarChart3,
      link: '/admin/reports',
      color: 'bg-green-600',
      permission: 'reports', legacyPermission: 'reports',
    },
    {
      title: 'Audit Trail',
      description: 'System activity log',
      icon: History,
      link: '/admin/audit-trail',
      color: 'bg-purple-600',
      permission: 'audit_trail', legacyPermission: 'user_management',
      superAdminOnly: true,
    },
    {
      title: 'Revenue Reports',
      description: 'Revenue by store, product, period',
      icon: DollarSign,
      link: '/admin/revenue-reports',
      color: 'bg-emerald-600',
      permission: 'reports', legacyPermission: 'reports',
    },
    {
      title: 'Product Performance',
      description: 'Best and worst selling products',
      icon: PieChart,
      link: '/admin/product-performance',
      color: 'bg-orange-600',
      permission: 'analytics', legacyPermission: 'reports',
    },
    {
      title: 'Daily Summary',
      description: 'End of day reports',
      icon: Calendar,
      link: '/admin/daily-summary',
      color: 'bg-cyan-600',
      permission: 'reports', legacyPermission: 'reports',
    },
    {
      title: 'Export Reports',
      description: 'Download reports as spreadsheets',
      icon: FileBarChart,
      link: '/admin/export-reports',
      color: 'bg-slate-600',
      permission: 'reports', legacyPermission: 'reports',
    },
  ];

  return (
    <HubPage 
      title="Reports" 
      subtitle="Business analytics and reporting"
      icon={BarChart3}
      cards={cards} 
    />
  );
}
