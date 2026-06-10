"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import type { Conversation, ConversationStatus } from "@/types";
import { Search, Plus } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { ScrollArea } from "@/components/ui/scroll-area";

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  /**
   * Increment to force the fetch effect below to refire. The parent
   * bumps this on realtime reconnect / tab visibility → visible so the
   * list catches up on any events sent while the WS was disconnected
   * or the tab was throttled. Optional so existing callers keep working.
   */
  resyncToken?: number;
}

// Quick-filter values. "unread" is derived (unread_count > 0), and
// "open"/"closed" are derived from the WhatsApp 24h customer service
// window (see isWindowOpen). Only "pending" still maps straight to
// conversation.status.
type Filter = "all" | "unread" | ConversationStatus;

// WhatsApp's 24-hour customer service window, anchored to the customer's
// last INBOUND message (conversations.last_inbound_at). Outbound
// agent/bot messages never extend it. No inbound ever → window closed.
const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

function isWindowOpen(conv: Conversation, now: number): boolean {
  if (!conv.last_inbound_at) return false;
  return now - new Date(conv.last_inbound_at).getTime() <= SERVICE_WINDOW_MS;
}

const FILTER_OPTIONS: { label: string; value: Filter }[] = [
  { label: "All", value: "all" },
  { label: "Unread", value: "unread" },
  { label: "Open", value: "open" },
  { label: "Pending", value: "pending" },
  { label: "Closed", value: "closed" },
];

// Deterministic avatar tint so each contact keeps a stable, on-brand
// colour (matching the multi-colour avatars in the Wasify 2 design).
const AVATAR_COLORS = [
  "#16A34A",
  "#2563EB",
  "#F59E0B",
  "#7C3AED",
  "#DB2777",
  "#0891B2",
  "#EA580C",
];

function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
}: ConversationListProps) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [loading, setLoading] = useState(true);

  // Ticks every minute so conversations drift from Open to Closed as
  // their 24h window lapses, without waiting for a refetch or realtime
  // event (time passing produces no DB event).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Keep the latest callback in a ref so the fetch effect below can
  // have a stable, empty-dep identity. Previously the fetch useCallback
  // depended on `onConversationsLoaded`, which depends on the parent's
  // `deepLinkConvId` — so every URL change (including one the parent
  // triggered via router.replace after a click) caused a fresh
  // conversations fetch. That extra refetch was the trigger for the
  // deep-link auto-select running a second time and wiping the active
  // thread's messages.
  // Mutation lives in an effect (not render) per React 19's refs rule;
  // the fetch runs once on mount so it's fine to read the slightly
  // older value — the very next render updates the ref for any
  // subsequent async completion.
  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
  });

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select("*, contact:contacts(*)")
        .order("last_message_at", { ascending: false });

      if (cancelled) return;

      if (error) {
        // Supabase errors have non-enumerable properties — log fields explicitly
        console.error("Failed to fetch conversations:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        setLoading(false);
        return;
      }

      onConversationsLoadedRef.current(data ?? []);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus — catches
    // up on any events sent while the WS was disconnected or throttled.
  }, [resyncToken]);

  const counts = useMemo(
    () => ({
      all: conversations.length,
      unread: conversations.filter((c) => c.unread_count > 0).length,
      open: conversations.filter((c) => isWindowOpen(c, now)).length,
      pending: conversations.filter((c) => c.status === "pending").length,
      closed: conversations.filter((c) => !isWindowOpen(c, now)).length,
    }),
    [conversations, now],
  );

  const filtered = useMemo(() => {
    let result = conversations;

    if (filter === "unread") {
      result = result.filter((c) => c.unread_count > 0);
    } else if (filter === "open") {
      result = result.filter((c) => isWindowOpen(c, now));
    } else if (filter === "closed") {
      result = result.filter((c) => !isWindowOpen(c, now));
    } else if (filter !== "all") {
      result = result.filter((c) => c.status === filter);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? "";
        const phone = c.contact?.phone?.toLowerCase() ?? "";
        const lastMsg = c.last_message_text?.toLowerCase() ?? "";
        return name.includes(q) || phone.includes(q) || lastMsg.includes(q);
      });
    }

    return result;
  }, [conversations, filter, search, now]);

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    [],
  );

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
    },
    [onSelect],
  );

  return (
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed 320px on desktop where it shares the
    // row with the thread + contact sidebar.
    <div className="flex h-full w-full flex-col border-r border-border bg-card lg:w-80">
      {/* Header: title + new chat, search, filter chips */}
      <div className="shrink-0 px-4 pb-3 pt-4">
        <div className="mb-3.5 flex items-center justify-between">
          <h2 className="font-heading text-lg font-extrabold text-foreground">
            Inbox
          </h2>
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-primary px-3 font-heading text-[13px] font-bold text-primary-foreground shadow-[0_8px_20px_rgba(22,163,74,0.22)] transition hover:bg-primary-hover"
          >
            <Plus className="h-4 w-4" />
            New chat
          </button>
        </div>

        <div className="flex h-10 items-center gap-2.5 rounded-xl border border-border bg-background px-3.5 text-muted-foreground">
          <Search className="h-[17px] w-[17px] shrink-0" />
          <input
            value={search}
            onChange={handleSearchChange}
            placeholder="Search conversations…"
            aria-label="Search conversations"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {FILTER_OPTIONS.map((opt) => {
            const active = filter === opt.value;
            const count = counts[opt.value];
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setFilter(opt.value)}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 font-heading text-[13px] font-bold transition",
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card text-muted-foreground hover:bg-muted",
                )}
              >
                {opt.label}
                <span
                  className={cn(
                    "rounded-full px-1.5 text-[11px] font-extrabold",
                    active
                      ? "bg-white/25 text-primary-foreground"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Conversation Items */}
      <ScrollArea className="min-h-0 flex-1 border-t border-border-soft">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm text-muted-foreground">No conversations found</p>
          </div>
        ) : (
          <div className="flex flex-col">
            {filtered.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                isActive={conv.id === activeConversationId}
                onSelect={handleSelect}
                now={now}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
  /** Parent's minute-tick timestamp — keeps the window dot pure. */
  now: number;
}

function ConversationItem({
  conversation,
  isActive,
  onSelect,
  now,
}: ConversationItemProps) {
  const contact = conversation.contact;
  const displayName = contact?.name || contact?.phone || "Unknown";
  const initials = displayName.charAt(0).toUpperCase();
  const color = avatarColor(contact?.id ?? displayName);
  const unread = conversation.unread_count > 0;

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

  const timeAgo = conversation.last_message_at
    ? formatDistanceToNow(new Date(conversation.last_message_at), {
        addSuffix: false,
      })
    : "";

  return (
    <button
      onClick={handleClick}
      className={cn(
        "flex w-full items-start gap-3 border-b border-border-soft px-4 py-3 text-left transition-colors",
        isActive
          ? "border-l-[3px] border-l-primary bg-primary-soft"
          : "border-l-[3px] border-l-transparent hover:bg-background",
      )}
    >
      {/* Avatar */}
      <div className="relative shrink-0">
        <div
          className="flex h-11 w-11 items-center justify-center rounded-full font-heading text-sm font-extrabold"
          style={{ backgroundColor: `${color}1f`, color }}
        >
          {contact?.avatar_url ? (
            <img
              src={contact.avatar_url}
              alt={displayName}
              className="h-11 w-11 rounded-full object-cover"
            />
          ) : (
            initials
          )}
        </div>
        {isWindowOpen(conversation, now) && (
          <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-primary-hover ring-2 ring-card" />
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-heading text-sm font-bold text-foreground">
            {displayName}
          </span>
          <span
            className={cn(
              "shrink-0 text-[11.5px]",
              unread ? "font-extrabold text-primary" : "text-muted-foreground",
            )}
          >
            {timeAgo}
          </span>
        </div>
        <div className="mt-1 flex items-center justify-between gap-2">
          <p
            className={cn(
              "truncate text-[13px]",
              unread ? "font-semibold text-foreground" : "text-muted-foreground",
            )}
          >
            {conversation.last_message_text || "No messages yet"}
          </p>
          {unread && (
            <span className="flex h-[19px] min-w-[19px] shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-extrabold text-primary-foreground">
              {conversation.unread_count}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
