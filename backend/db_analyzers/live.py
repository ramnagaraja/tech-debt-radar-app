"""
Live-connection DB analysis via SQLAlchemy's dialect-agnostic Inspector —
works against Postgres, MySQL/MariaDB, and SQL Server (any dialect
SQLAlchemy + an installed driver supports, really) for the core structural
signals: tables, columns, primary keys, foreign keys, and indexes. The only
genuinely per-dialect pieces (row/size estimates, "broadly writable" grants)
live in dialect_extras.py and degrade gracefully to empty/zero for dialects
without a specific implementation.
"""
from sqlalchemy import create_engine, inspect

from . import dialect_extras, scoring

# Schemas that hold engine internals, never user tables — excluded from the
# scan below regardless of dialect. A real application's tables often live in
# a non-default schema (e.g. Postgres's "public" left empty, everything
# actually in an app-named schema instead); reflecting only
# insp.default_schema_name silently reported zero tables in that case.
SYSTEM_SCHEMAS = {"information_schema", "pg_catalog", "pg_toast", "sys", "guest", "mysql", "performance_schema"}


def analyze_live_db(connection_string):
    engine = create_engine(connection_string)
    try:
        insp = inspect(engine)
        try:
            all_schemas = insp.get_schema_names()
        except Exception:
            all_schemas = [insp.default_schema_name]
        candidate_schemas = [s for s in all_schemas if s.lower() not in SYSTEM_SCHEMAS and not s.lower().startswith("pg_")]
        if not candidate_schemas:
            candidate_schemas = [insp.default_schema_name]

        schema_tables = {s: insp.get_table_names(schema=s) for s in candidate_schemas}
        non_empty = {s: names for s, names in schema_tables.items() if names}
        if not non_empty:
            non_empty = schema_tables  # every schema was empty — keep going, just yields zero tables as before
        # Only qualify ids with their schema when more than one schema actually
        # has tables — the common single-schema case then stays byte-for-byte
        # identical to before this fix, same "prefix only when there's more
        # than one" convention multi_source.py already uses for multi-repo/db.
        multi_schema = len(non_empty) > 1

        def qualify(schema, name):
            return f"{schema}.{name}" if multi_schema else name

        table_refs = [(schema, tname) for schema, names in non_empty.items() for tname in names]

        row_size = dialect_extras.get_row_estimate_and_size(engine)
        public_grants = dialect_extras.get_public_write_grants(engine)

        edges = []
        fan_out, fan_in = {}, {}
        fk_cols_by_table = {}
        for schema, tname in table_refs:
            qid = qualify(schema, tname)
            for fk in insp.get_foreign_keys(tname, schema=schema):
                ftable = fk.get("referred_table")
                if not ftable:
                    continue
                fqid = qualify(fk.get("referred_schema") or schema, ftable)
                edges.append({"source": qid, "target": fqid, "edge_type": "db_fk"})
                fan_out[qid] = fan_out.get(qid, 0) + 1
                fan_in[fqid] = fan_in.get(fqid, 0) + 1
                fk_cols_by_table.setdefault(qid, []).extend(fk.get("constrained_columns") or [])

        tables = []
        for schema, tname in table_refs:
            qid = qualify(schema, tname)
            cols = [c["name"] for c in insp.get_columns(tname, schema=schema)]
            col_count = len(cols)

            pk_info = insp.get_pk_constraint(tname, schema=schema) or {}
            pk_cols = pk_info.get("constrained_columns") or []
            missing_pk = not bool(pk_cols)

            # SQLAlchemy's get_indexes() excludes the index that backs a
            # PRIMARY KEY (and often unique constraints) in most dialects, so
            # a PK-only table would otherwise look indexless — fold pk_cols
            # in explicitly rather than relying on get_indexes() alone.
            indexes = insp.get_indexes(tname, schema=schema)
            indexed_cols = set(pk_cols)
            for idx in indexes:
                indexed_cols.update(idx.get("column_names") or [])
            no_indexes = len(indexes) == 0 and missing_pk

            fk_cols = fk_cols_by_table.get(qid, [])
            missing_indexed_fks = sum(1 for c in fk_cols if c not in indexed_cols)

            high_cols, medium_cols = scoring.classify_columns(cols)
            # dialect_extras scans every non-system schema in one query and
            # keys its results by bare table name, so the lookup here always
            # uses the unqualified name regardless of the id's own qualification.
            public_writes = public_grants.get(tname, 0)
            unenforced_rels = scoring.find_unenforced_relationships(cols, fk_cols)

            security = scoring.security_score(high_cols, medium_cols, public_writes)
            design = scoring.design_score(missing_pk, col_count, len(unenforced_rels), no_indexes)

            row_est, size_bytes = row_size.get(tname, (0, 0))
            debt_score, breakdown = scoring.debt_score_for_table(
                row_est, missing_indexed_fks, col_count, security, design)

            tables.append({
                "id": qid, "kind": "table", "file": qid, "bare_name": tname,
                "row_estimate": int(row_est or 0),
                "size_bytes": int(size_bytes or 0),
                "column_count": col_count,
                "fk_out": fan_out.get(qid, 0),
                "fk_in": fan_in.get(qid, 0),
                "missing_indexed_fks": missing_indexed_fks,
                "missing_primary_key": missing_pk,
                "high_risk_columns": high_cols,
                "medium_risk_columns": medium_cols,
                "public_write_grants": public_writes,
                "unenforced_relationships": unenforced_rels,
                "no_indexes": no_indexes,
                "score_breakdown": breakdown,
                "debt_score": debt_score,
            })
        return {"tables": tables, "edges": edges}
    finally:
        engine.dispose()
