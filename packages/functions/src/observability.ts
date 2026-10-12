import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import type { Context, Handler } from "aws-lambda";
import { Resource } from "sst";

/**
 * Powertools observability for every Lambda (SPEC §15). One structured JSON
 * logger + one EMF metrics buffer, shared across warm invocations.
 *
 * Logging: `logLevel: "WARN"` suppresses INFO/DEBUG on ordinary invocations,
 * while `sampleRateValue: 0.1` lowers the level to DEBUG for ~10% of them — so
 * INFO surfaces at ~10% and WARN/ERROR always emit, matching SPEC §15
 * ("INFO sampled 10%, WARN/ERROR always"). `app`/`stage` are persistent keys;
 * `requestId`/`emailId`/`teamId` correlation comes from `addContext` plus the
 * per-log extra object each handler passes.
 *
 * Metrics: a single `opensender` EMF namespace. Handlers call `recordMetric`;
 * `withObservability` flushes the buffer once per invocation. `stage` is the
 * only default dimension — team/email ids are NEVER dimensions (cardinality
 * would multiply the metric count far past the SPEC §15 ~15-metric budget).
 */

const logger = new Logger({
  serviceName: "opensender",
  logLevel: "WARN",
  sampleRateValue: 0.1,
  persistentKeys: { app: Resource.App.name, stage: Resource.App.stage },
});

const metrics = new Metrics({
  namespace: "opensender",
  serviceName: "opensender",
  defaultDimensions: { stage: Resource.App.stage },
});

export { logger };

// Whether this invocation buffered any metric; guards the flush so invocations
// that emit none don't trip Powertools' "no metrics to publish" warning.
let hasPendingMetrics = false;

/** Buffer one Count metric (flushed by `withObservability`). */
export function recordMetric(name: string, value = 1): void {
  metrics.addMetric(name, MetricUnit.Count, value);
  hasPendingMetrics = true;
}

/**
 * Per-invocation lifecycle for handlers that don't use middy: bind the Lambda
 * context (adds `requestId`/`coldStart`), re-roll the sampling decision, and
 * flush buffered EMF metrics in a `finally`. `withSentry` wraps this from the
 * outside so unhandled errors are still captured.
 */
export function withObservability<E, R>(handler: Handler<E, R>): Handler<E, R> {
  return (async (event: E, context: Context, callback) => {
    logger.addContext(context);
    logger.refreshSampleRateCalculation();
    try {
      return await (handler(event, context, callback) as Promise<R>);
    } finally {
      if (hasPendingMetrics) {
        metrics.publishStoredMetrics();
        hasPendingMetrics = false;
      }
    }
  }) as Handler<E, R>;
}
