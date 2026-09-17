import { Resend } from "resend";

const FROM = process.env.RESEND_FROM_EMAIL || "ClearPath Mapper <login@clearpathmap.taxsherpa.com>";

let client: Resend | null = null;

function resend(): Resend {
  if (!process.env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY must be set to deliver magic-link email.");
  }
  if (!client) {
    client = new Resend(process.env.RESEND_API_KEY);
  }
  return client;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Sends the magic-link email.
 *
 * `verifyUrl` deliberately points at the app's own 2-step transition page, NOT at an
 * endpoint that consumes the token. Corporate email scanners pre-fetch links in inbound
 * mail; if the link itself logged the user in, the scanner would burn the single-use
 * token before the human ever clicked. The transition page requires a real click.
 */
export async function sendMagicLinkEmail(opts: {
  to: string;
  verifyUrl: string;
  expiresInMinutes: number;
}): Promise<void> {
  const url = opts.verifyUrl;
  const safeUrl = escapeHtml(url);

  const html = `
<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9;padding:32px 12px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;padding:32px;">
          <tr><td>
            <h1 style="margin:0 0 8px;font-size:20px;color:#111827;">Sign in to ClearPath Mapper</h1>
            <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#4b5563;">
              Click the button below to open your ClearPath Mapper account. This link works once
              and expires in ${opts.expiresInMinutes} minutes.
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:8px;background:#1d4ed8;">
              <a href="${safeUrl}" style="display:inline-block;padding:13px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">Continue to sign-in</a>
            </td></tr></table>
            <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#6b7280;">
              If the button doesn't work, paste this into your browser:<br />
              <span style="color:#1d4ed8;word-break:break-all;">${safeUrl}</span>
            </p>
            <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#6b7280;">
              If you didn't request this, you can ignore this email — no account changes were made.
            </p>
            <p style="margin:24px 0 0;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.6;color:#9ca3af;">
              This mailbox isn't monitored — replies to this address won't reach anyone.
              For help, get in touch through the website rather than replying here.
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`.trim();

  const text = [
    "Sign in to ClearPath Mapper",
    "",
    `Open this link to sign in (works once, expires in ${opts.expiresInMinutes} minutes):`,
    url,
    "",
    "If you didn't request this, you can ignore this email.",
    "",
    "This mailbox isn't monitored — replies to this address won't reach anyone.",
    "For help, get in touch through the website rather than replying here.",
  ].join("\n");

  await deliver({ kind: "magic-link", to: opts.to, subject: "Your ClearPath Mapper sign-in link", html, text });
}

/**
 * Sent instead of a sign-in link when the access gate is on and the address has no active
 * access. The HTTP response to the requester is identical either way (see server/auth.ts),
 * so whether an address has access is only ever disclosed to that address's own inbox.
 */
export async function sendNoAccessEmail(opts: {
  to: string;
  endedAt: Date | null;
  startsAt: Date | null;
  purchaseUrl: string | null;
}): Promise<void> {
  const formatDate = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

  const reason = opts.startsAt
    ? `Your ClearPath Mapper access starts on ${formatDate(opts.startsAt)}. Request a sign-in link again on or after that date.`
    : opts.endedAt
      ? `Your ClearPath Mapper access ended on ${formatDate(opts.endedAt)}. Your uploads and reports are still saved, and they'll be there if you renew.`
      : "There's no active ClearPath Mapper access for this email address. Access is included with a Tax Sherpa workshop ticket.";

  const cta = !opts.startsAt && opts.purchaseUrl
    ? { label: opts.endedAt ? "Renew access" : "Get access", url: opts.purchaseUrl }
    : null;
  const safeReason = escapeHtml(reason);
  const safeCtaUrl = cta ? escapeHtml(cta.url) : "";

  const html = `
<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9;padding:32px 12px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;padding:32px;">
          <tr><td>
            <h1 style="margin:0 0 8px;font-size:20px;color:#111827;">About your ClearPath Mapper sign-in</h1>
            <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#4b5563;">${safeReason}</p>
            ${cta ? `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:8px;background:#1d4ed8;">
              <a href="${safeCtaUrl}" style="display:inline-block;padding:13px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">${cta.label}</a>
            </td></tr></table>` : ""}
            <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#6b7280;">
              If you didn't request a sign-in link, you can ignore this email.
            </p>
            <p style="margin:24px 0 0;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.6;color:#9ca3af;">
              This mailbox isn't monitored — replies to this address won't reach anyone.
              For help, get in touch through the website rather than replying here.
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`.trim();

  const text = [
    "About your ClearPath Mapper sign-in",
    "",
    reason,
    ...(cta ? ["", `${cta.label}: ${cta.url}`] : []),
    "",
    "If you didn't request a sign-in link, you can ignore this email.",
  ].join("\n");

  await deliver({ kind: "no-access", to: opts.to, subject: "About your ClearPath Mapper sign-in", html, text });
}

type OutgoingEmail = { kind: "magic-link" | "no-access"; to: string; subject: string; html: string; text: string };

/**
 * Local verification only: with EMAIL_TRANSPORT=memory, emails are recorded here instead of
 * being sent, so scripts/verify-access-gating.ts can assert which email a request produced
 * without a Resend key. Refused in production so a misconfigured deploy cannot silently stop
 * delivering sign-in links.
 */
export const memoryOutbox: OutgoingEmail[] = [];

async function deliver(email: OutgoingEmail): Promise<void> {
  if (process.env.EMAIL_TRANSPORT === "memory") {
    if (process.env.NODE_ENV === "production") {
      throw new Error("EMAIL_TRANSPORT=memory is not allowed in production.");
    }
    memoryOutbox.push(email);
    return;
  }

  const { error } = await resend().emails.send({
    from: FROM,
    to: email.to,
    subject: email.subject,
    html: email.html,
    text: email.text,
  });

  if (error) {
    throw new Error(`Resend failed to send ${email.kind} email: ${error.message}`);
  }
}
