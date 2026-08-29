import React from 'react';
import { PageContainer } from '@/infrastructure/ui/PageContainer';
import { PageShell } from '@/infrastructure/ui/PageShell';

export default function Page() {
  return (
    <PageContainer>
      <PageShell sectionKey="control_churn_risk" />
    </PageContainer>
  );
}