/// <reference path="./.sst/platform/config.d.ts" />

/**
 * Reads instance.config.ts (SPEC §20). Stage is always `production` for real
 * instances (SPEC §3.2); `sst dev` shares the same stage via Live mode.
 */
export default $config({
  app(input) {
    const defaultTags = { tags: { app: "opensender", stage: input.stage } };
    const app = {
      name: "opensender",
      home: "aws" as const,
      protect: input.stage === "production",
      removal: input.stage === "production" ? ("retain" as const) : ("remove" as const),
      // Global cost-allocation tags on every AWS resource (SPEC §15). The
      // operator activates `app`/`stage` as cost-allocation tags once in
      // Billing (they surface in Cost Explorer ~24h later) — docs/deploying.md.
      providers: { aws: { defaultTags }, random: "4.16.6" },
    };
    const withRegion = import("./instance.config").then(({ instanceConfig }) => ({
      ...app,
      providers: { ...app.providers, aws: { region: instanceConfig.region, defaultTags } },
    }));
    // SST Console Autodeploy evaluates this file alone (no instance.config.ts)
    // and serializes app() without awaiting it, so the static fields ride on
    // the promise and its rejection must not crash that process. The CLI
    // awaits `withRegion` and still sees any import error.
    withRegion.catch(() => {});
    return Object.assign(withRegion, app);
  },
  // SST Console Autodeploy: a push to `main` deploys the single `production`
  // stage; every other branch, PR and tag is skipped.
  console: {
    autodeploy: {
      target(event) {
        if (event.type === "branch" && event.branch === "main" && event.action === "pushed") {
          return { stage: "production" };
        }
      },
    },
  },
  async run() {
    const { instanceConfig } = await import("./instance.config");

    if (instanceConfig.dnsMode !== "route53") {
      // The manual-DNS bootstrap path (emit records for the operator) is built
      // when the first non-route53 instance exists — no speculative code.
      throw new Error("dnsMode 'manual' is not implemented yet; instance #1 is route53");
    }

    const betterAuthSecret = new sst.Secret("BetterAuthSecret");
    const sentryDsn = new sst.Secret("SentryDsn");
    // Frontend Sentry DSN (public), injected into the SPA build (SPEC §15).
    const sentryDsnWeb = new sst.Secret("SentryDsnWeb");
    // HMAC key for signed one-click unsubscribe tokens (SPEC §11.2). Must be
    // set before deploy: `sst secret set UnsubscribeSecret <random>` (docs/deploying.md).
    const unsubscribeSecret = new sst.Secret("UnsubscribeSecret");

    // 30-day log retention on every Lambda (SPEC §15) — covers the Cron and
    // Queue-subscriber functions created internally too. The Sentry DSN is
    // linked per-function below (its `link` arg isn't a plain array in this
    // transform, so it can't be merged here).
    $transform(sst.aws.Function, (args) => {
      args.logging = { retention: "1 month" };
      // Upload sourcemaps to Sentry at build time via the esbuild plugin
      // (SPEC §15). No-op until the operator sets SENTRY_AUTH_TOKEN/ORG/PROJECT
      // in .env — see sentry-esbuild-plugins.mjs. No function sets `nodejs`, so
      // this assignment never clobbers per-function config.
      args.nodejs = {
        ...((args.nodejs as Record<string, unknown>) ?? {}),
        plugins: "./sentry-esbuild-plugins.mjs",
      };
    });

    // Single-table design (SPEC §4). gsi1: team-scoped listings and
    // better-auth model partitions; gsi2/gsi3: better-auth field lookups
    // (email, session token, member org/user, ...).
    const table = new sst.aws.Dynamo("Table", {
      fields: {
        pk: "string",
        sk: "string",
        gsi1pk: "string",
        gsi1sk: "string",
        gsi2pk: "string",
        gsi2sk: "string",
        gsi3pk: "string",
        gsi3sk: "string",
      },
      primaryIndex: { hashKey: "pk", rangeKey: "sk" },
      globalIndexes: {
        gsi1: { hashKey: "gsi1pk", rangeKey: "gsi1sk" },
        gsi2: { hashKey: "gsi2pk", rangeKey: "gsi2sk" },
        gsi3: { hashKey: "gsi3pk", rangeKey: "gsi3sk" },
      },
      // Reserved attribute so no domain/auth model field can collide with
      // the TTL semantics (epoch-number attributes get hard-deleted).
      ttl: "_ttl",
      transform: {
        table: (args) => {
          args.pointInTimeRecovery = { enabled: true };
        },
      },
    });

    // One-time admin bootstrap token (SPEC §13.2), Grafana-style: emitted at
    // deploy, checked by the bootstrap endpoint while the instance has zero
    // users. Rotating it is `sst deploy` after taints, or manual SSM edit.
    const bootstrapToken = new random.RandomPassword("BootstrapToken", {
      length: 48,
      special: false,
    });
    const bootstrapTokenParam = new aws.ssm.Parameter("BootstrapTokenParam", {
      name: `/opensender/${$app.stage}/bootstrap-token`,
      type: "SecureString",
      value: bootstrapToken.result,
    });

    // Operator alerting channel (SPEC §15): the single SNS topic behind both
    // CloudWatch alarms and app-level guardrail alerts (tenant freeze / auto-
    // freeze). The email subscription requires a one-time confirmation click by
    // the operator after the first deploy (docs/deploying.md); AWS cannot auto-confirm.
    const opsAlerts = new sst.aws.SnsTopic("OpsAlerts");
    new aws.sns.TopicSubscription("OpsAlertsEmail", {
      topic: opsAlerts.arn,
      protocol: "email",
      endpoint: instanceConfig.alertEmail,
    });

    // Tenants, identities, and config sets are created at runtime per
    // customer (SPEC §3.2) — IaC only grants the Lambdas the SES surface.
    const sesRuntimePermissions = {
      actions: [
        "ses:CreateTenant",
        "ses:GetTenant",
        "ses:DeleteTenant",
        "ses:CreateTenantResourceAssociation",
        "ses:DeleteTenantResourceAssociation",
        "ses:CreateEmailIdentity",
        "ses:GetEmailIdentity",
        "ses:DeleteEmailIdentity",
        "ses:PutEmailIdentityMailFromAttributes",
        "ses:CreateConfigurationSet",
        "ses:DeleteConfigurationSet",
        "ses:CreateConfigurationSetEventDestination",
        "ses:UpdateConfigurationSetEventDestination",
        "ses:TagResource",
        "ses:SendEmail",
        // SES v2 SendEmail with Content.Raw authorizes as the legacy action.
        "ses:SendRawEmail",
      ],
      resources: ["*"],
    };

    // Outbound attachments (and, at M6, inbound raw MIME) — 90-day expiry
    // documented in docs/sending-email.md (SPEC §3.2).
    const attachmentsBucket = new sst.aws.Bucket("AttachmentsBucket", {
      versioning: true,
    });
    new aws.s3.BucketLifecycleConfigurationV2("AttachmentsLifecycle", {
      bucket: attachmentsBucket.name,
      rules: [
        {
          id: "expire-bodies",
          status: "Enabled",
          filter: {},
          expiration: { days: 90 },
          noncurrentVersionExpiration: { noncurrentDays: 7 },
        },
      ],
    });

    // Event pipeline (SPEC §8): SES -> EventBridge default bus -> SQS ->
    // event-processor; webhook deliveries fan out through their own queue.
    const emailEventsDlq = new sst.aws.Queue("EmailEventsDlq");
    const emailEvents = new sst.aws.Queue("EmailEvents", {
      dlq: { queue: emailEventsDlq.arn, retry: 5 },
      visibilityTimeout: "120 seconds",
    });
    const webhookDeliveriesDlq = new sst.aws.Queue("WebhookDeliveriesDlq");
    const webhookDeliveries = new sst.aws.Queue("WebhookDeliveries", {
      // 8 receives ≈ Resend's 8 attempts over ~28h; pacing is set per
      // message by the dispatcher via ChangeMessageVisibility (SPEC §8.3).
      dlq: { queue: webhookDeliveriesDlq.arn, retry: 8 },
      visibilityTimeout: "60 seconds",
    });

    // Broadcast fan-out (SPEC §11): a `start` message expands a segment into
    // `page` messages on this same queue; the consumer sends each page through
    // the ordinary send pipeline. Visibility exceeds the 120s function timeout
    // so an in-flight page is not redelivered mid-send.
    const broadcastFanoutDlq = new sst.aws.Queue("BroadcastFanoutDlq");
    const broadcastFanout = new sst.aws.Queue("BroadcastFanout", {
      dlq: { queue: broadcastFanoutDlq.arn, retry: 5 },
      visibilityTimeout: "180 seconds",
    });

    // Inbound (SPEC §9): raw MIME lands here (key = SES mail.messageId),
    // then inbound-processor parses it. Receipt rules are SES v1-only.
    const inboundRuleSetName = `opensender-${$app.stage}`;
    const inboundRuleName = "catch-all";
    const accountId = aws.getCallerIdentityOutput().accountId;
    const receiptRuleArn = $interpolate`arn:aws:ses:${instanceConfig.region}:${accountId}:receipt-rule-set/${inboundRuleSetName}:receipt-rule/${inboundRuleName}`;

    // SES writes the raw MIME; the SourceArn condition scopes it to our rule
    // (receiving-email-permissions docs). Carried on the bucket's own policy
    // — SST owns the single BucketPolicy, so a separate one would collide.
    const inboundBucket = new sst.aws.Bucket("InboundBucket", {
      policy: [
        {
          actions: ["s3:PutObject"],
          principals: [{ type: "service", identifiers: ["ses.amazonaws.com"] }],
          paths: ["*"],
          conditions: [
            { test: "StringEquals", variable: "aws:SourceAccount", values: [accountId] },
            { test: "StringLike", variable: "aws:SourceArn", values: [receiptRuleArn] },
          ],
        },
      ],
    });
    new aws.s3.BucketLifecycleConfigurationV2("InboundLifecycle", {
      bucket: inboundBucket.name,
      rules: [{ id: "expire-mime", status: "Enabled", filter: {}, expiration: { days: 90 } }],
    });

    const inboundProcessor = new sst.aws.Function("InboundProcessor", {
      handler: "packages/functions/src/inbound-processor.handler",
      timeout: "120 seconds",
      link: [table, inboundBucket, attachmentsBucket, webhookDeliveries, sentryDsn],
      environment: { AWS_ACCOUNT_ID: accountId },
      permissions: [sesRuntimePermissions],
    });

    const inboundInvokePermission = new aws.lambda.Permission("InboundSesInvoke", {
      action: "lambda:InvokeFunction",
      function: inboundProcessor.arn,
      principal: "ses.amazonaws.com",
      sourceAccount: accountId,
      sourceArn: receiptRuleArn,
    });

    const inboundRuleSet = new aws.ses.ReceiptRuleSet("InboundRuleSet", {
      ruleSetName: inboundRuleSetName,
    });
    const inboundRule = new aws.ses.ReceiptRule(
      "InboundCatchAll",
      {
        name: inboundRuleName,
        ruleSetName: inboundRuleSet.ruleSetName,
        enabled: true,
        scanEnabled: true,
        tlsPolicy: "Optional",
        // No recipients ⇒ matches every verified identity; the processor
        // drops mail to domains without inbound enabled (SPEC §9).
        s3Actions: [{ position: 1, bucketName: inboundBucket.name }],
        lambdaActions: [
          { position: 2, functionArn: inboundProcessor.arn, invocationType: "Event" },
        ],
      },
      { dependsOn: [inboundBucket, inboundInvokePermission] },
    );
    new aws.ses.ActiveReceiptRuleSet(
      "InboundActiveRuleSet",
      { ruleSetName: inboundRuleSet.ruleSetName },
      { dependsOn: [inboundRule] },
    );

    emailEvents.subscribe(
      {
        handler: "packages/functions/src/event-processor.handler",
        timeout: "120 seconds",
        // OpsAlerts: the reputation auto-freeze publishes here (SPEC §12).
        link: [table, webhookDeliveries, opsAlerts, sentryDsn],
        environment: { AWS_ACCOUNT_ID: aws.getCallerIdentityOutput().accountId },
      },
      // Backpressure from day one (SPEC §3.2).
      {
        batch: { partialResponses: true },
        transform: {
          eventSourceMapping: (args) => {
            args.scalingConfig = { maximumConcurrency: 10 };
          },
        },
      },
    );

    webhookDeliveries.subscribe(
      {
        handler: "packages/functions/src/webhook-dispatcher.handler",
        timeout: "60 seconds",
        link: [table, sentryDsn],
        environment: { WEBHOOK_QUEUE_URL: webhookDeliveries.url },
        permissions: [
          { actions: ["sqs:ChangeMessageVisibility"], resources: [webhookDeliveries.arn] },
        ],
      },
      {
        // size:1 — each delivery gets its own invocation and its own 60s budget.
        // A batch of 10 with a per-POST 10s timeout could exhaust the function
        // timeout on a few slow endpoints, and a hard timeout never returns the
        // batchItemFailures array, so SQS would redeliver the WHOLE batch —
        // re-POSTing already-delivered webhooks. Per-message isolation also
        // avoids concurrent mutation of an endpoint's circuit-breaker state.
        batch: { size: 1, partialResponses: true },
        transform: {
          eventSourceMapping: (args) => {
            args.scalingConfig = { maximumConcurrency: 10 };
          },
        },
      },
    );

    // Broadcast fan-out consumer: links the queue back to itself so the
    // `start` handler can enqueue `page` messages; the unsubscribe secret and
    // API base URL build per-recipient one-click unsubscribe links.
    broadcastFanout.subscribe(
      {
        handler: "packages/functions/src/broadcast-fanout.handler",
        timeout: "120 seconds",
        // webhookDeliveries: the send pipeline's emitter fans events out to it.
        link: [
          table,
          attachmentsBucket,
          broadcastFanout,
          webhookDeliveries,
          unsubscribeSecret,
          sentryDsn,
        ],
        environment: {
          AWS_ACCOUNT_ID: aws.getCallerIdentityOutput().accountId,
          API_BASE_URL: `https://api.${instanceConfig.domain}`,
          // Fan-out paces its SES sends to a fair share of this account cap so
          // the fleet stays under it (SPEC §20). Previously dead config.
          SES_MAX_SEND_RATE: String(instanceConfig.sesMaxSendRatePerSecond),
        },
        permissions: [sesRuntimePermissions],
      },
      {
        // size:1 — one `start` OR one `page` per invocation. A batch of 10 could
        // pull 10 pages (500 recipients) into a single invocation and blow the
        // timeout, and a mid-batch failure would redeliver every page in the
        // batch. Per-recipient sends are made idempotent by a deterministic
        // emailId (broadcast-fanout.ts), so a redelivered page never re-sends;
        // size:1 keeps the redelivery blast radius to a single page.
        // maximumConcurrency 10 bounds aggregate SES send rate together with the
        // per-Lambda pacer in broadcast-fanout.ts (SES account cap ~14/s).
        batch: { size: 1, partialResponses: true },
        transform: {
          eventSourceMapping: (args) => {
            args.scalingConfig = { maximumConcurrency: 10 };
          },
        },
      },
    );

    // Deferred broadcasts (SPEC §11): a one-time EventBridge schedule targets
    // the fan-out queue directly (universal SQS target), delivering the `start`
    // message body at fire time. The role lets Scheduler send to the queue.
    const broadcastSchedulerRole = new aws.iam.Role("BroadcastSchedulerRole", {
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "scheduler.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      }),
    });
    new aws.iam.RolePolicy("BroadcastSchedulerPolicy", {
      role: broadcastSchedulerRole.id,
      policy: $jsonStringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: "sqs:SendMessage", Resource: broadcastFanout.arn }],
      }),
    });

    // Scheduling (SPEC §10): one-time schedules in a per-stage group target
    // scheduled-sender; ActionAfterCompletion DELETE keeps the group clean.
    const scheduleGroup = new aws.scheduler.ScheduleGroup("ScheduleGroup", {
      name: `opensender-${$app.stage}-emails`,
    });
    const scheduledSender = new sst.aws.Function("ScheduledSender", {
      handler: "packages/functions/src/scheduled-sender.handler",
      timeout: "120 seconds",
      link: [table, attachmentsBucket, webhookDeliveries, sentryDsn],
      environment: { AWS_ACCOUNT_ID: aws.getCallerIdentityOutput().accountId },
      permissions: [sesRuntimePermissions],
    });
    const schedulerRole = new aws.iam.Role("SchedulerInvokeRole", {
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "scheduler.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      }),
    });
    new aws.iam.RolePolicy("SchedulerInvokePolicy", {
      role: schedulerRole.id,
      policy: $jsonStringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: "lambda:InvokeFunction",
            Resource: scheduledSender.arn,
          },
        ],
      }),
    });
    const schedulerEnvironment = {
      SCHEDULE_GROUP_NAME: scheduleGroup.name,
      SCHEDULED_SENDER_ARN: scheduledSender.arn,
      SCHEDULER_ROLE_ARN: schedulerRole.arn,
    };
    const schedulerPermissions = [
      {
        actions: [
          "scheduler:CreateSchedule",
          "scheduler:UpdateSchedule",
          "scheduler:DeleteSchedule",
          "scheduler:GetSchedule",
        ],
        resources: [
          $interpolate`arn:aws:scheduler:${instanceConfig.region}:${aws.getCallerIdentityOutput().accountId}:schedule/${scheduleGroup.name}/*`,
        ],
      },
      { actions: ["iam:PassRole"], resources: [schedulerRole.arn] },
    ];

    // Email-events rule: match detail-type explicitly — bare source:aws.ses
    // also catches VDM advisor and tenant-status events (R03 §3.2).
    const sesEventsRule = new aws.cloudwatch.EventRule("SesEmailEventsRule", {
      eventPattern: JSON.stringify({
        source: ["aws.ses"],
        "detail-type": [
          "Email Sent",
          "Email Rejected",
          "Email Bounced",
          "Email Complaint Received",
          "Email Delivered",
          "Email Opened",
          "Email Clicked",
          "Email Rendering Failed",
          "Email Delivery Delayed",
          "Email Subscribed",
        ],
      }),
    });
    new aws.cloudwatch.EventTarget("SesEmailEventsTarget", {
      rule: sesEventsRule.name,
      arn: emailEvents.arn,
    });
    new aws.sqs.QueuePolicy("EmailEventsQueuePolicy", {
      queueUrl: emailEvents.url,
      policy: $jsonStringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "events.amazonaws.com" },
            Action: "sqs:SendMessage",
            Resource: emailEvents.arn,
            Condition: { ArnEquals: { "aws:SourceArn": sesEventsRule.arn } },
          },
        ],
      }),
    });

    // Tenant sending-status handling (SPEC §12): a DISABLED event freezes the
    // owning team; ENABLED/REINSTATED restores it. The handler logs every event
    // to its own CloudWatch group, so no separate log-target is needed.
    const tenantStatusRule = new aws.cloudwatch.EventRule("SesTenantStatusRule", {
      eventPattern: JSON.stringify({
        source: ["aws.ses"],
        "detail-type": ["Sending Status Enabled", "Sending Status Disabled"],
      }),
    });
    const tenantStatusFn = new sst.aws.Function("TenantStatus", {
      handler: "packages/functions/src/tenant-status.handler",
      timeout: "60 seconds",
      // OpsAlerts: every freeze/restore transition alerts the operator (§15).
      link: [table, opsAlerts, sentryDsn],
      environment: { AWS_ACCOUNT_ID: accountId },
    });
    const tenantStatusInvoke = new aws.lambda.Permission("TenantStatusEventInvoke", {
      action: "lambda:InvokeFunction",
      function: tenantStatusFn.arn,
      principal: "events.amazonaws.com",
      sourceArn: tenantStatusRule.arn,
    });
    new aws.cloudwatch.EventTarget(
      "SesTenantStatusTarget",
      { rule: tenantStatusRule.name, arn: tenantStatusFn.arn },
      { dependsOn: [tenantStatusInvoke] },
    );

    // Front door (SPEC §3.1): Router (CloudFront) + Lambda Function URL.
    // The router's CloudFront function creates the URL origin with OAC
    // disabled (AuthType NONE) — required so the Resend SDK's plain POSTs work.
    const router = new sst.aws.Router("ApiRouter", {
      domain: `api.${instanceConfig.domain}`,
    });

    const api = new sst.aws.Function("Api", {
      handler: "packages/functions/src/api.handler",
      timeout: "120 seconds",
      url: {
        // The Lambda Function URL's built-in CORS defaults to `*` and would
        // (a) answer OPTIONS preflights itself with `*` (illegal for the
        // dashboard's credentialed requests) and (b) append a second
        // `access-control-allow-origin` to real responses, colliding with the
        // Hono `cors()` middleware. Disable it so Hono is the sole, correct,
        // origin-specific + credentialed CORS source (SPEC §16).
        cors: false,
        router: {
          instance: router,
          // Origin response timeout above CloudFront's 30s default; this
          // account's "Response timeout per origin" quota is 120s
          // (L-AECE9FA7). Needed for path-attachment downloads (SPEC §3.1).
          readTimeout: "120 seconds",
        },
      },
      link: [
        table,
        attachmentsBucket,
        webhookDeliveries,
        broadcastFanout,
        betterAuthSecret,
        unsubscribeSecret,
        sentryDsn,
      ],
      environment: {
        BOOTSTRAP_TOKEN_PARAM: bootstrapTokenParam.name,
        API_BASE_URL: `https://api.${instanceConfig.domain}`,
        AWS_ACCOUNT_ID: aws.getCallerIdentityOutput().accountId,
        // Deferred-broadcast scheduling targets the fan-out queue; the schedule
        // group is shared with email scheduling (SCHEDULE_GROUP_NAME).
        BROADCAST_FANOUT_QUEUE_ARN: broadcastFanout.arn,
        BROADCAST_SCHEDULER_ROLE_ARN: broadcastSchedulerRole.arn,
        ...schedulerEnvironment,
      },
      permissions: [
        sesRuntimePermissions,
        { actions: ["ssm:GetParameter"], resources: [bootstrapTokenParam.arn] },
        ...schedulerPermissions,
        { actions: ["iam:PassRole"], resources: [broadcastSchedulerRole.arn] },
      ],
    });

    // 10-minute verification sweep (SPEC §7): SES searches DNS for up to
    // 72h; the cron keeps domain status current without user action.
    new sst.aws.CronV2("DomainVerifier", {
      schedule: "rate(10 minutes)",
      function: {
        handler: "packages/functions/src/domain-verifier.handler",
        timeout: "120 seconds",
        // createDomainsService builds the events emitter, which reads
        // Resource.WebhookDeliveries at construction — so the cron must link it
        // even though a domain refresh rarely emits (domain.verified fan-out).
        link: [table, webhookDeliveries, sentryDsn],
        environment: { AWS_ACCOUNT_ID: aws.getCallerIdentityOutput().accountId },
        permissions: [sesRuntimePermissions],
      },
    });

    // Dashboard (SPEC §13): a Vite StaticSite on the bare instance domain.
    // Branding + API origin are injected as build-time Vite env; the client
    // dogfoods the public API at api.<domain> with the session cookie.
    const dashboard = new sst.aws.StaticSite("Dashboard", {
      path: "packages/web",
      domain: {
        name: instanceConfig.domain,
        redirects: [`www.${instanceConfig.domain}`],
      },
      build: {
        command: "pnpm build",
        output: "dist",
      },
      // SPA fallback: client-side routes (e.g. /emails) resolve to index.html
      // instead of a CloudFront 404 (TanStack Router owns routing).
      errorPage: "index.html",
      environment: {
        VITE_API_URL: `https://api.${instanceConfig.domain}`,
        VITE_INSTANCE_NAME: instanceConfig.instanceName,
        VITE_SIGNUP_OPEN: String(instanceConfig.signupOpen),
        VITE_SENTRY_DSN: sentryDsnWeb.value,
      },
      transform: {
        // Own the CloudFront error responses (SST's default maps 403/404 to
        // index.html but keeps a 404 status, and leaves 5xx as the raw
        // "Failed to contact the origin" page during the deploy window).
        // Replace the whole set so that:
        //   - deep client routes (403/404 from S3) serve the SPA shell as 200,
        //     since TanStack Router owns routing (no spurious 404 status);
        //   - transient origin 5xx during a deploy also serve the shell as 200,
        //     cached briefly so it self-heals within seconds instead of showing
        //     CloudFront's error page.
        cdn: (args) => {
          args.customErrorResponses = [
            {
              errorCode: 403,
              responseCode: 200,
              responsePagePath: "/index.html",
              errorCachingMinTtl: 0,
            },
            {
              errorCode: 404,
              responseCode: 200,
              responsePagePath: "/index.html",
              errorCachingMinTtl: 0,
            },
            {
              errorCode: 500,
              responseCode: 200,
              responsePagePath: "/index.html",
              errorCachingMinTtl: 5,
            },
            {
              errorCode: 502,
              responseCode: 200,
              responsePagePath: "/index.html",
              errorCachingMinTtl: 5,
            },
            {
              errorCode: 503,
              responseCode: 200,
              responsePagePath: "/index.html",
              errorCachingMinTtl: 5,
            },
            {
              errorCode: 504,
              responseCode: 200,
              responsePagePath: "/index.html",
              errorCachingMinTtl: 5,
            },
          ];
        },
      },
    });

    // Infra split into modules (SST requires dynamic imports in sst.config).
    const { createObservability } = await import("./infra/observability");
    const { createCostControls } = await import("./infra/costs");

    const { costWidget } = createCostControls({
      table,
      attachmentsBucket,
      webhookDeliveries,
      opsAlerts,
      sentryDsn,
    });

    createObservability({
      opsAlerts,
      emailEventsDlq,
      webhookDeliveriesDlq,
      broadcastFanoutDlq,
      emailEvents,
      webhookDeliveries,
      broadcastFanout,
      api,
      costWidget,
    });

    // With `url.router` configured, api.url resolves to the router's domain
    // too — a second output would just repeat this one.
    return {
      apiUrl: router.url,
      dashboardUrl: dashboard.url,
      // Grafana-style one-time admin bootstrap credential (SPEC §13.2); the
      // endpoint stops honoring it as soon as any user exists.
      bootstrapToken: bootstrapToken.result,
    };
  },
});
