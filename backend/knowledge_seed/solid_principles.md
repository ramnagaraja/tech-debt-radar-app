# SOLID Principles: A Practical Reference

The SOLID principles are five guidelines for keeping object-oriented (and, with
minor translation, functional/module-based) code easy to change without breaking
unrelated things. They are heuristics, not laws — the point is always to reduce
the cost of the *next* change, not to satisfy a checklist.

**Canonical source**: the five principles and the acronym "SOLID" were introduced
and popularized by Robert C. Martin ("Uncle Bob"), collected in *Agile Software
Development: Principles, Patterns, and Practices* (2002) and later *Clean
Architecture* (2017); the Liskov Substitution Principle originates from Barbara
Liskov's 1987 keynote "Data Abstraction and Hierarchy" and her 1994 paper with
Jeannette Wing formalizing the substitution requirement. This document is an
original summary of those ideas for this codebase's own vocabulary of debt
signals, not a reproduction of that text.

## Single Responsibility Principle (SRP)

*Source: Robert C. Martin — a unit of code should have exactly one reason to change.*

A module, class, or function should have one reason to change. In practice, SRP
violations show up as "god objects" or "god files": a single file that renders UI,
fetches data, validates input, formats output, and handles error logging all at
once. Tells that SRP is being violated:

- A file with a very high number of public functions/exported symbols, especially
  when they cover unrelated concerns (e.g. one file mixing chart rendering, SQL
  queries, and alert dispatch).
- A single function with high cyclomatic complexity and deep nesting because it
  is branching on several unrelated axes at once (e.g. domain x role x
  environment all inside one `render()`).
- Editing "one feature" requires touching a file that has nothing to do with that
  feature, because the feature's logic is tangled into a shared god file.

Fix: extract each responsibility into its own module/function/class with a narrow,
named purpose. A useful test is: "can I describe what this unit does in one
sentence without using the word 'and'?" If not, split it.

## Open/Closed Principle (OCP)

*Source: Bertrand Meyer, "Object-Oriented Software Construction" (1988); restated by Robert C. Martin as part of SOLID.*

Software entities should be open for extension but closed for modification —
adding a new case should mean adding new code, not editing a long chain of
existing conditionals. The classic tell is a long `if/elif`/`switch`/`match` chain
that dispatches behavior by type, mode, or category, and that keeps growing every
time a new case is added.

Fix: replace the conditional chain with polymorphism (a strategy/dispatch table
keyed by the same discriminator, or a small class hierarchy with one
implementation per case). Adding a new case then means adding one new
implementation, not editing a function everyone else also depends on — which also
shrinks the blast radius of a change and makes the existing cases easier to test
in isolation.

## Liskov Substitution Principle (LSP)

*Source: Barbara Liskov, 1987 OOPSLA keynote; formalized with Jeannette Wing in "A Behavioral Notion of Subtyping" (1994).*

A subtype must be usable anywhere its supertype is expected, without surprising
the caller. Violations are often subtle: a subclass that overrides a method to
throw where the base class wouldn't, silently returns a different type, or
requires extra preconditions the base type didn't. A common code smell is a
caller doing `if isinstance(x, SpecificSubclass): ...` to special-case one
subtype — that usually means the subtype broke the substitutability contract the
supertype promised.

Fix: if a subtype needs to behave meaningfully differently from its supertype,
it is probably the wrong abstraction — favor composition (has-a) over an
inheritance relationship that doesn't hold in every case, or narrow the shared
interface to only the behavior every implementation can honor identically.

## Interface Segregation Principle (ISP)

*Source: Robert C. Martin, developed while consulting at Xerox on the printer's client-side software.*

Clients shouldn't be forced to depend on methods they don't use. A wide interface
(or a function with many optional parameters/many boolean flags) that only a
subset of callers actually need is an ISP smell — every caller pays the coupling
cost of the whole surface even though they only use a slice of it. This shows up
concretely as "many boolean flag" parameters or props: a function or component
taking more than a handful of independent boolean switches usually means several
distinct behaviors have been jammed into one interface instead of being split, or
expressed through composition/control inversion (e.g. passing a render function
or child component instead of a flag that toggles internal behavior).

Fix: split a fat interface into several narrow ones, each serving one kind of
caller; replace a pile of boolean parameters with either separate functions, a
discriminated-union options object, or inversion of control (the caller supplies
the varying behavior rather than the callee branching on a flag).

## Dependency Inversion Principle (DIP)

*Source: Robert C. Martin, "Object Oriented Software Engineering: A Use Case Driven Approach" essays and Clean Architecture (2017).*

High-level modules shouldn't depend on low-level modules directly; both should
depend on abstractions. In practice: business logic should not import a concrete
database client, HTTP client, or third-party SDK directly — it should depend on
an interface/protocol that a concrete adapter implements, so the business logic
can be tested and reused without the concrete dependency, and the concrete
dependency can be swapped without touching the business logic. A tell is business
logic that becomes hard to unit test without spinning up a real database or
network call — that's usually because it's depending on the concrete
implementation instead of an abstraction over it.

## How these interact with reusability and duplication

Duplicated logic (the same function structure appearing in more than one place,
just with renamed variables) is often a *downstream symptom* of an SRP or DIP
violation: because a responsibility wasn't extracted into its own reusable unit,
each place that needed it re-implemented it slightly differently. The fix for
duplication is rarely "extract a helper function" alone — it's worth asking which
of the five principles above was skipped that let the duplication happen in the
first place, since fixing the root cause prevents the next copy-paste too.
