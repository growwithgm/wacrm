import type { Metadata } from 'next';
import { TemplateManager } from '@/components/settings/template-manager';

export const metadata: Metadata = { title: 'Templates' };

export default function TemplatesPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-bold text-foreground">
          Message Templates
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage your approved WhatsApp message templates for broadcasts and automations.
        </p>
      </div>
      <TemplateManager />
    </div>
  );
}
