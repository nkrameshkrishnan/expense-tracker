/* Two customer-facing billing emails, sent via SES. Same lazy-client shape
   as db.js/stripe.js - one module-scope client, env vars read at call
   time so tests can set them after import. */

import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

const ses = new SESClient({});

/* Must match the Stripe Dashboard's dunning retry window (Settings →
   Billing → Subscriptions and emails → Manage failed payments — see
   DEPLOYMENT.md's Phase 3, step 3). Stripe has no API or webhook that
   reports this setting back, so there is no way to read it at send time -
   this constant is the one place to update if that Dashboard setting ever
   changes, instead of a number buried in the email prose below. */
const RETRY_WINDOW_DAYS = 30;

async function send(toEmail, subject, bodyText) {
  await ses.send(
    new SendEmailCommand({
      Source: process.env.SES_FROM_ADDRESS,
      Destination: { ToAddresses: [toEmail] },
      Message: {
        Subject: { Data: subject },
        Body: { Text: { Data: bodyText } },
      },
    }),
  );
}

export async function sendPastDueEmail(toEmail) {
  await send(
    toEmail,
    "Your Ledger payment failed",
    "We couldn't process your latest payment. Please update your card in the Billing panel to keep full access. " +
      `We'll retry automatically for ${RETRY_WINDOW_DAYS} days; if the payment still hasn't gone through by then, your account will move to the Free plan.`,
  );
}

export async function sendDowngradedEmail(toEmail) {
  await send(
    toEmail,
    "Your Ledger account has moved to the Free plan",
    "After repeated failed payment attempts, your subscription was canceled and your account has moved to the Free plan. " +
      "Your existing data and members are unaffected. Resubscribe any time from the Billing panel.",
  );
}
