# Microservices Architecture Best Practices: A Practical Reference

**Primary canonical sources**: Sam Newman, *Building Microservices* (2015, 2nd
ed. 2021); Martin Fowler & James Lewis, "Microservices" (martinfowler.com,
2014) — the article that named and defined the pattern; Chris Richardson,
*Microservices Patterns* (2018); Michael Nygard, *Release It!* (2007, 2nd ed.
2018) for stability patterns (circuit breaker, bulkhead); Gregor Hohpe & Bobby
Woolf, *Enterprise Integration Patterns* (2003) for asynchronous-messaging
patterns. This document is an original summary written for this codebase's own
dependency/coupling debt signals, not a reproduction of any of the above.

## Bounded contexts and single data ownership

*Source: Eric Evans, "Domain-Driven Design" (2003) for bounded contexts;
Newman and Richardson both make single data ownership per service a core
microservices tenet.*

Each service should own a distinct business capability (a "bounded context")
and be the only service that reads and writes its own data. Two services
sharing direct access to the same database table is one of the most common
ways a microservices system quietly becomes a "distributed monolith" — you pay
all the operational cost of network calls and independent deployment, but keep
all the coupling cost of a shared schema, since neither service can change its
own table without checking the other. Code-level tell: two independently
deployable codebases with SQL/ORM code referencing the same table name, or
foreign keys crossing what should be a service boundary.

## Avoiding chatty, synchronous call chains

*Source: Newman's discussion of synchronous vs. asynchronous collaboration in
"Building Microservices"; Fowler & Lewis's original article calls out "smart
endpoints, dumb pipes."*

A request that fans out into a long synchronous chain of service-to-service
calls (A calls B calls C calls D to answer one user request) compounds latency
and failure probability at every hop, and makes the system's actual behavior
hard to reason about from any single service's code. Two mitigations: (1)
prefer asynchronous, event-driven collaboration (a service publishes a fact;
interested services react on their own schedule) over synchronous
request/response chains wherever the caller doesn't need an immediate answer;
(2) where a synchronous call graph really is required, keep it shallow — a high
fan-out/fan-in count on a single file or service (many other modules it calls
into, or many that call into it) is the same coupling smell whether it's
happening inside one codebase or across a network, and is worth flagging the
same way regardless of physical deployment boundary.

## Resilience: circuit breakers, retries, and timeouts

*Source: Michael Nygard, "Release It!" (2007) — coined the Circuit Breaker
pattern for software; widely adopted in service-mesh and client-library
implementations since.*

Any call across a service boundary can fail or hang, and a service that calls a
failing dependency without a timeout risks exhausting its own resources waiting
on it, which then cascades the failure upstream. A circuit breaker tracks a
downstream dependency's recent failure rate and "opens" (fails fast without
attempting the call) once failures cross a threshold, giving the dependency
room to recover instead of being hit with a continued flood of retries.
Combined with a sane per-call timeout and a bounded number of retries (ideally
with backoff), this keeps one failing service from taking down every service
that depends on it — the opposite of a tightly coupled call chain with no
failure isolation.

## API contracts and backward-compatible versioning

*Source: Newman's chapter on service evolution in "Building Microservices";
also standard practice in API-gateway and public-API design generally.*

Because each service deploys independently, a breaking change to a service's
API can break every caller the moment it ships, even though the caller's own
code hasn't changed. The standard mitigation is treating the API contract as a
first-class, versioned artifact: additive changes (new optional fields, new
endpoints) don't require a version bump; anything that removes or changes the
meaning of an existing field does, and the old version should keep working
for a defined deprecation window so callers can migrate on their own schedule
rather than being forced to upgrade in lockstep with the service's own release.

## The API gateway / backend-for-frontend

*Source: Chris Richardson, "Microservices Patterns" (2018), API Gateway
pattern; the Backend-for-Frontend variant is credited to Phil Calçado's work at
SoundCloud (2015).*

Rather than a client (web or mobile) calling many individual services directly
— which couples every client to every service's internal topology, and makes
cross-cutting concerns like auth, rate limiting, and request logging something
every service has to reimplement — a gateway or backend-for-frontend service
sits in front, routes to the right internal services, and aggregates their
responses into what the client actually needs. Internal services can then
evolve their own boundaries without every client needing to know about it.

## Recognizing a "distributed monolith"

*Term used throughout Newman's writing and widely in the microservices
community to describe the failure mode where teams adopt the operational
complexity of microservices without actually achieving service independence.*

Warning signs, several of which map directly onto structural debt signals: (1)
every service must be deployed together because their contracts changed in
lockstep — no real independence; (2) services share a database or schema
directly rather than each owning its own data; (3) a single logical change
requires coordinated pull requests across many services' repositories at once;
(4) synchronous call chains several hops deep are required to answer even
simple requests. Any of these erodes the actual benefit microservices are
meant to provide (independent deployability) while keeping all of the added
operational cost (network calls, distributed tracing, eventual consistency).
