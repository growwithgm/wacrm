'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Plus, X, Loader2, Tag, Users } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import type { Tag as TagType } from '@/types';

const PRESET_COLORS = [
  { name: 'Red',     value: '#ef4444' },
  { name: 'Orange',  value: '#f97316' },
  { name: 'Amber',   value: '#f59e0b' },
  { name: 'Emerald', value: '#10b981' },
  { name: 'Cyan',    value: '#06b6d4' },
  { name: 'Blue',    value: '#3b82f6' },
  { name: 'Violet',  value: '#8b5cf6' },
  { name: 'Pink',    value: '#ec4899' },
];

interface TagWithCount extends TagType {
  contact_count: number;
}

export default function TagsPage() {
  const router = useRouter();
  const supabase = createClient();
  const { user, loading: authLoading } = useAuth();

  const [loading, setLoading]         = useState(true);
  const [tags, setTags]               = useState<TagWithCount[]>([]);
  const [dialogOpen, setDialogOpen]   = useState(false);
  const [deleteOpen, setDeleteOpen]   = useState(false);
  const [tagToDelete, setTagToDelete] = useState<TagWithCount | null>(null);
  const [saving, setSaving]           = useState(false);
  const [deleting, setDeleting]       = useState(false);
  const [newName, setNewName]         = useState('');
  const [color, setColor]             = useState(PRESET_COLORS[3].value);

  const fetchTags = useCallback(async (userId: string) => {
    setLoading(true);
    try {
      // Fetch tags + per-tag contact count in a single RPC-free query.
      // contact_tags is the join table; count(*) per tag_id gives the total.
      const { data: tagRows, error: tagErr } = await supabase
        .from('tags')
        .select('*')
        .eq('user_id', userId)
        .order('name', { ascending: true });

      if (tagErr) throw tagErr;

      if (!tagRows || tagRows.length === 0) {
        setTags([]);
        return;
      }

      const tagIds = tagRows.map((t) => t.id);
      const { data: countRows, error: countErr } = await supabase
        .from('contact_tags')
        .select('tag_id')
        .in('tag_id', tagIds);

      if (countErr) throw countErr;

      // Aggregate counts client-side — avoids needing a GROUP BY RPC.
      const countMap: Record<string, number> = {};
      for (const row of countRows ?? []) {
        countMap[row.tag_id] = (countMap[row.tag_id] ?? 0) + 1;
      }

      setTags(tagRows.map((t) => ({ ...t, contact_count: countMap[t.id] ?? 0 })));
    } catch (err) {
      console.error('Failed to fetch tags:', err);
      toast.error('Failed to load tags');
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    if (authLoading || !user) return;
    fetchTags(user.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user?.id]);

  async function handleCreate() {
    if (!newName.trim()) { toast.error('Tag name is required'); return; }
    if (!user) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from('tags')
        .insert({ user_id: user.id, name: newName.trim(), color });
      if (error) throw error;
      toast.success('Tag created');
      setDialogOpen(false);
      setNewName('');
      setColor(PRESET_COLORS[3].value);
      fetchTags(user.id);
    } catch (err) {
      console.error(err);
      toast.error('Failed to create tag');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!tagToDelete || !user) return;
    setDeleting(true);
    try {
      const { error } = await supabase.from('tags').delete().eq('id', tagToDelete.id);
      if (error) throw error;
      toast.success('Tag deleted');
      setTags((prev) => prev.filter((t) => t.id !== tagToDelete.id));
      setDeleteOpen(false);
      setTagToDelete(null);
    } catch (err) {
      console.error(err);
      toast.error('Failed to delete tag');
    } finally {
      setDeleting(false);
    }
  }

  function openNewTagDialog() {
    setNewName('');
    setColor(PRESET_COLORS[3].value);
    setDialogOpen(true);
  }

  // Navigate to Contacts with this tag pre-filtered via URL search param
  function filterByTag(tag: TagWithCount) {
    router.push(`/contacts?tag=${encodeURIComponent(tag.id)}`);
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-heading text-2xl font-bold text-foreground">Tags</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Color-coded labels for your contacts. Click a tag to filter the Contacts list.
          </p>
        </div>
        <Button
          onClick={openNewTagDialog}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="size-4" />
          New Tag
        </Button>
      </div>

      {/* Tags grid */}
      {tags.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card px-6 py-16 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <Tag className="h-6 w-6 text-primary" />
          </div>
          <p className="mt-4 text-sm font-medium text-foreground">No tags yet</p>
          <p className="mt-1 max-w-xs text-xs text-muted-foreground">
            Create your first tag to start organizing contacts.
          </p>
          <Button onClick={openNewTagDialog} className="mt-5 bg-primary text-primary-foreground hover:bg-primary/90">
            <Plus className="h-4 w-4" />
            Create your first tag
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {tags.map((tag) => (
            <div
              key={tag.id}
              className="group relative flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 transition-colors hover:border-primary/30"
            >
              {/* Color strip */}
              <div
                className="h-1.5 w-8 rounded-full"
                style={{ backgroundColor: tag.color }}
              />

              {/* Name + pill */}
              <div className="flex items-center justify-between gap-2">
                <span
                  className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold"
                  style={{
                    backgroundColor: `${tag.color}20`,
                    color: tag.color,
                    border: `1px solid ${tag.color}40`,
                  }}
                >
                  <span className="size-1.5 rounded-full" style={{ backgroundColor: tag.color }} />
                  {tag.name}
                </span>
                <button
                  onClick={() => { setTagToDelete(tag); setDeleteOpen(true); }}
                  className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                  aria-label={`Delete ${tag.name}`}
                >
                  <X className="size-3.5" />
                </button>
              </div>

              {/* Contact count + filter link */}
              <button
                onClick={() => filterByTag(tag)}
                className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-primary"
                aria-label={`Filter contacts by ${tag.name}`}
              >
                <Users className="size-3.5" />
                <span>
                  {tag.contact_count}{' '}
                  {tag.contact_count === 1 ? 'contact' : 'contacts'}
                </span>
                <span className="ml-auto text-[10px] opacity-0 transition-opacity group-hover:opacity-60">
                  View →
                </span>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* New Tag dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="bg-card border-border sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-foreground">New Tag</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Create a color-coded tag to organize contacts.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label className="text-foreground">Name</Label>
              <Input
                placeholder="e.g. VIP Customer"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-foreground">Color</Label>
              <div className="flex flex-wrap gap-2">
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c.value}
                    onClick={() => setColor(c.value)}
                    title={c.name}
                    className="size-8 rounded-full transition-transform hover:scale-110 focus:outline-none"
                    style={{
                      backgroundColor: c.value,
                      boxShadow: color === c.value
                        ? `0 0 0 2px var(--background), 0 0 0 4px ${c.value}`
                        : 'none',
                    }}
                  />
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label className="text-foreground">Preview</Label>
              <span
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium"
                style={{
                  backgroundColor: `${color}20`,
                  color,
                  border: `1px solid ${color}40`,
                }}
              >
                <span className="size-2 rounded-full" style={{ backgroundColor: color }} />
                {newName || 'Tag name'}
              </span>
            </div>
          </div>
          <DialogFooter className="bg-card">
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
              className="border-border text-foreground hover:bg-muted"
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={saving}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {saving ? <><Loader2 className="size-4 animate-spin" />Creating…</> : 'Create Tag'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="bg-card border-border sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-foreground">Delete Tag</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Delete &quot;{tagToDelete?.name}&quot;? It will be removed from all{' '}
              {tagToDelete?.contact_count ?? 0} contact
              {tagToDelete?.contact_count !== 1 ? 's' : ''} that use it. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              className="border-border text-foreground hover:bg-muted"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? <><Loader2 className="size-4 animate-spin" />Deleting…</> : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
