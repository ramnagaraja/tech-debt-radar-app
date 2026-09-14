"""
Blast-radius / change-impact queries over the combined dependency graph
(code imports, DB foreign keys, code-to-table references, and — once
coupling_analyzer.py has run — implicit runtime couplings like shared
caches, queues, or services). This is pure graph traversal over the
`edges` list every analysis run already produces in dashboard_data.json;
it adds no new analysis, just a new way to query data that's already there.

"Blast radius" here means: starting from one file or table, walk the graph
outward and report every node reachable within a hop limit, tagged with
how it's reached (upstream = this node's own dependencies, i.e. what it
relies on; downstream = things that depend on it, i.e. what could break if
it changes) and how many hops away it is. This is the same fan_in/fan_out
data already shown per-node, generalized to more than one hop and made
queryable for a specific node on demand — the "should I be careful before
touching this?" question a tech lead actually asks before a refactor.
"""
from collections import defaultdict, deque

HIGH_DEBT_THRESHOLD = 0.6  # matches summary.high_debt_count elsewhere in the app


def build_adjacency(edges):
    """Returns (out_adj, in_adj): {node_id: [(neighbor_id, edge_type), ...]}.
    out_adj[n] = nodes n points AT (n's own dependencies).
    in_adj[n]  = nodes that point AT n (n's dependents)."""
    out_adj = defaultdict(list)
    in_adj = defaultdict(list)
    for e in edges:
        src, tgt = e.get("source"), e.get("target")
        if not src or not tgt:
            continue
        et = e.get("edge_type", "code_import")
        out_adj[src].append((tgt, et))
        in_adj[tgt].append((src, et))
    return out_adj, in_adj


def blast_radius(node_id, edges, direction="both", max_depth=3):
    """BFS outward from node_id over `edges`.

    direction:
      "downstream" — what depends on this node (in_adj) — "what could break
        if I change this".
      "upstream"   — what this node depends on (out_adj) — "what I'm
        exposed to / what could break this".
      "both"       — both directions in one traversal (default).

    Returns a dict with `root`, `direction`, `max_depth`, and `nodes`: a
    list of {id, hops, edge_type, direction, via} sorted by hops then id.
    A node reachable by more than one path keeps only the first (shortest)
    hop count it was found at, since that's the meaningful "how many steps
    away" answer; `via` names one concrete predecessor on that shortest
    path (not necessarily the only one) so a UI can show one example edge.
    The root itself is never included in `nodes`.
    """
    out_adj, in_adj = build_adjacency(edges)
    visited = {node_id}
    nodes = []
    queue = deque([(node_id, 0)])

    def neighbors_of(n):
        out = []
        if direction in ("upstream", "both"):
            out += [(t, et, "upstream") for t, et in out_adj.get(n, [])]
        if direction in ("downstream", "both"):
            out += [(t, et, "downstream") for t, et in in_adj.get(n, [])]
        return out

    while queue:
        current, depth = queue.popleft()
        if depth >= max_depth:
            continue
        for neighbor, edge_type, dir_label in neighbors_of(current):
            if neighbor in visited:
                continue
            visited.add(neighbor)
            nodes.append({"id": neighbor, "hops": depth + 1, "edge_type": edge_type, "direction": dir_label, "via": current})
            queue.append((neighbor, depth + 1))

    nodes.sort(key=lambda r: (r["hops"], r["id"]))
    return {"root": node_id, "direction": direction, "max_depth": max_depth, "nodes": nodes, "total_affected": len(nodes)}


def enrich_with_node_data(result, nodes_by_id):
    """Attaches debt_score/kind to each node in a blast_radius() result (when
    known — a node can be named by an edge but not present in the current
    run's node list, e.g. a coupling edge pointing at an external service
    name rather than an analyzed file/table) and adds a summary block:
    total affected, how many are high-debt, and a breakdown by hop count
    and by edge_type. Mutates and returns `result`."""
    by_hops = defaultdict(int)
    by_edge_type = defaultdict(int)
    high_debt_count = 0
    for n in result["nodes"]:
        node = nodes_by_id.get(n["id"])
        if node is not None:
            n["debt_score"] = node.get("debt_score")
            n["kind"] = node.get("kind")
            if (node.get("debt_score") or 0) >= HIGH_DEBT_THRESHOLD:
                high_debt_count += 1
        else:
            n["debt_score"] = None
            n["kind"] = "external"  # named by an edge (e.g. a coupling target) but not an analyzed node
        by_hops[n["hops"]] += 1
        by_edge_type[n["edge_type"]] += 1
    result["summary"] = {
        "total_affected": result["total_affected"],
        "high_debt_count": high_debt_count,
        "by_hops": dict(sorted(by_hops.items())),
        "by_edge_type": dict(by_edge_type),
    }
    return result
