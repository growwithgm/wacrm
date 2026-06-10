"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Contact, Conversation, MessageTemplate } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, MessageSquarePlus, Phone, Search } from "lucide-react";
import { toast } from "sonner";
import { TemplatePicker } from "./template-picker";
import {
  isValidE164,
  phonesMatch,
  sanitizePhoneForMeta,
} from "@/lib/whatsapp/phone-utils";

interface NewChatFlowProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Called with the conversation (contact joined) after the template send
   * succeeds. The parent opens it in the thread; the conversation list
   * itself catches up through the same realtime INSERT/UPDATE events a
   * webhook-created conversation uses.
   */
  onConversationReady: (conversation: Conversation) => void;
}

type Recipient =
  | { kind: "existing"; contact: Contact }
  | { kind: "new"; phone: string };

// Mirrors renderTemplateBody in message-thread.tsx (unexported there): the
// rendered body is stored as the message's content_text so the thread shows
// the final text, exactly like templates sent from inside a thread.
function renderTemplateBody(body: string, params: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, raw) => {
    const idx = Number(raw) - 1;
    return params[idx] ?? `{{${raw}}}`;
  });
}

/**
 * Find the contact this chat should target, never creating a duplicate.
 *
 * Mirrors the inbound webhook's findOrCreateContact: load this user's
 * contacts and compare with phonesMatch (tolerant of trunk-0 / formatting
 * differences), NOT strict string equality — so a chat started here and a
 * later webhook reply always resolve to the same contact row. New contacts
 * are stored digits-only (sanitizePhoneForMeta), the same format the
 * webhook writes wa_ids in.
 */
async function resolveContact(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  userId: string,
  recipient: Recipient,
): Promise<Contact> {
  if (recipient.kind === "existing") return recipient.contact;

  const sanitized = sanitizePhoneForMeta(recipient.phone);

  const { data: contacts, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("user_id", userId);
  if (error) throw new Error(`Failed to look up contacts: ${error.message}`);

  const match = (contacts ?? []).find((c: Contact) =>
    phonesMatch(c.phone, sanitized),
  );
  if (match) return match;

  const { data: created, error: createError } = await supabase
    .from("contacts")
    .insert({ user_id: userId, phone: sanitized, name: sanitized })
    .select()
    .single();
  if (createError || !created) {
    throw new Error(
      `Failed to create contact: ${createError?.message ?? "unknown error"}`,
    );
  }
  return created as Contact;
}

/**
 * Find or create the conversation for a contact — same match keys as the
 * webhook's findOrCreateConversation (user_id + contact_id), so a chat
 * started here and the conversation a webhook would create for the same
 * contact are always the same row. If the insert loses a race (e.g. the
 * customer messaged in at the same moment), re-select instead of failing.
 */
async function resolveConversation(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  userId: string,
  contactId: string,
): Promise<Conversation> {
  const find = () =>
    supabase
      .from("conversations")
      .select("*")
      .eq("user_id", userId)
      .eq("contact_id", contactId)
      .maybeSingle();

  const { data: existing } = await find();
  if (existing) return existing as Conversation;

  const { data: created, error: createError } = await supabase
    .from("conversations")
    .insert({ user_id: userId, contact_id: contactId })
    .select()
    .single();
  if (created) return created as Conversation;

  const { data: retry } = await find();
  if (retry) return retry as Conversation;

  throw new Error(
    `Failed to create conversation: ${createError?.message ?? "unknown error"}`,
  );
}

export function NewChatFlow({
  open,
  onOpenChange,
  onConversationReady,
}: NewChatFlowProps) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(true);
  const [search, setSearch] = useState("");
  const [phoneInput, setPhoneInput] = useState("");
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [recipient, setRecipient] = useState<Recipient | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sending, setSending] = useState(false);

  // Recent contacts for the picker list. Capped — for anyone not in the
  // first page, typing their full number still dedupes onto the existing
  // contact via phonesMatch in resolveContact.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoadingContacts(true);
      const supabase = createClient();
      const { data, error } = await supabase
        .from("contacts")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(200);
      if (cancelled) return;
      if (error) {
        console.error("Failed to fetch contacts:", error);
        setContacts([]);
      } else {
        setContacts((data as Contact[]) ?? []);
      }
      setLoadingContacts(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const q = search.trim().toLowerCase();
  const filtered = q
    ? contacts.filter((c) => {
        const name = c.name?.toLowerCase() ?? "";
        const phone = c.phone?.toLowerCase() ?? "";
        const email = c.email?.toLowerCase() ?? "";
        return name.includes(q) || phone.includes(q) || email.includes(q);
      })
    : contacts;

  function resetRecipientState() {
    setSearch("");
    setPhoneInput("");
    setPhoneError(null);
  }

  function handleRecipientOpenChange(next: boolean) {
    if (!next) resetRecipientState();
    onOpenChange(next);
  }

  function proceedWith(r: Recipient) {
    setRecipient(r);
    resetRecipientState();
    onOpenChange(false);
    setPickerOpen(true);
  }

  function handlePickContact(contact: Contact) {
    proceedWith({ kind: "existing", contact });
  }

  function handleContinueWithPhone() {
    const trimmed = phoneInput.trim();
    if (!isValidE164(trimmed)) {
      setPhoneError(
        "Enter a valid phone number in international format, e.g. +37061234567",
      );
      return;
    }
    setPhoneError(null);
    proceedWith({ kind: "new", phone: trimmed });
  }

  function handlePickerOpenChange(next: boolean) {
    setPickerOpen(next);
    // Picker dismissed without choosing a template — drop the pending
    // recipient so reopening the flow starts clean.
    if (!next && !sending) setRecipient(null);
  }

  async function handleTemplateSelect(
    template: MessageTemplate,
    params: string[],
  ) {
    if (!recipient || sending) return;
    setSending(true);
    const toastId = toast.loading("Sending template…");

    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in");

      const contact = await resolveContact(supabase, user.id, recipient);
      const conversation = await resolveConversation(
        supabase,
        user.id,
        contact.id,
      );

      // Same payload the in-thread template send uses — one send path.
      const res = await fetch("/api/whatsapp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversation_id: conversation.id,
          message_type: "template",
          template_name: template.name,
          template_language: template.language,
          template_params: params,
          content_text: renderTemplateBody(template.body_text, params),
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload?.error || `HTTP ${res.status}`);
      }

      // Re-fetch with the contact joined — the parent's select handler
      // reads conversation.contact for the thread header + sidebar.
      const { data: full } = await supabase
        .from("conversations")
        .select("*, contact:contacts(*)")
        .eq("id", conversation.id)
        .single();

      toast.success("Template sent", { id: toastId });
      setRecipient(null);
      onConversationReady((full as Conversation) ?? conversation);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Unknown error";
      console.error("New chat send failed:", err);
      toast.error(`Failed to start chat: ${reason}`, { id: toastId });
      setRecipient(null);
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={handleRecipientOpenChange}>
        <DialogContent className="border-border bg-card sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-heading text-foreground">
              <MessageSquarePlus className="h-4 w-4 text-primary" />
              New chat
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Start a conversation by sending an approved template — new
              contacts are outside the 24-hour window, so free text isn&apos;t
              allowed yet.
            </DialogDescription>
          </DialogHeader>

          {/* Existing contacts */}
          <div className="flex h-10 items-center gap-2.5 rounded-xl border border-border bg-background px-3.5 text-muted-foreground transition-[border-color,box-shadow] focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/10">
            <Search className="h-4 w-4 shrink-0" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search contacts…"
              aria-label="Search contacts"
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>

          <div className="max-h-56 space-y-1 overflow-y-auto">
            {loadingContacts ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
              </div>
            ) : filtered.length === 0 ? (
              <p className="px-1 py-4 text-center text-xs text-muted-foreground">
                {contacts.length === 0
                  ? "No contacts yet — enter a phone number below."
                  : "No contacts match your search."}
              </p>
            ) : (
              filtered.map((c) => {
                const display = c.name || c.phone;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => handlePickContact(c)}
                    className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors duration-150 hover:bg-muted"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 font-heading text-sm font-extrabold text-primary">
                      {display.charAt(0).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-heading text-sm font-bold text-foreground">
                        {display}
                      </span>
                      {c.name && (
                        <span className="block truncate text-xs text-muted-foreground">
                          {c.phone}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })
            )}
          </div>

          {/* New number */}
          <div className="flex items-center gap-3">
            <span className="h-px flex-1 bg-border-soft" />
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              or send to a new number
            </span>
            <span className="h-px flex-1 bg-border-soft" />
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="flex h-10 flex-1 items-center gap-2.5 rounded-xl border border-border bg-background px-3.5 text-muted-foreground transition-[border-color,box-shadow] focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/10">
                <Phone className="h-4 w-4 shrink-0" />
                <input
                  value={phoneInput}
                  onChange={(e) => {
                    setPhoneInput(e.target.value);
                    if (phoneError) setPhoneError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleContinueWithPhone();
                    }
                  }}
                  placeholder="+37061234567"
                  aria-label="New phone number"
                  inputMode="tel"
                  className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                />
              </div>
              <Button
                onClick={handleContinueWithPhone}
                disabled={!phoneInput.trim()}
                className="h-10 rounded-xl bg-primary font-heading font-bold text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
              >
                Continue
              </Button>
            </div>
            {phoneError && (
              <p className="text-xs text-destructive">{phoneError}</p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <TemplatePicker
        open={pickerOpen}
        onOpenChange={handlePickerOpenChange}
        onSelect={handleTemplateSelect}
      />
    </>
  );
}
