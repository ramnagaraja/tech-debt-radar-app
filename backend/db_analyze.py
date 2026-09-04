"""
Backward-compatible facade. The real implementations now live under
db_analyzers/ — db_analyzers/live.py (any SQLAlchemy-supported RDBMS),
db_analyzers/sql_file.py (multi-dialect .sql parsing via sqlglot), and
db_analyzers/scoring.py (the dialect-agnostic debt-scoring math shared by
both). See db_analyzers/__init__.py for the registry.

Kept so any external script importing `db_analyze` directly doesn't break.
"""
from db_analyzers import (  # noqa: F401
    analyze_live_db,
    analyze_sql_file,
    find_code_to_table_edges,
)
