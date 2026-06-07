'use client';

import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  Eye,
  EyeOff,
  Copy,
  Loader2,
  ExternalLink,
  Zap,
  AlertTriangle,
  RotateCcw,
  RefreshCw,
  Webhook,
  Stethoscope,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useWhatsAppConnection, WA_STATE_UI } from '@/hooks/use-whatsapp-connection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
import type { WhatsAppConfig as WhatsAppConfigType } from '@/types';

const MASKED_TOKEN = '••••••••••••••••';
const LS_KEY = 'wa_config_draft';

function saveDraft(patch: { phoneNumberId?: string; wabaId?: string; accessToken?: string; verifyToken?: string; tokenEdited?: boolean }) {
  try {
    const current = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    localStorage.setItem(LS_KEY, JSON.stringify({ ...current, ...patch }));
  } catch {}
}

function clearDraft() {
  try { localStorage.removeItem(LS_KEY); } catch {}
}

function formatTimestamp(ts: string | null): string {
  if (!ts) return 'Never';
  try {
    return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return ts;
  }
}

interface DiagData {
  token_app?: { id?: string | null; name?: string | null; is_valid?: boolean; scopes?: string[]; granular_scopes?: unknown };
  waba_id?: string | null;
  phone_number_id?: string | null;
  verify_token?: string | null;
  app_secret_configured?: boolean;
  subscribed_apps?: unknown;
  phone_numbers?: unknown;
  phone?: unknown;
}

function DiagRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2 text-sm">
      <span className="font-medium text-foreground">{label}:</span>
      <span className="break-all text-muted-foreground">{children}</span>
    </div>
  );
}

function DiagRaw({ label, value }: { label: string; value: unknown }) {
  return (
    <details className="rounded-lg border border-border bg-muted/40 p-2">
      <summary className="cursor-pointer text-xs font-medium text-foreground">{label}</summary>
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-relaxed text-muted-foreground">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

function DiagnosticsView({ data }: { data: DiagData }) {
  const app = data.token_app ?? {};
  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <DiagRow label="Token app">{app.name ?? '—'} ({app.id ?? '—'})</DiagRow>
      <DiagRow label="Token valid">{app.is_valid ? 'yes' : 'no'}</DiagRow>
      <DiagRow label="WABA ID">{data.waba_id ?? '—'}</DiagRow>
      <DiagRow label="Phone number ID">{data.phone_number_id ?? '—'}</DiagRow>
      <DiagRow label="Webhook verify token">{data.verify_token ?? '—'}</DiagRow>
      <DiagRow label="META_APP_SECRET configured">{data.app_secret_configured ? 'yes' : 'no'}</DiagRow>
      <DiagRaw label="subscribed_apps (raw Meta response)" value={data.subscribed_apps} />
      <DiagRaw label="phone_numbers under WABA (raw)" value={data.phone_numbers} />
      <DiagRaw label="phone number (raw)" value={data.phone} />
      <DiagRaw label="token granular_scopes" value={app.granular_scopes} />
    </div>
  );
}

export function WhatsAppConfig() {
  const supabase = createClient();
  const { user, loading: authLoading } = useAuth();

  // Single source of truth for the 3-state connection status (shared with the
  // sidebar's API-status card so they can never disagree).
  const wa = useWhatsAppConnection();
  const ui = WA_STATE_UI[wa.state];

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [subscribing, setSubscribing] = useState(false);
  const [loadingDiag, setLoadingDiag] = useState(false);
  const [diagnostics, setDiagnostics] = useState<DiagData | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [config, setConfig] = useState<WhatsAppConfigType | null>(null);

  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [verifyToken, setVerifyToken] = useState('');
  const [tokenEdited, setTokenEdited] = useState(false);

  const fetchedForUserRef = useRef<string | null>(null);

  const webhookUrl =
    typeof window !== 'undefined' ? `${window.location.origin}/api/whatsapp/webhook` : '';

  // Loads the stored row for the FORM fields only — the connection status comes
  // from the shared hook (which does the live debug_token check).
  const fetchConfig = useCallback(async (userId: string) => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('whatsapp_config')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();

      if (error) console.error('Failed to load config row:', error);

      const draft = (() => {
        try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null') ?? {}; }
        catch { return {}; }
      })();

      if (data) {
        setConfig(data);
        setPhoneNumberId(draft.phoneNumberId ?? data.phone_number_id ?? '');
        setWabaId(draft.wabaId ?? data.waba_id ?? '');
        if (draft.accessToken && draft.tokenEdited) {
          setAccessToken(draft.accessToken);
          setTokenEdited(true);
        } else {
          setAccessToken(MASKED_TOKEN);
          setTokenEdited(false);
        }
        setVerifyToken(draft.verifyToken ?? '');
      } else {
        setConfig(null);
        setPhoneNumberId(draft.phoneNumberId ?? '');
        setWabaId(draft.wabaId ?? '');
        setAccessToken(draft.accessToken && draft.tokenEdited ? draft.accessToken : '');
        setVerifyToken(draft.verifyToken ?? '');
        setTokenEdited(!!draft.tokenEdited);
      }
    } catch (err) {
      console.error('fetchConfig error:', err);
      toast.error('Failed to load WhatsApp configuration');
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setLoading(false);
      return;
    }
    if (fetchedForUserRef.current === user.id) return;
    fetchedForUserRef.current = user.id;
    fetchConfig(user.id);
  }, [authLoading, user, fetchConfig]);

  async function handleSave() {
    if (!phoneNumberId.trim()) {
      toast.error('Phone Number ID is required');
      return;
    }
    if (!config && (!accessToken.trim() || !tokenEdited)) {
      toast.error('Access Token is required for initial setup');
      return;
    }

    try {
      setSaving(true);
      const payload: Record<string, unknown> = {
        phone_number_id: phoneNumberId.trim(),
        waba_id: wabaId.trim() || null,
        verify_token: verifyToken.trim() || null,
      };

      if (tokenEdited && accessToken !== MASKED_TOKEN && accessToken.trim()) {
        payload.access_token = accessToken.trim();
      } else if (config) {
        toast.error('Please re-enter the Access Token to save changes');
        setSaving(false);
        return;
      }

      const res = await fetch('/api/whatsapp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Failed to save configuration');
        setSaving(false);
        return;
      }

      toast.success('Configuration saved — verifying send permission…');
      clearDraft();
      fetchedForUserRef.current = null;
      if (user) await fetchConfig(user.id);
      // Re-run the live 3-state check so the banner/pill/sidebar update.
      await wa.refresh();
    } catch (err) {
      console.error('Save error:', err);
      toast.error('Failed to save configuration');
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    try {
      setTesting(true);
      const d = await wa.refresh();
      const state = d.state ?? (d.connected ? 'connected' : 'not_connected');
      const detail = d.detail || d.message || '';
      if (state === 'connected') {
        toast.success(d.waba_name ? `Connected to ${d.waba_name} — can send` : 'Connected — can send');
      } else if (state === 'cannot_send') {
        toast.warning(detail || 'Token is valid but cannot send (Meta #200).');
      } else {
        toast.error(detail || 'Not connected — token is invalid, revoked, or expired.');
      }
    } catch {
      toast.error('Connection test failed. Check your network and try again.');
    } finally {
      setTesting(false);
    }
  }

  async function handleReset() {
    if (!confirm('This will delete the current WhatsApp config so you can re-enter it. Continue?')) return;
    try {
      setResetting(true);
      const res = await fetch('/api/whatsapp/config', { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to reset configuration');
        return;
      }
      toast.success('Configuration cleared. You can now re-enter your credentials.');
      clearDraft();
      setConfig(null);
      setPhoneNumberId('');
      setWabaId('');
      setAccessToken('');
      setVerifyToken('');
      setTokenEdited(false);
      await wa.refresh();
    } catch (err) {
      console.error('Reset error:', err);
      toast.error('Failed to reset configuration');
    } finally {
      setResetting(false);
    }
  }

  async function handleSubscribe() {
    try {
      setSubscribing(true);
      const res = await fetch('/api/whatsapp/subscribe', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to subscribe');
        return;
      }
      const apps = Array.isArray(data.subscribed_apps) ? data.subscribed_apps : [];
      if (data.success && apps.length > 0) {
        toast.success('Subscribed — inbound webhooks are now active for this WABA.');
      } else if (data.success) {
        toast.warning('Meta returned success but no app is listed yet. Run diagnostics to confirm.');
      } else {
        toast.error('Meta did not confirm the subscription.');
      }
      await wa.refresh();
    } catch {
      toast.error('Subscribe request failed. Check your network and try again.');
    } finally {
      setSubscribing(false);
    }
  }

  async function handleRunDiagnostics() {
    try {
      setLoadingDiag(true);
      const res = await fetch('/api/whatsapp/diagnostics');
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Diagnostics failed');
        return;
      }
      setDiagnostics(data as DiagData);
    } catch {
      toast.error('Diagnostics request failed.');
    } finally {
      setLoadingDiag(false);
    }
  }

  function handleCopyWebhookUrl() {
    navigator.clipboard.writeText(webhookUrl);
    toast.success('Webhook URL copied to clipboard');
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  const pillLabel =
    wa.state === 'connected' && wa.wabaName ? `Connected — ${wa.wabaName}` : ui.label;

  return (
    <div className="mt-4 space-y-6">
      {/* Header row — title + top-right status pill */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-heading text-lg font-bold text-foreground">WhatsApp connection</h2>
          <p className="text-sm text-muted-foreground">
            Connect your Meta WhatsApp Business API to send and receive messages.
          </p>
        </div>
        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-bold',
            ui.border,
            ui.tint,
            ui.text,
          )}
        >
          <span className={cn('h-1.5 w-1.5 rounded-full', ui.dot)} />
          {pillLabel}
          {wa.loading && <RefreshCw className="size-3 animate-spin" />}
        </span>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        {/* Main config form */}
        <div className="space-y-6">
          {/* Corrupted-token reset banner */}
          {wa.needsReset && (
            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-600" />
                <div className="flex-1">
                  <p className="font-heading font-bold text-amber-700">
                    Stored token can&apos;t be decrypted
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">{wa.detail}</p>
                  <Button onClick={handleReset} disabled={resetting} size="sm" variant="outline" className="mt-3">
                    {resetting ? (
                      <><Loader2 className="size-4 animate-spin" />Resetting…</>
                    ) : (
                      <><RotateCcw className="size-4" />Reset Configuration</>
                    )}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* ─── 3-state connection banner ─── */}
          <div className={cn('rounded-2xl border p-4', ui.border, ui.tint)}>
            <div className="flex items-start gap-3">
              <span className={cn('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', ui.dot)} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className={cn('font-heading font-bold', ui.text)}>
                    {wa.state === 'connected'
                      ? `Connected${wa.wabaName ? ` — ${wa.wabaName}` : ''}`
                      : ui.label}
                  </p>
                  {wa.loading && <RefreshCw className="size-3.5 animate-spin text-muted-foreground" />}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {wa.detail ||
                    (wa.state === 'connected'
                      ? 'Your WhatsApp Business account can send messages.'
                      : 'Configure your Meta API credentials below to connect.')}
                </p>
                {/* Inbound (webhook subscription) — independent of send capability:
                    a token can send while inbound still won't arrive until the
                    app is subscribed to the WABA. */}
                {wa.state !== 'not_connected' && (
                  <p className="mt-1.5 flex items-center gap-1.5 text-xs font-medium">
                    <span
                      className={cn(
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        wa.subscribed === true
                          ? 'bg-primary'
                          : wa.subscribed === false
                            ? 'bg-amber-500'
                            : 'bg-muted-foreground',
                      )}
                    />
                    <span
                      className={cn(
                        wa.subscribed === true
                          ? 'text-primary'
                          : wa.subscribed === false
                            ? 'text-amber-600'
                            : 'text-muted-foreground',
                      )}
                    >
                      {wa.subscribed === true
                        ? 'Inbound: subscribed to webhooks'
                        : wa.subscribed === false
                          ? 'Inbound: not subscribed — incoming messages won’t arrive. Click “Subscribe to webhooks”.'
                          : 'Inbound: subscription status unknown'}
                    </span>
                  </p>
                )}
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Last checked: {wa.loading ? 'Verifying…' : formatTimestamp(wa.lastCheckedAt)}
                </p>
              </div>
            </div>
          </div>

          {/* API Credentials */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">API Credentials</CardTitle>
              <CardDescription>Enter your Meta WhatsApp Business API credentials.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Phone Number ID</Label>
                <Input
                  placeholder="e.g. 100234567890123"
                  value={phoneNumberId}
                  onChange={(e) => { setPhoneNumberId(e.target.value); saveDraft({ phoneNumberId: e.target.value }); }}
                />
              </div>

              <div className="space-y-2">
                <Label>WhatsApp Business Account ID</Label>
                <Input
                  placeholder="e.g. 100234567890456"
                  value={wabaId}
                  onChange={(e) => { setWabaId(e.target.value); saveDraft({ wabaId: e.target.value }); }}
                />
              </div>

              <div className="space-y-2">
                <Label>Permanent Access Token</Label>
                <div className="relative">
                  <Input
                    type={showToken ? 'text' : 'password'}
                    placeholder="Enter your access token"
                    value={accessToken}
                    onChange={(e) => {
                      setAccessToken(e.target.value);
                      setTokenEdited(true);
                      saveDraft({ accessToken: e.target.value, tokenEdited: true });
                    }}
                    onFocus={() => {
                      if (accessToken === MASKED_TOKEN) {
                        setAccessToken('');
                        setTokenEdited(true);
                      }
                    }}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken(!showToken)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
                {config && !tokenEdited && (
                  <p className="text-xs text-muted-foreground">
                    Token is hidden for security. Re-enter it to update configuration.
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Must be a System User token with <span className="font-medium text-foreground">whatsapp_business_messaging</span> granted for this WABA — a management-only token will connect but fail to send (#200).
                </p>
              </div>

              <div className="space-y-2">
                <Label>Webhook Verify Token</Label>
                <Input
                  placeholder="Create a custom verify token"
                  value={verifyToken}
                  onChange={(e) => { setVerifyToken(e.target.value); saveDraft({ verifyToken: e.target.value }); }}
                />
                <p className="text-xs text-muted-foreground">
                  A custom string you create. Must match the token you set in Meta webhook settings.
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Webhook URL */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Webhook Configuration</CardTitle>
              <CardDescription>Use this URL as your webhook callback in the Meta App Dashboard.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Webhook Callback URL</Label>
                <div className="flex gap-2">
                  <Input readOnly value={webhookUrl} className="font-mono text-sm" />
                  <Button variant="outline" size="icon" onClick={handleCopyWebhookUrl} className="shrink-0">
                    <Copy className="size-4" />
                  </Button>
                </div>
              </div>
              <div className="space-y-2 border-t border-border pt-4">
                <Label>Inbound subscription</Label>
                <div className="flex flex-wrap items-center gap-3">
                  <Button variant="outline" onClick={handleSubscribe} disabled={subscribing || !config}>
                    {subscribing ? (
                      <><Loader2 className="size-4 animate-spin" />Subscribing…</>
                    ) : (
                      <><Webhook className="size-4" />Subscribe to webhooks</>
                    )}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    Subscribes this app to your WhatsApp Business Account so inbound messages reach
                    Wasify. Required once per WABA — without it, no incoming messages arrive.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Connection diagnostics */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Connection diagnostics</CardTitle>
              <CardDescription>
                Live, raw data from Meta for this token — app identity, webhook subscription, and
                phone-number access. Use it to pin down inbound / outbound (#200) issues.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button variant="outline" onClick={handleRunDiagnostics} disabled={loadingDiag || !config}>
                {loadingDiag ? (
                  <><Loader2 className="size-4 animate-spin" />Running…</>
                ) : (
                  <><Stethoscope className="size-4" />Run diagnostics</>
                )}
              </Button>
              {diagnostics && <DiagnosticsView data={diagnostics} />}
            </CardContent>
          </Card>

          {/* Action Buttons */}
          <div className="flex flex-wrap gap-3">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? <><Loader2 className="size-4 animate-spin" />Saving…</> : 'Save Configuration'}
            </Button>
            <Button variant="outline" onClick={handleTestConnection} disabled={testing || !config}>
              {testing ? <><Loader2 className="size-4 animate-spin" />Testing…</> : <><Zap className="size-4" />Test API Connection</>}
            </Button>
            {config && (
              <Button
                variant="outline"
                onClick={handleReset}
                disabled={resetting}
                className="text-destructive hover:text-destructive"
              >
                {resetting ? <><Loader2 className="size-4 animate-spin" />Resetting…</> : <><RotateCcw className="size-4" />Reset Configuration</>}
              </Button>
            )}
          </div>
        </div>

        {/* Setup Instructions */}
        <div>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Setup Instructions</CardTitle>
              <CardDescription>Follow these steps to connect your WhatsApp Business API.</CardDescription>
            </CardHeader>
            <CardContent>
              <Accordion>
                <AccordionItem className="border-border">
                  <AccordionTrigger className="text-foreground hover:no-underline">
                    <span className="flex items-center gap-2">
                      <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">1</span>
                      Create a Meta App
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="text-muted-foreground">
                    <ol className="list-inside list-decimal space-y-1 text-sm">
                      <li>Go to <span className="text-primary">developers.facebook.com</span></li>
                      <li>Click &quot;My Apps&quot; and then &quot;Create App&quot;</li>
                      <li>Select &quot;Business&quot; as the app type</li>
                      <li>Fill in app details and create</li>
                    </ol>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem className="border-border">
                  <AccordionTrigger className="text-foreground hover:no-underline">
                    <span className="flex items-center gap-2">
                      <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">2</span>
                      Add WhatsApp Product
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="text-muted-foreground">
                    <ol className="list-inside list-decimal space-y-1 text-sm">
                      <li>In your app dashboard, click &quot;Add Product&quot;</li>
                      <li>Find &quot;WhatsApp&quot; and click &quot;Set Up&quot;</li>
                      <li>Follow the setup wizard to link your business</li>
                    </ol>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem className="border-border">
                  <AccordionTrigger className="text-foreground hover:no-underline">
                    <span className="flex items-center gap-2">
                      <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">3</span>
                      Get API Credentials
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="text-muted-foreground">
                    <ol className="list-inside list-decimal space-y-1 text-sm">
                      <li>Go to WhatsApp &gt; API Setup</li>
                      <li>Copy your <strong className="text-foreground">Phone Number ID</strong></li>
                      <li>Copy your <strong className="text-foreground">WhatsApp Business Account ID</strong></li>
                      <li>Generate a <strong className="text-foreground">Permanent Access Token</strong> from Business Settings &gt; System Users (grant whatsapp_business_messaging + management)</li>
                    </ol>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem className="border-border">
                  <AccordionTrigger className="text-foreground hover:no-underline">
                    <span className="flex items-center gap-2">
                      <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">4</span>
                      Configure Webhooks
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="text-muted-foreground">
                    <ol className="list-inside list-decimal space-y-1 text-sm">
                      <li>Go to WhatsApp &gt; Configuration</li>
                      <li>Click &quot;Edit&quot; on the Webhook section</li>
                      <li>Paste the <strong className="text-foreground">Webhook Callback URL</strong> from above</li>
                      <li>Enter the same <strong className="text-foreground">Verify Token</strong> you set here</li>
                      <li>Subscribe to &quot;messages&quot; webhook field</li>
                    </ol>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>

              <div className="mt-4 border-t border-border pt-4">
                <a
                  href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-primary transition-colors hover:text-primary/80"
                >
                  <ExternalLink className="size-3.5" />
                  Meta WhatsApp API Documentation
                </a>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
