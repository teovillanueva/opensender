import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { QueuePublisher } from "../ports.js";

export class SqsQueuePublisher implements QueuePublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async enqueue(message: Record<string, unknown>, delaySeconds?: number): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message),
        ...(delaySeconds === undefined ? {} : { DelaySeconds: Math.min(delaySeconds, 900) }),
      }),
    );
  }
}
