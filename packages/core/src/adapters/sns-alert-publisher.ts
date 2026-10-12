import { PublishCommand, type SNSClient } from "@aws-sdk/client-sns";
import type { AlertPublisher } from "../ports.js";

/**
 * `AlertPublisher` backed by the ops SNS topic (SPEC §15). The topic fans out
 * to the operator's confirmed email subscription, so guardrail alerts share the
 * same channel as CloudWatch alarms.
 */
export class SnsAlertPublisher implements AlertPublisher {
  constructor(
    private readonly client: SNSClient,
    private readonly topicArn: string,
  ) {}

  async publish(subject: string, message: string): Promise<void> {
    await this.client.send(
      new PublishCommand({
        TopicArn: this.topicArn,
        // SNS caps the Subject at 100 chars and forbids newlines/control chars.
        Subject: subject.replace(/[\r\n]+/g, " ").slice(0, 100),
        Message: message,
      }),
    );
  }
}
