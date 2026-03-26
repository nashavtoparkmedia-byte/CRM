import React from 'react';
import { PageContainer } from '@/components/ui/PageContainer';
import { PageShell } from '@/components/layout/PageShell';

export default function Page() {
  return (
    <PageContainer>
      <PageShell sectionKey="promo_active" />
    </PageContainer>
  );
}