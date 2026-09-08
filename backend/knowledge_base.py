"""
Technical-document knowledge base: upload -> extract -> chunk -> embed ->
store, then cosine-similarity search at query time, with a feedback-weighted
re-ranking loop.

Deliberately NOT a dedicated vector database (chromadb/faiss/lancedb) —
every other feature in this app stores everything in plain SQLite (see
app.py's app_settings/chat_feedback, debt_radar.db's code_metrics/db_metrics),
and a technical-doc library for one team is realistically a few thousand
chunks at most. A linear cosine-similarity scan over a few thousand 384-dim
vectors is comfortably sub-100ms — no ANN index needed at this scale. If the
library ever outgrows that, swapping in sqlite-vec later only touches
`search()`; the storage shape (one row per chunk, embedding as a BLOB)
stays the same.

Embeddings are local (fastembed, ONNX-runtime) — no API key, no per-call
cost, works offline. The feedback loop is real and does change future
ranking (see `_trust_multipliers`), but it is NOT reinforcement learning in
the ML sense: no model weights are updated anywhere, only a per-chunk
trust multiplier computed from a vote history. Same honest distinction the
existing chat thumbs-up/down loop documents in README.md.
"""
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

BACKEND_DIR = Path(__file__).resolve().parent
DATA_DIR = BACKEND_DIR / "app_data"
DATA_DIR.mkdir(exist_ok=True)
APP_DB_PATH = DATA_DIR / "app.db"
KNOWLEDGE_DIR = DATA_DIR / "knowledge"
KNOWLEDGE_DIR.mkdir(exist_ok=True)

CHUNK_SIZE = 1000
CHUNK_OVERLAP = 150
EMBEDDING_MODEL_NAME = "BAAI/bge-small-en-v1.5"

# Heuristic, tunable thresholds — not universal constants. Calibrated for
# bge-small-style embeddings, where a genuinely relevant match typically
# lands well above 0.7 and an off-topic one drops below 0.45.
CONFIDENCE_HIGH = 0.70
CONFIDENCE_MEDIUM = 0.45

_model = None


def _connect():
    return sqlite3.connect(APP_DB_PATH)


def _init_tables():
    conn = _connect()
    conn.execute("""CREATE TABLE IF NOT EXISTS kb_documents (
        id TEXT PRIMARY KEY, filename TEXT, uploaded_at TEXT,
        status TEXT, error TEXT, chunk_count INTEGER DEFAULT 0,
        is_builtin INTEGER DEFAULT 0)""")
    try:
        conn.execute("ALTER TABLE kb_documents ADD COLUMN is_builtin INTEGER DEFAULT 0")
        conn.commit()
    except sqlite3.OperationalError:
        pass  # column already exists — a DB created before this field was added
    conn.execute("""CREATE TABLE IF NOT EXISTS kb_chunks (
        id TEXT PRIMARY KEY, doc_id TEXT, chunk_index INTEGER,
        page INTEGER, text TEXT, embedding BLOB)""")
    conn.execute("""CREATE TABLE IF NOT EXISTS kb_feedback_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, chunk_id TEXT, vote TEXT,
        query TEXT, created_at TEXT)""")
    conn.commit()
    conn.close()


_init_tables()

SEED_DIR = BACKEND_DIR / "knowledge_seed"
# Bundled, original reference material (SOLID, design patterns, microservices
# architecture) so recommendations have real industry-standard grounding to
# retrieve and cite even before a team uploads anything of their own. Ingested
# through the exact same pipeline as a manual upload — the only difference is
# the is_builtin flag, which just protects them from accidental deletion.
BUILTIN_SEED_FILES = ["solid_principles.md", "design_patterns.md", "microservices_architecture.md"]


def _get_model():
    global _model
    if _model is None:
        from fastembed import TextEmbedding
        _model = TextEmbedding(model_name=EMBEDDING_MODEL_NAME)
    return _model


def _embed_documents(texts):
    return [np.asarray(v, dtype=np.float32) for v in _get_model().embed(texts)]


def _embed_query(text):
    """bge-style models are trained asymmetrically — a query needs a
    different embedding path than a passage/chunk for good retrieval.
    fastembed exposes query_embed() for models that support it; fall back
    to the generic embed() if this installed version/model doesn't."""
    model = _get_model()
    embed_fn = getattr(model, "query_embed", None) or model.embed
    return np.asarray(next(iter(embed_fn([text]))), dtype=np.float32)


def _chunk_text(text, chunk_size=CHUNK_SIZE, overlap=CHUNK_OVERLAP):
    text = (text or "").strip()
    if not text:
        return []
    chunks = []
    start, n = 0, len(text)
    while start < n:
        end = min(start + chunk_size, n)
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end == n:
            break
        start = end - overlap
    return chunks


def _extract_pages(path, filename):
    """Returns [(page_number_or_None, text), ...] — one entry per page for
    PDFs (so citations can say 'page 12'), one entry total for everything
    else (page=None, since docx/md/txt have no fixed pagination)."""
    ext = os.path.splitext(filename)[1].lower()
    if ext == ".pdf":
        from pypdf import PdfReader
        reader = PdfReader(path)
        return [(i + 1, page.extract_text() or "") for i, page in enumerate(reader.pages)]
    if ext == ".docx":
        import docx
        d = docx.Document(path)
        return [(None, "\n".join(p.text for p in d.paragraphs))]
    with open(path, "r", encoding="utf-8", errors="ignore") as fh:
        return [(None, fh.read())]


def _confidence_bucket(similarity):
    if similarity >= CONFIDENCE_HIGH:
        return "High"
    if similarity >= CONFIDENCE_MEDIUM:
        return "Medium"
    return "Low"


def _trust_multipliers(conn):
    """Laplace-smoothed trust multiplier per chunk from its feedback
    history, ~0.6x-1.4x — sustained down-votes demote a chunk significantly
    without ever fully zeroing it out (the content could still be the best
    match for a differently-phrased query). This is the whole feedback
    loop: it's recomputed fresh on every search from the event log, so a
    new vote changes the very next query's ranking."""
    rows = conn.execute("""
        SELECT chunk_id,
               SUM(CASE WHEN vote = 'up' THEN 1 ELSE 0 END),
               SUM(CASE WHEN vote = 'down' THEN 1 ELSE 0 END)
        FROM kb_feedback_events GROUP BY chunk_id
    """).fetchall()
    return {
        chunk_id: 0.6 + 0.8 * ((ups or 0) + 1) / ((ups or 0) + (downs or 0) + 2)
        for chunk_id, ups, downs in rows
    }


def ingest_document(path, filename):
    """Extracts, chunks, embeds, and stores one document. Runs synchronously
    (the caller — app.py's upload endpoint — runs this in a background
    thread, the same pattern run_analysis() already uses) and updates the
    document's own status row as it goes, so a slow/large upload is visible
    as "processing" rather than the request just hanging."""
    doc_id = uuid.uuid4().hex[:12]
    now = datetime.now(timezone.utc).isoformat()
    conn = _connect()
    conn.execute(
        "INSERT INTO kb_documents (id, filename, uploaded_at, status, error, chunk_count) VALUES (?,?,?,?,?,?)",
        (doc_id, filename, now, "processing", None, 0),
    )
    conn.commit()
    conn.close()

    try:
        pages = _extract_pages(path, filename)
        texts, meta = [], []
        chunk_index = 0
        for page_num, page_text in pages:
            for chunk in _chunk_text(page_text):
                texts.append(chunk)
                meta.append((page_num, chunk_index))
                chunk_index += 1

        if not texts:
            raise ValueError("No extractable text found in this document.")

        embeddings = _embed_documents(texts)

        conn = _connect()
        for (page_num, idx), text, emb in zip(meta, texts, embeddings):
            chunk_id = uuid.uuid4().hex[:16]
            conn.execute(
                "INSERT INTO kb_chunks (id, doc_id, chunk_index, page, text, embedding) VALUES (?,?,?,?,?,?)",
                (chunk_id, doc_id, idx, page_num, text, emb.tobytes()),
            )
        conn.execute("UPDATE kb_documents SET status = ?, chunk_count = ? WHERE id = ?", ("ready", len(texts), doc_id))
        conn.commit()
        conn.close()
    except Exception as e:
        conn = _connect()
        conn.execute("UPDATE kb_documents SET status = ?, error = ? WHERE id = ?", ("error", str(e), doc_id))
        conn.commit()
        conn.close()
    return doc_id


def ensure_builtin_seed_documents():
    """Ingests the bundled reference docs on first run. Idempotent — checks
    for an existing is_builtin row per filename before re-ingesting, so this
    is safe to call on every startup."""
    conn = _connect()
    existing = {row[0] for row in conn.execute("SELECT filename FROM kb_documents WHERE is_builtin = 1").fetchall()}
    conn.close()
    for filename in BUILTIN_SEED_FILES:
        if filename in existing:
            continue
        path = SEED_DIR / filename
        if not path.exists():
            continue
        doc_id = ingest_document(str(path), filename)
        conn = _connect()
        conn.execute("UPDATE kb_documents SET is_builtin = 1 WHERE id = ?", (doc_id,))
        conn.commit()
        conn.close()


def search(query, top_k=5):
    """Embeds the query, scores every ready chunk by
    similarity * trust_multiplier, returns the top_k. `similarity` (raw
    retrieval confidence) and `trust_multiplier` (feedback adjustment) are
    both returned separately so the UI never conflates 'the library had a
    good match' with 'the team has upvoted this before'."""
    query_vec = _embed_query(query)
    query_norm = float(np.linalg.norm(query_vec)) or 1.0

    conn = _connect()
    rows = conn.execute("""
        SELECT c.id, c.doc_id, c.page, c.text, c.embedding, d.filename, d.is_builtin
        FROM kb_chunks c JOIN kb_documents d ON d.id = c.doc_id
        WHERE d.status = 'ready'
    """).fetchall()
    trust = _trust_multipliers(conn)
    conn.close()

    scored = []
    for chunk_id, doc_id, page, text, emb_blob, filename, is_builtin in rows:
        vec = np.frombuffer(emb_blob, dtype=np.float32)
        denom = (float(np.linalg.norm(vec)) * query_norm) or 1.0
        similarity = float(np.dot(vec, query_vec) / denom)
        multiplier = trust.get(chunk_id, 1.0)
        scored.append({
            "chunk_id": chunk_id, "doc_id": doc_id, "filename": filename, "page": page,
            "text": text, "similarity": round(similarity, 4),
            "confidence": _confidence_bucket(similarity),
            "trust_multiplier": round(multiplier, 3),
            "effective_score": round(similarity * multiplier, 4),
            "is_builtin": bool(is_builtin),
        })
    scored.sort(key=lambda r: r["effective_score"], reverse=True)
    return scored[:top_k]


def record_feedback(chunk_id, vote, query=None):
    conn = _connect()
    conn.execute(
        "INSERT INTO kb_feedback_events (chunk_id, vote, query, created_at) VALUES (?,?,?,?)",
        (chunk_id, vote, query, datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()
    conn.close()


def list_documents():
    conn = _connect()
    rows = conn.execute(
        "SELECT id, filename, uploaded_at, status, error, chunk_count, is_builtin FROM kb_documents ORDER BY is_builtin DESC, uploaded_at DESC"
    ).fetchall()
    conn.close()
    return [
        {"id": r[0], "filename": r[1], "uploaded_at": r[2], "status": r[3], "error": r[4], "chunk_count": r[5], "is_builtin": bool(r[6])}
        for r in rows
    ]


def delete_document(doc_id):
    """Returns False (no-op) for a built-in seed document instead of deleting
    it — the bundled SOLID/design-pattern/microservices reference library is
    meant to be a permanent part of the app, not something removable through
    the same endpoint used for team uploads."""
    conn = _connect()
    row = conn.execute("SELECT is_builtin FROM kb_documents WHERE id = ?", (doc_id,)).fetchone()
    if row and row[0]:
        conn.close()
        return False
    conn.execute("DELETE FROM kb_feedback_events WHERE chunk_id IN (SELECT id FROM kb_chunks WHERE doc_id = ?)", (doc_id,))
    conn.execute("DELETE FROM kb_chunks WHERE doc_id = ?", (doc_id,))
    conn.execute("DELETE FROM kb_documents WHERE id = ?", (doc_id,))
    conn.commit()
    conn.close()
    for f in KNOWLEDGE_DIR.glob(f"{doc_id}__*"):
        try:
            f.unlink()
        except OSError:
            pass
    return True
