import type { Metadata } from 'next';
import { ShopifyConfig } from '@/components/settings/shopify-config';

export const metadata: Metadata = { title: 'Shopify' };

export default function ShopifyPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-bold text-foreground">
          Shopify Integration
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect your Shopify store to sync customers and trigger WhatsApp automations from order events.
        </p>
      </div>
      <ShopifyConfig />
    </div>
  );
}
