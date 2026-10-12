import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { config } from "@/config";
import { api } from "@/lib/api";

/**
 * First-run admin bootstrap (SPEC §13.2). Only reachable while the instance
 * has zero users; gated by the deploy-emitted token. Creates exactly the
 * first admin, then sends the operator to the login screen.
 */
export const Route = createFileRoute("/bootstrap")({
  beforeLoad: async () => {
    const { data } = await api.GET("/internal/bootstrap");
    if (!data?.needs_bootstrap) throw redirect({ to: "/login" });
  },
  component: BootstrapScreen,
});

function BootstrapScreen() {
  const navigate = useNavigate();
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    try {
      const { data, error } = await api.POST("/internal/bootstrap", {
        body: { token, name, email, password },
      });
      if (error || !data) {
        const message =
          error && typeof error === "object" && "message" in error
            ? String((error as { message: unknown }).message)
            : "Bootstrap failed";
        toast.error(message);
        return;
      }
      toast.success("Admin created. Please sign in.");
      navigate({ to: "/login" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Bootstrap failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Set up {config.instanceName}</CardTitle>
          <CardDescription>
            Create the first administrator using the bootstrap token from your deploy output.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="token">Bootstrap token</FieldLabel>
                <Input
                  id="token"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  required
                />
                <FieldDescription>
                  Emitted once at deploy (SSM / <code>sst deploy</code> output).
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="name">Name</FieldLabel>
                <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
              </Field>
              <Field>
                <FieldLabel htmlFor="email">Email</FieldLabel>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <Input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </Field>
              <Button type="submit" disabled={pending}>
                {pending && <Spinner />}
                Create admin
              </Button>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
