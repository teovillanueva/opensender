import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContactEntity } from "../src/adapters/dynamo-entities.js";
import { ContactsService } from "../src/contacts/contacts.js";
import type { DomainEvent } from "../src/events/emitter.js";
import { type LocalDynamo, startLocalDynamo } from "./helpers/ddb-local.js";

let dynamo: LocalDynamo;

beforeAll(async () => {
  dynamo = await startLocalDynamo();
}, 120_000);

afterAll(async () => {
  await dynamo.stop();
});

let clockSeq = 0;
function makeService() {
  const events: Array<{ teamId: string; event: DomainEvent }> = [];
  const service = new ContactsService({
    contacts: createContactEntity({ client: dynamo.client, table: dynamo.table }),
    emitter: {
      emit: async (teamId, event) => {
        events.push({ teamId, event });
        return true;
      },
    },
    clock: () => new Date(Date.UTC(2026, 7, 9, 10, 0, ++clockSeq)),
    idGenerator: () => randomUUID(),
  });
  return { service, events };
}

describe("contacts service (DynamoDB-Local)", () => {
  it("creates a contact and emits contact.created with audience_id", async () => {
    const { service, events } = makeService();
    const contact = await service.create({
      teamId: "team-c",
      segmentId: "seg-1",
      email: "Fixture-Contact@Example.com",
      firstName: "Fixture",
      lastName: "Contact",
      unsubscribed: false,
    });

    // Email is normalized to lowercase for the uniqueness GSI.
    expect(contact.email).toBe("fixture-contact@example.com");
    expect(events).toHaveLength(1);
    expect(events[0]?.event.type).toBe("contact.created");
    expect(events[0]?.event.data).toMatchObject({
      id: contact.contactId,
      audience_id: "seg-1",
      email: "fixture-contact@example.com",
      first_name: "Fixture",
      unsubscribed: false,
    });
  });

  it("resolves by contact id and by email within the segment", async () => {
    const { service } = makeService();
    const contact = await service.create({
      teamId: "team-c2",
      segmentId: "seg-2",
      email: "person@example.com",
    });

    const byId = await service.getByIdOrEmail("team-c2", "seg-2", contact.contactId);
    expect(byId?.contactId).toBe(contact.contactId);

    const byEmail = await service.getByIdOrEmail("team-c2", "seg-2", "Person@Example.com");
    expect(byEmail?.contactId).toBe(contact.contactId);

    // Wrong team is scoped out; wrong segment fails the id path.
    expect(await service.getByIdOrEmail("nope", "seg-2", contact.contactId)).toBeUndefined();
    expect(await service.getByIdOrEmail("team-c2", "seg-other", contact.contactId)).toBeUndefined();
    expect(await service.getByIdOrEmail("team-c2", "seg-2", "missing@example.com")).toBeUndefined();
  });

  it("updates fields and lists newest-first excluding nothing", async () => {
    const { service } = makeService();
    const a = await service.create({ teamId: "team-c3", segmentId: "seg-3", email: "a@x.co" });
    const b = await service.create({ teamId: "team-c3", segmentId: "seg-3", email: "b@x.co" });

    const updated = await service.update(a, { firstName: "Renamed" });
    expect(updated.firstName).toBe("Renamed");
    expect((await service.getByIdOrEmail("team-c3", "seg-3", a.contactId))?.firstName).toBe(
      "Renamed",
    );

    const listed = await service.list("seg-3");
    expect(listed.map((c) => c.contactId)).toEqual([b.contactId, a.contactId]);
  });

  it("toggles unsubscribed and filters listSendable", async () => {
    const { service, events } = makeService();
    const keep = await service.create({
      teamId: "team-c4",
      segmentId: "seg-4",
      email: "keep@x.co",
    });
    const gone = await service.create({
      teamId: "team-c4",
      segmentId: "seg-4",
      email: "gone@x.co",
    });

    const before = events.length;
    const off = await service.setUnsubscribed(gone, true);
    expect(off.unsubscribed).toBe(true);
    expect(events[events.length - 1]?.event.type).toBe("contact.updated");
    expect(events.length).toBe(before + 1);

    const sendable = await service.listSendable("seg-4");
    expect(sendable.map((c) => c.contactId)).toEqual([keep.contactId]);
  });

  it("deletes a contact and emits contact.deleted", async () => {
    const { service, events } = makeService();
    const contact = await service.create({
      teamId: "team-c5",
      segmentId: "seg-5",
      email: "d@x.co",
    });

    await service.delete(contact);
    expect(events[events.length - 1]?.event.type).toBe("contact.deleted");
    expect(await service.getByIdOrEmail("team-c5", "seg-5", contact.contactId)).toBeUndefined();
  });
});
