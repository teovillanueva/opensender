import { CreateTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GenericContainer, type StartedTestContainer } from "testcontainers";

/**
 * DynamoDB Local via testcontainers (SPEC §17 — no LocalStack). The table
 * mirrors sst.config.ts exactly: pk/sk + gsi1-3, so key bugs surface here,
 * not in production.
 */

export interface LocalDynamo {
  client: DynamoDBDocumentClient;
  table: string;
  stop: () => Promise<void>;
}

function keySchema(pk: string, sk: string) {
  return [
    { AttributeName: pk, KeyType: "HASH" as const },
    { AttributeName: sk, KeyType: "RANGE" as const },
  ];
}

export async function startLocalDynamo(): Promise<LocalDynamo> {
  const container: StartedTestContainer = await new GenericContainer("amazon/dynamodb-local:latest")
    .withExposedPorts(8000)
    .start();

  const raw = new DynamoDBClient({
    endpoint: `http://${container.getHost()}:${container.getMappedPort(8000)}`,
    region: "local",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });
  const table = "opensender-test";
  await raw.send(
    new CreateTableCommand({
      TableName: table,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        "pk",
        "sk",
        "gsi1pk",
        "gsi1sk",
        "gsi2pk",
        "gsi2sk",
        "gsi3pk",
        "gsi3sk",
      ].map((name) => ({ AttributeName: name, AttributeType: "S" })),
      KeySchema: keySchema("pk", "sk"),
      GlobalSecondaryIndexes: (["gsi1", "gsi2", "gsi3"] as const).map((index) => ({
        IndexName: index,
        KeySchema: keySchema(`${index}pk`, `${index}sk`),
        Projection: { ProjectionType: "ALL" },
      })),
    }),
  );

  return {
    client: DynamoDBDocumentClient.from(raw, {
      marshallOptions: { removeUndefinedValues: true },
    }),
    table,
    stop: async () => {
      raw.destroy();
      await container.stop();
    },
  };
}
