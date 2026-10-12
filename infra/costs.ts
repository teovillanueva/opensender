/// <reference path="../.sst/platform/config.d.ts" />
import { instanceConfig } from "../instance.config";

type Queue = InstanceType<typeof sst.aws.Queue>;
type Topic = InstanceType<typeof sst.aws.SnsTopic>;
type Table = InstanceType<typeof sst.aws.Dynamo>;
type Bucket = InstanceType<typeof sst.aws.Bucket>;
type Secret = InstanceType<typeof sst.Secret>;
type Fn = InstanceType<typeof sst.aws.Function>;

/**
 * Budget + weekly cost-report cron + the live cost-widget backend (SPEC §15).
 * Returns the cost-widget Function so the dashboard can reference its ARN.
 */
export function createCostControls(deps: {
  table: Table;
  attachmentsBucket: Bucket;
  webhookDeliveries: Queue;
  opsAlerts: Topic;
  sentryDsn: Secret;
}): { costWidget: Fn } {
  const { table, attachmentsBucket, webhookDeliveries, opsAlerts, sentryDsn } = deps;
  const accountId = aws.getCallerIdentityOutput().accountId;
  // --- Cost controls (SPEC §15) ---

  // Budget alerts at 50/80/100% of the instance's monthly budget. Email
  // subscribers get AWS's notifications directly — no confirmation click
  // (unlike SNS email subscriptions), so these fire without operator action.
  new aws.budgets.Budget("MonthlyCostBudget", {
    budgetType: "COST",
    limitAmount: String(instanceConfig.monthlyBudgetUsd),
    limitUnit: "USD",
    timeUnit: "MONTHLY",
    // Scope the budget to THIS instance's spend via the global `app` tag, so
    // unrelated resources in the account never count against it. Requires the
    // `app` cost-allocation tag activated in Billing (one-time, ~24h) — until
    // then the filter tracks $0. Format: `user:<key>$<value>`.
    costFilters: [{ name: "TagKeyValue", values: ["user:app$opensender"] }],
    notifications: [50, 80, 100].map((threshold) => ({
      comparisonOperator: "GREATER_THAN",
      threshold,
      thresholdType: "PERCENTAGE",
      notificationType: "ACTUAL",
      subscriberEmailAddresses: [instanceConfig.alertEmail],
    })),
  });

  // Cost Anomaly Detection (SPEC §15) is an ACCOUNT-global service: AWS
  // allows exactly one DIMENSIONAL/SERVICE spend monitor per account, so it
  // is not managed per-stage here (a second `CreateAnomalyMonitor` fails with
  // "Limit exceeded"). The operator confirms the account monitor is on with a
  // daily email subscription once — docs/deploying.md.

  // Weekly cost summary cron (SPEC §15): queries Cost Explorer and mails the
  // per-service breakdown through the platform itself (dogfooding), with an
  // SNS fallback. `ce:GetCostAndUsage` is ~$0.01/query. Links mirror the send
  // path (table, attachments bucket, webhook-deliveries queue) plus OpsAlerts.
  new sst.aws.CronV2("CostReport", {
    schedule: "rate(7 days)",
    function: {
      handler: "packages/functions/src/cost-report.handler",
      timeout: "120 seconds",
      link: [table, attachmentsBucket, webhookDeliveries, opsAlerts, sentryDsn],
      environment: { AWS_ACCOUNT_ID: accountId },
      // Least privilege: the cost report only sends (dogfood email) and reads
      // Cost Explorer — not the full tenant-management surface. ce:* has no
      // resource ARNs, so "*" is required there.
      permissions: [
        { actions: ["ses:SendEmail", "ses:SendRawEmail"], resources: ["*"] },
        { actions: ["ce:GetCostAndUsage"], resources: ["*"] },
      ],
    },
  });

  // Live cost widget backing the CloudWatch custom widget on the ops dashboard
  // (SPEC §15). The native `AWS/Billing` metric is account-wide and cannot be
  // tag-filtered, so this Lambda answers with the same tag-scoped Cost Explorer
  // query the weekly report uses — opensender's spend only. It is invoked by
  // the CloudWatch console with the viewing operator's own IAM credentials
  // (no schedule, no links); it only needs read access to Cost Explorer.
  const costWidget = new sst.aws.Function("CostWidget", {
    handler: "packages/functions/src/cost-widget.handler",
    timeout: "30 seconds",
    // Sentry DSN only (no data links): the handler reads Cost Explorer via the
    // permission below and reports errors via the shared withSentry wrapper.
    link: [sentryDsn],
    permissions: [{ actions: ["ce:GetCostAndUsage"], resources: ["*"] }],
  });

  return { costWidget };
}
