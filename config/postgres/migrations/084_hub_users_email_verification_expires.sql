-- Migration 084: hub_users.email_verification_expires
-- WaddleBot v3.0.x
-- Depends on: 083_discord_twitch_demo_convergence.sql
--
-- Reconciles a pre-existing schema gap documented in hub_api/PORTING.md
-- (module docstring gap 1, services/schema.py::bind_auth_tables): Node's
-- authController.js register()/verifyEmail()/resendVerification() -- and
-- the Python port's auth_service.py equivalents -- read/write
-- hub_users.email_verification_expires, but no numbered migration ever
-- added it; it only ever existed in the separately-drifted
-- config/postgres/init.sql bootstrap script. Any real environment
-- provisioned from the numbered migrations (not init.sql) 500s on
-- POST /api/v1/auth/login -- the pydal model binds the column
-- (services/schema.py::bind_auth_tables), pydal SELECTs hub_users.* for
-- every login, and Postgres rejects the unknown column, aborting the
-- pooled connection's transaction (psycopg2.errors.InFailedSqlTransaction)
-- for every subsequent query on that connection until the pool is
-- recycled.
--
-- `IF NOT EXISTS` makes this safe to run against an environment where the
-- column was already added out-of-band (e.g. a live hotfix ALTER TABLE).

BEGIN;

ALTER TABLE hub_users
  ADD COLUMN IF NOT EXISTS email_verification_expires TIMESTAMP;

COMMIT;
