import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { config } from "@/config";
import { api } from "@/lib/api";
import { authClient, signIn, signUp } from "@/lib/auth";

/**
 * Login (SPEC §13.1). Before showing the form we check the first-run
 * bootstrap status; a zero-user instance redirects to /bootstrap. Sign-up is
 * only offered when `signupOpen` — the server rejects it regardless.
 */
export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => ({
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
  }),
  beforeLoad: async () => {
    const { data } = await api.GET("/internal/bootstrap");
    if (data?.needs_bootstrap) throw redirect({ to: "/bootstrap" });
    const session = await authClient.getSession();
    if (session.data) throw redirect({ to: "/emails" });
  },
  component: LoginScreen,
});

function LoginScreen() {
  const search = Route.useSearch();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    try {
      const result =
        mode === "signup"
          ? await signUp.email({ email, password, name })
          : await signIn.email({ email, password });
      if (result.error) {
        toast.error(result.error.message ?? "Authentication failed");
        return;
      }
      // OAuth continuation: when this page was reached from
      // /auth/oauth2/authorize, the auth client forwards the signed
      // oauth_query and the server answers the sign-in with the NEXT step of
      // the authorize flow ({ redirect, url }) instead of a plain session.
      const oauth = result.data as { redirect?: boolean; url?: string } | null;
      window.location.href =
        oauth?.redirect && oauth.url ? oauth.url : (search.redirect ?? "/emails");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Authentication failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background p-4">
      <div className="flex items-center gap-2.5">
        <div className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-600 to-emerald-800 text-sm font-semibold text-white">
          {config.instanceName.trim().charAt(0).toUpperCase() || "M"}
        </div>
        <span className="text-lg font-semibold tracking-tight">{config.instanceName}</span>
      </div>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{mode === "signup" ? "Create Your Account" : "Welcome Back"}</CardTitle>
          <CardDescription>
            {mode === "signup"
              ? "Set up your account to start sending."
              : "Sign in to your dashboard."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit}>
            <FieldGroup>
              {mode === "signup" && (
                <Field>
                  <FieldLabel htmlFor="name">Name</FieldLabel>
                  <Input
                    id="name"
                    autoComplete="name"
                    placeholder="Ada Lovelace"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                  />
                </Field>
              )}
              <Field>
                <FieldLabel htmlFor="email">Email</FieldLabel>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  spellCheck={false}
                  placeholder="you@company.com"
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
                  autoComplete={mode === "signup" ? "new-password" : "current-password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </Field>
              <Button type="submit" disabled={pending}>
                {pending && <Spinner />}
                {mode === "signup" ? "Create account" : "Sign in"}
              </Button>
              {config.signupOpen && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setMode(mode === "signup" ? "login" : "signup")}
                >
                  {mode === "signup" ? "Have an account? Sign in" : "Need an account? Sign up"}
                </Button>
              )}
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
