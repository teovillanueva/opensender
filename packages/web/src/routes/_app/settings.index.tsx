import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { authClient } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { fullOrganizationQuery } from "@/lib/queries";

export const Route = createFileRoute("/_app/settings/")({
  loader: ({ context }) => {
    context.queryClient.prefetchQuery(fullOrganizationQuery);
  },
  component: GeneralSettingsScreen,
});

function teamInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "T";
}

function GeneralSettingsScreen() {
  const queryClient = useQueryClient();
  const query = useQuery(fullOrganizationQuery);
  const team = query.data;

  const [name, setName] = useState("");
  useEffect(() => {
    if (team?.name) setName(team.name);
  }, [team?.name]);

  const rename = useMutation({
    mutationFn: async () => {
      const result = await authClient.organization.update({
        data: { name: name.trim() },
      });
      if (result.error) throw new Error(result.error.message ?? "Could not rename the team.");
      return result.data;
    },
    onSuccess: () => {
      toast.success("Team renamed");
      queryClient.invalidateQueries({ queryKey: ["organization"] });
      // The Team record mirrors the org name server-side; refetch its readers.
      queryClient.invalidateQueries({ queryKey: ["usage"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (query.isLoading) {
    return (
      <div className="flex max-w-2xl flex-col gap-6">
        <Skeleton className="h-56 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }
  if (query.isError || !team) {
    return <p className="text-sm text-destructive">Failed to load team settings.</p>;
  }

  const dirty = name.trim().length > 0 && name.trim() !== team.name;

  return (
    <div className="content-reveal flex max-w-2xl flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Team Profile</CardTitle>
          <CardDescription>The team's name is shown across the dashboard.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <div className="flex items-center gap-4">
            <div className="flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-600 to-emerald-800 text-xl font-semibold text-white">
              {teamInitial(team.name)}
            </div>
            <p className="text-sm text-muted-foreground">
              Team avatars are generated from the name — custom images aren't supported yet.
            </p>
          </div>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (dirty && !rename.isPending) rename.mutate();
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="team-name">Team name</FieldLabel>
                <Input
                  id="team-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Acme"
                  autoComplete="off"
                />
              </Field>
              <div className="flex justify-end">
                <Button type="submit" disabled={!dirty || rename.isPending}>
                  {rename.isPending ? "Saving…" : "Save"}
                </Button>
              </div>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Team Details</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm">
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">Team ID</span>
            <span className="flex items-center gap-1">
              <code className="rounded bg-muted px-2 py-1 font-mono text-xs">{team.id}</code>
              <CopyButton value={team.id} label="Copy team ID" className="size-7" />
            </span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">Created</span>
            <span>{formatDateTime(team.createdAt as unknown as string)}</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
