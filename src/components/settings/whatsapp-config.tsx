'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import {
  Eye,
  EyeOff,
  Copy,
  CheckCircle2,
  XCircle,
  Loader2,
  ExternalLink,
  Zap,
  AlertTriangle,
  RotateCcw,
  RefreshCw,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
    return new Date(ts).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return ts;
  }
}

type ConnectionStatus = 'connected' | 'disconnected' | 'unknown';
type ResetReason = 'token_corrupted' | 'meta_api_error' | null;

export function WhatsAppConfig() {
  const supabase = createClient();
  const { user, loading: authLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [config, setConfig] = useState<WhatsAppConfigType | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('unknown');
  const [resetReason, setResetReason] = useState<ResetReason>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [wabaName, setWabaName] = useState<string>('');
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);

  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [verifyToken, setVerifyToken] = useState('');
  const [tokenEdited, setTokenEdited] = useState(false);

  const fetchedForUserRef = useRef<string | null>(null);

  const webhookUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/whatsapp/webhook`
      : '';

  const fetchConfig = useCallback(async (userId: string) => {
    setLoading(true);
    let hasConfig = false;

    try {
      const { data, error } = await supabase
        .from('whatsapp_config')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();

      if (error) {
        console.error('Failed to load config row:', error);
      }

      const draft = (() => {
        try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null') ?? {}; }
        catch { return {}; }
      })();

      if (data) {
        hasConfig = true;
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
        // Show cached status immediately from DB
        setConnectionStatus(data.status === 'connected' ? 'connected' : 'disconnected');
        setWabaName((data as unknown as Record<string, unknown>).waba_name as string ?? '');
        setLastCheckedAt((data as unknown as Record<string, unknown>).last_checked_at as string ?? null);
      } else {
        setConfig(null);
        setPhoneNumberId(draft.phoneNumberId ?? '');
        setWabaId(draft.wabaId ?? '');
        setAccessToken(draft.accessToken && draft.tokenEdited ? draft.accessToken : '');
        setVerifyToken(draft.verifyToken ?? '');
        setTokenEdited(!!draft.tokenEdited);
        setConnectionStatus('disconnected');
        setWabaName('');
        setLastCheckedAt(null);
      }
    } catch (err) {
      console.error('fetchConfig error:', err);
      toast.error('Failed to load WhatsApp configuration');
    } finally {
      setLoading(false);
    }

    // Background re-validation — updates banner without blocking form render.
    if (!hasConfig) return;
    setChecking(true);
    try {
      const res = await fetch('/api/whatsapp/config', { method: 'GET' });
      const payload = await res.json();

      if (payload.connected) {
        setConnectionStatus('connected');
        setWabaName(payload.waba_info?.name ?? '');
        setLastCheckedAt(payload.last_checked_at ?? null);
        setResetReason(null);
        setStatusMessage('');
      } else {
        setConnectionStatus('disconnected');
        setResetReason(payload.needs_reset ? 'token_corrupted' : payload.reason === 'meta_api_error' ? 'meta_api_error' : null);
        setStatusMessage(payload.message || '');
        setLastCheckedAt(payload.last_checked_at ?? null);
      }
    } catch (err) {
      console.error('Background health check failed:', err);
      // Keep cached status — don't change anything
    } finally {
      setChecking(false);
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

      if (data.warning) {
        toast.warning(`Credentials saved. Meta verification failed: ${data.warning}`);
      } else {
        const name = data.waba_info?.name || data.phone_info?.verified_name;
        toast.success(name ? `Connected to ${name}` : 'Configuration saved successfully');
      }

      clearDraft();
      fetchedForUserRef.current = null; // Force re-fetch
      if (user) await fetchConfig(user.id);
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
      const res = await fetch('/api/whatsapp/config', { method: 'GET' });
      const payload = await res.json();

      if (payload.connected) {
        setConnectionStatus('connected');
        setWabaName(payload.waba_info?.name ?? '');
        setLastCheckedAt(payload.last_checked_at ?? null);
        setResetReason(null);
        setStatusMessage('');
        const name = payload.waba_info?.name || payload.phone_info?.verified_name;
        toast.success(name ? `Connected to ${name}` : 'API connection successful');
      } else {
        setConnectionStatus('disconnected');
        setResetReason(payload.needs_reset ? 'token_corrupted' : payload.reason === 'meta_api_error' ? 'meta_api_error' : null);
        setStatusMessage(payload.message || '');
        toast.error(payload.message || 'API connection failed');
      }
    } catch (err) {
      console.error('Test connection error:', err);
      setConnectionStatus('disconnected');
      toast.error('Connection test failed. Check network and try again.');
    } finally {
      setTesting(false);
    }
  }

  async function handleReset() {
    if (!confirm('This will delete the current WhatsApp config so you can re-enter it. Continue?')) {
      return;
    }
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
      setConnectionStatus('disconnected');
      setResetReason(null);
      setStatusMessage('');
      setWabaName('');
      setLastCheckedAt(null);
    } catch (err) {
      console.error('Reset error:', err);
      toast.error('Failed to reset configuration');
    } finally {
      setResetting(false);
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

  const showResetBanner = resetReason === 'token_corrupted';

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px] mt-4">
      {/* Main config form */}
      <div className="space-y-6">

        {/* Corrupted-token reset banner */}
        {showResetBanner && (
          <Alert className="bg-amber-950/40 border-amber-600/40">
            <div className="flex items-start gap-3">
              <AlertTriangle className="size-5 text-amber-400 mt-0.5 shrink-0" />
              <div className="flex-1">
                <AlertTitle className="text-amber-200 mb-1">
                  Stored token can&apos;t be decrypted
                </AlertTitle>
                <AlertDescription className="text-amber-100/80 text-sm">
                  {statusMessage}
                </AlertDescription>
                <Button
                  onClick={handleReset}
                  disabled={resetting}
                  size="sm"
                  className="mt-3 bg-amber-600 hover:bg-amber-700 text-white"
                >
                  {resetting ? (
                    <><Loader2 className="size-4 animate-spin" />Resetting...</>
                  ) : (
                    <><RotateCcw className="size-4" />Reset Configuration</>
                  )}
                </Button>
              </div>
            </div>
          </Alert>
        )}

        {/* ─── Connection Status Banner ─── */}
        <div
          className={
            connectionStatus === 'connected'
              ? 'rounded-xl border border-green-500 bg-green-900/50 p-4'
              : 'rounded-xl border border-red-500 bg-red-900/50 p-4'
          }
        >
          <div className="flex items-start gap-3">
            {connectionStatus === 'connected' ? (
              <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-green-400" />
            ) : (
              <XCircle className="mt-0.5 size-5 shrink-0 text-red-400" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className={connectionStatus === 'connected' ? 'font-semibold text-green-200' : 'font-semibold text-red-200'}>
                  {connectionStatus === 'connected'
                    ? `Connected${wabaName ? ` — Account: ${wabaName}` : ''}`
                    : 'Not Connected'}
                </p>
                {checking && (
                  <RefreshCw className="size-3.5 animate-spin text-slate-400" />
                )}
              </div>
              {connectionStatus !== 'connected' && (
                <p className="mt-1 text-sm text-red-300/80">
                  {statusMessage || 'Configure your Meta API credentials below to connect your WhatsApp Business account.'}
                </p>
              )}
              <p className="mt-1.5 text-xs text-slate-400">
                Last checked: {checking ? 'Verifying…' : formatTimestamp(lastCheckedAt)}
              </p>
            </div>
          </div>
        </div>

        {/* API Credentials */}
        <Card className="bg-slate-900 border-slate-700 ring-0 ring-transparent">
          <CardHeader>
            <CardTitle className="text-white">API Credentials</CardTitle>
            <CardDescription className="text-slate-400">
              Enter your Meta WhatsApp Business API credentials.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label className="text-slate-300">Phone Number ID</Label>
              <Input
                placeholder="e.g. 100234567890123"
                value={phoneNumberId}
                onChange={(e) => { setPhoneNumberId(e.target.value); saveDraft({ phoneNumberId: e.target.value }); }}
                className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-slate-300">WhatsApp Business Account ID</Label>
              <Input
                placeholder="e.g. 100234567890456"
                value={wabaId}
                onChange={(e) => { setWabaId(e.target.value); saveDraft({ wabaId: e.target.value }); }}
                className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-slate-300">Permanent Access Token</Label>
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
                  className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500 pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white transition-colors"
                >
                  {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              {config && !tokenEdited && (
                <p className="text-xs text-slate-500">
                  Token is hidden for security. Re-enter it to update configuration.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-slate-300">Webhook Verify Token</Label>
              <Input
                placeholder="Create a custom verify token"
                value={verifyToken}
                onChange={(e) => { setVerifyToken(e.target.value); saveDraft({ verifyToken: e.target.value }); }}
                className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500"
              />
              <p className="text-xs text-slate-500">
                A custom string you create. Must match the token you set in Meta webhook settings.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Webhook URL */}
        <Card className="bg-slate-900 border-slate-700 ring-0 ring-transparent">
          <CardHeader>
            <CardTitle className="text-white">Webhook Configuration</CardTitle>
            <CardDescription className="text-slate-400">
              Use this URL as your webhook callback in the Meta App Dashboard.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <Label className="text-slate-300">Webhook Callback URL</Label>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={webhookUrl}
                  className="bg-slate-800 border-slate-700 text-slate-300 font-mono text-sm"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleCopyWebhookUrl}
                  className="shrink-0 border-slate-700 text-slate-300 hover:text-white hover:bg-slate-800"
                >
                  <Copy className="size-4" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Action Buttons */}
        <div className="flex flex-wrap gap-3">
          <Button
            onClick={handleSave}
            disabled={saving}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {saving ? (
              <><Loader2 className="size-4 animate-spin" />Saving...</>
            ) : (
              'Save Configuration'
            )}
          </Button>
          <Button
            variant="outline"
            onClick={handleTestConnection}
            disabled={testing || !config}
            className="border-slate-700 text-slate-300 hover:text-white hover:bg-slate-800"
          >
            {testing ? (
              <><Loader2 className="size-4 animate-spin" />Testing...</>
            ) : (
              <><Zap className="size-4" />Test API Connection</>
            )}
          </Button>
          {config && (
            <Button
              variant="outline"
              onClick={handleReset}
              disabled={resetting}
              className="border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
            >
              {resetting ? (
                <><Loader2 className="size-4 animate-spin" />Resetting...</>
              ) : (
                <><RotateCcw className="size-4" />Reset Configuration</>
              )}
            </Button>
          )}
        </div>
      </div>

      {/* Setup Instructions Sidebar */}
      <div>
        <Card className="bg-slate-900 border-slate-700 ring-0 ring-transparent">
          <CardHeader>
            <CardTitle className="text-white text-base">Setup Instructions</CardTitle>
            <CardDescription className="text-slate-400">
              Follow these steps to connect your WhatsApp Business API.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Accordion>
              <AccordionItem className="border-slate-700">
                <AccordionTrigger className="text-slate-300 hover:text-white hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">1</span>
                    Create a Meta App
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-slate-400">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>Go to <span className="text-primary">developers.facebook.com</span></li>
                    <li>Click &quot;My Apps&quot; and then &quot;Create App&quot;</li>
                    <li>Select &quot;Business&quot; as the app type</li>
                    <li>Fill in app details and create</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem className="border-slate-700">
                <AccordionTrigger className="text-slate-300 hover:text-white hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">2</span>
                    Add WhatsApp Product
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-slate-400">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>In your app dashboard, click &quot;Add Product&quot;</li>
                    <li>Find &quot;WhatsApp&quot; and click &quot;Set Up&quot;</li>
                    <li>Follow the setup wizard to link your business</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem className="border-slate-700">
                <AccordionTrigger className="text-slate-300 hover:text-white hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">3</span>
                    Get API Credentials
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-slate-400">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>Go to WhatsApp &gt; API Setup</li>
                    <li>Copy your <strong className="text-slate-200">Phone Number ID</strong></li>
                    <li>Copy your <strong className="text-slate-200">WhatsApp Business Account ID</strong></li>
                    <li>Generate a <strong className="text-slate-200">Permanent Access Token</strong> from Business Settings &gt; System Users</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem className="border-slate-700">
                <AccordionTrigger className="text-slate-300 hover:text-white hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">4</span>
                    Configure Webhooks
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-slate-400">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>Go to WhatsApp &gt; Configuration</li>
                    <li>Click &quot;Edit&quot; on the Webhook section</li>
                    <li>Paste the <strong className="text-slate-200">Webhook Callback URL</strong> from above</li>
                    <li>Enter the same <strong className="text-slate-200">Verify Token</strong> you set here</li>
                    <li>Subscribe to &quot;messages&quot; webhook field</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>
            </Accordion>

            <div className="mt-4 pt-4 border-t border-slate-700">
              <a
                href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 transition-colors"
              >
                <ExternalLink className="size-3.5" />
                Meta WhatsApp API Documentation
              </a>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
