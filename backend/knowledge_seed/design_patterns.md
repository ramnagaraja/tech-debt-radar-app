# Design Patterns: Gang of Four Catalog and Practical Extensions

**Primary canonical source**: Erich Gamma, Richard Helm, Ralph Johnson, and John
Vlissides ("the Gang of Four"), *Design Patterns: Elements of Reusable
Object-Oriented Software* (1994) — the catalog that named and formalized the 23
patterns below, organized into the same three categories the book uses:
Creational, Structural, and Behavioral. Additional sources are called out per
pattern where the pattern comes from later, more specific literature
(enterprise-application or service-oriented patterns). This document is an
original summary written for this codebase's own debt-signal vocabulary, not a
reproduction of any catalog text.

A design pattern is a named, reusable solution to a recurring structural problem
— useful as shared vocabulary ("this needs a Strategy, not another `if`
branch") and as a checklist of proven shapes, but never a goal in itself: forcing
a pattern where a plain function would do is its own anti-pattern
("pattern-itis"). A codebase with zero named patterns visible in it isn't
necessarily under-engineered; the signal worth acting on is a *recurring* smell
(a growing conditional chain, a combinatorial subclass explosion, scattered
constructor logic) that a specific pattern below directly resolves.

## Creational Patterns

Creational patterns abstract the process of instantiating objects, so a
codebase depends on *what* gets created rather than *how* — the fix whenever
object-construction logic (which concrete type, built from which parameters,
under which lifecycle) has leaked into callers instead of staying in one place.

### Factory Method

*Gang of Four, "Design Patterns" (1994), Creational Patterns.*

Defines an interface for creating an object but lets a subclass decide which
concrete class to instantiate. Useful when a base class knows an object of some
type is needed at a certain point in an algorithm, but shouldn't be coupled to
which concrete subclass gets built — that choice is deferred to whichever
subclass overrides the factory method. The smell this fixes: a base class
`import`-ing and directly constructing concrete subclasses of the very
abstraction it defines, inverting the dependency the class hierarchy is
supposed to provide.

### Abstract Factory

*Gang of Four, "Design Patterns" (1994), Creational Patterns.*

Provides an interface for creating *families* of related objects without
specifying their concrete classes — one level above Factory Method, which
creates a single object. Useful when a system must stay agnostic to a whole
product family (e.g. a UI toolkit's widgets, or a set of database-dialect-
specific query builders) and swap the entire family together, never mixing
members from two families by accident. Both patterns exist to centralize
object creation instead of scattering `new`/constructor calls (and the
conditional logic deciding which concrete type to build) throughout the
codebase — a concrete application of the Dependency Inversion Principle,
since callers end up depending on an abstraction, not a concrete class.

### Builder

*Gang of Four, "Design Patterns" (1994), Creational Patterns.*

Separates the construction of a complex object from its representation, so the
same step-by-step construction process can produce different representations —
in practice, the fix for a constructor (or function) whose parameter list has
grown so long, and so full of optional/mutually-exclusive combinations, that
callers routinely pass `null`/`None` for arguments that don't apply to their
case ("telescoping constructor"). A fluent builder with named, chainable steps
(or, in languages that support them, keyword-only parameters with sensible
defaults) replaces the need to memorize positional argument order or thread
undefined values through a constructor call.

### Prototype

*Gang of Four, "Design Patterns" (1994), Creational Patterns.*

Specifies the kind of object to create using a prototypical instance, and
creates new objects by copying that prototype, rather than instantiating
classes directly. Useful when creating an object is significantly more
expensive than copying one already configured close to what's needed (a
heavyweight object with expensive initialization, or one whose exact concrete
class isn't known until runtime), or when a system needs to stay independent of
how its products are created, composed, and represented.

### Singleton

*Gang of Four, "Design Patterns" (1994), Creational Patterns.*

Ensures a class has only one instance and provides a single global access point
to it. The most misused pattern in the original catalog: a real Singleton
guarantees single-instantiation deliberately (a hardware interface, a single
shared connection pool where a second instance would be actively wrong), but
the same shape is routinely reached for as a shortcut to avoid passing a
dependency explicitly through a call chain — at which point it has become
disguised global mutable state, with every downside that implies (hidden
coupling, hard-to-isolate unit tests, and — the specific failure mode this
codebase's own flow-risk scan checks for — unsynchronized concurrent access
when more than one thread or async task reaches the same instance without a
lock). Before reaching for Singleton, prefer passing the shared instance in
explicitly (constructor/parameter injection) so the dependency stays visible
in every signature that needs it.

## Structural Patterns

Structural patterns compose classes and objects into larger structures while
keeping those structures flexible and efficient — the fix whenever two pieces
of code need to work together but their existing shapes don't fit.

### Adapter

*Gang of Four, "Design Patterns" (1994), Structural Patterns.*

Wraps an existing interface (often a third-party library or legacy component)
with the interface the rest of the codebase actually expects, without modifying
the wrapped code. Useful when integrating an external dependency whose API
doesn't match the shape the domain logic wants — the adapter absorbs that
mismatch in one place instead of leaking the third-party shape throughout the
codebase.

### Bridge

*Gang of Four, "Design Patterns" (1994), Structural Patterns.*

Decouples an abstraction from its implementation so the two can vary
independently — each can be extended (subclassed) on its own axis without the
other's hierarchy exploding to match. The smell this fixes: a class hierarchy
that has grown a subclass for every combination of two independent dimensions
(e.g. `WindowsButton`, `MacButton`, `WindowsCheckbox`, `MacCheckbox` — platform
crossed with widget type), where adding a value on either axis multiplies the
number of subclasses needed on the other.

### Composite

*Gang of Four, "Design Patterns" (1994), Structural Patterns.*

Composes objects into tree structures and lets client code treat an individual
object and a composition of objects through the same interface — a single
leaf node and an entire subtree respond to the same calls uniformly. Useful for
any genuinely recursive/hierarchical domain (a file system, a UI component
tree, an org chart, a nested permissions/menu structure); the smell it fixes is
client code that has to type-check "is this one item or a collection of items"
before it can act, instead of treating both uniformly.

### Decorator

*Gang of Four, "Design Patterns" (1994), Structural Patterns.*

Attaches additional behavior to an object dynamically by wrapping it in another
object sharing the same interface, instead of creating a combinatorial explosion
of subclasses for every combination of behaviors (e.g. a base handler plus
optional logging, caching, and retry behavior, each addable independently). A
smell this fixes: a class hierarchy that has grown a subclass for every
combination of two or more independent, orthogonal behaviors — the same root
cause Bridge addresses for a fixed pair of axes, generalized to any number of
stackable behaviors composed at runtime.

### Facade

*Gang of Four, "Design Patterns" (1994), Structural Patterns.*

Provides a single, simplified entry point over a set of more complex
subsystems, so callers depend on one narrow interface instead of coordinating
several lower-level components themselves. A common, healthy use is exactly
what a Repository or a service-layer function does for a set of lower-level
data-access or infrastructure calls.

### Flyweight

*Gang of Four, "Design Patterns" (1994), Structural Patterns.*

Uses sharing to support large numbers of fine-grained objects efficiently, by
splitting an object's state into "intrinsic" state (shared, immutable, held
once) and "extrinsic" state (passed in by the caller at use time, not stored per
instance). Useful when profiling shows memory pressure from instantiating many
near-identical objects (glyphs in a text editor, particles in a simulation,
repeated cell/row renderers in a large grid) — a narrower, performance-driven
pattern than most of this catalog, and one that should be reached for from a
measured problem, not applied speculatively.

### Proxy

*Gang of Four, "Design Patterns" (1994), Structural Patterns.*

Provides a surrogate or placeholder for another object to control access to it
— the same "stand in for the real thing behind an identical interface" shape as
Adapter and Decorator, but for a different purpose: not converting an
interface (Adapter) or adding behavior the caller asked for (Decorator), but
controlling *when and how* the real object is reached. Common variants: a
virtual proxy that defers expensive initialization until first real use, a
protection proxy that adds an access check, and a remote proxy that makes a
network call look like a local method call to its caller.

## Behavioral Patterns

Behavioral patterns are concerned with algorithms and the assignment of
responsibilities between objects — how control and data flow through a system,
and how objects communicate without becoming tightly coupled to each other's
concrete types.

### Chain of Responsibility

*Gang of Four, "Design Patterns" (1994), Behavioral Patterns.*

Passes a request along a chain of potential handlers until one handles it,
decoupling the sender from knowing which specific handler will act — each
handler either processes the request or forwards it to the next link. Common in
middleware/pipeline architectures (HTTP middleware stacks, validation
pipelines, event-processing chains). The smell it fixes: a single function with
a long, ordered `if/elif` chain of unrelated checks that grows every time a new
kind of handling is added, where each check would rather be its own
independently addable/removable/reorderable handler.

### Command

*Gang of Four, "Design Patterns" (1994), Behavioral Patterns.*

Encapsulates a request (an action plus the arguments and receiver it needs) as
a standalone object, so requests can be queued, logged, undone, or passed
around as first-class values instead of being an immediate direct method call.
This is the structural basis for undo/redo stacks, job queues, and transactional
outboxes — anywhere "the fact that an action was requested" needs to outlive
the moment it was triggered, or be replayed/reversed later.

### Interpreter

*Gang of Four, "Design Patterns" (1994), Behavioral Patterns.*

Given a language, defines a representation for its grammar along with an
interpreter that uses that representation to evaluate sentences in it. Narrow
in practice — genuinely useful when a codebase needs to parse and evaluate a
small domain-specific expression language (a rules engine's condition syntax, a
search-query mini-language, a permission-expression DSL) — but a pattern to
reach for deliberately, not by accident: an ad hoc string-eval or a
hand-rolled mini-parser that has grown organically is a sign this pattern (or
an existing parser-generator library) should have been adopted explicitly.

### Iterator

*Gang of Four, "Design Patterns" (1994), Behavioral Patterns.*

Provides a way to access the elements of an aggregate object sequentially
without exposing its underlying representation — the client code that walks a
collection doesn't need to know whether it's backed by an array, a linked list,
a tree traversal, or a lazily-computed stream. Most modern languages bake this
pattern directly into the language (Python's iterator protocol, JavaScript's
`Symbol.iterator`, C#'s `IEnumerable`), so it's rarely something a codebase
needs to hand-roll today — its main relevance now is recognizing when custom
traversal code has reinvented it instead of implementing the language's own
iterator protocol, which would make the collection interoperate with
`for`-loops, spread syntax, and every other language/library feature that
already expects it.

### Mediator

*Gang of Four, "Design Patterns" (1994), Behavioral Patterns.*

Defines an object that encapsulates how a set of other objects interact,
keeping them from referring to each other directly — every object talks only
to the mediator, and the mediator decides how to coordinate them. Useful when a
set of components have grown a dense many-to-many web of direct references to
each other (every component calling several others), which the mediator
collapses into a hub-and-spoke shape: still coupled, but the coupling is
centralized in one place instead of tangled across every pair of components.

### Memento

*Gang of Four, "Design Patterns" (1994), Behavioral Patterns.*

Captures and externalizes an object's internal state without violating
encapsulation, so that object can later be restored to that state — the basis
for undo functionality, checkpointing, and snapshot/restore features. The
originator object creates the memento and is the only thing that can read its
internals back out; whatever stores the memento (a "caretaker") treats it as
opaque, which is what keeps this from just being "expose all internal state
publicly so something else can save and restore it."

### Observer / Publish-Subscribe

*Gang of Four, "Design Patterns" (1994), Behavioral Patterns; the distributed
publish-subscribe variant is described in enterprise-integration literature
such as Hohpe & Woolf, "Enterprise Integration Patterns" (2003).*

Lets an object (the subject) notify a list of dependents (observers) of state
changes without the subject needing to know their concrete types — decoupling
"something happened" from "here's everything that should react to it." Overused,
this pattern can also hide control flow (a change ripples through several
indirect handlers that are hard to trace); it earns its complexity when the set
of reactions genuinely varies independently of the subject.

### State

*Gang of Four, "Design Patterns" (1994), Behavioral Patterns.*

Lets an object alter its behavior when its internal state changes, appearing to
change its class — each state becomes its own class implementing a shared
interface, and the object delegates to whichever state object is current
instead of branching on a state field/enum throughout its methods. The direct
fix for an object whose methods are each riddled with `if state == X` /
`switch(state)` blocks that all have to be kept in sync whenever a state is
added, removed, or its transition rules change — the same growing-conditional
smell Strategy fixes for interchangeable algorithms, applied instead to an
object's own lifecycle stages.

### Strategy

*Gang of Four, "Design Patterns" (1994), Behavioral Patterns.*

Defines a family of interchangeable algorithms/behaviors behind one interface,
selected at runtime, instead of a client branching on type/mode to pick behavior
inline. This is the direct fix for the Open/Closed Principle's classic smell: a
long `if/elif`/`switch` chain that dispatches on a category and keeps growing
every time a new category is added. Each branch becomes its own Strategy
implementation; adding a case means adding a new implementation, not editing a
function every other case also depends on.

### Template Method

*Gang of Four, "Design Patterns" (1994), Behavioral Patterns.*

Defines the skeleton of an algorithm in a base-class method, deferring specific
steps to subclasses without letting them change the algorithm's overall
structure — the base class controls the sequence ("validate, then fetch, then
transform, then persist"), and each subclass fills in only the steps that
genuinely vary. Distinct from Strategy in where control lives: Strategy lets a
caller swap in an entirely different algorithm object at runtime, while Template
Method fixes the algorithm's shape once, in one place, and only opens specific
steps for extension — useful when several similar procedures duplicate most of
their structure and differ only in a handful of well-defined steps.

### Visitor

*Gang of Four, "Design Patterns" (1994), Behavioral Patterns.*

Represents an operation to be performed on the elements of an object structure,
letting a new operation be defined without changing the classes of the elements
it operates on — each element accepts a visitor and calls back into the
visitor's type-specific method ("double dispatch"). Useful for an object
structure that is stable (rarely gains new element types) but needs many
unrelated operations performed over it (serialization, validation, rendering,
metric collection) without each operation's logic being crammed into the
element classes themselves — the tradeoff is the reverse of Strategy/State:
adding a new *operation* is easy (one new visitor), but adding a new *element
type* means updating every existing visitor.

## Enterprise / Service-Oriented Extensions (Beyond the GoF Catalog)

The GoF catalog predates the web-service and ORM era it's now most often
applied within; the following patterns are widely treated as part of the same
shared vocabulary but come from later, more specific literature.

### Repository

*Popularized by Martin Fowler, "Patterns of Enterprise Application Architecture"
(2002), and Eric Evans, "Domain-Driven Design" (2003).*

Mediates between the domain/business logic and a data source (database, external
API, file) behind a collection-like interface, so business logic depends on an
abstraction ("give me the orders for this customer") rather than a concrete
query, ORM, or client library. This is Dependency Inversion applied specifically
to persistence: it is what makes business logic unit-testable without a real
database, and what lets the underlying storage change without touching the
logic that uses it.

## Anti-patterns

Named, recurring *bad* shapes — worth recognizing by name for the same reason
a good pattern is: shared vocabulary that makes a code-review comment concrete
("this file is becoming a God Object") instead of a vague complaint.

### Anti-pattern: the God Object / God File

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

### Anti-pattern: the Static Utility Class

*Discussed as a smell in Martin Fowler, "Refactoring: Improving the Design of
Existing Code" (1999, 2nd ed. 2018), under "Feature Envy" and related smells;
also common guidance in functional-programming style guides.*

An exported class where every member is static amounts to a namespace, not an
object — it groups functions without ever needing instance state or
polymorphism. In languages/ecosystems with real module systems (Python modules,
ES modules), plain exported functions serve the same purpose, are more
tree-shakable, and don't imply an object-oriented relationship (inheritance,
overriding) that will never actually be used.
