"""
Registry over DB analysis. `analyze_live_db` covers any SQLAlchemy-supported
RDBMS given the right connection string + driver (Postgres, MySQL/MariaDB,
SQL Server first-class via dialect_extras.py; anything else SQLAlchemy
supports still gets the generic structural analysis, just without the
row-count/grants extras). `analyze_sql_file` needs an explicit dialect since
a raw .sql file doesn't self-identify one.
"""
from sqlalchemy.engine import make_url

from .live import analyze_live_db
from .scoring import find_code_to_table_edges
from .sql_file import analyze_sql_file

SUPPORTED_SQL_FILE_DIALECTS = ("auto", "postgres", "mysql", "mssql")

__all__ = [
    "analyze_live_db",
    "analyze_sql_file",
    "find_code_to_table_edges",
    "detect_dialect_label",
    "SUPPORTED_SQL_FILE_DIALECTS",
]


def detect_dialect_label(connection_string):
    """Best-effort human-readable dialect name from a connection string's URL
    scheme, for display only (SQLAlchemy itself resolves the real dialect)."""
    try:
        return make_url(connection_string).get_backend_name()
    except Exception:
        return "unknown"
