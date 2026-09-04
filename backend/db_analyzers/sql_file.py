"""
No live DB available — parse a schema dump/migration file instead, via
sqlglot's multi-dialect SQL parser (replacing the original Postgres-flavored
regex parser so MySQL/T-SQL/generic-ANSI dumps parse correctly too). Gives
structure (tables, FKs, column counts, sensitive-looking column names,
whether a PRIMARY KEY is declared) but no row counts, real index usage, or
grants — so debt scores here are a lighter-weight proxy, same as before, and
the security component only reflects column *names*, not permissions.

A raw .sql file doesn't self-identify its dialect the way a live connection
string does (postgresql:// vs mysql+pymysql:// vs mssql+pyodbc://), so the
caller must say which one it is — see the `dialect` param.
"""
import sqlglot
from sqlglot import exp

from . import scoring

DIALECT_MAP = {
    "postgres": "postgres",
    "mysql": "mysql",
    "mssql": "tsql",
    "auto": None,  # sqlglot's generic/ANSI parser
}


def _extract_table_name(node):
    if node is None:
        return None
    if isinstance(node, exp.Schema):
        node = node.this
    if isinstance(node, exp.Table):
        return node.name
    return getattr(node, "name", None)


def _is_kind(node, *type_name_fragments):
    """Loose, version-tolerant type check: matches by class name substring
    instead of importing exact sqlglot expression classes that can move
    between minor versions."""
    if node is None:
        return False
    cls_name = type(node).__name__
    return any(fragment in cls_name for fragment in type_name_fragments)


def _parse_column_def(col_def, table_name, col_names, fk_pairs, has_pk_flag):
    col_name = col_def.name
    if col_name:
        col_names.append(col_name)
    for constraint in col_def.args.get("constraints") or []:
        kind = constraint.args.get("kind") if hasattr(constraint, "args") else constraint
        if _is_kind(kind, "PrimaryKey"):
            has_pk_flag[0] = True
        if _is_kind(kind, "Reference", "ForeignKey"):
            ref_target = kind.args.get("this") if hasattr(kind, "args") else None
            ref_table = _extract_table_name(ref_target)
            if ref_table and col_name:
                fk_pairs.append((col_name, ref_table))


def _parse_table_constraint(d, fk_pairs, has_pk_flag):
    if _is_kind(d, "PrimaryKey"):
        has_pk_flag[0] = True
        return
    if _is_kind(d, "ForeignKey"):
        local_cols = [c.name for c in (d.expressions or []) if getattr(c, "name", None)]
        reference = d.args.get("reference")
        ref_table = None
        if reference is not None:
            ref_table = _extract_table_name(reference.args.get("this") if hasattr(reference, "args") else None)
        if ref_table:
            for lc in local_cols:
                fk_pairs.append((lc, ref_table))


def _parse_create_statements(sql, dialect):
    read_dialect = DIALECT_MAP.get(dialect, None)
    try:
        statements = sqlglot.parse(sql, read=read_dialect)
    except Exception:
        try:
            statements = sqlglot.parse(sql, read=None)
        except Exception:
            statements = []

    parsed = []  # [(table_name, col_names, fk_pairs, has_pk)]
    for stmt in statements:
        if stmt is None:
            continue
        creates = stmt.find_all(exp.Create) if hasattr(stmt, "find_all") else []
        for create in creates:
            kind = create.args.get("kind")
            if kind and str(kind).upper() != "TABLE":
                continue
            table_exp = create.this
            table_name = _extract_table_name(table_exp)
            if not table_name:
                continue

            col_names, fk_pairs = [], []
            has_pk_flag = [False]
            defs = table_exp.expressions if isinstance(table_exp, exp.Schema) else []
            for d in defs:
                if isinstance(d, exp.ColumnDef):
                    _parse_column_def(d, table_name, col_names, fk_pairs, has_pk_flag)
                else:
                    _parse_table_constraint(d, fk_pairs, has_pk_flag)

            parsed.append((table_name, col_names, fk_pairs, has_pk_flag[0]))
    return parsed


def analyze_sql_file(path, dialect="auto"):
    with open(path, "r", encoding="utf-8", errors="ignore") as fh:
        sql = fh.read()

    parsed = _parse_create_statements(sql, dialect)

    fan_out, fan_in = {}, {}
    edges = []
    for tname, _cols, fk_pairs, _has_pk in parsed:
        fan_out[tname] = len(fk_pairs)
        for _lc, ftable in fk_pairs:
            fan_in[ftable] = fan_in.get(ftable, 0) + 1
            edges.append({"source": tname, "target": ftable, "edge_type": "db_fk"})

    tables = []
    for tname, col_names, fk_pairs, has_pk in parsed:
        fk_local_cols = [c for c, _ in fk_pairs]
        high_cols, medium_cols = scoring.classify_columns(col_names)
        missing_pk = not has_pk
        unenforced_rels = scoring.find_unenforced_relationships(col_names, fk_local_cols)
        security = scoring.security_score(high_cols, medium_cols, 0)
        design = scoring.design_score(missing_pk, len(col_names), len(unenforced_rels), no_indexes=False)
        debt_score, breakdown = scoring.debt_score_for_table(None, None, len(col_names), security, design)
        tables.append({
            "id": tname, "kind": "table", "file": tname,
            "row_estimate": None, "size_bytes": None,
            "column_count": len(col_names),
            "fk_out": fan_out.get(tname, 0),
            "fk_in": fan_in.get(tname, 0),
            "missing_indexed_fks": None,
            "missing_primary_key": missing_pk,
            "high_risk_columns": high_cols,
            "medium_risk_columns": medium_cols,
            "public_write_grants": None,
            "unenforced_relationships": unenforced_rels,
            "no_indexes": None,
            "score_breakdown": breakdown,
            "debt_score": debt_score,
        })
    return {"tables": tables, "edges": edges}
