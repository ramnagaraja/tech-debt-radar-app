"""
Best-effort Jira/Confluence context fetchers, using stdlib urllib (no new
dependency). Jira Cloud and Confluence Cloud authenticate the same way —
Basic Auth with an Atlassian account email + API token generated at
id.atlassian.com — so one credential pair covers both.

Every function here returns a result dict and NEVER raises: a broken URL,
missing credentials, a permissions error, or an unreachable host all just
produce {"ok": False, "error": "..."} so one bad context source never fails
the whole analysis run. This has not been exercised against a real
Atlassian Cloud site — treat it as best-effort until verified against yours.
"""
import base64
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

TIMEOUT = 10
MAX_TEXT_CHARS = 4000


def _auth_header(email, api_token):
    if not email or not api_token:
        return None
    token = base64.b64encode(f"{email}:{api_token}".encode("utf-8")).decode("ascii")
    return f"Basic {token}"


def _get_json(url, email, api_token):
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    auth = _auth_header(email, api_token)
    if auth:
        req.add_header("Authorization", auth)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _http_error_message(e):
    if e.code in (401, 403):
        return f"HTTP {e.code} — check the Atlassian email/API token in Admin settings."
    return f"HTTP {e.code} — {e.reason}"


# --- Jira ---------------------------------------------------------------

def _adf_to_text(node, lines):
    """Flattens Atlassian Document Format (the JSON tree Jira Cloud uses for
    rich-text fields like `description`) into plain text."""
    if not isinstance(node, dict):
        return
    if node.get("type") == "text":
        lines.append(node.get("text", ""))
    for child in node.get("content") or []:
        _adf_to_text(child, lines)
    if node.get("type") in ("paragraph", "heading", "listItem"):
        lines.append("\n")


def _adf_to_plain_text(adf):
    if not isinstance(adf, dict):
        return str(adf) if adf else ""
    lines = []
    _adf_to_text(adf, lines)
    return "".join(lines).strip()


_JIRA_ISSUE_RE = re.compile(r"/browse/([A-Z][A-Z0-9_]*-\d+)", re.I)
_JIRA_PROJECT_RE = re.compile(r"[?&]projectKey=([A-Z][A-Z0-9_]*)|/projects/([A-Z][A-Z0-9_]*)", re.I)


def fetch_jira_context(url, email=None, api_token=None):
    """Returns {"kind": "jira", "url", "title", "text", "ok", "error"}."""
    result = {"kind": "jira", "url": url, "title": "", "text": "", "ok": False, "error": None}
    try:
        parsed = urllib.parse.urlparse(url)
        base = f"{parsed.scheme}://{parsed.netloc}"

        issue_match = _JIRA_ISSUE_RE.search(url)
        if issue_match:
            key = issue_match.group(1)
            data = _get_json(
                f"{base}/rest/api/3/issue/{key}?fields=summary,description,status,issuetype,priority",
                email, api_token,
            )
            fields = data.get("fields", {})
            desc = _adf_to_plain_text(fields.get("description"))
            status = (fields.get("status") or {}).get("name", "")
            itype = (fields.get("issuetype") or {}).get("name", "")
            result["title"] = f"{key}: {fields.get('summary', '')}"
            result["text"] = f"Type: {itype} | Status: {status}\n\n{desc}"[:MAX_TEXT_CHARS]
            result["ok"] = True
            return result

        project_match = _JIRA_PROJECT_RE.search(url)
        project_key = project_match and (project_match.group(1) or project_match.group(2))
        if project_key:
            data = _get_json(
                f"{base}/rest/api/3/search?jql=project%3D{project_key}&maxResults=10&fields=summary,status",
                email, api_token,
            )
            lines = [
                f"- {i['key']}: {i['fields'].get('summary', '')} [{(i['fields'].get('status') or {}).get('name', '')}]"
                for i in data.get("issues", [])
            ]
            result["title"] = f"Project {project_key} — recent issues"
            result["text"] = "\n".join(lines)[:MAX_TEXT_CHARS]
            result["ok"] = True
            return result

        result["error"] = "Couldn't find a Jira issue key (PROJ-123) or project key in this URL."
        return result
    except urllib.error.HTTPError as e:
        result["error"] = _http_error_message(e)
        return result
    except Exception as e:
        result["error"] = str(e)
        return result


# --- Confluence -----------------------------------------------------------

class _HTMLTextExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.chunks = []

    def handle_data(self, data):
        self.chunks.append(data)

    def handle_endtag(self, tag):
        if tag in ("p", "div", "li", "h1", "h2", "h3", "h4", "br", "tr"):
            self.chunks.append("\n")


def _strip_html(html):
    """Confluence's 'storage format' is XHTML-ish — extract plain text with
    a real (if minimal) HTML parser rather than a regex tag-stripper."""
    parser = _HTMLTextExtractor()
    try:
        parser.feed(html or "")
    except Exception:
        pass
    text = "".join(parser.chunks)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


_CONFLUENCE_PAGE_ID_RE = re.compile(r"/pages/(\d+)")


def fetch_confluence_context(url, email=None, api_token=None):
    """Returns {"kind": "confluence", "url", "title", "text", "ok", "error"}."""
    result = {"kind": "confluence", "url": url, "title": "", "text": "", "ok": False, "error": None}
    try:
        parsed = urllib.parse.urlparse(url)
        base = f"{parsed.scheme}://{parsed.netloc}"

        page_match = _CONFLUENCE_PAGE_ID_RE.search(url)
        if page_match:
            data = _get_json(f"{base}/wiki/api/v2/pages/{page_match.group(1)}?body-format=storage", email, api_token)
            body = ((data.get("body") or {}).get("storage") or {}).get("value", "")
            result["title"] = data.get("title", "")
            result["text"] = _strip_html(body)[:MAX_TEXT_CHARS]
            result["ok"] = True
            return result

        qs = urllib.parse.parse_qs(parsed.query)
        title = (qs.get("title") or [None])[0]
        space = (qs.get("spaceKey") or [None])[0]
        if title and space:
            data = _get_json(
                f"{base}/wiki/rest/api/content?title={urllib.parse.quote(title)}"
                f"&spaceKey={urllib.parse.quote(space)}&expand=body.storage",
                email, api_token,
            )
            results = data.get("results", [])
            if results:
                page = results[0]
                body = ((page.get("body") or {}).get("storage") or {}).get("value", "")
                result["title"] = page.get("title", "")
                result["text"] = _strip_html(body)[:MAX_TEXT_CHARS]
                result["ok"] = True
                return result

        result["error"] = "Couldn't find a Confluence page ID in this URL (and no ?title=&spaceKey= to look one up)."
        return result
    except urllib.error.HTTPError as e:
        result["error"] = _http_error_message(e)
        return result
    except Exception as e:
        result["error"] = str(e)
        return result


def fetch_context(kind, url, email=None, api_token=None):
    if kind == "jira":
        return fetch_jira_context(url, email, api_token)
    if kind == "confluence":
        return fetch_confluence_context(url, email, api_token)
    return {"kind": kind, "url": url, "title": "", "text": "", "ok": False, "error": f"Unknown context kind: {kind!r}"}
