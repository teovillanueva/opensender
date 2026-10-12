import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { MonitorSmartphone } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { authClient } from "@/lib/auth";
import { formatRelative } from "@/lib/format";
import { sessionsQuery } from "@/lib/queries";

interface SessionRow {
  id?: string;
  token: string;
  userAgent?: string | null;
  ipAddress?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export const Route = createFileRoute("/_app/settings/account")({
  loader: ({ context }) => {
    context.queryClient.prefetchQuery(sessionsQuery);
  },
  component: AccountScreen,
});

/** A terse human label for a session's user agent, e.g. "Chrome · macOS". */
function describeUserAgent(userAgent: string | null | undefined): string {
  if (!userAgent) return "Unknown device";
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /OPR\//.test(userAgent)
      ? "Opera"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Chrome\//.test(userAgent)
          ? "Chrome"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : "Browser";
  const os = /iPhone|iPad/.test(userAgent)
    ? "iOS"
    : /Android/.test(userAgent)
      ? "Android"
      : /Mac OS X/.test(userAgent)
        ? "macOS"
        : /Windows/.test(userAgent)
          ? "Windows"
          : /Linux/.test(userAgent)
            ? "Linux"
            : "Unknown OS";
  return `${browser} · ${os}`;
}

function AccountScreen() {
  const { data: session } = authClient.useSession();

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <ProfileCard name={session?.user.name ?? ""} email={session?.user.email ?? ""} />
      <PasswordCard />
      <SessionsCard currentToken={session?.session.token} />
    </div>
  );
}

function ProfileCard({ name: initialName, email }: { name: string; email: string }) {
  const [name, setName] = useState(initialName);
  useEffect(() => setName(initialName), [initialName]);

  const save = useMutation({
    mutationFn: async () => {
      const result = await authClient.updateUser({ name: name.trim() });
      if (result.error) throw new Error(result.error.message ?? "Could not update your profile.");
    },
    onSuccess: () => toast.success("Profile updated"),
    onError: (error: Error) => toast.error(error.message),
  });

  const dirty = name.trim().length > 0 && name.trim() !== initialName;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Profile</CardTitle>
        <CardDescription>How you appear to your teammates.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (dirty && !save.isPending) save.mutate();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="account-name">Name</FieldLabel>
              <Input
                id="account-name"
                autoComplete="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="account-email">Email</FieldLabel>
              <Input id="account-email" value={email} disabled aria-readonly="true" />
            </Field>
            <div className="flex justify-end">
              <Button type="submit" disabled={!dirty || save.isPending}>
                {save.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}

function PasswordCard() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [revokeOthers, setRevokeOthers] = useState(true);

  const change = useMutation({
    mutationFn: async () => {
      const result = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: revokeOthers,
      });
      if (result.error) throw new Error(result.error.message ?? "Could not change the password.");
    },
    onSuccess: () => {
      toast.success("Password changed");
      setCurrentPassword("");
      setNewPassword("");
      setConfirm("");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const mismatch = confirm.length > 0 && newPassword !== confirm;
  const canSubmit =
    currentPassword.length > 0 &&
    newPassword.length >= 8 &&
    newPassword === confirm &&
    !change.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Password</CardTitle>
        <CardDescription>Use at least 8 characters.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) change.mutate();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="current-password">Current password</FieldLabel>
              <Input
                id="current-password"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="new-password">New password</FieldLabel>
                <Input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="confirm-password">Confirm new password</FieldLabel>
                <Input
                  id="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  aria-invalid={mismatch}
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                />
              </Field>
            </div>
            {mismatch && <p className="text-sm text-destructive">Passwords don't match.</p>}
            <Label htmlFor="revoke-others" className="flex items-center gap-2 font-normal">
              <Checkbox
                id="revoke-others"
                checked={revokeOthers}
                onCheckedChange={(checked) => setRevokeOthers(checked === true)}
              />
              Sign out my other devices
            </Label>
            <div className="flex justify-end">
              <Button type="submit" disabled={!canSubmit}>
                {change.isPending ? "Changing…" : "Change Password"}
              </Button>
            </div>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}

function SessionsCard({ currentToken }: { currentToken: string | undefined }) {
  const queryClient = useQueryClient();
  const query = useQuery(sessionsQuery);
  const sessions = (query.data ?? []) as unknown as SessionRow[];

  const revoke = useMutation({
    mutationFn: async (token: string) => {
      const result = await authClient.revokeSession({ token });
      if (result.error) throw new Error(result.error.message ?? "Could not revoke the session.");
    },
    onSuccess: () => {
      toast.success("Session revoked");
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Sessions</CardTitle>
        <CardDescription>Devices currently signed in to your account.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        {query.isLoading ? (
          <div className="flex flex-col gap-2">
            {["s1", "s2"].map((key) => (
              <Skeleton key={key} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        ) : sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active sessions.</p>
        ) : (
          sessions.map((row) => {
            const isCurrent = row.token === currentToken;
            return (
              <div
                key={row.token}
                className="flex items-center justify-between gap-3 rounded-lg px-2 py-2.5"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-card text-muted-foreground">
                    <MonitorSmartphone className="size-4" aria-hidden="true" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span className="truncate">{describeUserAgent(row.userAgent)}</span>
                      {isCurrent && <Badge variant="secondary">This device</Badge>}
                    </div>
                    <p className="truncate text-xs tabular-nums text-muted-foreground">
                      {row.ipAddress ? `${row.ipAddress} · ` : ""}
                      signed in {formatRelative(row.createdAt)}
                    </p>
                  </div>
                </div>
                {!isCurrent && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => revoke.mutate(row.token)}
                    disabled={revoke.isPending}
                  >
                    Revoke
                  </Button>
                )}
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
