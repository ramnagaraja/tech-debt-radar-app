"""
Best-effort PR/MR history mining.

Detects a locally-cloned repo's GitHub or GitLab.com origin remote, fetches
its recently merged pull/merge requests, and asks the configured LLM to
distill durable "gotchas" from them — invariants, migration steps, ordering
requirements, footguns — that a future changer of the same files should
know before they touch them. This is knowledge that lives in nobody's head
and nowhere in the current source tree; it's scattered across months of
merged PR descriptions.

Mirrors external_context.py's contract on purpose: every public function
returns {"ok": True/False, ...} and never raises. No GitHub/GitLab token,
no network egress, a private repo, an API rate limit, a repo with no
recognized remote — all of these degrade to a clear "ok": False with a
human-readable reason, never a crash and never a silently empty result
presented as success.
"""
import json
import re
import subprocess
import urllib.error
import urllib.parse
import urllib.request

import llm_providers

GITHUB_API = "https://api.github.com"
GITLAB_API = "https://gitlab.com/api/v4"

REQUEST_TIMEOUT = 15


def detect_remote(repo_path):
    """Returns {"host": "github"|"gitlab", "owner": str, "repo": str} or None
    if the repo has no `origin` remote, or that remote isn't on github.com or
    gitlab.com (self-hosted GitLab/Gitea/Bitbucket/etc. are out of scope for
    this v1 — same "documented limit, not a silent gap" approach as the rest
    of this module)."""
    try:
        out = subprocess.run(
            ["git", "-C", repo_path, "remote", "get-url", "origin"],
            capture_output=True, text=True, timeout=10,
        )
        if out.returncode != 0:
            return None
        url = out.stdout.strip()
    except Exception:
        return None

    # Covers git@github.com:owner/repo.git, https://github.com/owner/repo(.git)?(/)?
    # and the same two shapes for gitlab.com.
    m = re.search(r"github\.com[:/]([^/]+)/([^/]+?)(?:\.git)?/?$", url)
    if m:
        return {"host": "github", "owner": m.group(1), "repo": m.group(2)}
    m = re.search(r"gitlab\.com[:/]([^/]+)/([^/]+?)(?:\.git)?/?$", url)
    if m:
        return {"host": "gitlab", "owner": m.group(1), "repo": m.group(2)}
    return None


def _http_get_json(url, token=None, token_header="Authorization", token_prefix="Bearer"):
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "tech-debt-radar-app"})
    if token:
        req.add_header(token_header, f"{token_prefix} {token}" if token_prefix else token)
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_recent_prs(remote, token=None, limit=15):
    """Returns {"ok": True, "prs": [{number, title, body, files: [...]}]} or
    {"ok": False, "error": "..."}. `files` (the paths each PR touched) is
    best-effort — a second API call per PR that's simply omitted if it
    fails, since the title/body alone is still useful to the LLM step."""
    try:
        if remote["host"] == "github":
            url = (f"{GITHUB_API}/repos/{remote['owner']}/{remote['repo']}/pulls"
                   f"?state=closed&per_page={limit}&sort=updated&direction=desc")
            prs = _http_get_json(url, token=token)
            results = []
            for pr in prs:
                if not pr.get("merged_at"):
                    continue  # closed-without-merging PRs carry no durable lesson worth mining
                files = []
                try:
                    files_json = _http_get_json(
                        f"{GITHUB_API}/repos/{remote['owner']}/{remote['repo']}/pulls/{pr['number']}/files",
                        token=token,
                    )
                    files = [f["filename"] for f in files_json]
                except Exception:
                    pass
                results.append({"number": pr["number"], "title": pr.get("title", ""), "body": pr.get("body") or "", "files": files})
            return {"ok": True, "prs": results}

        if remote["host"] == "gitlab":
            project_path = urllib.parse.quote(f"{remote['owner']}/{remote['repo']}", safe="")
            url = f"{GITLAB_API}/projects/{project_path}/merge_requests?state=merged&per_page={limit}&order_by=updated_at"
            mrs = _http_get_json(url, token=token, token_header="PRIVATE-TOKEN", token_prefix="")
            results = []
            for mr in mrs:
                files = []
                try:
                    changes = _http_get_json(
                        f"{GITLAB_API}/projects/{project_path}/merge_requests/{mr['iid']}/changes",
                        token=token, token_header="PRIVATE-TOKEN", token_prefix="",
                    )
                    files = [c["new_path"] for c in changes.get("changes", [])]
                except Exception:
                    pass
                results.append({"number": mr["iid"], "title": mr.get("title", ""), "body": mr.get("description") or "", "files": files})
            return {"ok": True, "prs": results}

        return {"ok": False, "error": f"Unsupported remote host: {remote['host']}"}
    except urllib.error.HTTPError as e:
        reason = "private repo or missing/invalid token" if e.code in (401, 403, 404) else f"HTTP {e.code}"
        return {"ok": False, "error": f"Could not reach the {remote['host']} API ({reason})."}
    except Exception as e:
        return {"ok": False, "error": str(e)}


INVARIANT_SYSTEM_PROMPT = (
    "You are analyzing merged pull requests from a software repository to extract "
    "durable engineering knowledge: the kind of thing a senior engineer would tell "
    "a newcomer before they touch a given file — an invariant that must hold, a "
    "migration step that must run alongside a code change, a non-obvious ordering "
    "requirement, a footgun that caused a past incident or bug fix. Ignore routine "
    "PRs entirely (dependency bumps, formatting, typo fixes, pure test additions "
    "with no behavior change) — only extract something when it reflects a real, "
    "specific constraint. Respond with ONLY a JSON array, no prose before or after: "
    '[{"file": "path/to/file", "insight": "one or two sentence gotcha", "source_pr": 123}]. '
    "Every \"file\" value must be a path that actually appears in the PR's file list "
    "given to you — never invent one. If a PR yields no durable insight, omit it "
    "entirely. If nothing in the whole batch is worth surfacing, respond with []."
)


def extract_invariants(prs, provider, model, api_key, base_url=None, max_prs=15):
    """Feeds up to `max_prs` PR summaries to the configured LLM and asks it to
    extract durable per-file invariants. Returns {"ok": True, "insights": [...]}
    or {"ok": False, "error": "..."}."""
    if not prs:
        return {"ok": True, "insights": []}
    batch = prs[:max_prs]
    blocks = []
    for pr in batch:
        files_preview = ", ".join(pr["files"][:8]) + (" …" if len(pr["files"]) > 8 else "") if pr["files"] else "(file list unavailable)"
        body_preview = (pr["body"] or "").strip()[:600]
        blocks.append(f"PR #{pr['number']}: {pr['title']}\nFiles: {files_preview}\n{body_preview}")
    user_content = "\n\n---\n\n".join(blocks)
    try:
        text = llm_providers.call_llm(
            provider, model, api_key, INVARIANT_SYSTEM_PROMPT,
            [{"role": "user", "content": user_content}], max_tokens=2000, base_url=base_url,
        )
        parsed = llm_providers.extract_json(text, expect="array")
        insights = [
            {"file": item["file"], "insight": item["insight"], "source_pr": item.get("source_pr")}
            for item in parsed
            if isinstance(item, dict) and item.get("file") and item.get("insight")
        ]
        return {"ok": True, "insights": insights}
    except Exception as e:
        return {"ok": False, "error": f"Could not extract insights from PR history: {e}"}


def mine_repo(repo_path, provider, model, api_key, base_url=None, token=None):
    """End-to-end best-effort pipeline for one repo: detect remote -> fetch
    recently merged PRs/MRs -> extract invariants via LLM. Always returns a
    dict with "ok"; never raises."""
    remote = detect_remote(repo_path)
    if not remote:
        return {"ok": False, "error": "No GitHub or GitLab.com 'origin' remote detected for this repo (local-only clones, or self-hosted Git servers, aren't supported yet)."}
    pr_result = fetch_recent_prs(remote, token=token)
    if not pr_result["ok"]:
        return pr_result
    if not pr_result["prs"]:
        return {"ok": True, "insights": [], "note": "No recently merged pull/merge requests found."}
    return extract_invariants(pr_result["prs"], provider, model, api_key, base_url=base_url)
