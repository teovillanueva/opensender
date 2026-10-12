import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  ResourceNotFoundException,
  type SchedulerClient,
  UpdateScheduleCommand,
} from "@aws-sdk/client-scheduler";
import type { SchedulerPort } from "../ports.js";

interface EventBridgeSchedulerConfig {
  groupName: string;
  targetArn: string;
  roleArn: string;
}

/** One-time schedules (SPEC §10); `at(...)` expressions take UTC, no zone. */
function atExpression(at: Date): string {
  return `at(${at.toISOString().slice(0, 19)})`;
}

export class EventBridgeScheduler implements SchedulerPort {
  constructor(
    private readonly client: SchedulerClient,
    private readonly config: EventBridgeSchedulerConfig,
  ) {}

  async createSchedule(name: string, at: Date, payload: Record<string, unknown>): Promise<string> {
    const result = await this.client.send(
      new CreateScheduleCommand({
        Name: name,
        GroupName: this.config.groupName,
        ScheduleExpression: atExpression(at),
        FlexibleTimeWindow: { Mode: "OFF" },
        ActionAfterCompletion: "DELETE",
        Target: {
          Arn: this.config.targetArn,
          RoleArn: this.config.roleArn,
          Input: JSON.stringify(payload),
          RetryPolicy: { MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 3600 },
        },
      }),
    );
    return result.ScheduleArn ?? "";
  }

  async updateSchedule(name: string, at: Date, payload: Record<string, unknown>): Promise<void> {
    await this.client.send(
      new UpdateScheduleCommand({
        Name: name,
        GroupName: this.config.groupName,
        ScheduleExpression: atExpression(at),
        FlexibleTimeWindow: { Mode: "OFF" },
        ActionAfterCompletion: "DELETE",
        Target: {
          Arn: this.config.targetArn,
          RoleArn: this.config.roleArn,
          Input: JSON.stringify(payload),
          RetryPolicy: { MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 3600 },
        },
      }),
    );
  }

  async deleteSchedule(name: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteScheduleCommand({ Name: name, GroupName: this.config.groupName }),
      );
    } catch (error) {
      if (error instanceof ResourceNotFoundException) return;
      throw error;
    }
  }
}
