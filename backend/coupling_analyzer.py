"""
Implicit runtime-coupling detection.

Import graphs and DB foreign keys only capture *compile-time* coupling —
files that literally reference each other. Two services that never import
one another can still be tightly coupled at runtime because they read and
write the same Redis key, publish/consume the same Kafka topic, or share a
queue/exchange name. That coupling is invisible to every other analyzer in
this app and is exactly the kind of thing that turns "just delete this
unused-looking file" into a production incident.

This is a heuristic, language-agnostic v1: it scans the same `source_text`
dict every language analyzer already contributes to (raw file text, keyed
by namespaced file id — see multi_source.analyze_repos), looks for known
messaging/cache library signatures, and pulls out literal queue/topic/
channel/key names and well-known env-var names near them. Two files that
both talk to the same library AND reference the same literal name become a
coupling edge. It will miss couplings expressed only through indirection
(a name built from a runtime variable, a constant imported from a third
file) — that's the honest limit of a regex pass with no type/dataflow
information — but it catches the common, costly case: hardcoded queue and
channel names duplicated (or copy-pasted) across services.
"""
import re
from collections import defaultdict

# Library/client signatures used only to *classify* a file into a coupling
# category — matching here does not by itself create an edge; a shared key
# (below) between two files in the same category does.
LIBRARY_SIGNATURES = {
    "coupling_redis": re.compile(r"\bredis\b|StackExchange\.Redis|ioredis", re.IGNORECASE),
    "coupling_kafka": re.compile(r"\bkafka\b", re.IGNORECASE),
    "coupling_queue": re.compile(r"\b(rabbitmq|amqp|pika|sqs|sns|celery|bullmq|servicebus|azure\.servicebus)\b", re.IGNORECASE),
}

# Literal key/queue/topic/channel names passed to common pub/sub, cache, or
# messaging calls — e.g. redis.publish("orders:created", ...),
# channel.basic_publish(exchange="orders", ...), QueueUrl="user-signups".
KEY_RE = re.compile(
    r"(?:queue(?:_name|url)?|topic(?:_name|arn)?|channel|exchange|routing_key|cache_key)"
    r"\s*[=:\(]\s*[\"']([\w./:\-]{3,80})[\"']",
    re.IGNORECASE,
)

# The same, but for pub/sub method calls that take the name as a positional
# first argument rather than a keyword — e.g. redis_client.publish("orders:created", body),
# socket.emit("user-events", data). Deliberately narrow to verb names that are
# almost always messaging calls (not, say, generic "send") to keep noise down.
POSITIONAL_KEY_RE = re.compile(
    r"\.(?:publish|subscribe|basic_publish|basic_consume|emit)\s*\(\s*[\"']([\w./:\-]{3,80})[\"']",
    re.IGNORECASE,
)

# Well-known env-var names that name a shared broker/cache — two files that
# both reference the same one are coupled even with no literal topic name in
# sight (the actual topic/key lives in config, not in either file).
ENV_VAR_CATEGORY = {
    "REDIS_URL": "coupling_redis", "REDIS_HOST": "coupling_redis", "REDIS_CONNECTION_STRING": "coupling_redis",
    "KAFKA_BROKERS": "coupling_kafka", "KAFKA_BOOTSTRAP_SERVERS": "coupling_kafka",
    "AMQP_URL": "coupling_queue", "RABBITMQ_URL": "coupling_queue",
    "SQS_QUEUE_URL": "coupling_queue", "SNS_TOPIC_ARN": "coupling_queue",
    "SERVICEBUS_CONNECTION_STRING": "coupling_queue",
}
ENV_VAR_RE = re.compile(r"\b(" + "|".join(re.escape(v) for v in ENV_VAR_CATEGORY) + r")\b")

EDGE_TYPE_LABELS = {
    "coupling_redis": "Shared Redis key/connection",
    "coupling_kafka": "Shared Kafka topic/broker",
    "coupling_queue": "Shared queue/exchange (AMQP/SQS/SNS/etc.)",
    "coupling_shared_key": "Shared literal key (unclassified library)",
}

MAX_FILES_PER_KEY = 25  # a key shared by more files than this is almost always a false-positive keyword (e.g. "queue" as a variable name, not a real shared resource) — skip it rather than emit a near-complete graph


def _categories_in(text):
    return {cat for cat, sig in LIBRARY_SIGNATURES.items() if sig.search(text)}


def detect_coupling(source_text):
    """source_text: {file_id: raw_text}. Returns a list of coupling edges:
    {"source": file_a, "target": file_b, "edge_type": "coupling_redis"|...,
    "coupling_key": the shared literal that produced this edge}.

    Never raises — a regex that finds nothing just yields no edges, which is
    the correct, honest answer when this heuristic can't see a coupling."""
    file_keys = defaultdict(lambda: defaultdict(set))  # file -> category -> {keys}

    for file_id, text in (source_text or {}).items():
        if not text:
            continue
        cats = _categories_in(text)
        literal_keys = {m.group(1).lower() for m in KEY_RE.finditer(text)}
        literal_keys |= {m.group(1).lower() for m in POSITIONAL_KEY_RE.finditer(text)}
        env_keys = {(ENV_VAR_CATEGORY[m.group(1)], m.group(1).lower()) for m in ENV_VAR_RE.finditer(text)}

        if literal_keys:
            target_cats = cats if cats else {"coupling_shared_key"}
            for cat in target_cats:
                file_keys[file_id][cat] |= literal_keys
        for cat, key in env_keys:
            file_keys[file_id][cat].add(key)

    # Group files sharing a (category, key) pair.
    group = defaultdict(set)
    for file_id, cats in file_keys.items():
        for cat, keys in cats.items():
            for key in keys:
                group[(cat, key)].add(file_id)

    edges = []
    for (cat, key), files in group.items():
        if len(files) < 2 or len(files) > MAX_FILES_PER_KEY:
            continue
        ordered = sorted(files)
        for i in range(len(ordered)):
            for j in range(i + 1, len(ordered)):
                edges.append({"source": ordered[i], "target": ordered[j], "edge_type": cat, "coupling_key": key})
    return edges
