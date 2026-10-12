import type { ContactEntity } from "../adapters/dynamo-entities.js";
import type { EventsService } from "../events/emitter.js";
import type { Clock, IdGenerator } from "../ports.js";

/**
 * Contacts belong to a segment (SPEC §11). Lookups resolve by contact id or,
 * when the path segment is an address, by the unique (segmentId, email) GSI —
 * the route passes whichever the caller supplied.
 */
export interface Contact {
  contactId: string;
  teamId: string;
  segmentId: string;
  email: string;
  firstName?: string | undefined;
  lastName?: string | undefined;
  unsubscribed: boolean;
  createdAt: string;
}

/** RFC 4122 canonical form — anything else is treated as an email address. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ContactsServiceDeps {
  contacts: ContactEntity;
  emitter: Pick<EventsService, "emit">;
  clock: Clock;
  idGenerator: IdGenerator;
}

/** ContactEventData (R02 §3.7): id, audience_id, and the contact fields. */
function contactEventData(contact: Contact): Record<string, unknown> {
  return {
    id: contact.contactId,
    audience_id: contact.segmentId,
    email: contact.email,
    first_name: contact.firstName ?? null,
    last_name: contact.lastName ?? null,
    unsubscribed: contact.unsubscribed,
    created_at: new Date(contact.createdAt).toISOString(),
  };
}

export class ContactsService {
  constructor(private readonly deps: ContactsServiceDeps) {}

  async create(input: {
    teamId: string;
    segmentId: string;
    email: string;
    firstName?: string | undefined;
    lastName?: string | undefined;
    unsubscribed?: boolean | undefined;
  }): Promise<Contact> {
    const contact: Contact = {
      contactId: this.deps.idGenerator(),
      teamId: input.teamId,
      segmentId: input.segmentId,
      email: input.email.toLowerCase(),
      ...(input.firstName === undefined ? {} : { firstName: input.firstName }),
      ...(input.lastName === undefined ? {} : { lastName: input.lastName }),
      unsubscribed: input.unsubscribed ?? false,
      createdAt: this.deps.clock().toISOString(),
    };
    await this.deps.contacts
      .create({
        contactId: contact.contactId,
        teamId: contact.teamId,
        segmentId: contact.segmentId,
        email: contact.email,
        ...(contact.firstName === undefined ? {} : { firstName: contact.firstName }),
        ...(contact.lastName === undefined ? {} : { lastName: contact.lastName }),
        unsubscribed: contact.unsubscribed,
        createdAt: contact.createdAt,
      })
      .go();
    await this.deps.emitter.emit(contact.teamId, {
      type: "contact.created",
      data: contactEventData(contact),
    });
    return contact;
  }

  /**
   * Resolve within a segment: a UUID hits the primary key (then verifies the
   * segment and team); anything else is an email looked up on the GSI.
   */
  async getByIdOrEmail(
    teamId: string,
    segmentId: string,
    idOrEmail: string,
  ): Promise<Contact | undefined> {
    if (UUID_PATTERN.test(idOrEmail)) {
      const result = await this.deps.contacts.get({ contactId: idOrEmail }).go();
      const contact = result.data ?? undefined;
      return contact && contact.teamId === teamId && contact.segmentId === segmentId
        ? (contact as Contact)
        : undefined;
    }
    const result = await this.deps.contacts.query
      .bySegmentEmail({ segmentId, email: idOrEmail.toLowerCase() })
      .go();
    const contact = result.data[0] ?? undefined;
    return contact && contact.teamId === teamId ? (contact as Contact) : undefined;
  }

  async list(segmentId: string): Promise<Contact[]> {
    const result = await this.deps.contacts.query.bySegment({ segmentId }).go({ pages: "all" });
    return (result.data as Contact[]).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Fan-out candidates: suppression is applied later in the consumer (§11). */
  async listSendable(segmentId: string): Promise<Contact[]> {
    const all = await this.list(segmentId);
    return all.filter((contact) => contact.unsubscribed !== true);
  }

  async update(
    contact: Contact,
    patch: {
      firstName?: string | undefined;
      lastName?: string | undefined;
      unsubscribed?: boolean | undefined;
    },
  ): Promise<Contact> {
    const updated: Contact = {
      ...contact,
      ...(patch.firstName === undefined ? {} : { firstName: patch.firstName }),
      ...(patch.lastName === undefined ? {} : { lastName: patch.lastName }),
      ...(patch.unsubscribed === undefined ? {} : { unsubscribed: patch.unsubscribed }),
    };
    await this.deps.contacts
      .patch({ contactId: contact.contactId })
      .set({
        ...(patch.firstName === undefined ? {} : { firstName: patch.firstName }),
        ...(patch.lastName === undefined ? {} : { lastName: patch.lastName }),
        ...(patch.unsubscribed === undefined ? {} : { unsubscribed: patch.unsubscribed }),
      })
      .go();
    await this.deps.emitter.emit(updated.teamId, {
      type: "contact.updated",
      data: contactEventData(updated),
    });
    return updated;
  }

  /** Public unsubscribe flow entry point (SPEC §11.2). */
  async setUnsubscribed(contact: Contact, unsubscribed: boolean): Promise<Contact> {
    await this.deps.contacts.patch({ contactId: contact.contactId }).set({ unsubscribed }).go();
    const updated: Contact = { ...contact, unsubscribed };
    await this.deps.emitter.emit(updated.teamId, {
      type: "contact.updated",
      data: contactEventData(updated),
    });
    return updated;
  }

  async delete(contact: Contact): Promise<void> {
    await this.deps.contacts.delete({ contactId: contact.contactId }).go();
    await this.deps.emitter.emit(contact.teamId, {
      type: "contact.deleted",
      data: contactEventData(contact),
    });
  }
}
