# Integration Patterns: A Practical Reference

**Primary canonical sources**: Gregor Hohpe & Bobby Woolf, *Enterprise
Integration Patterns* (2003) — the catalog that named and formalized most of
the messaging patterns below; Eric Evans, *Domain-Driven Design* (2003) for the
Anti-Corruption Layer; Martin Fowler, "StranglerFigApplication" (martinfowler.com,
2004) for the Strangler Fig migration pattern; Chris Richardson, *Microservices
Patterns* (2018) for the Saga and Transactional Outbox patterns, which formalize
solutions to distributed-transaction problems that arise directly from
following the integration patterns below. This document is an original summary
written for this codebase's own integration-debt signal vocabulary, not a
reproduction of any of the above. It covers how independently deployed systems
exchange data and coordinate; see this knowledge base's companion
microservices-architecture document for service-boundary and resilience
concerns (circuit breakers, API gateways, bounded contexts), which this
document deliberately does not repeat.

## Message channel and point-to-point vs. publish-subscribe

*Source: Hohpe & Woolf, "Enterprise Integration Patterns" — Message Channel,
Point-to-Point Channel, and Publish-Subscribe Channel.*

A message channel is the basic unit of asynchronous integration: a logical
pipe one system writes to and another reads from, decoupling sender from
receiver in time (the receiver doesn't need to be available the instant the
message is sent) as well as in space (sender and receiver don't call each
other directly). Point-to-point delivers each message to exactly one
consumer (a work queue — the right shape for distributing units of work across
a pool of workers); publish-subscribe delivers each message to every
subscriber (a topic/event stream — the right shape for broadcasting a fact
that multiple independent systems each need to react to). Reaching for the
wrong one is a common integration-debt source: point-to-point used where
multiple systems actually need the same event silently drops the event for
everyone but whichever consumer happened to claim it first.

## Competing consumers for horizontal scale

*Source: Hohpe & Woolf, "Enterprise Integration Patterns" — Competing
Consumers.*

Multiple consumer instances read from the same point-to-point channel, each
message processed by exactly one of them, so throughput scales by adding
consumer instances rather than by making a single consumer faster. This is the
standard shape behind most task-queue/worker-pool systems. The two things that
make this safe rather than a source of duplicate or lost work: message
acknowledgment only after successful processing (so a crashed consumer's
in-flight message is redelivered, not lost), and idempotent message handling
(so a message redelivered after a slow-but-successful process, whose
acknowledgment was lost, doesn't get double-applied) — the same idempotency
concern this knowledge base's API-best-practices document covers for synchronous
retries, here applying to asynchronous redelivery instead.

## Dead-letter channel for poison messages

*Source: Hohpe & Woolf, "Enterprise Integration Patterns" — Dead Letter
Channel/Invalid Message Channel.*

A message that repeatedly fails processing (malformed, or triggering a bug in
the consumer) shouldn't be retried forever, blocking every message queued
behind it, nor silently dropped, losing the failure signal. A dead-letter
channel is where a message goes after exceeding a retry limit, for manual
inspection or automated alerting — separating "this one message is broken" from
"the whole pipeline is down." Code-level tell: a message consumer with a retry
loop and no maximum-attempts cap, or one whose failure path is a bare
`except: pass`/`catch (e) {}` that silently discards the message.

## Message translator and anti-corruption layer

*Source: Hohpe & Woolf, "Enterprise Integration Patterns" — Message
Translator; Eric Evans, "Domain-Driven Design" — Anti-Corruption Layer, a more
specific application of the same idea at a bounded-context boundary.*

A message translator converts a message from one system's data format into
another's, so two systems with incompatible schemas can still communicate
without either being modified. An anti-corruption layer generalizes this to an
entire external system or legacy subsystem: a dedicated translation layer that
keeps an external system's domain model, naming, and quirks from leaking into
your own domain model, so your own code speaks its own clean vocabulary even
while depending on a messier upstream. Code-level tell: external-API field
names, enum values, or status codes threaded directly through internal domain
objects and business logic, rather than translated once at the integration
boundary.

## Content-based router

*Source: Hohpe & Woolf, "Enterprise Integration Patterns" — Content-Based
Router.*

Inspects a message's content and routes it to one of several possible
downstream channels/handlers based on that content, rather than every
consumer receiving every message and filtering internally. This is the
messaging-infrastructure-level counterpart to the Chain of Responsibility and
Strategy design patterns (see this knowledge base's design-patterns document):
the same "pick the right handler without a long conditional" problem, applied
at the level of routing messages between systems rather than dispatching a
function call within one.

## Saga pattern for distributed transactions

*Source: Chris Richardson, "Microservices Patterns" (2018), formalizing a
pattern with roots in Hector Garcia-Molina & Kenneth Salem's 1987 paper
"Sagas."*

A single business transaction that spans multiple services (e.g. "place an
order" touching an orders service, a payments service, and an inventory
service) can't use a traditional ACID database transaction across service
boundaries — a saga instead breaks it into a sequence of local transactions,
each with a defined compensating action to undo it if a later step in the
sequence fails. This is the direct answer to a specific integration-debt
question worth asking of any multi-service write flow: if step 3 of 4 fails,
what undoes steps 1 and 2? A codebase with no answer to that question for a
given cross-service flow has an implicit, undocumented saga at best, and a
data-consistency bug waiting to happen at worst.

## Transactional outbox for reliable event publishing

*Source: Chris Richardson, "Microservices Patterns" (2018) — Transactional
Outbox, addressing the "dual write" problem.*

Writing to a database and separately publishing a message about that write
(two independent operations against two different systems) can't be made
atomic directly — a crash between the two leaves either an unpublished write
or a published event for a write that never committed. The transactional
outbox pattern writes the event into an "outbox" table in the *same* local
database transaction as the business write, then a separate process reliably
relays outbox rows to the real message channel — turning two independent
writes into one atomic local transaction plus an at-least-once relay. Code-level
tell: a handler that writes to the database and then calls a message
broker/webhook directly afterward, with no compensating logic for the case
where the process crashes between the two calls.

## Idempotent consumer

*Source: Hohpe & Woolf, "Enterprise Integration Patterns" — Idempotent
Receiver; widely reinforced in the same Saga/Outbox literature above, since
at-least-once delivery (the norm for most message brokers) requires it.*

A message consumer should produce the same end state whether it processes a
given message once or several times — necessary because most messaging
infrastructure offers at-least-once delivery, not exactly-once, so duplicate
delivery is an expected, normal event, not an edge case. The standard
implementation: track processed message IDs (or a domain-specific dedup key)
and skip re-processing a message whose ID has already been recorded. Without
this, a redelivered message (from a consumer crash, a network partition, or a
broker's own retry policy) silently double-applies its effect — the
asynchronous-messaging counterpart to the non-idempotent-retry risk this
codebase's own flow-risk scanner flags for synchronous HTTP retries.

## Strangler Fig for incremental migration

*Source: Martin Fowler, "StranglerFigApplication" (martinfowler.com, 2004),
naming the pattern after the strangler fig vine, which grows around a host
tree and gradually replaces it.*

When replacing a legacy system, routing all traffic through a facade/proxy
that initially forwards everything to the legacy system, then incrementally
redirects individual routes/features to the new system as each is rebuilt and
verified, avoids the two failure modes of a "big bang" rewrite: a long period
with no shippable progress, and a single high-risk cutover where every feature
switches over at once. The facade is what makes this an integration pattern
rather than purely a project-management strategy — it's the same
content-based-routing shape as above, applied to routing between an old
implementation and a new one instead of between business-logic handlers.
