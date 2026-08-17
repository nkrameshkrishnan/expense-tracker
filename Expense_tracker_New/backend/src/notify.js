/* Two customer-facing billing emails, sent via SES. Same lazy-client shape
   as db.js/stripe.js - one module-scope client, env vars read at call
   time so tests can set them after import. */

import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

const ses = new SESClient({});

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
      "We'll retry automatically for 30 days; if the payment still hasn't gone through by then, your account will move to the Free plan.",
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
