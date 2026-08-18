/* Cognito PostConfirmation Lambda trigger — fires once, right after a new
   user verifies their email. Mirrors what Code.gs's sheet-provisioning
   never had to do (a household only ever needed ONE sheet, created by
   hand); a SaaS signup needs a tenant to exist before the user's first API
   call, and no HTTP request is the right place to create one implicitly.

   Two paths:
   - Signup carried a valid, unused invite token (passed through as a
     clientMetadata field from the frontend's sign-up call) -> join that
     tenant with the invite's role.
   - No invite, or it's invalid/expired/used -> create a brand new tenant
     and make this user its owner.

   Either way, the resulting tenant id is written back onto the user as the
   `custom:tenant_id` Cognito attribute, which auth.js reads out of the ID
   token on every later request. */

import { runProvisioningTransaction } from "./db.js";
import { SEAT_CAPS } from "./plans.js";
import {
  CognitoIdentityProviderClient,
  AdminUpdateUserAttributesCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const cognito = new CognitoIdentityProviderClient({});

export const handler = async (event) => {
  const { sub, email } = event.request.userAttributes;
  const inviteToken = event.request.clientMetadata?.inviteToken || null;

  const tenantId = await resolveTenant({ sub, email, inviteToken });

  await cognito.send(
    new AdminUpdateUserAttributesCommand({
      UserPoolId: event.userPoolId,
      Username: event.userName,
      UserAttributes: [{ Name: "custom:tenant_id", Value: tenantId }],
    }),
  );

  return event; // Cognito triggers must return the event unchanged
};

async function resolveTenant({ sub, email, inviteToken }) {
  // Runs with NO app.tenant_id set at all - there is no tenant yet. Relies
  // entirely on the narrow provisioning-* policies in db/schema.sql; see
  // db.js's runProvisioningTransaction for why this is the one legitimate
  // caller of that carve-out.
  return runProvisioningTransaction(sub, async (execute) => {
    if (inviteToken) {
      const invites = await execute.rows(
        `select tenant_id, role from tenant_invites
         where token = :token and used_at is null and expires_at > now()`,
        { token: inviteToken },
      );
      if (invites[0]) {
        const { tenant_id, role } = invites[0];
        const [{ plan }] = await execute.rows(
          `select plan from tenants where id = cast(:tenantId as uuid)`,
          { tenantId: tenant_id },
        );
        // cast(... as int) rather than `::int`: same reason as
        // routes/tenants.js's createInvite - the second colon of `::` is
        // indistinguishable from a `:name` bind param to the RDS Data
        // API's named-parameter parser.
        const [{ count: memberCount }] = await execute.rows(
          `select cast(count(*) as int) as count from tenant_users where tenant_id = cast(:tenantId as uuid)`,
          { tenantId: tenant_id },
        );
        // Hard, authoritative check: state can have changed (plan
        // downgraded, another invite redeemed) since this invite was
        // created - createInvite's check above is only a soft, best-effort
        // warning at send time. Falling through to "create a new tenant"
        // here would silently strand the invitee in the wrong household,
        // so this rejects outright instead - same reasoning as an
        // expired/invalid token, but the failure mode is different enough
        // (the invite IS valid, the household just doesn't have room) that
        // it deserves its own message when this ever gets surfaced to a
        // user-facing flow.
        if (memberCount >= SEAT_CAPS[plan]) {
          throw new Error(`Household is at its ${SEAT_CAPS[plan]}-seat limit for its current plan.`);
        }
        await execute(
          `insert into tenant_users (user_sub, tenant_id, email, role)
           values (:sub, :tenantId, :email, :role)`,
          { sub, tenantId: tenant_id, email, role },
        );
        await execute(
          `update tenant_invites set used_at = now() where token = :token`,
          { token: inviteToken },
        );
        return tenant_id;
      }
      // Falls through to "create a new tenant" on an invalid/expired
      // token rather than blocking signup — an expired invite shouldn't
      // strand a real person mid-signup; they just don't land where they
      // expected and can be re-invited afterward.
    }

    const created = await execute.rows(
      `insert into tenants (name) values (:name) returning id`,
      { name: `${email}'s household` },
    );
    const tenantId = created[0].id;
    await execute(
      `insert into tenant_users (user_sub, tenant_id, email, role)
       values (:sub, :tenantId, :email, 'owner')`,
      { sub, tenantId, email },
    );
    return tenantId;
  });
}
