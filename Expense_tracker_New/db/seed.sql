-- Local/dev convenience only — creates one tenant and drops the Lambda's
-- RLS session vars manually so you can poke at the schema with psql before
-- any real auth flow exists. Never run this against a real deployment.

insert into tenants (id, name) values
  ('00000000-0000-0000-0000-000000000001', 'Dev Household')
returning id;

-- Simulate what db.js sets per-request:
-- set local app.tenant_id = '00000000-0000-0000-0000-000000000001';
-- set local app.user_id = 'dev-user-sub';

insert into tenant_users (user_sub, tenant_id, email, role) values
  ('dev-user-sub', '00000000-0000-0000-0000-000000000001', 'dev@example.com', 'owner');
