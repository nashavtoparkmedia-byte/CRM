const fs = require('fs');
const path = require('path');

const ROUTES = [
  { href: '/drivers/cards', key: 'cards' },
  { href: '/drivers/archive', key: 'archive' },
  { href: '/leads/new', key: 'leads_new' },
  { href: '/leads/in-progress', key: 'leads_in_progress' },
  { href: '/leads/connected', key: 'leads_connected' },
  { href: '/leads/no-orders', key: 'leads_no_orders' },
  { href: '/control/launch-risk', key: 'control_launch_risk' },
  { href: '/control/churn-risk', key: 'control_churn_risk' },
  { href: '/control/no-orders', key: 'control_no_orders' },
  { href: '/control/attention', key: 'control_attention' },
  { href: '/promotions/active', key: 'promo_active' },
  { href: '/promotions/ending', key: 'promo_ending' },
  { href: '/promotions/history', key: 'promo_history' },
  { href: '/promotions/efficiency', key: 'promo_efficiency' },
  { href: '/communications/auto-messages', key: 'auto_messages' },
  { href: '/communications/templates', key: 'msg_templates' },
  { href: '/resources/numbers', key: 'res_numbers' },
  { href: '/resources/accounts', key: 'res_accounts' },
  { href: '/resources/cars', key: 'res_cars' },
  { href: '/resources/bindings', key: 'res_bindings' },
  { href: '/analytics/channels', key: 'analytics_channels' },
  { href: '/analytics/funnel', key: 'analytics_funnel' },
  { href: '/analytics/churn', key: 'analytics_churn' },
  { href: '/analytics/active-base', key: 'analytics_active_base' }
];

ROUTES.forEach(route => {
  const dirPath = path.join(__dirname, 'src', 'app', route.href);
  fs.mkdirSync(dirPath, { recursive: true });
  
  const content = `import React from 'react';\nimport { PageContainer } from '@/components/ui/PageContainer';\nimport { PageShell } from '@/components/layout/PageShell';\n\nexport default function Page() {\n  return (\n    <PageContainer>\n      <PageShell sectionKey="${route.key}" />\n    </PageContainer>\n  );\n}`;
  
  fs.writeFileSync(path.join(dirPath, 'page.tsx'), content);
  console.log('Created stub for', route.href);
});
