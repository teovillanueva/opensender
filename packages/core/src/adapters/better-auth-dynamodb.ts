import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { createAdapterFactory } from "better-auth/adapters";

/**
 * Better-auth adapter over the opensender single table. Community DynamoDB
 * adapters exist but are weeks old; this one is ~250 lines against the
 * documented createAdapterFactory contract and tested against DynamoDB Local
 * with real better-auth flows.
 *
 * Layout: pk `ba#<model>#<id>`, sk `ba`; gsi1 partitions each model
 * (`ba#<model>`) for scans; gsi2/gsi3 serve the field lookups better-auth
 * actually issues (see LOOKUP_FIELDS). Everything else — extra where clauses,
 * non-eq operators, sorting, offset — evaluates in memory, which is fine at
 * dashboard-auth scale (a team has a handful of members, a user a handful of
 * sessions).
 */

interface AdapterDeps {
  client: DynamoDBDocumentClient;
  table: string;
}

/** Which model fields get a dedicated GSI lookup (gsi2 first, gsi3 second). */
const LOOKUP_FIELDS: Record<string, [string?, string?]> = {
  user: ["email"],
  session: ["token", "userId"],
  account: ["userId", "accountId"],
  verification: ["identifier"],
  organization: ["slug"],
  member: ["organizationId", "userId"],
  invitation: ["organizationId", "email"],
  // OAuth provider models; fields taken from the queries the plugin actually
  // issues (traced with BA_ADAPTER_TRACE through the full authorization-code
  // flow). `jwks` is deliberately absent: the jwt plugin loads the whole
  // (~1-row) model, which is exactly the gsi1 fallback.
  oauthClient: ["clientId"],
  oauthConsent: ["clientId", "userId"],
  oauthRefreshToken: ["token"],
  oauthAccessToken: ["token", "refreshId"],
  // Our own model (createOAuthGrants): per-grant sending-domain restriction,
  // read by the token verifier on OAuth-authenticated requests.
  oauthGrantDomains: ["clientId", "userId"],
};

type Row = Record<string, unknown>;

interface Where {
  field: string;
  value: unknown;
  operator: string;
  connector: "AND" | "OR";
}

function normalize(value: unknown): unknown {
  // SQL-bred plugins filter unset columns with `value: null` (e.g. the OAuth
  // refresh-token rotation's `revoked = null` guard); in DynamoDB an unset
  // attribute is simply absent, so missing and null must compare equal.
  if (value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function compare(a: unknown, b: unknown): number {
  const left = normalize(a);
  const right = normalize(b);
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right));
}

function matchesClause(row: Row, clause: Where): boolean {
  const actual = normalize(row[clause.field]);
  const expected = normalize(clause.value);
  switch (clause.operator) {
    case "eq":
      return actual === expected;
    case "ne":
      return actual !== expected;
    case "lt":
      return compare(actual, expected) < 0;
    case "lte":
      return compare(actual, expected) <= 0;
    case "gt":
      return compare(actual, expected) > 0;
    case "gte":
      return compare(actual, expected) >= 0;
    case "in":
      return Array.isArray(expected) && expected.map(normalize).includes(actual);
    case "not_in":
      return Array.isArray(expected) && !expected.map(normalize).includes(actual);
    case "contains":
      return typeof actual === "string" && actual.includes(String(expected));
    case "starts_with":
      return typeof actual === "string" && actual.startsWith(String(expected));
    case "ends_with":
      return typeof actual === "string" && actual.endsWith(String(expected));
    default:
      throw new Error(`unsupported where operator "${clause.operator}"`);
  }
}

function matchesWhere(row: Row, where: Where[]): boolean {
  const ands = where.filter((clause) => clause.connector !== "OR");
  const ors = where.filter((clause) => clause.connector === "OR");
  if (!ands.every((clause) => matchesClause(row, clause))) return false;
  return ors.length === 0 || ors.some((clause) => matchesClause(row, clause));
}

export function dynamodbAdapter({ client, table }: AdapterDeps) {
  const primaryKey = (model: string, id: string) => ({
    pk: `ba#${model}#${id}`,
    sk: "ba",
  });

  function indexAttributes(model: string, data: Row): Row {
    const id = String(data.id);
    const [gsi2Field, gsi3Field] = LOOKUP_FIELDS[model] ?? [];
    const attributes: Row = {
      ...primaryKey(model, id),
      gsi1pk: `ba#${model}`,
      gsi1sk: id,
    };
    if (gsi2Field && data[gsi2Field] != null) {
      attributes.gsi2pk = `ba#${model}#${gsi2Field}#${String(normalize(data[gsi2Field]))}`;
      attributes.gsi2sk = id;
    }
    if (gsi3Field && data[gsi3Field] != null) {
      attributes.gsi3pk = `ba#${model}#${gsi3Field}#${String(normalize(data[gsi3Field]))}`;
      attributes.gsi3sk = id;
    }
    return attributes;
  }

  function stripKeys(item: Row): Row {
    const { pk, sk, gsi1pk, gsi1sk, gsi2pk, gsi2sk, gsi3pk, gsi3sk, ...data } = item;
    return data;
  }

  async function queryIndex(index: "gsi1" | "gsi2" | "gsi3", pkValue: string): Promise<Row[]> {
    const items: Row[] = [];
    let cursor: Row | undefined;
    do {
      const result = await client.send(
        new QueryCommand({
          TableName: table,
          IndexName: index,
          KeyConditionExpression: "#pk = :pk",
          ExpressionAttributeNames: { "#pk": `${index}pk` },
          ExpressionAttributeValues: { ":pk": pkValue },
          ExclusiveStartKey: cursor,
        }),
      );
      items.push(...(result.Items ?? []));
      cursor = result.LastEvaluatedKey;
    } while (cursor);
    return items;
  }

  /** Fetch candidates using the best available index, then filter in memory. */
  async function findRows(model: string, where: Where[]): Promise<Row[]> {
    const eqAnds = where.filter((clause) => clause.operator === "eq" && clause.connector !== "OR");

    const idClause = eqAnds.find((clause) => clause.field === "id");
    if (idClause) {
      const result = await client.send(
        new GetCommand({ TableName: table, Key: primaryKey(model, String(idClause.value)) }),
      );
      const row = result.Item ? stripKeys(result.Item) : undefined;
      return row && matchesWhere(row, where) ? [row] : [];
    }

    const [gsi2Field, gsi3Field] = LOOKUP_FIELDS[model] ?? [];
    let candidates: Row[];
    const gsi2Clause = gsi2Field && eqAnds.find((clause) => clause.field === gsi2Field);
    const gsi3Clause = gsi3Field && eqAnds.find((clause) => clause.field === gsi3Field);
    if (gsi2Clause) {
      candidates = await queryIndex(
        "gsi2",
        `ba#${model}#${gsi2Field}#${String(normalize(gsi2Clause.value))}`,
      );
    } else if (gsi3Clause) {
      candidates = await queryIndex(
        "gsi3",
        `ba#${model}#${gsi3Field}#${String(normalize(gsi3Clause.value))}`,
      );
    } else {
      candidates = await queryIndex("gsi1", `ba#${model}`);
    }
    return candidates.map(stripKeys).filter((row) => matchesWhere(row, where));
  }

  async function putRow(model: string, data: Row): Promise<void> {
    await client.send(
      new PutCommand({ TableName: table, Item: { ...data, ...indexAttributes(model, data) } }),
    );
  }

  async function deleteRow(model: string, id: string): Promise<void> {
    await client.send(new DeleteCommand({ TableName: table, Key: primaryKey(model, id) }));
  }

  return createAdapterFactory({
    config: {
      adapterId: "opensender-dynamodb",
      adapterName: "opensender single-table DynamoDB",
      supportsNumericIds: false,
      supportsJSON: false,
      supportsDates: false,
      supportsBooleans: true,
      supportsArrays: false,
      transaction: false,
    },
    adapter: () => ({
      async create({ model, data }) {
        await putRow(model, data as Row);
        // biome-ignore lint/suspicious/noExplicitAny: CustomAdapter's generic contract
        return data as any;
      },
      async findOne({ model, where }) {
        const rows = await findRows(model, where as Where[]);
        // biome-ignore lint/suspicious/noExplicitAny: CustomAdapter's generic contract
        return (rows[0] ?? null) as any;
      },
      async findMany({ model, where, limit, sortBy, offset }) {
        let rows = await findRows(model, (where ?? []) as Where[]);
        if (sortBy) {
          rows.sort(
            (a, b) =>
              compare(a[sortBy.field], b[sortBy.field]) * (sortBy.direction === "desc" ? -1 : 1),
          );
        }
        if (offset) rows = rows.slice(offset);
        if (limit !== undefined) rows = rows.slice(0, limit);
        // biome-ignore lint/suspicious/noExplicitAny: CustomAdapter's generic contract
        return rows as any;
      },
      async count({ model, where }) {
        const rows = await findRows(model, (where ?? []) as Where[]);
        return rows.length;
      },
      async update({ model, where, update }) {
        const rows = await findRows(model, where as Where[]);
        const row = rows[0];
        if (!row) return null;
        const updated = { ...row, ...(update as Row) };
        await putRow(model, updated);
        // biome-ignore lint/suspicious/noExplicitAny: CustomAdapter's generic contract
        return updated as any;
      },
      async updateMany({ model, where, update }) {
        const rows = await findRows(model, where as Where[]);
        for (const row of rows) {
          await putRow(model, { ...row, ...update });
        }
        return rows.length;
      },
      async delete({ model, where }) {
        const rows = await findRows(model, where as Where[]);
        const row = rows[0];
        if (row) await deleteRow(model, String(row.id));
      },
      async deleteMany({ model, where }) {
        const rows = await findRows(model, where as Where[]);
        for (const row of rows) {
          await deleteRow(model, String(row.id));
        }
        return rows.length;
      },
    }),
  });
}
