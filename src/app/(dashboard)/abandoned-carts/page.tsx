'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import type { ShopifyCheckout } from '@/types';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Search, ShoppingCart, ExternalLink, Loader2, PhoneOff } from 'lucide-react';

type RecoveryRow = { status: string; reminders_sent: number };

/**
 * Derive the recovery indicator for a cart. The "Recovered" state is keyed
 * STRICTLY off the checkout's own truth (recovered === true OR completed_at
 * set) — never off the checkout_recoveries row — so a stale or mislinked
 * recovery row can never paint a false green "Recovered" badge.
 */
function recoveryDisplay(
  rec: RecoveryRow | undefined,
  opts: { hasPhone: boolean; recovered: boolean; completedAt: string | null },
): { label: string; tone: 'primary' | 'warning' | 'rose' | 'muted' | 'missing' } {
  // Authoritative: the checkout itself converted to an order.
  if (opts.recovered || opts.completedAt) {
    return { label: 'Recovered', tone: 'primary' };
  }
  if (!opts.hasPhone || rec?.status === 'skipped_no_phone') {
    return { label: 'WhatsApp number missing', tone: 'missing' };
  }
  if (!rec) return { label: 'No recovery yet', tone: 'muted' };
  switch (rec.status) {
    case 'completed_order':
      // Recovery row claims completed but the checkout above says it is NOT
      // recovered — trust the checkout and never show a false "Recovered".
      return { label: 'No recovery yet', tone: 'muted' };
    case 'opted_out':
      return { label: 'Opted out', tone: 'rose' };
    case 'suppressed_cooldown':
      return { label: 'Suppressed (cooldown)', tone: 'muted' };
    case 'active':
    case 'done':
      return rec.reminders_sent > 0
        ? {
            label: `Reminder ${rec.reminders_sent} sent`,
            tone: rec.status === 'done' ? 'primary' : 'warning',
          }
        : { label: 'Recovery scheduled', tone: 'muted' };
    default:
      return { label: 'No recovery yet', tone: 'muted' };
  }
}

function RecoveryBadge({
  rec,
  hasPhone,
  recovered,
  completedAt,
}: {
  rec: RecoveryRow | undefined;
  hasPhone: boolean;
  recovered: boolean;
  completedAt: string | null;
}) {
  const { label, tone } = recoveryDisplay(rec, { hasPhone, recovered, completedAt });
  if (tone === 'missing') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[12px] font-bold text-amber-600">
        <PhoneOff className="h-3 w-3" />
        WhatsApp number missing
      </span>
    );
  }
  const cls =
    tone === 'primary'
      ? 'bg-primary/10 text-primary'
      : tone === 'warning'
        ? 'bg-warning/10 text-warning'
        : tone === 'rose'
          ? 'bg-rose-500/10 text-rose-500'
          : 'bg-muted text-muted-foreground';
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[12px] font-bold ${cls}`}>
      {label}
    </span>
  );
}

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
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function itemsSummary(items: ShopifyCheckout['line_items']): string {
  if (!items?.length) return 'No items';
  const count = items.reduce((sum, li) => sum + (li.quantity || 1), 0);
  const first = items[0]?.title ?? 'Item';
  const extra = items.length > 1 ? ` +${items.length - 1} more` : '';
  return `${count} × ${first}${extra}`;
}

export default function AbandonedCartsPage() {
  const [checkouts, setCheckouts] = useState<ShopifyCheckout[] | null>(null);
  // Recovery state keyed by checkout id (shopify_checkouts.id). Display-only.
  const [recoveries, setRecoveries] = useState<Map<string, RecoveryRow>>(new Map());
  const [search, setSearch] = useState('');

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const [checkoutsRes, recRes] = await Promise.all([
        supabase
          .from('shopify_checkouts')
          .select('*')
          .order('abandoned_at', { ascending: false })
          .limit(200),
        supabase.from('checkout_recoveries').select('checkout_id, status, reminders_sent'),
      ]);
      if (cancelled) return;
      if (checkoutsRes.error) {
        console.error('[abandoned-carts] fetch failed:', checkoutsRes.error.message);
        setCheckouts([]);
        return;
      }
      setCheckouts((checkoutsRes.data ?? []) as ShopifyCheckout[]);

      const map = new Map<string, RecoveryRow>();
      for (const r of (recRes.data ?? []) as {
        checkout_id: string;
        status: string;
        reminders_sent: number;
      }[]) {
        if (r.checkout_id) map.set(r.checkout_id, { status: r.status, reminders_sent: r.reminders_sent });
      }
      setRecoveries(map);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    if (!checkouts) return [];
    const q = search.trim().toLowerCase();
    if (!q) return checkouts;
    return checkouts.filter((c) =>
      [c.customer_name, c.customer_phone, c.customer_email]
        .filter(Boolean)
        .some((f) => f!.toLowerCase().includes(q)),
    );
  }, [checkouts, search]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-bold text-foreground">Abandoned Carts</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Abandoned checkouts synced from Shopify — the foundation for WhatsApp cart recovery
            (messaging comes in a later phase). Sync from{' '}
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
            placeholder="Search carts…"
            aria-label="Search abandoned carts"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        {checkouts === null ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <ShoppingCart className="h-6 w-6" />
            </div>
            <h3 className="mt-4 font-heading text-lg font-bold text-foreground">
              {checkouts.length === 0 ? 'No abandoned carts yet' : 'No matching carts'}
            </h3>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              {checkouts.length === 0
                ? 'Connect your Shopify store and run “Sync Abandoned Checkouts”.'
                : 'Try a different search term.'}
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead>Customer</TableHead>
                <TableHead>Cart</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Recovery</TableHead>
                <TableHead>Abandoned</TableHead>
                <TableHead className="text-right">Recovery link</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((c) => (
                <TableRow key={c.id} className="border-border">
                  <TableCell>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground">
                        {c.customer_name || 'Unknown'}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {c.customer_phone || c.customer_email || '—'}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-foreground">
                    {itemsSummary(c.line_items)}
                  </TableCell>
                  <TableCell className="font-heading font-bold text-foreground">
                    {formatMoney(c.total_price, c.currency)}
                  </TableCell>
                  <TableCell>
                    {c.recovered || c.completed_at ? (
                      <span className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-1 text-[12px] font-bold text-primary">
                        Recovered
                      </span>
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-warning/10 px-2.5 py-1 text-[12px] font-bold text-warning">
                        Open
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <RecoveryBadge
                      rec={recoveries.get(c.id)}
                      hasPhone={!!c.customer_phone}
                      recovered={!!c.recovered}
                      completedAt={c.completed_at ?? null}
                    />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDate(c.abandoned_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    {c.abandoned_checkout_url ? (
                      <a
                        href={c.abandoned_checkout_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                      >
                        Open cart
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : (
                      <span className="text-sm text-muted-foreground">—</span>
                    )}
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
