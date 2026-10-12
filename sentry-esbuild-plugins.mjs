import { sentryEsbuildPlugin } from "@sentry/esbuild-plugin";

/**
 * esbuild plugins injected into every SST Lambda bundle (referenced by
 * `nodejs.plugins` in sst.config.ts). The Sentry plugin injects Debug IDs and
 * uploads sourcemaps to Sentry at build time — with Debug IDs (Sentry SDK v8+)
 * frames resolve to original source WITHOUT pinning a release, so no runtime
 * SENTRY_RELEASE is needed.
 *
 * It only activates when the operator has set SENTRY_AUTH_TOKEN + SENTRY_ORG +
 * SENTRY_PROJECT (SST loads these from .env). Without them this exports an
 * empty plugin list — bundling is unchanged. The auth token is a Sentry
 * project token with `project:releases`/`project:write` scope; it is NOT the
 * DSN. See docs/deploying.md.
 */
const { SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT } = process.env;

export default SENTRY_AUTH_TOKEN && SENTRY_ORG && SENTRY_PROJECT
  ? [
      sentryEsbuildPlugin({
        authToken: SENTRY_AUTH_TOKEN,
        org: SENTRY_ORG,
        project: SENTRY_PROJECT,
        sourcemaps: { deleteFilesAfterUpload: ["**/*.js.map"] },
      }),
    ]
  : [];
