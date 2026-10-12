/**
 * Broadcast merge tags — current upstream syntax only (SPEC §11.1, R01 §5):
 * triple-brace, lowercase, `contact.`-prefixed, with an inline `|fallback`.
 * The uppercase `{{{FIRST_NAME}}}` forms are gone from upstream and unsupported.
 *
 *   {{{contact.first_name|fallback}}}
 *   {{{contact.last_name|fallback}}}
 *   {{{contact.email}}}
 *   {{{RESEND_UNSUBSCRIBE_URL}}}
 *
 * The fallback (text after the first `|`) is used whenever the resolved value
 * is empty or missing; unknown tags resolve to their fallback or empty string.
 */

export interface MergeContext {
  contact: {
    email: string;
    firstName?: string | undefined;
    lastName?: string | undefined;
  };
  unsubscribeUrl: string;
}

const TAG_PATTERN = /\{\{\{([^{}]+?)\}\}\}/g;

export function renderMergeTags(template: string, ctx: MergeContext): string {
  return template.replace(TAG_PATTERN, (_match, inner: string) => {
    const separator = inner.indexOf("|");
    const key = (separator === -1 ? inner : inner.slice(0, separator)).trim();
    const fallback = separator === -1 ? "" : inner.slice(separator + 1);

    const resolved = resolve(key, ctx);
    return resolved !== undefined && resolved !== "" ? resolved : fallback;
  });
}

function resolve(key: string, ctx: MergeContext): string | undefined {
  switch (key) {
    case "contact.email":
      return ctx.contact.email;
    case "contact.first_name":
      return ctx.contact.firstName;
    case "contact.last_name":
      return ctx.contact.lastName;
    case "RESEND_UNSUBSCRIBE_URL":
      return ctx.unsubscribeUrl;
    default:
      return undefined;
  }
}
