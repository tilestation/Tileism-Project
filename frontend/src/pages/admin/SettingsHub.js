import React from 'react';
import HubPage from '../../components/HubPage';
import { 
  Settings, Building2, Shield, KeyRound, Link2, 
  Trash2, Cog, Database, Lock, Percent, ShieldCheck
} from 'lucide-react';

export default function SettingsHub() {
  const cards = [
    {
      title: 'Pricing Settings',
      description: 'Configure markup % and update prices',
      icon: Percent,
      link: '/admin/pricing-settings',
      color: 'bg-amber-600',
      permission: 'pricing_settings', legacyPermission: 'user_management',
      superAdminOnly: true,
    },
    {
      title: 'Stores',
      description: 'Manage store locations',
      icon: Building2,
      link: '/admin/showrooms',
      color: 'bg-blue-600',
      permission: 'showrooms', legacyPermission: 'showrooms',
    },
    {
      title: 'User Management',
      description: 'Manage admin users and roles',
      icon: Shield,
      link: '/admin/users',
      color: 'bg-green-600',
      permission: 'user_management', legacyPermission: 'user_management',
      superAdminOnly: true,
    },
    {
      title: 'Permissions',
      description: 'Control which pages and actions each role can access',
      icon: ShieldCheck,
      link: '/admin/permissions',
      color: 'bg-emerald-600',
      permission: 'permissions_admin', legacyPermission: 'user_management',
      superAdminOnly: true,
    },
    {
      title: 'Storefront Features',
      description: 'Show/hide Compare, Refer-a-friend & Welcome Popup on the live website',
      icon: Cog,
      link: '/admin/storefront-features',
      color: 'bg-amber-600',
      permission: 'storefront_features', legacyPermission: 'user_management',
      superAdminOnly: true,
    },
    {
      title: 'Staff PINs',
      description: 'Manage staff PIN codes',
      icon: KeyRound,
      link: '/admin/staff-pins',
      color: 'bg-purple-600',
      permission: 'staff_pins', legacyPermission: 'user_management',
      superAdminOnly: true,
    },
    {
      title: 'Staff Invites',
      description: 'Invite new staff members',
      icon: Link2,
      link: '/admin/staff-invites',
      color: 'bg-orange-600',
      permission: 'staff_invites', legacyPermission: 'user_management',
      superAdminOnly: true,
    },
    {
      title: 'Trash',
      description: 'Restore deleted items',
      icon: Trash2,
      link: '/admin/trash',
      color: 'bg-red-600',
      permission: 'trash', legacyPermission: 'user_management',
      superAdminOnly: true,
    },
    {
      title: 'General Settings',
      description: 'System configuration',
      icon: Cog,
      link: '/admin/settings',
      color: 'bg-slate-600',
      permission: 'general_settings', legacyPermission: 'dashboard',
    },
    {
      title: 'Backup',
      description: 'Database backup and restore',
      icon: Database,
      link: '/admin/backup',
      color: 'bg-cyan-600',
      permission: 'backup', legacyPermission: 'user_management',
      superAdminOnly: true,
    },
    {
      title: 'Security',
      description: 'Device authorization and security settings',
      icon: Lock,
      link: '/admin/settings?tab=security',
      color: 'bg-pink-600',
      permission: 'security_settings', legacyPermission: 'user_management',
      superAdminOnly: true,
    },
  ];

  return (
    <HubPage 
      title="Admin Settings" 
      subtitle="System configuration and user management"
      icon={Settings}
      cards={cards} 
    />
  );
}
