# Keeping an instance up to date

Each instance lives in its own private repo, created from this one (see
[Deploying an instance](deploying.md#1-create-your-instance-repo)). The
instance repo differs from upstream only in `instance.config.ts`, so pulling
upstream changes is a clean merge.

The setup below makes that automatic: every hour the instance merges the
latest upstream commit that passed CI, and the push to `main` deploys it.

```
upstream main ──CI passes──▶ instance: sync-upstream (hourly) ──push main──▶ SST Autodeploy ──▶ AWS
```

## Sync upstream automatically

Copy [`templates/sync-upstream.yml`](templates/sync-upstream.yml) to
`.github/workflows/sync-upstream.yml` in your instance repo and commit it.

It runs hourly and on demand (**Actions → sync-upstream → Run workflow**):

1. Asks the upstream repo for the latest `main` commit whose CI passed.
2. If the instance doesn't have it yet, merges it into `main` and pushes.
3. Does nothing if the instance is already up to date.

It needs no tokens or secrets: upstream is public, and the push uses the
workflow's own `GITHUB_TOKEN`. Two cases need you, and the run fails with the
exact commands to finish by hand:

- **A merge conflict**, usually because upstream changed something you also
  changed in the instance.
- **Upstream changed `.github/workflows/`.** GitHub doesn't let `GITHUB_TOKEN`
  push workflow files.

To sync by hand at any time:

```bash
git fetch upstream
git merge upstream/main
git push origin main
```

## Deploy on push with SST Console Autodeploy

`sst.config.ts` already configures [Autodeploy](https://sst.dev/docs/console/#autodeploy):
a push to `main` deploys the `production` stage, and every other branch, PR
and tag is skipped. To turn it on for an instance:

1. In the [SST Console](https://console.sst.dev), connect the instance's AWS
   account and create the app.
2. **Settings → Autodeploy:** connect the instance's GitHub repo.
3. **Add a branch environment** with stage `production` and the instance's AWS
   account. No environment variables are needed: secrets come from
   `sst secret`.

Builds run in CodeBuild inside your account. The next push to `main` (or the
next sync) deploys; **Autodeploy → Redeploy** re-runs the latest one.

> [!IMPORTANT]
> The SST Console evaluates `sst.config.ts` on its own, without the rest of the
> repo, and calls `app()` without awaiting it. That's why `app()` returns the
> `instance.config` import as a promise with its static fields attached. Keep
> that shape if you edit it, or Autodeploy fails with *Error evaluating
> sst.config.ts*.

Autodeploy runs its builds in `us-east-1`; the stack itself still deploys to
your configured `region`.
