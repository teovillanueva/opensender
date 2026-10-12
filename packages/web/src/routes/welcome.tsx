import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Check, Globe, RefreshCw, Send, UserRound } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/copy-button";
import { RegionLabel } from "@/components/region-label";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { config } from "@/config";
import { api, unwrap } from "@/lib/api";
import { authClient } from "@/lib/auth";
import { domainQuery, domainsQuery, fullOrganizationQuery } from "@/lib/queries";
import { ensureSessionGuard } from "@/lib/teams";

const REGIONS = ["us-east-1", "eu-west-1", "sa-east-1", "ap-northeast-1"] as const;

type Step = 1 | 2 | 3;

const STEPS: { step: Step; title: string }[] = [
  { step: 1, title: "Invite your team" },
  { step: 2, title: "Add a domain" },
  { step: 3, title: "Send a test email" },
];

export interface WelcomeSearch {
  step: Step;
  domain?: string;
}

/**
 * Post team-creation onboarding: invite teammates, register the first sending
 * domain (with its DNS records), and send a test email once the domain
 * verifies. Every step is skippable; state lives in the URL so a reload (or
 * coming back later while DNS propagates) resumes where the user left off.
 */
export const Route = createFileRoute("/welcome")({
  validateSearch: (search: Record<string, unknown>): WelcomeSearch => ({
    step: search.step === 2 || search.step === 3 ? (search.step as Step) : 1,
    ...(typeof search.domain === "string" && search.domain.length > 0
      ? { domain: search.domain }
      : {}),
  }),
  beforeLoad: async () => {
    const guard = await ensureSessionGuard();
    if (guard.status === "unauthenticated") {
      throw redirect({ to: "/login", search: {} });
    }
    if (guard.status === "no-team") {
      throw redirect({ to: "/new-team" });
    }
  },
  component: WelcomeScreen,
});

function WelcomeScreen() {
  const { step, domain } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const goTo = (next: Step, domainId?: string) =>
    navigate({
      search: { step: next, ...((domainId ?? domain) ? { domain: domainId ?? domain } : {}) },
    });

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <header className="flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-2.5">
          <div className="flex size-7 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-600 to-emerald-800 text-xs font-semibold text-white">
            {config.instanceName.trim().charAt(0).toUpperCase() || "M"}
          </div>
          <span className="text-sm font-semibold tracking-tight">{config.instanceName}</span>
        </div>
        <Link
          to="/emails"
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          Skip onboarding
        </Link>
      </header>

      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-8 px-6 py-10">
        <div className="flex flex-col gap-2">
          <h1 className="text-balance text-2xl font-semibold tracking-tight">
            Welcome to {config.instanceName}
          </h1>
          <p className="text-pretty text-sm text-muted-foreground">
            Three quick steps and your team is sending email.
          </p>
        </div>

        <StepIndicator current={step} />

        {step === 1 && <InviteStep onContinue={() => goTo(2)} />}
        {step === 2 && (
          <DomainStep
            domainId={domain}
            onContinue={() => goTo(3)}
            onCreated={(id) => goTo(2, id)}
          />
        )}
        {step === 3 && <TestEmailStep domainId={domain} />}
      </main>
    </div>
  );
}

function StepIndicator({ current }: { current: Step }) {
  return (
    <ol className="flex items-center gap-2" aria-label="Onboarding progress">
      {STEPS.map(({ step, title }, index) => {
        const done = step < current;
        const active = step === current;
        return (
          <li key={step} className="flex flex-1 items-center gap-2">
            <span
              aria-current={active ? "step" : undefined}
              className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors ${
                done
                  ? "bg-emerald-600 text-white"
                  : active
                    ? "bg-primary text-primary-foreground"
                    : "border bg-card text-muted-foreground"
              }`}
            >
              {done ? <Check className="size-3.5" /> : step}
            </span>
            <span
              className={`hidden text-xs sm:block ${active ? "font-medium" : "text-muted-foreground"}`}
            >
              {title}
            </span>
            {index < STEPS.length - 1 && <span className="h-px flex-1 bg-border" />}
          </li>
        );
      })}
    </ol>
  );
}

function StepCard({ children }: { children: React.ReactNode }) {
  return <div className="content-reveal flex flex-col gap-6 rounded-xl border p-6">{children}</div>;
}

function InviteStep({ onContinue }: { onContinue: () => void }) {
  const queryClient = useQueryClient();
  const orgQuery = useQuery(fullOrganizationQuery);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");

  const pending = ((orgQuery.data?.invitations ?? []) as { email: string; status: string }[])
    .filter((invitation) => invitation.status === "pending")
    .map((invitation) => invitation.email);

  const invite = useMutation({
    mutationFn: async () => {
      const result = await authClient.organization.inviteMember({ email: email.trim(), role });
      if (result.error) throw new Error(result.error.message ?? "Could not create the invitation.");
    },
    onSuccess: () => {
      toast.success(`Invitation created for ${email.trim()}`);
      setEmail("");
      queryClient.invalidateQueries({ queryKey: ["organization"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const canInvite = email.includes("@") && !invite.isPending;

  return (
    <StepCard>
      <div className="flex flex-col gap-1">
        <h2 className="flex items-center gap-2 font-semibold tracking-tight">
          <UserRound className="size-4 text-muted-foreground" aria-hidden="true" />
          Invite your team
        </h2>
        <p className="text-sm text-muted-foreground">
          Teammates see their invitation in the team switcher when they sign in with the invited
          email — no invitation email is sent.
        </p>
      </div>

      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (canInvite) invite.mutate();
        }}
      >
        <Field className="flex-1">
          <FieldLabel htmlFor="welcome-invite-email">Email</FieldLabel>
          <Input
            id="welcome-invite-email"
            type="email"
            autoComplete="off"
            spellCheck={false}
            placeholder="teammate@company.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <Field className="w-28">
          <FieldLabel htmlFor="welcome-invite-role">Role</FieldLabel>
          <Select value={role} onValueChange={(value) => setRole(value as "member" | "admin")}>
            <SelectTrigger id="welcome-invite-role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="member">Member</SelectItem>
              <SelectItem value="admin">Admin</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Button type="submit" disabled={!canInvite}>
          {invite.isPending ? "Inviting…" : "Invite"}
        </Button>
      </form>

      {pending.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {pending.map((invited) => (
            <li key={invited} className="flex items-center gap-2 text-muted-foreground">
              <Check className="size-3.5 text-emerald-500" aria-hidden="true" />
              {invited}
            </li>
          ))}
        </ul>
      )}

      <div className="flex justify-end">
        <Button variant={pending.length > 0 ? "default" : "outline"} onClick={onContinue}>
          {pending.length > 0 ? "Continue" : "Skip for now"}
          <ArrowRight />
        </Button>
      </div>
    </StepCard>
  );
}

interface DomainRecordRow {
  name?: string;
  type?: string;
  value?: string;
  status?: string;
  priority?: number;
}

function DomainStep({
  domainId,
  onContinue,
  onCreated,
}: {
  domainId: string | undefined;
  onContinue: () => void;
  onCreated: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [region, setRegion] = useState<(typeof REGIONS)[number]>("us-east-1");

  const create = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST("/domains", { body: { name: name.trim(), region, tls: "opportunistic" } }),
      ),
    onSuccess: (data) => {
      toast.success("Domain created");
      queryClient.invalidateQueries({ queryKey: ["domains"] });
      const id = (data as { id?: string } | undefined)?.id;
      if (id) onCreated(id);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const detail = useQuery({ ...domainQuery(domainId ?? ""), enabled: Boolean(domainId) });
  const records = (
    (detail.data as { records?: DomainRecordRow[] } | undefined)?.records ?? []
  ).filter((record) => record.value);
  const domainName = (detail.data as { name?: string } | undefined)?.name ?? "";
  // Wire record names are relative to the domain; copy the unambiguous full host.
  const fqdn = (record: DomainRecordRow) =>
    record.name ? `${record.name}.${domainName}` : domainName;

  return (
    <StepCard>
      <div className="flex flex-col gap-1">
        <h2 className="flex items-center gap-2 font-semibold tracking-tight">
          <Globe className="size-4 text-muted-foreground" aria-hidden="true" />
          Add your sending domain
        </h2>
        <p className="text-sm text-muted-foreground">
          Emails are sent from addresses on a domain you control. Add the DNS records at your
          provider to verify it.
        </p>
      </div>

      {!domainId ? (
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim().length > 0 && !create.isPending) create.mutate();
          }}
        >
          <Field className="flex-1">
            <FieldLabel htmlFor="welcome-domain-name">Domain</FieldLabel>
            <Input
              id="welcome-domain-name"
              placeholder="mail.yourcompany.com"
              autoComplete="off"
              spellCheck={false}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field className="w-44">
            <FieldLabel htmlFor="welcome-domain-region">Region</FieldLabel>
            <Select
              value={region}
              onValueChange={(value) => setRegion(value as (typeof REGIONS)[number])}
            >
              <SelectTrigger id="welcome-domain-region">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REGIONS.map((value) => (
                  <SelectItem key={value} value={value}>
                    <RegionLabel region={value} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Button type="submit" disabled={name.trim().length === 0 || create.isPending}>
            {create.isPending && <Spinner />}
            {create.isPending ? "Creating…" : "Create"}
          </Button>
        </form>
      ) : detail.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Loading DNS records…
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            Add these records for{" "}
            <span className="font-medium">
              {(detail.data as { name?: string } | undefined)?.name}
            </span>{" "}
            at your DNS provider:
          </p>
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="border-border/60 hover:bg-transparent">
                  <TableHead className="pl-3">Type</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead className="w-0 pr-3">
                    <span className="sr-only">Copy</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.map((record) => (
                  <TableRow
                    key={`${record.type}-${record.name}-${record.value}`}
                    className="border-border/60"
                  >
                    <TableCell className="py-2 pl-3 text-xs">{record.type ?? "—"}</TableCell>
                    <TableCell className="py-2">
                      <div className="flex items-center gap-1">
                        <span className="max-w-[8rem] truncate font-mono text-xs">
                          {record.name || "@"}
                        </span>
                        <CopyButton value={fqdn(record)} label="Copy record host" />
                      </div>
                    </TableCell>
                    <TableCell className="max-w-[14rem] truncate py-2 font-mono text-xs">
                      {record.value}
                    </TableCell>
                    <TableCell className="py-2 text-xs tabular-nums text-muted-foreground">
                      {record.priority ?? "—"}
                    </TableCell>
                    <TableCell className="py-2 pr-3">
                      <CopyButton value={record.value ?? ""} label="Copy record value" />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-muted-foreground">
            You can finish this later — the records are always available on the domain's page.
          </p>
        </div>
      )}

      <div className="flex justify-end">
        <Button variant={domainId ? "default" : "outline"} onClick={onContinue}>
          {domainId ? "Continue" : "Skip for now"}
          <ArrowRight />
        </Button>
      </div>
    </StepCard>
  );
}

function TestEmailStep({ domainId }: { domainId: string | undefined }) {
  const { data: session } = authClient.useSession();
  const navigate = useNavigate();

  // Fall back to the team's first domain when the user skipped step 2.
  const domains = useQuery({ ...domainsQuery, enabled: !domainId });
  const fallbackId = ((domains.data?.data ?? []) as { id?: string }[])[0]?.id;
  const effectiveId = domainId ?? fallbackId;

  const detail = useQuery({ ...domainQuery(effectiveId ?? ""), enabled: Boolean(effectiveId) });
  const domain = detail.data as { id?: string; name?: string; status?: string } | undefined;
  const verified = domain?.status === "verified";

  const [to, setTo] = useState(session?.user.email ?? "");
  const [sent, setSent] = useState(false);

  const verify = useMutation({
    mutationFn: async () => {
      if (!effectiveId) return;
      const { error } = await api.POST("/domains/{domain_id}/verify", {
        params: { path: { domain_id: effectiveId } },
      });
      if (error) throw new Error("Verification request failed");
    },
    onSuccess: () => {
      toast.success("Verification requested — checking records");
      detail.refetch();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const send = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST("/emails", {
          body: {
            from: `${config.instanceName} <hello@${domain?.name}>`,
            to: [to.trim()],
            subject: `Hello from ${config.instanceName}`,
            text: `This is a test email from your new ${config.instanceName} team. Your domain ${domain?.name} is verified and ready to send. 🎉`,
          },
        }),
      ),
    onSuccess: () => setSent(true),
    onError: (error: Error) => toast.error(error.message),
  });

  const finish = () => navigate({ to: "/emails" });

  return (
    <StepCard>
      <div className="flex flex-col gap-1">
        <h2 className="flex items-center gap-2 font-semibold tracking-tight">
          <Send className="size-4 text-muted-foreground" aria-hidden="true" />
          Send a test email
        </h2>
        <p className="text-sm text-muted-foreground">
          Prove the pipes work end to end with a real send through the API.
        </p>
      </div>

      {sent ? (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-emerald-600/15 text-emerald-500">
            <Check className="size-6" aria-hidden="true" />
          </div>
          <p className="font-medium">Test email sent to {to}</p>
          <p className="text-sm text-muted-foreground">
            Check your inbox — and the Emails page, where every send is tracked.
          </p>
        </div>
      ) : !effectiveId ? (
        <p className="text-sm text-muted-foreground">
          No domain yet — add one in the previous step to send a test email, or finish and do it
          later from the dashboard.
        </p>
      ) : detail.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Checking domain status…
        </div>
      ) : verified ? (
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (to.includes("@") && !send.isPending) send.mutate();
          }}
        >
          <Field className="flex-1">
            <FieldLabel htmlFor="welcome-test-to">Send to</FieldLabel>
            <Input
              id="welcome-test-to"
              type="email"
              spellCheck={false}
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </Field>
          <Button type="submit" disabled={!to.includes("@") || send.isPending}>
            {send.isPending && <Spinner />}
            {send.isPending ? "Sending…" : "Send test email"}
          </Button>
        </form>
      ) : (
        <div className="flex flex-col gap-3 rounded-lg border p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{domain?.name}</p>
              <p className="text-xs text-muted-foreground">
                DNS changes can take a few minutes to propagate.
              </p>
            </div>
            <StatusBadge status={domain?.status ?? "pending"} />
          </div>
          <Button
            variant="outline"
            className="self-start"
            onClick={() => verify.mutate()}
            disabled={verify.isPending}
          >
            <RefreshCw className={verify.isPending ? "animate-spin" : undefined} />
            {verify.isPending ? "Checking…" : "Check verification"}
          </Button>
        </div>
      )}

      <div className="flex justify-end">
        <Button variant={sent ? "default" : "outline"} onClick={finish}>
          {sent ? "Go to dashboard" : "Finish"}
          <ArrowRight />
        </Button>
      </div>
    </StepCard>
  );
}
