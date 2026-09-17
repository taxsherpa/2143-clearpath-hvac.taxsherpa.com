import { Link } from "wouter";
import { LegalPage, Section } from "@/components/LegalPage";

export default function Privacy() {
  return (
    <LegalPage title="Privacy Policy" updated="September 7, 2026">
      <Section title="The short version">
        <p>
          ClearPath Mapper stores the financial data you upload — your Profit &amp; Loss
          statements, how you map their line items to the ClearPath categories, and the reports
          generated from them — for as long as your account exists, unless you delete it
          yourself. We do not sell your data. Tax Sherpa and its affiliates may use your email to
          reach out about education, invitations, reminders, news, and marketing, in addition to
          the account and product emails needed to run the service.
        </p>
      </Section>

      <Section title="What we collect">
        <ul className="list-disc pl-5 space-y-1">
          <li>
            <strong>Your email address</strong>, used to sign you in (via a one-time magic link)
            and to reach you as described below.
          </li>
          <li>
            <strong>The P&amp;L statements you upload</strong> (CSV or PDF), the line items
            extracted from them, how you or the tool map each line to a ClearPath category, any
            "remembered mappings" rules created from those choices, and the reports and
            comparisons generated from that data.
          </li>
          <li>
            <strong>Basic account activity</strong> — sign-in timestamps and which pages you use
            — kept only as needed to operate and troubleshoot the service.
          </li>
        </ul>
        <p>We do not run third-party advertising trackers or analytics pixels inside the app itself.</p>
      </Section>

      <Section title="How long we keep it">
        <p>
          Your uploads, mappings, and reports are <strong>retained indefinitely by default</strong>
          — there is no automatic deletion. You can permanently delete your financial data
          yourself at any time from{" "}
          <Link href="/settings" className="text-blue-600 hover:underline dark:text-blue-400">
            Account settings
          </Link>
          : this removes your uploads, their line items and mappings, and the reports built from
          them. It does <strong>not</strong> delete your account, your email address, or your
          sign-in history, and it does not change your contact/marketing preferences — those are
          separate choices. If you want your account itself closed, contact us at{" "}
          <a href="mailto:office@taxsherpa.com" className="text-blue-600 hover:underline dark:text-blue-400">
            office@taxsherpa.com
          </a>
          .
        </p>
      </Section>

      <Section title="How we use your email">
        <p>
          Beyond the transactional emails needed to run the service (sign-in links, purge
          confirmations), <strong>Tax Sherpa and its affiliates may contact you at the email you
          sign in with for education, invitations, reminders, news, and marketing.</strong> This
          is a broader, separate permission from anything specific you do inside the app — it
          does not depend on whether you've uploaded a P&amp;L, finished a report, or taken any
          other in-app action. If you'd rather not receive these, contact us at{" "}
          <a href="mailto:office@taxsherpa.com" className="text-blue-600 hover:underline dark:text-blue-400">
            office@taxsherpa.com
          </a>{" "}
          and we will honor that request; this does not affect your ability to keep using the
          diagnostic tool itself.
        </p>
      </Section>

      <Section title="Who can see your data">
        <p>
          Your uploads and mappings are private to your account. ClearPath Mapper is multi-tenant
          software: other accounts cannot see your data, and you cannot see theirs. Staff access
          is limited to what's needed to operate, secure, and support the service.
        </p>
      </Section>

      <Section title="Service providers">
        <p>
          We use a small number of vendors to run the service on our behalf, under obligations to
          protect your data and use it only to provide that service to us:
        </p>
        <ul className="list-disc pl-5 space-y-1">
          <li><strong>Railway</strong> — application hosting and the Postgres database your data is stored in.</li>
          <li><strong>Resend</strong> — delivery of sign-in (magic link) emails.</li>
          <li>An AI provider for PDF statement parsing, used only to extract line items from the PDF you upload for that single processing step.</li>
        </ul>
        <p>We do not sell your data to anyone, for any purpose.</p>
      </Section>

      <Section title="Children's privacy">
        <p>
          ClearPath Mapper is a business tool for adults managing a company's finances. It is not
          directed at children, and we do not knowingly collect information from children.
        </p>
      </Section>

      <Section title="Changes to this policy">
        <p>
          We may update this Privacy Policy — for example, if we add a new vendor or change what
          we collect. The "Last updated" date above reflects the most recent revision.
        </p>
      </Section>

      <Section title="Who we are">
        <p>
          ClearPath Mapper is operated by <strong>Online Tax Solutions Group LLC</strong>, doing
          business as Tax Sherpa, 2302 Parklake Dr NE, Ste 675, Atlanta, GA 30345.
        </p>
      </Section>

      <Section title="Contact us">
        <p>
          Questions about this Privacy Policy, or requests about your data or contact
          preferences, can be directed to{" "}
          <a href="mailto:office@taxsherpa.com" className="text-blue-600 hover:underline dark:text-blue-400">
            office@taxsherpa.com
          </a>{" "}
          or by mail at the address above.
        </p>
      </Section>
    </LegalPage>
  );
}
