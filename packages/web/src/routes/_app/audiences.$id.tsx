import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Pencil, Plus, Trash2, Upload, Users } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { ListSkeleton } from "@/components/list-skeleton";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api, unwrap } from "@/lib/api";
import { formatDateTime, formatRelative } from "@/lib/format";
import { audienceQuery, contactsQuery } from "@/lib/queries";

/** Local contact shape shown in the table (matches the ContactSummary wire type). */
interface ContactRow {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  created_at: string;
  unsubscribed: boolean;
}

export const Route = createFileRoute("/_app/audiences/$id")({
  loader: ({ context, params }) => {
    context.queryClient.prefetchQuery(audienceQuery(params.id));
    context.queryClient.prefetchQuery(contactsQuery(params.id));
  },
  component: AudienceDetailScreen,
});

function AudienceDetailScreen() {
  const { id } = Route.useParams();

  const audienceDetail = useQuery(audienceQuery(id));
  const contactsList = useQuery(contactsQuery(id));

  const [editTarget, setEditTarget] = useState<ContactRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ContactRow | null>(null);

  const contacts = contactsList.data?.data ?? [];
  const unsubscribedCount = contacts.filter((contact) => contact.unsubscribed).length;
  const subscribedCount = contacts.length - unsubscribedCount;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/audiences" aria-label="Back to audiences">
            <ArrowLeft />
          </Link>
        </Button>
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-tight">
            {audienceDetail.data?.name ?? (audienceDetail.isLoading ? "Loading…" : "Audience")}
          </h1>
          {audienceDetail.data?.created_at ? (
            <p className="text-sm text-muted-foreground">
              Created {formatDateTime(audienceDetail.data.created_at)}
            </p>
          ) : null}
        </div>
      </div>

      {contactsList.data ? (
        <div className="grid grid-cols-3 gap-4">
          <StatTile label="All contacts" value={contacts.length} />
          <StatTile label="Subscribers" value={subscribedCount} />
          <StatTile label="Unsubscribers" value={unsubscribedCount} />
        </div>
      ) : null}

      <PageHeader
        title="Contacts"
        description={contactsList.isLoading ? undefined : `${contacts.length} total`}
        actions={
          <>
            <ImportCsvDialog audienceId={id} />
            <ContactFormDialog audienceId={id} />
          </>
        }
      />

      {contactsList.isLoading ? (
        <ListSkeleton rows={5} />
      ) : contactsList.isError ? (
        <p className="text-sm text-destructive">Failed to load contacts.</p>
      ) : contacts.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No contacts yet"
          description="Add a contact or import a CSV to get started."
        />
      ) : (
        <div className="content-reveal overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow className="border-border/60 hover:bg-transparent">
                <TableHead className="pl-4">Email</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Added</TableHead>
                <TableHead className="w-0 pr-4">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {contacts.map((contact) => (
                <TableRow key={contact.id} className="group border-border/60">
                  <TableCell className="py-3 pl-4 font-medium">{contact.email}</TableCell>
                  <TableCell className="py-3 text-muted-foreground">
                    {[contact.first_name, contact.last_name].filter(Boolean).join(" ") || "—"}
                  </TableCell>
                  <TableCell className="w-0 py-3">
                    <StatusBadge status={contact.unsubscribed ? "unsubscribed" : "subscribed"} />
                  </TableCell>
                  <TableCell className="w-0 whitespace-nowrap py-3 text-right text-sm tabular-nums text-muted-foreground">
                    {formatRelative(contact.created_at)}
                  </TableCell>
                  <TableCell className="w-0 py-3 pr-4">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground"
                        onClick={() => setEditTarget(contact)}
                        aria-label={`Edit ${contact.email}`}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => setDeleteTarget(contact)}
                        aria-label={`Delete ${contact.email}`}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {editTarget ? (
        <ContactFormDialog
          audienceId={id}
          contact={editTarget}
          open
          onOpenChange={(next) => !next && setEditTarget(null)}
        />
      ) : null}
      <DeleteContactDialog
        audienceId={id}
        target={deleteTarget}
        onOpenChange={() => setDeleteTarget(null)}
      />
    </div>
  );
}

/** A single Resend-style summary tile (label + big number) in the stats row. */
function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border bg-card/30 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
    </div>
  );
}

function ContactFormDialog({
  audienceId,
  contact,
  open: controlledOpen,
  onOpenChange,
}: {
  audienceId: string;
  contact?: ContactRow;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const isEdit = contact !== undefined;
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;

  const [email, setEmail] = useState(contact?.email ?? "");
  const [firstName, setFirstName] = useState(contact?.first_name ?? "");
  const [lastName, setLastName] = useState(contact?.last_name ?? "");
  const [unsubscribed, setUnsubscribed] = useState(contact?.unsubscribed ?? false);

  const mutation = useMutation({
    mutationFn: async () => {
      if (isEdit && contact) {
        unwrap(
          await api.PATCH("/audiences/{id}/contacts/{contactId}", {
            params: { path: { id: audienceId, contactId: contact.id } },
            body: {
              first_name: firstName.trim(),
              last_name: lastName.trim(),
              unsubscribed,
            },
          }),
        );
        return;
      }
      unwrap(
        await api.POST("/audiences/{id}/contacts", {
          params: { path: { id: audienceId } },
          body: {
            email: email.trim(),
            ...(firstName.trim() ? { first_name: firstName.trim() } : {}),
            ...(lastName.trim() ? { last_name: lastName.trim() } : {}),
            unsubscribed,
          },
        }),
      );
    },
    onSuccess: () => {
      toast.success(isEdit ? "Contact updated" : "Contact added");
      queryClient.invalidateQueries({ queryKey: ["contacts", audienceId] });
      if (!isEdit) {
        setEmail("");
        setFirstName("");
        setLastName("");
        setUnsubscribed(false);
      }
      setOpen(false);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const dialogContent = (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{isEdit ? "Edit contact" : "Add contact"}</DialogTitle>
        <DialogDescription>
          {isEdit
            ? "Update this contact's details and subscription status."
            : "Add a single contact to this audience."}
        </DialogDescription>
      </DialogHeader>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (isEdit || email.trim().length > 0) mutation.mutate();
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="contact-email">Email</FieldLabel>
            <Input
              id="contact-email"
              type="email"
              placeholder="steve@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={isEdit}
              autoFocus={!isEdit}
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field>
              <FieldLabel htmlFor="contact-first">First name</FieldLabel>
              <Input
                id="contact-first"
                placeholder="Steve"
                value={firstName}
                onChange={(event) => setFirstName(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="contact-last">Last name</FieldLabel>
              <Input
                id="contact-last"
                placeholder="Wozniak"
                value={lastName}
                onChange={(event) => setLastName(event.target.value)}
              />
            </Field>
          </div>
          <Field orientation="horizontal">
            <Switch
              id="contact-unsubscribed"
              checked={unsubscribed}
              onCheckedChange={setUnsubscribed}
            />
            <FieldLabel htmlFor="contact-unsubscribed">Unsubscribed</FieldLabel>
          </Field>
        </FieldGroup>
        <DialogFooter className="mt-6">
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="submit"
            disabled={mutation.isPending || (!isEdit && email.trim().length === 0)}
          >
            {mutation.isPending
              ? isEdit
                ? "Saving…"
                : "Adding…"
              : isEdit
                ? "Save changes"
                : "Add contact"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );

  if (isEdit) {
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        {dialogContent}
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus />
          Add contact
        </Button>
      </DialogTrigger>
      {dialogContent}
    </Dialog>
  );
}

function DeleteContactDialog({
  audienceId,
  target,
  onOpenChange,
}: {
  audienceId: string;
  target: ContactRow | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (contactId: string) => {
      unwrap(
        await api.DELETE("/audiences/{id}/contacts/{contactId}", {
          params: { path: { id: audienceId, contactId } },
        }),
      );
    },
    onSuccess: () => {
      toast.success("Contact removed");
      queryClient.invalidateQueries({ queryKey: ["contacts", audienceId] });
      onOpenChange(false);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove contact</DialogTitle>
          <DialogDescription>
            Remove <span className="font-medium text-foreground">{target?.email}</span> from this
            audience? This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="mt-2">
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <Button
            variant="destructive"
            disabled={mutation.isPending}
            onClick={() => target && mutation.mutate(target.id)}
          >
            {mutation.isPending ? "Removing…" : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ParsedContact {
  email: string;
  first_name?: string;
  last_name?: string;
}

/** Minimal RFC-4180-ish CSV parser: handles quoted fields, `""` escapes, CRLF. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\r") {
      // Ignore; the paired \n closes the row.
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Map a header row to `email` / `first_name` / `last_name` column indices. */
function mapContactsCsv(rows: string[][]): ParsedContact[] {
  if (rows.length === 0) return [];
  const header = rows[0].map((cell) => cell.trim().toLowerCase().replace(/\s+/g, "_"));
  const emailIdx = header.indexOf("email");
  if (emailIdx === -1) {
    throw new Error("CSV must include an `email` column header.");
  }
  const firstIdx = header.indexOf("first_name");
  const lastIdx = header.indexOf("last_name");
  const contacts: ParsedContact[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    const cells = rows[index];
    const email = (cells[emailIdx] ?? "").trim();
    if (!email.includes("@")) continue;
    const first = firstIdx >= 0 ? (cells[firstIdx] ?? "").trim() : "";
    const last = lastIdx >= 0 ? (cells[lastIdx] ?? "").trim() : "";
    contacts.push({
      email,
      ...(first ? { first_name: first } : {}),
      ...(last ? { last_name: last } : {}),
    });
  }
  return contacts;
}

// Stay within the per-team rate limit (10 req/s): small concurrent batches,
// and retry each row on 429 so a large import ingests every contact.
const IMPORT_BATCH_SIZE = 8;
const IMPORT_MAX_RETRIES = 6;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POST one contact, retrying on 429 (respecting `retry-after`) so bulk imports
 * are not silently truncated by rate limiting. Resolves true on success.
 */
async function importContact(audienceId: string, contact: ParsedContact): Promise<boolean> {
  for (let attempt = 0; attempt <= IMPORT_MAX_RETRIES; attempt += 1) {
    const { error, response } = await api.POST("/audiences/{id}/contacts", {
      params: { path: { id: audienceId } },
      body: contact,
    });
    if (!error) return true;
    if (response.status === 429 && attempt < IMPORT_MAX_RETRIES) {
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : 400 * 2 ** attempt);
      continue;
    }
    return false;
  }
  return false;
}

function ImportCsvDialog({ audienceId }: { audienceId: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [total, setTotal] = useState(0);
  const [done, setDone] = useState(0);
  const [succeeded, setSucceeded] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setImporting(false);
    setTotal(0);
    setDone(0);
    setSucceeded(0);
    if (fileRef.current) fileRef.current.value = "";
  };

  const handleImport = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      toast.error("Choose a CSV file first.");
      return;
    }
    let contacts: ParsedContact[];
    try {
      const text = await file.text();
      contacts = mapContactsCsv(parseCsv(text));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not parse CSV.");
      return;
    }
    if (contacts.length === 0) {
      toast.error("No valid rows with an email address were found.");
      return;
    }

    setImporting(true);
    setTotal(contacts.length);
    setDone(0);
    setSucceeded(0);

    let ok = 0;
    let processed = 0;
    // Sequential batches of bounded concurrency (each row retries on 429), so a
    // large file (1000+ rows) ingests fully without exceeding the rate limit.
    for (let start = 0; start < contacts.length; start += IMPORT_BATCH_SIZE) {
      const batch = contacts.slice(start, start + IMPORT_BATCH_SIZE);
      const results = await Promise.all(batch.map((contact) => importContact(audienceId, contact)));
      ok += results.filter(Boolean).length;
      processed += batch.length;
      setDone(processed);
      setSucceeded(ok);
    }

    queryClient.invalidateQueries({ queryKey: ["contacts", audienceId] });
    const failed = contacts.length - ok;
    if (failed === 0) {
      toast.success(`Imported ${ok} contact${ok === 1 ? "" : "s"}.`);
    } else {
      toast.warning(`Imported ${ok} contact${ok === 1 ? "" : "s"}, ${failed} failed.`);
    }
    setImporting(false);
    setOpen(false);
    reset();
  };

  const percent = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (importing) return;
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          <Upload />
          Import CSV
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import contacts</DialogTitle>
          <DialogDescription>
            Upload a CSV with an <code>email</code> column (optional <code>first_name</code>,{" "}
            <code>last_name</code>). Rows are added to this audience.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="csv-file">CSV file</FieldLabel>
            <Input
              id="csv-file"
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              disabled={importing}
            />
          </Field>
          {importing || done > 0 ? (
            <div className="flex flex-col gap-2">
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${percent}%` }}
                />
              </div>
              <span className="text-xs text-muted-foreground">
                {done} / {total} processed · {succeeded} added
              </span>
            </div>
          ) : null}
        </FieldGroup>
        <DialogFooter className="mt-6">
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={importing}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="button" onClick={handleImport} disabled={importing}>
            {importing ? "Importing…" : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
