# Common Design Patterns: A Practical Reference

**Primary canonical source**: Erich Gamma, Richard Helm, Ralph Johnson, and John
Vlissides ("the Gang of Four"), *Design Patterns: Elements of Reusable
Object-Oriented Software* (1994) — the catalog that named and formalized most of
the patterns below. Additional sources are called out per pattern where the
pattern comes from later, more specific literature (enterprise-application or
service-oriented patterns). This document is an original summary written for
this codebase's own debt-signal vocabulary, not a reproduction of any catalog
text.

A design pattern is a named, reusable solution to a recurring structural problem
— useful as shared vocabulary ("this needs a Strategy, not another `if`
branch") and as a checklist of proven shapes, but never a goal in itself: forcing
a pattern where a plain function would do is its own anti-pattern
("pattern-itis").

## Strategy

*Gang of Four, "Design Patterns" (1994), Behavioral Patterns.*

Defines a family of interchangeable algorithms/behaviors behind one interface,
selected at runtime, instead of a client branching on type/mode to pick behavior
inline. This is the direct fix for the Open/Closed Principle's classic smell: a
long `if/elif`/`switch` chain that dispatches on a category and keeps growing
every time a new category is added. Each branch becomes its own Strategy
implementation; adding a case means adding a new implementation, not editing a
function every other case also depends on.

## Factory Method / Abstract Factory

*Gang of Four, "Design Patterns" (1994), Creational Patterns.*

Delegates object creation to a dedicated method or class instead of scattering
`new`/constructor calls (and the conditional logic that decides which concrete
type to build) throughout the codebase. Useful whenever the concrete type to
instantiate depends on configuration, environment, or runtime data — centralizing
that decision means callers depend on an abstraction, not a concrete class,
which is also a concrete application of the Dependency Inversion Principle.

## Repository

*Popularized by Martin Fowler, "Patterns of Enterprise Application Architecture"
(2002), and Eric Evans, "Domain-Driven Design" (2003).*

Mediates between the domain/business logic and a data source (database, external
API, file) behind a collection-like interface, so business logic depends on an
abstraction ("give me the orders for this customer") rather than a concrete
query, ORM, or client library. This is Dependency Inversion applied specifically
to persistence: it is what makes business logic unit-testable without a real
database, and what lets the underlying storage change without touching the
logic that uses it.

## Adapter

*Gang of Four, "Design Patterns" (1994), Structural Patterns.*

Wraps an existing interface (often a third-party library or legacy component)
with the interface the rest of the codebase actually expects, without modifying
the wrapped code. Useful when integrating an external dependency whose API
doesn't match the shape the domain logic wants — the adapter absorbs that
mismatch in one place instead of leaking the third-party shape throughout the
codebase.

## Decorator

*Gang of Four, "Design Patterns" (1994), Structural Patterns.*

Attaches additional behavior to an object dynamically by wrapping it in another
object sharing the same interface, instead of creating a combinatorial explosion
of subclasses for every combination of behaviors (e.g. a base handler plus
optional logging, caching, and retry behavior, each addable independently). A
smell this fixes: a class hierarchy that has grown a subclass for every
combination of two or more independent, orthogonal behaviors.

## Observer / Publish-Subscribe

*Gang of Four, "Design Patterns" (1994), Behavioral Patterns; the distributed
publish-subscribe variant is described in enterprise-integration literature
such as Hohpe & Woolf, "Enterprise Integration Patterns" (2003).*

Lets an object (the subject) notify a list of dependents (observers) of state
changes without the subject needing to know their concrete types — decoupling
"something happened" from "here's everything that should react to it." Overused,
this pattern can also hide control flow (a change ripples through several
indirect handlers that are hard to trace); it earns its complexity when the set
of reactions genuinely varies independently of the subject.

## Facade

*Gang of Four, "Design Patterns" (1994), Structural Patterns.*

Provides a single, simplified entry point over a set of more complex
subsystems, so callers depend on one narrow interface instead of coordinating
several lower-level components themselves. A common, healthy use is exactly
what a Repository or a service-layer function does for a set of lower-level
data-access or infrastructure calls.

## Anti-pattern: the God Object / God File

*Not a Gang-of-Four pattern — an anti-pattern named and cataloged in
"AntiPatterns: Refactoring Software, Architectures, and Projects in Crisis"
(Brown, Malveau, McCormick, Mowbray, 1998).*

A single class or file that has accumulated too many responsibilities and too
much knowledge of the rest of the system — the structural symptom of repeatedly
violating the Single Responsibility Principle. Concretely: a very large file
with a high public-function/export count spanning unrelated concerns, or one
function with very high cyclomatic complexity and nesting because it is
branching on several unrelated concerns at once. The fix is the same as SRP's:
extract each responsibility into its own focused unit.

## Anti-pattern: the Static Utility Class

*Discussed as a smell in Martin Fowler, "Refactoring: Improving the Design of
Existing Code" (1999, 2nd ed. 2018), under "Feature Envy" and related smells;
also common guidance in functional-programming style guides.*

An exported class where every member is static amounts to a namespace, not an
object — it groups functions without ever needing instance state or
polymorphism. In languages/ecosystems with real module systems (Python modules,
ES modules), plain exported functions serve the same purpose, are more
tree-shakable, and don't imply an object-oriented relationship (inheritance,
overriding) that will never actually be used.
