"""
The handful of signals SQLAlchemy's generic Inspector can't give us, because
they genuinely differ per database engine: live row-count/size estimates, and
"can basically anyone write to this table" grants. Everything else about a
table (columns, PKs, FKs, indexes) comes from the dialect-agnostic
sqlalchemy.inspect() API in live.py.

Each function is dispatched on engine.dialect.name and returns an empty dict
for any dialect it doesn't specifically know about (Oracle, SQLite, ...) —
same "lighter-weight proxy" degradation the .sql-file path already has for
security/size data it can't see.
"""
from sqlalchemy import text

WRITE_PRIVS = {"INSERT", "UPDATE", "DELETE", "TRUNCATE"}


def get_row_estimate_and_size(engine):
    """Returns {table_name: (row_estimate, size_bytes)}."""
    dialect = engine.dialect.name
    try:
        with engine.connect() as conn:
            if dialect == "postgresql":
                rows = conn.execute(text("""
                    SELECT c.relname, GREATEST(c.reltuples, 0)::bigint, pg_total_relation_size(c.oid)
                    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog','information_schema')
                """)).fetchall()
                return {r[0]: (int(r[1] or 0), int(r[2] or 0)) for r in rows}

            if dialect == "mysql":
                rows = conn.execute(text("""
                    SELECT TABLE_NAME, TABLE_ROWS, (DATA_LENGTH + INDEX_LENGTH)
                    FROM information_schema.TABLES
                    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
                """)).fetchall()
                return {r[0]: (int(r[1] or 0), int(r[2] or 0)) for r in rows}

            if dialect == "mssql":
                rows = conn.execute(text("""
                    SELECT t.name, SUM(p.rows), SUM(a.total_pages) * 8 * 1024
                    FROM sys.tables t
                    JOIN sys.partitions p ON t.object_id = p.object_id AND p.index_id IN (0, 1)
                    JOIN sys.allocation_units a ON p.partition_id = a.container_id
                    GROUP BY t.name
                """)).fetchall()
                return {r[0]: (int(r[1] or 0), int(r[2] or 0)) for r in rows}
    except Exception:
        pass
    return {}


def get_public_write_grants(engine):
    """Returns {table_name: write_grant_count}. Postgres and SQL Server both
    have a real PUBLIC/public role; MySQL has no equivalent, so a
    wildcard-host ('user'@'%') grantee is used as the closest proxy for
    'broadly writable' — documented here as an approximation, not a literal
    PUBLIC grant."""
    dialect = engine.dialect.name
    counts = {}
    try:
        with engine.connect() as conn:
            if dialect == "postgresql":
                rows = conn.execute(text("""
                    SELECT table_name, privilege_type FROM information_schema.role_table_grants
                    WHERE grantee = 'PUBLIC' AND table_schema NOT IN ('pg_catalog','information_schema')
                """)).fetchall()
                for tname, priv in rows:
                    if priv in WRITE_PRIVS:
                        counts[tname] = counts.get(tname, 0) + 1

            elif dialect == "mysql":
                rows = conn.execute(text("""
                    SELECT TABLE_NAME, PRIVILEGE_TYPE, GRANTEE FROM information_schema.TABLE_PRIVILEGES
                    WHERE TABLE_SCHEMA = DATABASE()
                """)).fetchall()
                for tname, priv, grantee in rows:
                    host = grantee.rsplit("@", 1)[-1].strip("'")
                    if priv in WRITE_PRIVS and host == "%":
                        counts[tname] = counts.get(tname, 0) + 1

            elif dialect == "mssql":
                rows = conn.execute(text("""
                    SELECT o.name, pm.permission_name
                    FROM sys.database_permissions pm
                    JOIN sys.objects o ON pm.major_id = o.object_id
                    JOIN sys.database_principals dp ON pm.grantee_principal_id = dp.principal_id
                    WHERE dp.name = 'public' AND pm.state = 'G'
                """)).fetchall()
                for tname, perm in rows:
                    if perm.upper() in WRITE_PRIVS:
                        counts[tname] = counts.get(tname, 0) + 1
    except Exception:
        pass
    return counts
