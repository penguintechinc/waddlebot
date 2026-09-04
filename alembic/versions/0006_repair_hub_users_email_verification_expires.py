"""Repair hub_users.email_verification_expires on already-migrated databases.

`config/postgres/migrations/084_hub_users_email_verification_expires.sql`
adds the column for FRESH databases (picked up by 0001_baseline's glob of
`*.sql` on an empty `schema_migrations`), but a database that already ran
baseline (e.g. the live beta/demo DB, head at 0005_repair_scoped_users)
never re-scans that directory -- same story 0003/0005 already fixed for
other gaps. `hub_api/PORTING.md` (module docstring gap 1,
`services/schema.py::bind_auth_tables`) documents this exact column as a
pre-existing gap between Node's `authController.js` and the numbered
migrations: pydal SELECTs `hub_users.*` on every login, so a missing
column 500s `POST /api/v1/auth/login` and poisons the pooled connection's
transaction (`psycopg2.errors.InFailedSqlTransaction`) for every
subsequent query on that connection until the pool recycles.

Revision ID: 0006_repair_email_verif_expires
Revises: 0005_repair_scoped_users
"""

from alembic import op

revision = "0006_repair_email_verif_expires"
down_revision = "0005_repair_scoped_users"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE hub_users "
        "ADD COLUMN IF NOT EXISTS email_verification_expires TIMESTAMP"
    )


def downgrade() -> None:
    # Dropping the column would reintroduce the exact 500/poisoned-pool bug
    # this repair fixes -- same "repairs cannot be safely downgraded"
    # rationale as 0003/0005.
    raise RuntimeError(
        "hub_users.email_verification_expires repair cannot be safely downgraded."
    )
