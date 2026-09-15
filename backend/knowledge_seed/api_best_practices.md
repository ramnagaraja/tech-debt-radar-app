# API Design Best Practices: A Practical Reference

**Primary canonical sources**: Roy Fielding, "Architectural Styles and the
Design of Network-based Software Architectures" (doctoral dissertation, 2000) —
the dissertation that defined REST; the Microsoft REST API Guidelines and
Google API Design Guide (both public, continuously maintained industry
references) for the concrete conventions below; the OpenAPI Initiative's
OpenAPI Specification for API-contract documentation; IETF RFC 7231 (HTTP/1.1
Semantics) for status-code and method semantics; IETF RFC 6902 (JSON Patch)
and RFC 7396 (JSON Merge Patch) for partial-update semantics. This document is
an original summary written for this codebase's own API-debt signal
vocabulary, not a reproduction of any of the above. It focuses on
request/response-surface design; see this knowledge base's companion
microservices-architecture document for service-to-service concerns (circuit
breakers, API gateways, contract versioning at the service-boundary level),
which this document deliberately does not repeat.

## Resource-oriented URI design

*Source: Fielding's dissertation (resources as the core REST abstraction);
Microsoft and Google API guidelines for the concrete naming conventions.*

A URI should identify a resource (a noun — `/orders`, `/orders/{id}`), not an
action (`/getOrders`, `/createOrder`) — the HTTP method already carries the
verb. Nested resources should reflect genuine ownership (`/customers/{id}/orders`
for orders that only make sense under a customer), not every possible query
relationship, which belongs in query parameters instead
(`/orders?customer_id={id}`). Code-level tell: endpoint names containing verbs
that duplicate their HTTP method (`POST /createUser`), or a URI structure that
doesn't match the actual data model's ownership graph.

## HTTP methods and status codes used for their defined semantics

*Source: RFC 7231 (HTTP/1.1 Semantics and Content).*

`GET` must be safe (no side effects) and idempotent; `PUT` replaces a resource
and is idempotent (calling it twice with the same body leaves the same end
state); `PATCH` applies a partial update and is not required to be idempotent
unless implemented as one (JSON Merge Patch/JSON Patch semantics); `POST`
creates a new subordinate resource or triggers a non-idempotent action;
`DELETE` is idempotent (deleting an already-deleted resource is still "not
present" afterward). Status codes should be specific enough for a client to
branch on programmatically: `400` for a malformed/invalid request, `401` for
missing/invalid authentication, `403` for authenticated-but-not-authorized,
`404` for a resource that doesn't exist, `409` for a conflicting state (e.g. a
duplicate unique key), `422` for semantically invalid input that is
well-formed JSON, `429` for rate-limiting, `500` only for genuinely unexpected
server failures. Code-level tell: every error path returning `200` with an
`{"error": ...}` body (forces every client to parse the body to know if a call
succeeded), or every failure collapsing to a generic `400`/`500` regardless of
cause.

## Idempotency for unsafe operations

*Source: RFC 7231's idempotency definitions; Stripe and Google Cloud's public
API documentation, both of which popularized the client-supplied idempotency
key as the standard solution for this problem at scale.*

`POST` (create, and any custom action endpoint) is the one common method
without built-in idempotency, which matters most exactly where it's riskiest:
a client retrying a request after a timeout, with no way to know whether the
original request actually succeeded server-side before the response was lost.
Without a safeguard, a naive retry can double-charge a payment, double-send a
notification, or double-insert a record. The standard fix is a client-supplied
idempotency key (a UUID generated once per logical operation, sent as a header
or body field) that the server checks against a short-lived store before
executing the operation a second time. This is precisely the condition this
codebase's own flow-risk scanner checks for statically: a retry loop wrapped
around a mutating call (an HTTP `POST`/`PUT`/`DELETE`, or an `INSERT`/`UPDATE`
statement) with no idempotency-key, nonce, or dedup check anywhere nearby is
flagged as a `non_idempotent_retry` finding.

## Consistent, structured error responses

*Source: RFC 7807 ("Problem Details for HTTP APIs"), the IETF standard for a
machine-readable error body shape.*

Every error response across an API's endpoints should share one predictable
shape (an error `code`, a human-readable `message`, optionally a `details`
list for field-level validation errors) rather than each endpoint inventing
its own ad hoc error format. A client integrating against the API should be
able to write one error-handling code path, not one per endpoint. Code-level
tell: grep for how many distinct error-response shapes actually appear across
an API's handlers — more than one or two is a sign this never got
standardized.

## Pagination for collection endpoints

*Source: Google and Microsoft API guidelines; widely convergent industry
practice (GitHub, Stripe, and most major public APIs use one of the two
variants described here).*

Any endpoint that can return an unbounded collection needs pagination from the
start — retrofitting it later is a breaking change for every existing client.
Two common approaches: offset/limit (simple, but degrades in performance and
correctness on a large, actively-written table as rows shift between pages)
and cursor-based (a token derived from the last item's sort key, stable
under concurrent writes, the preferred approach for any collection that
changes while being paged through). Code-level tell: a `GET` list endpoint
with no `limit`/`page_size` parameter at all, or one whose maximum result size
is unbounded.

## Authentication and authorization enforced at the API boundary

*Source: OWASP API Security Top 10 (the OWASP Foundation's community-maintained
industry-standard risk list for APIs specifically, distinct from its
general web Top 10).*

Every endpoint should have an explicit, auditable authorization decision — not
an implicit one inherited from "this endpoint is only ever called by trusted
code," which breaks the moment a new caller is added. The two OWASP API
Security Top 10 items this shows up as most often in practice: Broken Object
Level Authorization (an endpoint checks that the caller is authenticated, but
not that the caller is allowed to access *this specific* resource ID — e.g.
`GET /orders/{id}` returning any order for any logged-in user, not just the
caller's own), and Broken Function Level Authorization (an admin-only action
reachable by a non-admin caller who simply calls the endpoint directly,
because the check lives only in a UI that happens to hide the button). Both are
about authorization checks living at the API boundary, on every request,
rather than being assumed from context.

## Input validation at the boundary, not deep in business logic

*Source: OWASP API Security Top 10 ("Unrestricted Resource Consumption" and
injection-class risks); general secure-coding guidance across the industry.*

Request bodies, query parameters, and path parameters should be validated
(type, format, range, required-vs-optional) at the API layer, before that data
reaches business logic or a database query — both so invalid input fails fast
with a clear `400`/`422`, and so every downstream function can assume its
inputs are already well-formed rather than re-validating (or, worse, silently
trusting) the same data repeatedly. This is also the layer where
injection-class vulnerabilities (SQL injection, command injection) are
structurally prevented: parameterized queries and typed request models,
enforced once at the boundary, rather than string-concatenated queries built
ad hoc in handler code.

## Rate limiting and resource-consumption limits

*Source: OWASP API Security Top 10 ("Unrestricted Resource Consumption").*

An API with no limit on request rate, payload size, or response-set size per
client is exposed to both accidental abuse (a buggy client polling in a tight
loop) and deliberate abuse (denial of service, scraping). A `429 Too Many
Requests` response with a `Retry-After` header is the standard shape for
communicating a rate limit back to a well-behaved client. This is
infrastructure-adjacent but belongs in API design because the limit values
(per-endpoint, per-client-tier) are a design decision, not just an ops
configuration.

## Machine-readable API contracts (OpenAPI/Swagger)

*Source: The OpenAPI Initiative's OpenAPI Specification.*

An API's request/response shapes, status codes, and authentication
requirements should exist as a machine-readable contract (an OpenAPI document,
generated from code annotations/types where the framework supports it, rather
than hand-maintained separately from the implementation) — this is what
enables client SDK generation, contract testing, and documentation that can't
silently drift out of sync with the actual implementation the way a
hand-written wiki page can. Code-level tell: an API with no OpenAPI/Swagger
document at all, or one that is hand-maintained and demonstrably out of date
against the actual routes in code.
