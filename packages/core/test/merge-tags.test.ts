import { describe, expect, it } from "vitest";
import { renderMergeTags } from "../src/broadcasts/merge-tags.js";

const ctx = {
  contact: { email: "jane@example.com", firstName: "Jane", lastName: "Doe" },
  unsubscribeUrl: "https://send.example/u/abc",
};

describe("renderMergeTags (SPEC §11.1)", () => {
  it("resolves all four supported tag families", () => {
    expect(renderMergeTags("Hi {{{contact.first_name}}}", ctx)).toBe("Hi Jane");
    expect(renderMergeTags("{{{contact.last_name}}}", ctx)).toBe("Doe");
    expect(renderMergeTags("{{{contact.email}}}", ctx)).toBe("jane@example.com");
    expect(renderMergeTags("Unsub: {{{RESEND_UNSUBSCRIBE_URL}}}", ctx)).toBe(
      "Unsub: https://send.example/u/abc",
    );
  });

  it("uses the inline fallback when the value is empty or missing", () => {
    const bare = { contact: { email: "no-name@example.com" }, unsubscribeUrl: "u" };
    expect(renderMergeTags("Hi {{{contact.first_name|there}}}", bare)).toBe("Hi there");
    expect(renderMergeTags("{{{contact.last_name|friend}}}", bare)).toBe("friend");
    // Present values win over the fallback.
    expect(renderMergeTags("Hi {{{contact.first_name|there}}}", ctx)).toBe("Hi Jane");
  });

  it("treats an empty-string value as missing and falls back", () => {
    const empty = {
      contact: { email: "x@example.com", firstName: "", lastName: "Doe" },
      unsubscribeUrl: "u",
    };
    expect(renderMergeTags("{{{contact.first_name|there}}}", empty)).toBe("there");
  });

  it("renders unknown tags to their fallback or empty string", () => {
    expect(renderMergeTags("{{{contact.unknown|X}}}", ctx)).toBe("X");
    expect(renderMergeTags("[{{{contact.unknown}}}]", ctx)).toBe("[]");
    // Uppercase legacy syntax is unsupported — treated as unknown.
    expect(renderMergeTags("{{{FIRST_NAME|nope}}}", ctx)).toBe("nope");
  });

  it("replaces every occurrence and leaves surrounding text intact", () => {
    expect(renderMergeTags("{{{contact.first_name}}} <{{{contact.email}}}>", ctx)).toBe(
      "Jane <jane@example.com>",
    );
  });
});
