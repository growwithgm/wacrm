'use client';

import { useState, useRef, useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Upload, FileText, Loader2, CheckCircle, XCircle, Tag as TagIcon } from 'lucide-react';

interface ImportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}

interface ParsedRow {
  phone: string;
  name?: string;
  email?: string;
  company?: string;
  tag?: string;
}

function parseCSV(text: string): ParsedRow[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const headerLine = lines[0];
  const headers = headerLine.split(',').map((h) => h.trim().toLowerCase().replace(/["']/g, ''));

  const phoneIdx = headers.indexOf('phone');
  if (phoneIdx === -1) return [];

  const nameIdx = headers.indexOf('name');
  const emailIdx = headers.indexOf('email');
  const companyIdx = headers.indexOf('company');
  const tagIdx = headers.indexOf('tag');

  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Simple CSV parse (handles quoted fields)
    const values: string[] = [];
    let current = '';
    let inQuotes = false;
    for (const char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim());

    const phone = values[phoneIdx]?.replace(/["']/g, '').trim();
    if (!phone) continue;

    const clean = (idx: number) =>
      idx >= 0 ? values[idx]?.replace(/["']/g, '').trim() || undefined : undefined;

    rows.push({
      phone,
      name: clean(nameIdx),
      email: clean(emailIdx),
      company: clean(companyIdx),
      tag: clean(tagIdx),
    });
  }

  return rows;
}

/**
 * Find-or-create tags by name (case-insensitive) for this user, returning a
 * lowercased-name → tag id map. Reuses the existing `tags` table so imported
 * contacts show up under the same tags everywhere (e.g. Campaigns filters).
 */
async function resolveTags(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  userId: string,
  names: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const wanted = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (wanted.length === 0) return map;

  const { data: existing } = await supabase.from('tags').select('id, name').eq('user_id', userId);
  for (const t of existing ?? []) map.set(String(t.name).trim().toLowerCase(), t.id);

  const missing = wanted.filter((n) => !map.has(n.toLowerCase()));
  if (missing.length > 0) {
    const { data: created } = await supabase
      .from('tags')
      .insert(missing.map((name) => ({ user_id: userId, name })))
      .select('id, name');
    for (const t of created ?? []) map.set(String(t.name).trim().toLowerCase(), t.id);
  }
  return map;
}

export function ImportModal({ open, onOpenChange, onImported }: ImportModalProps) {
  const supabase = createClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ imported: number; failed: number; tagged: number } | null>(
    null,
  );
  const [dialogTag, setDialogTag] = useState('');
  const [existingTags, setExistingTags] = useState<{ id: string; name: string }[]>([]);

  // Load the user's existing tags for the quick-pick chips when the dialog opens.
  useEffect(() => {
    if (!open) return;
    (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const uid = session?.user?.id;
      if (!uid) return;
      const { data } = await supabase
        .from('tags')
        .select('id, name')
        .eq('user_id', uid)
        .order('name');
      setExistingTags(data ?? []);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function reset() {
    setFile(null);
    setParsedRows([]);
    setResult(null);
    setDialogTag('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handleOpenChange(open: boolean) {
    if (!open) reset();
    onOpenChange(open);
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0];
    if (!selected) return;

    setFile(selected);
    setResult(null);

    const text = await selected.text();
    const rows = parseCSV(text);

    if (rows.length === 0) {
      toast.error('No valid rows found. Ensure CSV has a "phone" column header.');
      setParsedRows([]);
      return;
    }

    setParsedRows(rows);
  }

  const csvHasTags = parsedRows.some((r) => r.tag?.trim());

  async function handleImport() {
    if (parsedRows.length === 0) return;
    setImporting(true);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) throw new Error('Not authenticated');

      // Resolve the dialog tag + every per-row tag up front (find-or-create).
      const dialogTagName = dialogTag.trim();
      const tagNames = [
        dialogTagName,
        ...parsedRows.map((r) => r.tag?.trim() ?? ''),
      ].filter(Boolean);
      const tagIdByName = await resolveTags(supabase, user.id, tagNames);
      const dialogTagId = dialogTagName ? tagIdByName.get(dialogTagName.toLowerCase()) : undefined;

      let imported = 0;
      let failed = 0;
      // Pair each successfully-inserted contact id with its source row so we
      // know which per-row tag to apply.
      const insertedPairs: { id: string; row: ParsedRow }[] = [];

      const chunkSize = 50;
      for (let i = 0; i < parsedRows.length; i += chunkSize) {
        const chunk = parsedRows.slice(i, i + chunkSize);
        const rows = chunk.map((row) => ({
          user_id: user.id,
          phone: row.phone,
          name: row.name || null,
          email: row.email || null,
          company: row.company || null,
        }));

        const { data, error } = await supabase.from('contacts').insert(rows).select('id');

        if (error) {
          // Fall back to individual inserts so one bad row doesn't sink the batch.
          for (let j = 0; j < rows.length; j++) {
            const { data: one, error: singleErr } = await supabase
              .from('contacts')
              .insert(rows[j])
              .select('id')
              .single();
            if (singleErr || !one) {
              failed++;
            } else {
              imported++;
              insertedPairs.push({ id: one.id, row: chunk[j] });
            }
          }
        } else {
          imported += data?.length ?? chunk.length;
          // Multi-row INSERT … RETURNING preserves input order → pair by index.
          (data ?? []).forEach((rec: { id: string }, j: number) => {
            insertedPairs.push({ id: rec.id, row: chunk[j] });
          });
        }
      }

      // Apply tags (dialog tag to all + per-row tag where present).
      let tagged = 0;
      const ctRows: { contact_id: string; tag_id: string }[] = [];
      for (const { id, row } of insertedPairs) {
        const tagIds = new Set<string>();
        if (dialogTagId) tagIds.add(dialogTagId);
        const rt = row.tag?.trim();
        if (rt) {
          const tid = tagIdByName.get(rt.toLowerCase());
          if (tid) tagIds.add(tid);
        }
        if (tagIds.size > 0) tagged++;
        for (const tid of tagIds) ctRows.push({ contact_id: id, tag_id: tid });
      }
      if (ctRows.length > 0) {
        // UNIQUE(contact_id, tag_id) — ignore duplicates so re-tagging is safe.
        const { error: tagErr } = await supabase
          .from('contact_tags')
          .upsert(ctRows, { onConflict: 'contact_id,tag_id', ignoreDuplicates: true });
        if (tagErr) {
          console.error('[import] tag assignment failed:', tagErr.message);
          toast.error('Contacts imported, but tagging failed. Check the Tags page.');
          tagged = 0;
        }
      }

      setResult({ imported, failed, tagged });
      if (imported > 0) {
        toast.success(`${imported} contact${imported !== 1 ? 's' : ''} imported`);
        onImported();
      }
      if (failed > 0) {
        toast.error(`${failed} contact${failed !== 1 ? 's' : ''} failed to import`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Import failed';
      toast.error(message);
    } finally {
      setImporting(false);
    }
  }

  const preview = parsedRows.slice(0, 5);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="bg-card border-border text-foreground sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-foreground">Import Contacts</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Upload a CSV with a &quot;phone&quot; column (required). Optional columns: name, email,
            company, tag.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Upload area */}
          <div
            onClick={() => fileInputRef.current?.click()}
            className="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border p-6 cursor-pointer hover:border-primary/50 transition-colors"
          >
            {file ? (
              <>
                <FileText className="size-8 text-primary" />
                <p className="text-sm text-foreground">{file.name}</p>
                <p className="text-xs text-muted-foreground">
                  {parsedRows.length} row{parsedRows.length !== 1 ? 's' : ''} detected
                  {csvHasTags ? ' · tag column found' : ''}
                </p>
              </>
            ) : (
              <>
                <Upload className="size-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Click to upload CSV file</p>
                <p className="text-xs text-muted-foreground">CSV with &quot;phone&quot; column required</p>
              </>
            )}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={handleFileChange}
            className="hidden"
          />

          {/* Tag-all selector (optional) */}
          {!result && (
            <div className="space-y-2">
              <label className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                <TagIcon className="size-3.5 text-muted-foreground" />
                Tag all imported contacts (optional)
              </label>
              <Input
                value={dialogTag}
                onChange={(e) => setDialogTag(e.target.value)}
                placeholder="Pick a tag below or type a new one (e.g. B2B)"
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
              />
              {existingTags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {existingTags.map((t) => {
                    const active = dialogTag.trim().toLowerCase() === t.name.toLowerCase();
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setDialogTag(active ? '' : t.name)}
                        className={cn(
                          'rounded-full border px-2.5 py-0.5 text-xs transition-colors',
                          active
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border text-muted-foreground hover:bg-muted',
                        )}
                      >
                        {t.name}
                      </button>
                    );
                  })}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Applied to every row. A <code className="text-foreground">tag</code> column in the CSV
                adds a per-row tag on top. New tags are created automatically.
              </p>
            </div>
          )}

          {/* Preview table */}
          {preview.length > 0 && !result && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Preview (first {preview.length} rows)
              </p>
              <div className="rounded-lg border border-border overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-muted">
                      <th className="px-3 py-1.5 text-left text-muted-foreground font-medium">Phone</th>
                      <th className="px-3 py-1.5 text-left text-muted-foreground font-medium">Name</th>
                      <th className="px-3 py-1.5 text-left text-muted-foreground font-medium">Email</th>
                      <th className="px-3 py-1.5 text-left text-muted-foreground font-medium">Company</th>
                      <th className="px-3 py-1.5 text-left text-muted-foreground font-medium">Tag</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((row, i) => (
                      <tr key={i} className="border-t border-border/50">
                        <td className="px-3 py-1.5 text-foreground">{row.phone}</td>
                        <td className="px-3 py-1.5 text-foreground">{row.name || '-'}</td>
                        <td className="px-3 py-1.5 text-foreground">{row.email || '-'}</td>
                        <td className="px-3 py-1.5 text-foreground">{row.company || '-'}</td>
                        <td className="px-3 py-1.5 text-foreground">{row.tag || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {parsedRows.length > 5 && (
                <p className="text-xs text-muted-foreground">...and {parsedRows.length - 5} more rows</p>
              )}
            </div>
          )}

          {/* Results */}
          {result && (
            <div className="rounded-lg border border-border p-4 space-y-2">
              <p className="text-sm font-medium text-foreground">Import Complete</p>
              <div className="flex flex-wrap items-center gap-4">
                {result.imported > 0 && (
                  <div className="flex items-center gap-1.5 text-primary text-sm">
                    <CheckCircle className="size-4" />
                    {result.imported} imported
                  </div>
                )}
                {result.tagged > 0 && (
                  <div className="flex items-center gap-1.5 text-primary text-sm">
                    <TagIcon className="size-4" />
                    {result.tagged} tagged
                  </div>
                )}
                {result.failed > 0 && (
                  <div className="flex items-center gap-1.5 text-red-400 text-sm">
                    <XCircle className="size-4" />
                    {result.failed} failed
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="bg-card border-border">
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            className="border-border text-foreground hover:bg-muted"
          >
            {result ? 'Close' : 'Cancel'}
          </Button>
          {!result && (
            <Button
              type="button"
              disabled={parsedRows.length === 0 || importing}
              onClick={handleImport}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {importing && <Loader2 className="size-4 animate-spin" />}
              Import {parsedRows.length > 0 ? `${parsedRows.length} Contacts` : ''}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
