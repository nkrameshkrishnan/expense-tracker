-- Mounted as 01-nosuperuser.sql: docker-entrypoint-initdb.d/ runs its
-- scripts in filename sort order, and the leading "01-" is just reserving
-- a low sort position in case a later init script ever needs to run
-- before or after this one - there's only one script today, so it has no
-- effect yet.
--
-- Runs once at container bootstrap via docker-entrypoint-initdb.d/ (official
-- postgres images execute every *.sql/*.sh file found there, connected as
-- the bootstrap superuser, before any application code touches the
-- database). The official image makes POSTGRES_USER a true Postgres
-- superuser by default, which unconditionally bypasses RLS - including
-- FORCE ROW LEVEL SECURITY, which explicitly does not constrain
-- superusers. Stripping that here makes ledger_test an accurate stand-in
-- for production's RDS master user: it stays the table owner (it still
-- runs schema.sql's CREATE TABLE statements via freshDb()), but it stops
-- being exempt from its own FORCE ROW LEVEL SECURITY.
--
-- pgcrypto needs to be installed here, while ledger_test is still
-- superuser, and parked in a schema that survives freshDb()'s
-- `drop schema public cascade; create schema public;`. If it were left in
-- the (default) public schema, every freshDb() call would drop it along
-- with the rest of public, and schema.sql's `create extension if not
-- exists pgcrypto;` would then try to genuinely (re)install it as the
-- now-unprivileged ledger_test, which fails with "permission denied for
-- language c" - CREATE EXTENSION requires superuser (or a "trusted"
-- extension, and pgcrypto isn't marked trusted). Installing it once here
-- into a dedicated `extensions` schema means later `create extension if
-- not exists pgcrypto` calls see it already present in pg_extension and
-- no-op, regardless of which schema it lives in.
create schema if not exists extensions;
create extension if not exists pgcrypto schema extensions;

-- Make gen_random_bytes() (used by tenant_invites' token default) resolve
-- via the unqualified name schema.sql uses, without living in public.
alter database ledger_test set search_path = "$user", public, extensions;

-- This must run LAST: once applied, ledger_test loses the superuser
-- privileges the statements above depend on.
alter role ledger_test nosuperuser nobypassrls;
