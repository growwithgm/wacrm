'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import type { ShopifyOrder } from '@/types';
import { cn } from '@/lib/utils';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Search, ShoppingBag, ExternalLink, Loader2 } from 'lucide-react';

function formatMoney(amount: number | null, currency: string | null): string {
  if (amount == null) return '—';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency ?? ''}`.trim();
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

// Status → tone mapping. Falls back to a neutral pill for unknown values.
function pillTone(kind: 'financial' | 'fulfillment', value: string | null): string {
  const v = (value ?? '').toLowerCase();
  if (kind === 'financial') {
    if (v === 'paid') return 'bg-primary/10 text-primary';
    if (v === 'pending' || v === 'authorized' || v === 'partially_paid')
      return 'bg-warning/10 text-warning';
    if (v.includes('refund')) return 'bg-muted text-muted-foreground';
    if (v === 'voided') return 'bg-destructive/10 text-destructive';
  } else {
    if (v === 'fulfilled') return 'bg-primary/10 text-primary';
    if (v === 'partial') return 'bg-warning/10 text-warning';
    if (v === 'restocked') return 'bg-muted text-muted-foreground';
  }
  return 'bg-muted text-muted-foreground';
}

function StatusPill({
  kind,
  value,
  fallback,
}: {
  kind: 'financial' | 'fulfillment';
  value: string | null;
  fallback: string;
}) {
  const label = (value ?? fallback).replace(/_/g, ' ');
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-1 text-[12px] font-bold capitalize',
        pillTone(kind, value),
      )}
    >
      {label}
    </span>
  );
}

const COD_LABELS: Record<string, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  cancel_requested: 'Cancel req.',
  no_reply: 'No reply',
};

function CodBadge({ status }: { status: string | null }) {
  if (!status) return <span className="text-sm text-muted-foreground">—</span>;
  const tone =
    status === 'confirmed'
      ? 'bg-primary/10 text-primary'
      : status === 'pending'
        ? 'bg-warning/10 text-warning'
        : status === 'cancel_requested'
          ? 'bg-destructive/10 text-destructive'
          : 'bg-muted text-muted-foreground';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-1 text-[12px] font-bold',
        tone,
      )}
    >
      {COD_LABELS[status] ?? status}
    </span>
  );
}

export default function OrdersPage() {
  const [orders, setOrders] = useState<ShopifyOrder[] | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('shopify_orders')
        .select('*')
        .order('order_created_at', { ascending: false })
        .limit(200);
      if (cancelled) return;
      if (error) {
        console.error('[orders] fetch failed:', error.message);
        setOrders([]);
        return;
      }
      setOrders((data ?? []) as ShopifyOrder[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    if (!orders) return [];
    const q = search.trim().toLowerCase();
    if (!q) return orders;
    return orders.filter((o) =>
      [o.name, o.order_number, o.customer_name, o.customer_phone, o.customer_email]
        .filter(Boolean)
        .some((f) => f!.toLowerCase().includes(q)),
    );
  }, [orders, search]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-bold text-foreground">Orders</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Shopify orders synced into Wasify. Connect a store and sync from{' '}
            <Link href="/shopify" className="text-primary hover:underline">
              Shopify settings
            </Link>
            .
          </p>
        </div>
        <div className="flex h-10 w-full max-w-xs items-center gap-2.5 rounded-xl border border-border bg-card px-3.5 text-muted-foreground">
          <Search className="h-[17px] w-[17px] shrink-0" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search orders…"
            aria-label="Search orders"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        {orders === null ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <ShoppingBag className="h-6 w-6" />
            </div>
            <h3 className="mt-4 font-heading text-lg font-bold text-foreground">
              {orders.length === 0 ? 'No orders synced yet' : 'No matching orders'}
            </h3>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              {orders.length === 0
                ? 'Connect your Shopify store and run “Sync Orders” to import your order history.'
                : 'Try a different search term.'}
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead>Order</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Total</TableHead>
                <TableHead>Payment</TableHead>
                <TableHead>Fulfillment</TableHead>
                <TableHead>COD</TableHead>
                <TableHead>Tracking</TableHead>
                <TableHead className="text-right">Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((o) => (
                <TableRow key={o.id} className="border-border">
                  <TableCell className="font-heading font-bold text-foreground">
                    {o.name || `#${o.order_number ?? o.shopify_order_id}`}
                  </TableCell>
                  <TableCell>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground">
                        {o.customer_name || 'Unknown'}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {o.customer_phone || o.customer_email || '—'}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="font-heading font-bold text-foreground">
                    {formatMoney(o.total_price, o.currency)}
                  </TableCell>
                  <TableCell>
                    <StatusPill kind="financial" value={o.financial_status} fallback="pending" />
                  </TableCell>
                  <TableCell>
                    <StatusPill
                      kind="fulfillment"
                      value={o.fulfillment_status}
                      fallback="unfulfilled"
                    />
                  </TableCell>
                  <TableCell>
                    <CodBadge status={o.cod_status} />
                  </TableCell>
                  <TableCell>
                    {o.tracking_number ? (
                      o.tracking_url ? (
                        <a
                          href={o.tracking_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                        >
                          {o.tracking_number}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        <span className="text-sm text-foreground">{o.tracking_number}</span>
                      )
                    ) : (
                      <span className="text-sm text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right text-sm text-muted-foreground">
                    {formatDate(o.order_created_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
