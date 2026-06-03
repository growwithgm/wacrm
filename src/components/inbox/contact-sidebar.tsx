"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Contact, Deal, ContactNote, Tag } from "@/types";
import { Phone, Copy, Check, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { format } from "date-fns";

interface ContactSidebarProps {
  contact: Contact | null;
}

// Deterministic avatar tint — mirrors the conversation list so a contact
// keeps the same colour across both panels.
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

/** Uppercase section wrapper matching the Wasify 2 profile panel. */
function Section({
  title,
  children,
  last,
}: {
  title: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div className={last ? "px-5 py-4" : "border-b border-border-soft px-5 py-4"}>
      <div className="mb-2.5 font-heading text-[11.5px] font-extrabold uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  );
}

export function ContactSidebar({ contact }: ContactSidebarProps) {
  const [copied, setCopied] = useState(false);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [tags, setTags] = useState<(Tag & { contact_tag_id: string })[]>([]);
  const [newNote, setNewNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);

  const fetchContactData = useCallback(async () => {
    if (!contact) return;

    const supabase = createClient();

    // Fetch deals, notes, and tags in parallel
    const [dealsRes, notesRes, tagsRes] = await Promise.all([
      supabase
        .from("deals")
        .select("*, stage:pipeline_stages(*)")
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("contact_notes")
        .select("*")
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("contact_tags")
        .select("id, tag_id, tags(*)")
        .eq("contact_id", contact.id),
    ]);

    if (dealsRes.data) setDeals(dealsRes.data);
    if (notesRes.data) setNotes(notesRes.data);
    if (tagsRes.data) {
      const mapped = tagsRes.data
        .filter((ct: Record<string, unknown>) => ct.tags)
        .map((ct: Record<string, unknown>) => ({
          ...(ct.tags as Tag),
          contact_tag_id: ct.id as string,
        }));
      setTags(mapped);
    }
  }, [contact]);

  // Load on contact change. setContactData/setTags run inside async
  // Supabase callbacks, not synchronously in the effect body.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchContactData();
  }, [fetchContactData]);

  const handleCopyPhone = useCallback(async () => {
    if (!contact?.phone) return;
    await navigator.clipboard.writeText(contact.phone);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    // Dep is the whole `contact` object (not `contact?.phone`) so the
    // React Compiler's inference agrees with the manual dep list —
    // fixes the `preserve-manual-memoization` lint error.
  }, [contact]);

  const handleAddNote = useCallback(async () => {
    if (!contact || !newNote.trim()) return;
    setAddingNote(true);

    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;

    const { data, error } = await supabase
      .from("contact_notes")
      .insert({
        contact_id: contact.id,
        user_id: user?.id,
        note_text: newNote.trim(),
      })
      .select()
      .single();

    if (!error && data) {
      setNotes((prev) => [data, ...prev]);
      setNewNote("");
    }
    setAddingNote(false);
  }, [contact, newNote]);

  if (!contact) {
    return (
      <div className="flex h-full w-[300px] items-center justify-center border-l border-border bg-card">
        <p className="text-sm text-muted-foreground">Select a conversation</p>
      </div>
    );
  }

  const displayName = contact.name || contact.phone;
  const initials = displayName.charAt(0).toUpperCase();
  const color = avatarColor(contact.id ?? displayName);

  return (
    <div className="flex h-full w-[300px] flex-col border-l border-border bg-card">
      <ScrollArea className="min-h-0 flex-1">
        {/* Profile header */}
        <div className="border-b border-border-soft px-5 py-6 text-center">
          <div
            className="mx-auto flex h-[72px] w-[72px] items-center justify-center rounded-full font-heading text-2xl font-extrabold"
            style={{ backgroundColor: `${color}1f`, color }}
          >
            {contact.avatar_url ? (
              <img
                src={contact.avatar_url}
                alt={displayName}
                className="h-[72px] w-[72px] rounded-full object-cover"
              />
            ) : (
              initials
            )}
          </div>
          <h3 className="mt-3 font-heading text-[17px] font-extrabold text-foreground">
            {displayName}
          </h3>
          {contact.company && (
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              {contact.company}
            </p>
          )}
          {contact.name && contact.phone && (
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              {contact.phone}
            </p>
          )}
          <div className="mt-3.5 flex justify-center gap-2">
            <a
              href={`tel:${contact.phone}`}
              className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-border bg-card px-3 font-heading text-[13px] font-bold text-foreground shadow-xs transition hover:bg-muted"
            >
              <Phone className="h-3.5 w-3.5" />
              Call
            </a>
            <button
              type="button"
              onClick={handleCopyPhone}
              className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-border bg-card px-3 font-heading text-[13px] font-bold text-foreground shadow-xs transition hover:bg-muted"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-primary" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>

        {/* Tags */}
        <Section title="Tags">
          <div className="flex flex-wrap gap-1.5">
            {tags.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">No tags</p>
            ) : (
              tags.map((tag) => (
                <span
                  key={tag.contact_tag_id}
                  className="rounded-full px-2.5 py-1 text-[12px] font-bold"
                  style={{
                    backgroundColor: `${tag.color}1f`,
                    color: tag.color,
                  }}
                >
                  {tag.name}
                </span>
              ))
            )}
          </div>
        </Section>

        {/* Active Deals */}
        <Section title="Active Deals">
          <div className="space-y-2">
            {deals.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">No deals</p>
            ) : (
              deals.map((deal) => (
                <div
                  key={deal.id}
                  className="rounded-xl border border-border px-3 py-2.5"
                >
                  <p className="text-sm font-bold text-foreground">
                    {deal.title}
                  </p>
                  <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                    <span className="font-heading font-bold text-foreground">
                      {deal.currency ?? "$"}
                      {deal.value.toLocaleString()}
                    </span>
                    {deal.stage && (
                      <span
                        className="rounded-full px-2 py-0.5 text-[10px] font-bold"
                        style={{
                          backgroundColor: `${deal.stage.color}1f`,
                          color: deal.stage.color,
                        }}
                      >
                        {deal.stage.name}
                      </span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </Section>

        {/* Notes */}
        <Section title="Notes" last>
          <div className="flex gap-2">
            <textarea
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
              placeholder="Add a note..."
              rows={2}
              className="flex-1 resize-none rounded-xl border border-border bg-background px-3 py-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/50"
            />
            <Button
              size="sm"
              className="h-auto bg-primary px-2 hover:bg-primary-hover"
              onClick={handleAddNote}
              disabled={!newNote.trim() || addingNote}
            >
              <Plus className="h-3 w-3" />
            </Button>
          </div>

          <div className="mt-2 space-y-2">
            {notes.map((note) => (
              <div
                key={note.id}
                className="rounded-xl border border-warning/20 bg-warning/10 px-3 py-2"
              >
                <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground">
                  {note.note_text}
                </p>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {format(new Date(note.created_at), "MMM d, yyyy HH:mm")}
                </p>
              </div>
            ))}
          </div>
        </Section>
      </ScrollArea>
    </div>
  );
}
