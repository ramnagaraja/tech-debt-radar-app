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


def analyze_live_db(connection_string):
    engine = create_engine(connection_string)
    try:
        insp = inspect(engine)
        table_names = insp.get_table_names()

        row_size = dialect_extras.get_row_estimate_and_size(engine)
        public_grants = dialect_extras.get_public_write_grants(engine)

        edges = []
        fan_out, fan_in = {}, {}
        fk_cols_by_table = {}
        for tname in table_names:
            for fk in insp.get_foreign_keys(tname):
                ftable = fk.get("referred_table")
                if not ftable:
                    continue
                edges.append({"source": tname, "target": ftable, "edge_type": "db_fk"})
                fan_out[tname] = fan_out.get(tname, 0) + 1
                fan_in[ftable] = fan_in.get(ftable, 0) + 1
                fk_cols_by_table.setdefault(tname, []).extend(fk.get("constrained_columns") or [])

        tables = []
        for tname in table_names:
            cols = [c["name"] for c in insp.get_columns(tname)]
            col_count = len(cols)

            pk_info = insp.get_pk_constraint(tname) or {}
            pk_cols = pk_info.get("constrained_columns") or []
            missing_pk = not bool(pk_cols)

            # SQLAlchemy's get_indexes() excludes the index that backs a
            # PRIMARY KEY (and often unique constraints) in most dialects, so
            # a PK-only table would otherwise look indexless — fold pk_cols
            # in explicitly rather than relying on get_indexes() alone.
            indexes = insp.get_indexes(tname)
            indexed_cols = set(pk_cols)
            for idx in indexes:
                indexed_cols.update(idx.get("column_names") or [])
            no_indexes = len(indexes) == 0 and missing_pk

            fk_cols = fk_cols_by_table.get(tname, [])
            missing_indexed_fks = sum(1 for c in fk_cols if c not in indexed_cols)

            high_cols, medium_cols = scoring.classify_columns(cols)
            public_writes = public_grants.get(tname, 0)
            unenforced_rels = scoring.find_unenforced_relationships(cols, fk_cols)

            security = scoring.security_score(high_cols, medium_cols, public_writes)
            design = scoring.design_score(missing_pk, col_count, len(unenforced_rels), no_indexes)

            row_est, size_bytes = row_size.get(tname, (0, 0))
            debt_score, breakdown = scoring.debt_score_for_table(
                row_est, missing_indexed_fks, col_count, security, design)

            tables.append({
                "id": tname, "kind": "table", "file": tname,
                "row_estimate": int(row_est or 0),
                "size_bytes": int(size_bytes or 0),
                "column_count": col_count,
                "fk_out": fan_out.get(tname, 0),
                "fk_in": fan_in.get(tname, 0),
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
