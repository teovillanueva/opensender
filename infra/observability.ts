/// <reference path="../.sst/platform/config.d.ts" />
import { instanceConfig } from "../instance.config";

type Queue = InstanceType<typeof sst.aws.Queue>;
type Fn = InstanceType<typeof sst.aws.Function>;
type Topic = InstanceType<typeof sst.aws.SnsTopic>;

/** CloudWatch alarms + the single ops dashboard (SPEC §15), routed to OpsAlerts. */
export function createObservability(deps: {
  opsAlerts: Topic;
  emailEventsDlq: Queue;
  webhookDeliveriesDlq: Queue;
  broadcastFanoutDlq: Queue;
  emailEvents: Queue;
  webhookDeliveries: Queue;
  broadcastFanout: Queue;
  api: Fn;
  costWidget: Fn;
}): void {
  const {
    opsAlerts,
    emailEventsDlq,
    webhookDeliveriesDlq,
    broadcastFanoutDlq,
    emailEvents,
    webhookDeliveries,
    broadcastFanout,
    api,
    costWidget,
  } = deps;
  // CloudWatch alarms (SPEC §15), all routed to OpsAlerts → operator email.
  // Ten alarms keeps us inside the CloudWatch always-free tier.
  const alarmActions = { alarmActions: [opsAlerts.arn], okActions: [opsAlerts.arn] };
  const dlqs = {
    EmailEvents: emailEventsDlq,
    WebhookDeliveries: webhookDeliveriesDlq,
    BroadcastFanout: broadcastFanoutDlq,
  };
  for (const [name, dlq] of Object.entries(dlqs)) {
    new aws.cloudwatch.MetricAlarm(`${name}DlqDepthAlarm`, {
      alarmDescription: `${name} DLQ has messages — a handler is failing repeatedly.`,
      namespace: "AWS/SQS",
      metricName: "ApproximateNumberOfMessagesVisible",
      dimensions: { QueueName: dlq.nodes.queue.name },
      statistic: "Maximum",
      period: 300,
      evaluationPeriods: 1,
      threshold: 0,
      comparisonOperator: "GreaterThanThreshold",
      treatMissingData: "notBreaching",
      ...alarmActions,
    });
  }
  const mainQueues = {
    EmailEvents: emailEvents,
    WebhookDeliveries: webhookDeliveries,
    BroadcastFanout: broadcastFanout,
  };
  for (const [name, queue] of Object.entries(mainQueues)) {
    new aws.cloudwatch.MetricAlarm(`${name}AgeAlarm`, {
      alarmDescription: `${name} queue is backing up (oldest message > 15 min).`,
      namespace: "AWS/SQS",
      metricName: "ApproximateAgeOfOldestMessage",
      dimensions: { QueueName: queue.nodes.queue.name },
      statistic: "Maximum",
      period: 300,
      evaluationPeriods: 1,
      threshold: 900,
      comparisonOperator: "GreaterThanThreshold",
      treatMissingData: "notBreaching",
      ...alarmActions,
    });
  }
  new aws.cloudwatch.MetricAlarm("ApiErrorsAlarm", {
    alarmDescription: "API Lambda is throwing errors.",
    namespace: "AWS/Lambda",
    metricName: "Errors",
    dimensions: { FunctionName: api.nodes.function.name },
    statistic: "Sum",
    period: 300,
    evaluationPeriods: 1,
    threshold: 5,
    comparisonOperator: "GreaterThanThreshold",
    treatMissingData: "notBreaching",
    ...alarmActions,
  });
  new aws.cloudwatch.MetricAlarm("ApiLatencyAlarm", {
    alarmDescription: "API Lambda p99 duration is high (> 5s).",
    namespace: "AWS/Lambda",
    metricName: "Duration",
    dimensions: { FunctionName: api.nodes.function.name },
    extendedStatistic: "p99",
    period: 300,
    evaluationPeriods: 3,
    threshold: 5000,
    comparisonOperator: "GreaterThanThreshold",
    treatMissingData: "notBreaching",
    ...alarmActions,
  });
  new aws.cloudwatch.MetricAlarm("SesBounceRateAlarm", {
    alarmDescription: "SES account bounce rate is elevated (> 5%).",
    namespace: "AWS/SES",
    metricName: "Reputation.BounceRate",
    statistic: "Average",
    period: 3600,
    evaluationPeriods: 1,
    threshold: 0.05,
    comparisonOperator: "GreaterThanThreshold",
    treatMissingData: "notBreaching",
    ...alarmActions,
  });
  new aws.cloudwatch.MetricAlarm("SesComplaintRateAlarm", {
    alarmDescription: "SES account complaint rate is elevated (> 0.1%).",
    namespace: "AWS/SES",
    metricName: "Reputation.ComplaintRate",
    statistic: "Average",
    period: 3600,
    evaluationPeriods: 1,
    threshold: 0.001,
    comparisonOperator: "GreaterThanThreshold",
    treatMissingData: "notBreaching",
    ...alarmActions,
  });

  // One CloudWatch dashboard (SPEC §15): volume, reputation, DLQs, API health.
  new aws.cloudwatch.Dashboard("OpsDashboard", {
    dashboardName: `opensender-${$app.stage}`,
    dashboardBody: $jsonStringify({
      widgets: [
        {
          type: "metric",
          width: 12,
          height: 6,
          properties: {
            title: "SES volume",
            region: instanceConfig.region,
            stat: "Sum",
            period: 300,
            metrics: [
              ["AWS/SES", "Send"],
              ["AWS/SES", "Delivery"],
              ["AWS/SES", "Bounce"],
              ["AWS/SES", "Complaint"],
            ],
          },
        },
        {
          type: "metric",
          width: 12,
          height: 6,
          properties: {
            title: "SES reputation rates",
            region: instanceConfig.region,
            stat: "Average",
            period: 3600,
            metrics: [
              ["AWS/SES", "Reputation.BounceRate"],
              ["AWS/SES", "Reputation.ComplaintRate"],
            ],
          },
        },
        {
          type: "metric",
          width: 12,
          height: 6,
          properties: {
            title: "Dead-letter queue depth",
            region: instanceConfig.region,
            stat: "Maximum",
            period: 300,
            metrics: [
              [
                "AWS/SQS",
                "ApproximateNumberOfMessagesVisible",
                "QueueName",
                emailEventsDlq.nodes.queue.name,
              ],
              [
                "AWS/SQS",
                "ApproximateNumberOfMessagesVisible",
                "QueueName",
                webhookDeliveriesDlq.nodes.queue.name,
              ],
              [
                "AWS/SQS",
                "ApproximateNumberOfMessagesVisible",
                "QueueName",
                broadcastFanoutDlq.nodes.queue.name,
              ],
            ],
          },
        },
        {
          type: "metric",
          width: 12,
          height: 6,
          properties: {
            title: "API Lambda health",
            region: instanceConfig.region,
            period: 300,
            metrics: [
              [
                "AWS/Lambda",
                "Invocations",
                "FunctionName",
                api.nodes.function.name,
                { stat: "Sum" },
              ],
              ["AWS/Lambda", "Errors", "FunctionName", api.nodes.function.name, { stat: "Sum" }],
              ["AWS/Lambda", "Duration", "FunctionName", api.nodes.function.name, { stat: "p99" }],
            ],
          },
        },
        // Custom Powertools EMF metrics (SPEC §15). SEARCH expressions match
        // the `opensender` namespace by metric name regardless of the
        // service/stage dimension values, so the widgets track our own
        // business counters, not just native AWS metrics.
        {
          type: "metric",
          width: 12,
          height: 6,
          properties: {
            title: "Application volume (opensender)",
            region: instanceConfig.region,
            period: 300,
            metrics: [
              [
                {
                  expression:
                    "SEARCH('{opensender,service,stage} MetricName=\"sends\"', 'Sum', 300)",
                  label: "sends",
                  id: "m_sends",
                },
              ],
              [
                {
                  expression:
                    "SEARCH('{opensender,service,stage} MetricName=\"deliveries\"', 'Sum', 300)",
                  label: "deliveries",
                  id: "m_deliveries",
                },
              ],
              [
                {
                  expression:
                    "SEARCH('{opensender,service,stage} MetricName=\"bounces\"', 'Sum', 300)",
                  label: "bounces",
                  id: "m_bounces",
                },
              ],
              [
                {
                  expression:
                    "SEARCH('{opensender,service,stage} MetricName=\"complaints\"', 'Sum', 300)",
                  label: "complaints",
                  id: "m_complaints",
                },
              ],
            ],
          },
        },
        {
          type: "metric",
          width: 12,
          height: 6,
          properties: {
            title: "Pipeline (opensender)",
            region: instanceConfig.region,
            period: 300,
            metrics: [
              [
                {
                  expression:
                    "SEARCH('{opensender,service,stage} MetricName=\"webhook_deliveries\"', 'Sum', 300)",
                  label: "webhook_deliveries",
                  id: "m_wh_ok",
                },
              ],
              [
                {
                  expression:
                    "SEARCH('{opensender,service,stage} MetricName=\"webhook_failures\"', 'Sum', 300)",
                  label: "webhook_failures",
                  id: "m_wh_fail",
                },
              ],
              [
                {
                  expression:
                    "SEARCH('{opensender,service,stage} MetricName=\"inbound_received\"', 'Sum', 300)",
                  label: "inbound_received",
                  id: "m_inbound",
                },
              ],
              [
                {
                  expression:
                    "SEARCH('{opensender,service,stage} MetricName=\"domains_verified\"', 'Sum', 300)",
                  label: "domains_verified",
                  id: "m_domains",
                },
              ],
            ],
          },
        },
        // opensender-only spend (SPEC §15): a custom widget backed by the
        // CostWidget Lambda, which runs the `app=opensender` tag-scoped Cost
        // Explorer query — the instance's spend ONLY, unlike the account-wide
        // native widget below (CloudWatch billing metrics can't be tag-filtered).
        {
          type: "custom",
          width: 24,
          height: 6,
          properties: {
            endpoint: costWidget.nodes.function.arn,
            title: "opensender cost (month-to-date, tag-filtered)",
            updateOn: { refresh: true, resize: true, timeRange: false },
          },
        },
        // Estimated charges (SPEC §15). AWS/Billing is ACCOUNT-WIDE and only
        // published in us-east-1; it cannot be filtered by the `app` tag
        // (only Budgets/Cost Explorer can — see the tag-scoped budget + weekly
        // cost report). Needs "Receive billing alerts" enabled once in Billing.
        {
          type: "metric",
          width: 24,
          height: 6,
          properties: {
            title: "Estimated charges (USD, account-wide — enable billing alerts)",
            region: "us-east-1",
            stat: "Maximum",
            period: 21600,
            metrics: [
              ["AWS/Billing", "EstimatedCharges", "Currency", "USD", { label: "Total" }],
              [
                {
                  expression:
                    "SEARCH('{AWS/Billing,Currency,ServiceName} MetricName=\"EstimatedCharges\"', 'Maximum', 21600)",
                  label: "By service",
                  id: "m_cost_svc",
                },
              ],
            ],
          },
        },
      ],
    }),
  });
}
