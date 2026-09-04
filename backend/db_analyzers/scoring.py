"""
Dialect-agnostic pieces of DB-side debt scoring — pure functions over column
names/counts/relationship shapes, unchanged from the original Postgres-only
db_analyze.py. Every dialect module (live.py, sql_file.py) feeds these the
same way, so a Postgres table and a SQL Server table score identically given
the same shape.
"""

# Column-name patterns, not data inspection — flags what the *schema*
# exposes, not what's actually stored in it.
SENSITIVE_HIGH = {
    "password", "passwd", "pwd", "secret", "token", "api_key", "apikey",
    "private_key", "access_key", "ssn", "social_security_number",
    "credit_card", "card_number", "cvv", "cvv2", "auth_token", "session_key",
}
SENSITIVE_MEDIUM = {
    "email", "phone", "phone_number", "address", "dob", "date_of_birth",
    "birth_date", "full_name", "ip_address", "national_id", "passport_number",
}
PROTECTED_HINTS = ("hash", "encrypted", "digest", "salt")  # column name suggests it's already protected


def classify_columns(col_names):
    high, medium = [], []
    for c in col_names:
        cl = c.lower()
        if any(hint in cl for hint in PROTECTED_HINTS):
            continue  # looks like it's already hashed/encrypted — don't flag
        if any(k in cl for k in SENSITIVE_HIGH):
            high.append(c)
        elif any(k in cl for k in SENSITIVE_MEDIUM):
            medium.append(c)
    return sorted(set(high)), sorted(set(medium))


def security_score(high_cols, medium_cols, public_write_grants):
    score = 0.0
    score += min(0.7, len(high_cols) * 0.35)
    score += min(0.25, len(medium_cols) * 0.08)
    score += min(0.35, public_write_grants * 0.35)
    return round(min(1.0, score), 4)


def find_unenforced_relationships(col_names, fk_cols, pk_like_names=("id",)):
    """Columns that look like foreign keys by name (ends in _id) but have no
    actual FK constraint — a common, real referential-integrity design smell."""
    fk_set = set(fk_cols)
    result = []
    for c in col_names:
        cl = c.lower()
        if cl in pk_like_names:
            continue
        if cl.endswith("_id") and c not in fk_set:
            result.append(c)
    return result


def design_score(missing_primary_key, col_count, unenforced_rel_count, no_indexes):
    score = 0.35 if missing_primary_key else 0.0
    score += min(0.30, max(0, col_count - 15) / 50.0)          # very wide tables
    score += min(0.25, unenforced_rel_count * 0.10)             # *_id columns with no real FK
    score += 0.10 if no_indexes else 0.0                        # nothing indexed at all (live only)
    return round(min(1.0, score), 4)


def debt_score_for_table(row_estimate, missing_index_count, col_count, security, design):
    size_component = min(1.0, (row_estimate or 0) / 1_000_000)
    index_component = min(1.0, missing_index_count / 3.0) if missing_index_count else 0.0
    # perf 30% / size 15% / security 30% / design (missing PK, width, unenforced FKs) 25%
    total = round(0.30 * index_component + 0.15 * size_component + 0.30 * security + 0.25 * design, 4)
    breakdown = {
        "performance": round(index_component, 3), "size": round(size_component, 3),
        "security": round(security, 3), "design": round(design, 3),
    }
    return total, breakdown


def find_code_to_table_edges(source_text_by_file, table_names):
    """Heuristic: a source file references a table if the table name appears
    as a whole word (covers raw SQL strings, ORM attribute/Meta.db_table,
    string-based query builders, etc.) — dialect- and language-agnostic."""
    import re
    edges = []
    patterns = {t: re.compile(r"\b" + re.escape(t) + r"\b") for t in table_names if len(t) > 2}
    for rel, src in source_text_by_file.items():
        for tname, pat in patterns.items():
            if pat.search(src):
                edges.append({"source": rel, "target": tname, "edge_type": "code_to_table"})
    return edges
