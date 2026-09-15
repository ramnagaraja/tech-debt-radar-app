# Frontend Design Best Practices: A Practical Reference

**Primary canonical sources**: Dan Vanderkam, *Effective TypeScript* (2019, 2nd
ed. 2024) for strict-typing and domain-modeling practices; Dan Abramov,
"Presentational and Container Components" (2015) for the
container/presentational split React later formalized as hooks; Kent C. Dodds'
published guidance on React application architecture (epicreact.dev and his
technical blog), specifically "State Colocation will make your React app
faster" (2019) and his compound-components pattern writeups; the official React
documentation ("Reusing Logic with Custom Hooks", `React.lazy`/`Suspense`) and
official Angular documentation (Signals, `InjectionToken`, functional
guards/interceptors, `@defer`, `loadComponent`); Thomas Burleson's Facade
pattern writeups for Angular + NgRx/RxJS (popularized publicly while at
SoundCloud, and continued in his conference talks and articles, c. 2017-2019);
and the widely adopted "folder-by-feature" community convention documented in
reference architectures such as `bulletproof-react`. This document is an
original summary written for this codebase's own frontend-debt signal
vocabulary, not a reproduction of any of the above.

## Strict TypeScript and domain-driven typing

*Source: Dan Vanderkam, "Effective TypeScript" (2019); the TypeScript
Handbook's own guidance on `strict` mode.*

`strict: true` (plus `noImplicitAny`, `strictNullChecks`,
`noUncheckedIndexedAccess`) should be on from the start of a project — turning
it on later means retrofitting types across a codebase that has already
accumulated implicit `any`s. `any` defeats the type checker silently; `unknown`
narrowed through a type guard (or a runtime validation library such as Zod)
keeps the compiler's guarantees intact at the exact boundary where untyped data
(an API response, `JSON.parse`, user input) enters the typed part of the
system. Modeling a multi-state flow (idle/loading/success/error) as a
discriminated union, rather than several independent boolean flags that can
drift out of sync with each other, makes invalid states genuinely
unrepresentable rather than merely undocumented; a branded type for an entity
ID (`type UserId = string & { __brand: "UserId" }`) prevents a class of bug
where two differently-typed IDs (a `UserId` and an `OrderId`, both plain
strings) are passed to each other's functions without the compiler noticing.
Code-level tell: a high `any_usage_count` or a `tsconfig.json` with `strict`
left off — both are metrics this codebase's own analyzer already reports per
file.

## Separating API contracts from client-side domain models

*Source: Widely documented practice across TypeScript/React reference
architectures (e.g. `bulletproof-react`); a direct application of the
Anti-Corruption Layer concept documented in this knowledge base's
integration-patterns document, applied at the frontend/backend boundary
specifically.*

A DTO (the shape an API actually returns) and the domain model a UI's
components are written against should be distinct types, mapped once at the
data-fetching boundary — not the same type reused everywhere. Without this
separation, a backend response-shape change (a renamed field, a restructured
nested object) propagates directly into every component that happened to
reference that field, however deep in the tree, instead of being absorbed in
one mapping function.

## Folder-by-feature over folder-by-technical-role

*Source: Widely adopted community convention; documented directly in
reference architectures such as `bulletproof-react`.*

Organizing a frontend as `features/billing/`, `features/onboarding/` (each
feature folder holding its own components, hooks, and types, with a public
barrel `index.ts` exporting only what other features should import) scales
better than a single top-level `components/`, `hooks/`, `types/` split by
technical role, which forces anyone working on one feature to jump between
several unrelated top-level folders and makes a feature's true boundaries
invisible from the folder structure alone. Code-level tell: a `components/`
folder whose files, read by name, have no discernible grouping by business
capability — a direct frontend analogue of the "distributed monolith" smell
this knowledge base's microservices document describes for backend services
with no real bounded contexts.

## Container/presentational separation, now usually expressed as hooks

*Source: Dan Abramov, "Presentational and Container Components" (2015); React's
official documentation on custom hooks, which is the pattern's modern
successor.*

Presentational components should render from props alone, with no data
fetching or side effects of their own; the code that owns data fetching, side
effects, and state mutation belongs in a container component or — the
now-preferred shape, since hooks were introduced — a custom hook
(`useUserPermissions()`, `useDebounce()`) that a presentational component
calls. This keeps a component's rendering logic testable in isolation (render
it with plain props, no mocking a network call) and keeps one specific kind of
logic reusable across multiple components without inheritance. Custom hooks
are now generally preferred over the legacy higher-order-component and
render-props patterns for the same logic-sharing goal, since a hook composes
more simply, with no wrapper-component nesting ("wrapper hell") and no prop-name
collisions between what a HOC injects and what a component already receives.

## State colocation over reflexive global state

*Source: Kent C. Dodds, "State Colocation will make your React app faster"
(2019).*

State should live as close as possible to where it's used; transient UI state
(a modal's open/closed flag, a form field's current value before submission)
belongs in the component that owns it, not lifted into a global store by
default. Pushing every piece of state into a global store causes every
subscriber to that store to re-render on any change anywhere in it (unless the
store has fine-grained selectors, which most naive usage doesn't bother
setting up), and makes a piece of state's actual lifetime and ownership harder
to read from the code. The global-store question should be asked in reverse:
does more than one, unrelated part of the tree genuinely need this state? — if
not, it's local state.

## Compound components over configuration-object sprawl

*Source: Dan Abramov's and Kent C. Dodds' published React pattern writeups on
compound components (Tabs/Accordion/Dropdown-style composite components sharing
implicit state via Context).*

A component family like `Tabs`/`Accordion`/`Dropdown`, where the parent and its
children need to coordinate (which tab is active, which panel is expanded),
reads better composed as JSX children sharing state through Context
(`<Tabs><Tabs.List><Tabs.Tab>...`) than as one component accepting a large,
growing configuration object or a long list of boolean/enum props controlling
every combination of behavior. This is the same "control inversion via
slotting" idea as passing JSX children/render props instead of a config
object riddled with boolean flags — each addition composes instead of adding
another flag every caller has to reason about. Code-level tell: a component
whose prop list has grown many boolean flags controlling largely independent
concerns (this codebase's own analyzer reports this per component as
`many_boolean_props_count`).

## Angular: Signals, Facades, and OnPush

*Source: Official Angular documentation on Signals (`signal()`, `computed()`,
`effect()`) and `ChangeDetectionStrategy.OnPush`; Thomas Burleson's published
Facade-pattern writeups for Angular + NgRx/RxJS.*

Signals-based reactivity is now Angular's own recommended default over
zone-based dirty checking or hand-assembled RxJS operator chains for local and
derived component state — it makes exactly what depends on what explicit and
lets Angular skip change detection for parts of the tree that provably haven't
changed. The Facade pattern keeps components from talking to NgRx/RxJS/HTTP
directly: components depend only on a Facade service exposing read-only
signals/observables plus command methods, which is what keeps state-management
implementation details (which store, which operators) from leaking into every
component that needs a piece of that state — an application of the same
Facade design pattern documented in this knowledge base's design-patterns
document, specifically to a state-management layer. Marking presentational
("dumb") components with `ChangeDetectionStrategy.OnPush` and explicit
typed `input()`/`output()` keeps their re-render triggers predictable and
provably limited to their own inputs changing.

## Server state, global client state, and form state as three distinct concerns

*Source: Official documentation for TanStack Query, Zustand/Jotai, and React
Hook Form + Zod (each a widely adopted, actively maintained library
representing current community consensus on its respective concern), and the
equivalent Angular ecosystem tools (TanStack Query Angular or RxJS-based
caching services; NgRx SignalStore; Angular Reactive/Typed Forms).*

Three genuinely different kinds of state are often collapsed into one
undifferentiated global store, which is itself a source of debt: server state
(data that lives on a server and can go stale — needs caching, retries, and
invalidation-by-key, which is what TanStack Query or an equivalent caching
layer is built for, not a plain global variable holding the last fetch's
result); global client state (state genuinely shared across unrelated parts of
the UI with no server backing — a narrower category than it's often treated
as, per the state-colocation point above); and local/form state (best modeled
with schema-driven validation — React Hook Form + Zod, or Angular's typed
Reactive Forms — rather than hand-rolled validation logic re-derived per form).

## Performance: code-splitting and immutable updates

*Source: Official React documentation (`React.lazy`/`Suspense`) and official
Angular documentation (`loadComponent`/`loadChildren`, `@defer`); general
industry guidance on reference-equality checks in both frameworks' change
detection.*

Lazy-loading and code-splitting at routing boundaries keeps an initial bundle
from growing to include code a user may never visit in a given session. State
and arrays should never be mutated directly — both React's and Angular's
(zone-based) change detection rely on reference-identity checks to know
something changed, so an in-place mutation (`arr.push(x)`,
`state.field = x`) can silently fail to trigger a re-render, or worse, trigger
one inconsistently depending on unrelated timing. Immutable updates (object/array
spread, or a library such as Immer for deeply nested state) keep this
guarantee intact. Static utility classes (see this knowledge base's
design-patterns document's anti-pattern entry) are also a frontend-specific
performance/maintainability concern here: plain exported functions are
tree-shakable by a bundler in a way an all-static class's members typically
are not, so an unused static method still ships in the bundle.
