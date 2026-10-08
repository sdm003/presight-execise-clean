# Class and Module Guide

This document explains the class-like units on both the server and client sides.
The project is written in JavaScript, so most units are functions and factories,
not ES6 classes. That is intentional: the code uses closures and dependency
injection instead of creating classes only to hold a few methods.

## Server side

## `AppError`

**File:** `server/src/shared/errors.js`

`AppError` is the base application error. It stores:

- a safe message;
- an HTTP status;
- an optional machine-readable error code.

Services, middleware and the database wrapper use it for expected failures such
as validation errors, missing users and temporary unavailability.

It prevents expected application failures from looking like unknown exceptions.
The central error handler can map the status while hiding internal details for
5xx responses.

## `ValidationError`

**File:** `server/src/shared/errors.js`

`ValidationError` extends `AppError` and always uses HTTP 400. It represents
invalid user input or invalid query values.

The user service and query builder throw it at the input boundary. The HTTP error
middleware then returns a client-safe 400 response.

## `ConfigurationError`

**File:** `server/src/shared/errors.js`

`ConfigurationError` represents invalid environment configuration. It stores the
name of the invalid key, not its secret value.

This is used by `config/index.js` so a server fails early and clearly instead of
starting with an invalid port, database URL, TLS setting or tracing endpoint.

## `isUnavailable`

**File:** `server/src/shared/errors.js`

This helper classifies PostgreSQL and network error codes such as connection
refused, reset, timeout and pool exhaustion. The error handler and transaction
layer use it to decide whether a failure should become HTTP 503 and whether a
connection should be discarded.

## `httpConfig`

**File:** `server/src/config/index.js`

This factory-like function creates validated HTTP configuration:

- environment mode;
- client origin;
- port;
- request and header timeouts;
- keep-alive timeout;
- maximum in-flight requests.

It rejects invalid values before the app starts.

## `databaseConfig`

**File:** `server/src/config/index.js`

Creates PostgreSQL configuration. It validates the database URL scheme, pool size,
bounded queue size, connection timeout, statement timeout, lock timeout and idle
transaction timeout.

When `PG_SSL=true`, it enables certificate verification. URL options cannot
silently weaken TLS verification.

## `tracingConfig`

**File:** `server/src/config/index.js`

Validates OpenTelemetry settings: enabled flag, sampling ratio and OTLP endpoint.
It returns normalized configuration for `tracing.js`.

## `createApp`

**File:** `server/src/http/app.js`

`createApp()` is the server composition root. It assembles:

```text
tracing -> request logging -> CORS -> admission -> body parser
         -> routes -> health endpoints -> errors
```

It accepts injectable repository, database, logger and configuration objects.
Tests can therefore run the HTTP layer without using the real database.

The app also defines:

- `/api/live`, which does not touch the database;
- `/api/health` and `/api/ready`, which run `SELECT 1`;
- static client asset serving;
- centralized 404 and error handling.

## `admission`

**File:** `server/src/http/middleware/admission.js`

`admission()` is a closure-based in-flight request limiter. It stores the current
request count privately and returns Express middleware.

When capacity is exhausted or the app is draining, it returns 503 with
`Retry-After: 1`.

For accepted requests it attaches `req.admission`:

- `hold()` says backend work continues after route entry;
- `complete()` says that work has finished.

The slot is released only after both backend work and the HTTP response have
finished. This prevents aborted browser connections from making the server
underestimate active database work.

## `requestLog`

**File:** `server/src/http/middleware/request-log.js`

`requestLog(log)` returns middleware that:

1. creates a server-owned UUID;
2. returns it as `X-Request-ID`;
3. adds basic security headers;
4. starts a duration timer;
5. logs method, route, status and duration;
6. places the ID in AsyncLocalStorage.

The same request ID is therefore available to nested service, repository and
database logs.

## `errorHandler`

**File:** `server/src/http/middleware/errors.js`

`errorHandler(log, database)` is the final Express error boundary. It maps:

| Failure                      | Response                      |
| ---------------------------- | ----------------------------- |
| `AppError` / validation      | controlled status and message |
| malformed JSON               | 400                           |
| oversized body               | 413                           |
| unsupported encoding/content | 415                           |
| unavailable dependency       | 503 with retry hint           |
| unknown exception            | generic 500                   |

It logs internal failures with request and pool context but does not expose raw
stack traces or internal messages to the client.

## `mountUsers`

**File:** `server/src/modules/users/routes.js`

`mountUsers(app, repository)` is the users controller/route factory. It creates
the service and registers:

- `GET /api/users`;
- `POST /api/users`;
- `DELETE /api/users/:id`.

It performs only HTTP-specific work: reading params/body, checking content type,
holding admission capacity and writing responses. SQL is not placed here.

## `createService`

**File:** `server/src/modules/users/service.js`

`createService(repository)` returns the application use cases:

### `listUsers(query)`

Delegates the normalized request query to the repository and creates a named
service span.

### `createUser(body)`

Calls `validateUser()` first, then passes only the normalized record to the
repository. This keeps untrusted HTTP input away from database code.

### `deleteUser(id)`

Calls the repository and converts a `null` result into a 404 `AppError`.
Successful deletion is returned as `{ id }`.

This factory is the service layer. It is deliberately small because the domain
currently has only three use cases.

## `validateUser`

**File:** `server/src/modules/users/validation.js`

`validateUser(body)` is the POST trust-boundary validator. It creates a new
normalized object and validates:

- object shape;
- non-empty bounded strings;
- control characters;
- absolute HTTP(S) avatar URL without credentials;
- integer age from 0 to 120;
- zero to ten hobby strings;
- distinct hobbies.

It trims accepted strings and rejects invalid input with `ValidationError`.

## `whereFor`

**File:** `server/src/modules/users/query.js`

`whereFor(query)` builds a SQL `WHERE` fragment and a separate parameter array.

- search becomes escaped literal `ILIKE`;
- nationalities use `ANY(text[])`, giving OR behavior;
- every selected hobby gets its own `EXISTS`, giving AND behavior;
- values are never concatenated directly into SQL.

Keeping SQL text and values separate is the main SQL-injection protection here.

## `orderFor`

**File:** `server/src/modules/users/query.js`

`orderFor(query)` maps only approved sort names to SQL columns:

```text
first_name -> u.first_name
last_name  -> u.last_name
age        -> u.age
nationality -> u.nationality
```

The direction is reduced to ASC or DESC, and `u.id ASC` is always appended as a
deterministic tie-breaker.

## `positiveInteger`

**File:** `server/src/modules/users/query.js`

Normalizes page and limit values. Invalid, non-integer and non-positive values
fall back to defaults; valid values are capped at a configured maximum.

This prevents unbounded page sizes and invalid OFFSET calculations.

## `createRepository`

**File:** `server/src/modules/users/repository.js`

`createRepository({ database })` is the PostgreSQL data-access factory.

### `listUsers(query)`

It:

1. normalizes page and limit;
2. builds scoped and selected filters;
3. executes one parameterized PostgreSQL statement;
4. returns users, total, `hasMore`, hobby facets and nationality facets.

The statement uses CTEs for the filtered set, page users and aggregations. Hobbies
are aggregated in SQL, avoiding one query per card.

The current nationality facet implementation intentionally keeps the nationality
choice set relatively stable: it respects search and hobbies but ignores the
selected nationality filter and may include zero-count values. This behavior was
chosen to keep selected checkboxes discoverable and is documented as a deviation
from the literal exercise requirement.

### `createUser(user)`

Uses the transaction helper to insert the user and then all hobbies atomically.

### `deleteUser(id)`

Deletes the user. The database foreign key cascade removes related hobbies.

## `createDatabase`

**File:** `server/src/database/pool.js`

`createDatabase()` wraps `pg.Pool` and keeps resource state in a closure:

```text
instance, inFlight, closing, capacity, ending
```

### `connect()`

Checks shutdown state and bounded capacity, acquires a client, records leased
client errors and returns a small interface with `query()` and `release()`.

### `query()`

Performs a short query and releases its client in a `finally` block.

### `release()`

Is idempotent. It decrements the in-flight count once and discards a broken
connection instead of returning it to the pool.

### `stats()`

Exposes safe pool counters for diagnostics.

## `transaction`

**File:** `server/src/database/transaction.js`

`transaction(work, source)` centralizes:

```text
connect -> BEGIN -> work -> COMMIT
```

On failure it rolls back, discards unusable connections and rethrows the original
error. Cleanup failures are logged without hiding the primary failure.

## `migrate`

**File:** `server/src/database/migrate.js`

`migrate(source)` applies the ordered SQL migration list. It obtains a
schema-scoped PostgreSQL advisory transaction lock, creates the migration ledger,
skips applied versions and records each successful version.

The transaction and ledger make startup migrations repeatable and safe against
multiple concurrent runners.

## SQL migrations

### `001-initial.sql`

Creates normalized `users` and `hobbies` tables, primary keys, age constraints,
foreign keys, cascade deletion and a unique user/hobby pair.

### `002-query-indexes.sql`

Adds indexes for common filtering and ordering paths. It does not fully solve
contains-name `ILIKE` scaling, which may require PostgreSQL trigram indexing at
larger data volumes.

### `003-demo-seed.sql`

Locks the users table and inserts 1000 deterministic demo users only when the
table is empty. It creates varied nationalities and zero-to-ten hobbies without
duplicating or replacing existing records.

## `start`

**File:** `server/src/runtime/lifecycle.js`

`start(app, options)` is the standalone process lifecycle manager.

### Startup

It checks the database with `SELECT 1`, starts listening, and configures Node HTTP
timeouts. If startup fails, it closes the database and telemetry.

### Shutdown

On SIGTERM/SIGINT it:

1. marks the app as draining;
2. stops new work;
3. closes the HTTP server;
4. closes database resources;
5. shuts down telemetry;
6. exits with the correct code.

Fatal process events trigger shutdown with a non-zero exit code. A deadline
prevents shutdown from hanging forever.

## `setup`

**File:** `server/src/setup.js`

Runs migrations and closes the database pool. It is used by the server
`prestart` script and Docker startup before HTTP traffic is accepted.

## `initializeTracing`

**File:** `server/src/observability/tracing.js`

Creates the OpenTelemetry provider once. It configures parent-based sampling,
optional OTLP HTTP export and W3C trace-context propagation.

## `span`

**File:** `server/src/observability/tracing.js`

`span(name, work, attributes)` wraps asynchronous work:

1. starts an active span;
2. executes the operation;
3. marks span status on failure;
4. logs operation name, duration and outcome;
5. ends the span.

It is used for HTTP, service, repository, database and transaction boundaries.

## `requestTracing`

**File:** `server/src/observability/tracing.js`

Creates the server HTTP span, extracts incoming W3C trace context and injects
trace context into the response. It names the span after the resolved HTTP route
and records the response status.

## `logger` and `requestContext`

**File:** `server/src/observability/logger.js`

Creates the Pino logger, sanitizes error metadata and stores the current request
ID in AsyncLocalStorage. Downstream logs automatically inherit the request ID.

## Client side

## `App`

**File:** `client/src/App.jsx`

`App` is the top-level React component. It owns the shared view state and
connects:

```text
state -> URL -> useUsers -> Results
                  |
              facets -> Facet
```

It renders the hero search, toolbar, active chips, responsive filters and results.
It uses functional state updates so consecutive checkbox changes compose correctly.

## `useDebouncedSearch`

**File:** `client/src/hooks.js`

Maintains immediate input separately from applied search state. It waits 300 ms
before applying a new search and pauses updates during IME composition.

This reduces request volume without breaking Chinese, Japanese, Korean or other
composition-based input.

## `useUrlSync`

**File:** `client/src/hooks.js`

Writes the current application state to the browser URL using `replaceState`.
It keeps reloads and shared links reproducible without adding one browser-history
entry for every keystroke.

## `useUsers`

**File:** `client/src/hooks.js`

The main client data hook. It:

- builds the serialized API query;
- fetches page one and subsequent pages;
- aborts obsolete requests;
- ignores stale responses;
- validates each response;
- tracks seen IDs;
- restarts when OFFSET pages overlap or totals change;
- exposes retry and load-more actions.

The hook uses a synchronous busy guard so IntersectionObserver cannot start two
loads for the same state.

## `useInfiniteScroll`

**File:** `client/src/hooks.js`

Observes a sentinel element and calls `loadMore()` near the end of the list. It
disconnects on cleanup and only observes when more data exists and the current
state is ready.

## `readState`, `changeState`, `stateParams`, `writeState`

**File:** `client/src/state.js`

These functions define the client state contract:

- `readState()` parses and normalizes URL parameters;
- `changeState()` applies patches and preserves object identity for no-ops;
- `stateParams()` serializes hobby/nationality arrays as comma-separated values;
- `writeState()` updates the URL.

## `validatePage`

**File:** `client/src/users.js`

Validates API payloads before rendering. It checks IDs, field types, ages, hobbies,
pagination shape, page length, `hasMore` and facet counts.

It reports malformed responses as `INVALID_RESPONSE` and repeated IDs across
pages as `PAGE_OVERLAP`.

## `rowWindow`

**File:** `client/src/virtual.js`

Purely calculates the visible virtualized range from item count, columns,
scroll position, list offset and viewport height. It returns start/end indexes,
top spacer and total height.

## `VirtualCards`

**File:** `client/src/components/Results.jsx`

Measures the results grid and renders only the visible card window plus overscan.
It uses `useLayoutEffect` because DOM geometry must be measured and corrected
before the browser paints. `ResizeObserver` handles responsive column changes,
and `requestAnimationFrame` coalesces scroll work.

## `Hero`

**File:** `client/src/components/Hero.jsx`

Presents the search input and heading. It exposes composition events to the
debounced search hook so partially composed text does not trigger requests.

## `Toolbar`

**File:** `client/src/components/Toolbar.jsx`

Renders sort field and direction controls and sends changes to `App`.

## `Facet`

**File:** `client/src/components/Facet.jsx`

Reusable nationality/hobby checkbox list. It displays counts, selected styling
and semantic matching labels. It preserves selected values in the UI even if the
server response no longer includes them in the top-20 list.

## `Chips`

**File:** `client/src/components/Chips.jsx`

Renders active filters as removable controls. Removing a chip updates the same
shared state used by the sidebar.

## `Results`

**File:** `client/src/components/Results.jsx`

Coordinates loading, empty, error, retry and ready states, then delegates the
actual list window to `VirtualCards`.

## `UserCard`

**File:** `client/src/components/UserCard.jsx`

Renders one user record with a fixed-size avatar, identity data and compact hobby
display. It shows at most two hobbies and a remaining count.

## `ErrorBoundary`

**File:** `client/src/components/ErrorBoundary.jsx`

Catches render exceptions, emits a sanitized client diagnostic and gives the user
a visible recovery action.

## `clientLog` and `installErrorReporting`

**File:** `client/src/diagnostics.js`

`clientLog()` filters diagnostic fields before writing to the console. It keeps
safe status, page, duration, server request ID, trace ID, outcome and error type.

`installErrorReporting()` installs global browser error listeners and returns a
cleanup callback.

The frontend does not create its own request ID. It reads the backend-generated
`X-Request-ID` from the response, so client console records can be correlated with
server logs when a response exists.

## `main`

**File:** `client/src/main.jsx`

Bootstraps React, installs global error reporting and renders `App` inside the
error boundary. It also handles development HMR cleanup.

## `client/test` units

### `client/test/units.test.mjs`

Tests URL state, comma-separated filter serialization, no-op state identity,
virtualization geometry and API response validation.

### `client/test/diagnostics.test.mjs`

Tests diagnostic redaction, debug gating, safe request/trace IDs and listener
cleanup.

### `client/test/browser.mjs`

Runs real browser scenarios against a test-only API fixture. It verifies the
visible behavior rather than internal React implementation details.

## Cross-side request flow

```text
Hero/App
  -> useDebouncedSearch / stateParams
  -> useUsers fetch
  -> requestLog + requestTracing
  -> mountUsers
  -> createService
  -> createRepository
  -> createDatabase
  -> PostgreSQL
  -> response X-Request-ID
  -> validatePage
  -> Results / VirtualCards / UserCard
```

The server owns the request ID. The client reads it from the response and logs it,
which provides request correlation. OpenTelemetry adds trace correlation when
enabled, but the browser does not currently create a full client span.

## Testing strategy

The project intentionally uses layers instead of test classes:

| Layer                  | Purpose                                                          |
| ---------------------- | ---------------------------------------------------------------- |
| Pure unit tests        | Query builders, validation, state and geometry                   |
| HTTP tests             | Routes, status mapping, middleware and service contracts         |
| PostgreSQL integration | Migrations, SQL, transactions and concurrency                    |
| Browser tests          | User-visible scrolling, filters, retries and responsive behavior |

This matches the architecture better than artificial `UserServiceTest` classes.
The implementation units remain small factories and functions because the project
does not need class hierarchies or framework-heavy dependency injection.
