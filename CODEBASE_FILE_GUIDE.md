# Codebase File Guide

This document explains what each tracked project file does and how the files work
together. It describes the current `main` branch after the nationality-facet
revert.

## Repository root

### `package.json`

Defines the npm workspaces (`client` and `server`) and the main project commands:
start, setup, test, check and build. The root `check` command delegates formatting,
tests and the client build to the workspaces.

### `package-lock.json`

Locks the complete dependency tree and versions so local, CI and Docker installs
resolve the same packages.

### `.nvmrc`

Documents the Node.js version expected by the project.

### `Dockerfile`

Builds the application in stages:

1. installs dependencies with `npm ci`;
2. builds the Vite client;
3. removes development dependencies from the runtime image;
4. copies the server and built client;
5. runs as a non-root user;
6. runs database setup before starting Node.

The final command uses `exec`, so container signals reach the Node process.

### `docker-compose.yml`

Defines a PostgreSQL service with a named persistent volume and healthcheck, plus
the API service. The API waits for PostgreSQL to become healthy and receives its
database URL and runtime configuration through environment variables.

### `vercel.json`

Maps deployment routes to the client assets and server entrypoint for the Vercel
deployment model. In this mode the server module is imported rather than owning a
long-running HTTP listener.

### `.dockerignore`

Keeps dependencies, build output, local databases, test coverage, graph artifacts
and `.env` files out of the Docker build context.

### `.gitignore`

Excludes local dependencies, environment files, generated build output, Graphify
artifacts and the local load-test workspace.

### `README.md`

The operational entrypoint for contributors. It documents local setup, PostgreSQL
configuration, migrations and seed, API behavior, Docker usage, diagnostics,
load-test commands and validation commands. It also records intentional
limitations such as unauthenticated write endpoints and the PostgreSQL choice.

### `PRODUCTION_READINESS.md`

Contains the source-backed engineering assessment: backend and frontend design,
failure handling, observability, seed behavior, performance evidence, deployment
limits, original exercise deviations and a go/no-go checklist. It is an assessment,
not an implementation module.

## Client application

### `client/package.json`

Defines the React/Vite client dependencies and scripts for development, production
builds and native Node test execution.

### `client/vite.config.js`

Configures Vite for the React client and development workflow.

### `client/index.html`

The browser HTML shell. Vite injects the client bundle into this document.

### `client/src/main.jsx`

The browser entrypoint. It mounts the React tree, installs global error and
unhandled-rejection reporting, and wraps the application in `ErrorBoundary`.

### `client/src/App.jsx`

The top-level UI composition component. It owns filter/sort state, synchronizes
state to the URL, starts user loading, connects the infinite-scroll sentinel,
renders the hero, toolbar, filter sidebar and results.

Its layout effect resets the results scroll position after a meaningful filter or
sort change so the user does not remain deep in an old result set.

### `client/src/state.js`

Defines the URL-backed view state:

- search text;
- selected hobbies;
- selected nationalities;
- sort field;
- sort direction.

It reads and normalizes query parameters, serializes filter arrays as comma-separated values, and
uses identity-preserving updates when a patch changes nothing.

### `client/src/hooks.js`

Contains client-side behavior hooks:

- debounced, IME-aware search;
- URL synchronization;
- fetching and appending user pages;
- `AbortController` cancellation;
- stale-response protection;
- page-overlap and changing-total recovery;
- retry handling;
- IntersectionObserver integration for infinite scrolling.

This is where the client prevents duplicate in-flight page loads and prevents an
old response from overwriting a newer filter state.

### `client/src/users.js`

Runtime-validates the API response before React uses it. It checks user fields,
IDs, duplicate records, pagination metadata, `hasMore`, and facet counts.

It raises `INVALID_RESPONSE` for malformed data and `PAGE_OVERLAP` when a later
page contains an already-rendered ID.

### `client/src/virtual.js`

Contains the pure virtualization geometry. Given item count, column count,
scroll position and viewport size, `rowWindow()` returns the visible row range,
top offset and total scroll height. The cards use a fixed height and overscan.

### `client/src/diagnostics.js`

Provides sanitized browser diagnostics. It logs API outcomes, status, duration,
server request IDs and trace IDs when available. It deliberately excludes search
values, user objects, raw URLs, error messages and stacks.

It also installs global `error` and `unhandledrejection` listeners and returns a
cleanup function for React lifecycle cleanup.

### `client/src/components/Hero.jsx`

Renders the page heading and search input. It handles composition start/end so
IME input is not treated as a sequence of completed search terms.

### `client/src/components/Toolbar.jsx`

Renders sort-field and sort-direction controls. It exposes the four supported
server sort fields and updates shared application state.

### `client/src/components/Facet.jsx`

Renders a reusable checkbox fieldset for hobbies or nationalities. It shows
counts, selected state and the matching semantics label (`Match all` for hobbies
and `Match any` for nationalities).

Selected values are appended to the visible facet list if they are absent from
the current top-20 response, so a selected filter remains removable.

### `client/src/components/Chips.jsx`

Displays active filters as removable chips. It gives users a second way to clear
individual search, hobby and nationality selections.

### `client/src/components/Results.jsx`

Renders loading skeletons, errors, empty state, result count and the virtualized
card list. Its `VirtualCards` component measures the grid and scroll position
with `useLayoutEffect`, `ResizeObserver` and `requestAnimationFrame`.

### `client/src/components/UserCard.jsx`

Renders one user card: avatar, full name, nationality, age and up to two hobbies.
Additional hobbies are represented by `+n`. Image dimensions and lazy loading
reduce layout shifts and unnecessary work.

### `client/src/components/ErrorBoundary.jsx`

Catches render-time React errors, reports a sanitized UI diagnostic and displays
a recovery message instead of leaving the whole page blank.

### `client/src/style.css`

Defines the visual system, cards, filters, skeletons, virtualized list geometry,
responsive layout, mobile controls and reduced-motion behavior.

## Client tests

### `client/test/units.test.mjs`

Tests pure client behavior: URL round-tripping, comma-separated filter serialization,
state identity preservation, virtualization bounds and API response validation.

### `client/test/diagnostics.test.mjs`

Tests diagnostic gating, safe metadata extraction, request/trace ID handling,
error classification and cleanup of global listeners.

### `client/test/browser.mjs`

Runs browser-level regression checks using an installed Chrome and native CDP.
It uses a test-only in-memory API fixture and checks scrolling, resizing, mobile
filters, IME input, URL restoration, stale searches, retries, empty results and
dataset changes.

The fixture mirrors the API contract without touching the real database.

## Server composition and configuration

### `server/package.json`

Defines the server scripts for setup, start, formatting, tests, coverage and the
native load smoke test. Dependencies are Express, PostgreSQL `pg`, Pino and
OpenTelemetry packages.

### `server/src/index.js`

The server entrypoint. It initializes tracing, creates the Express app and starts
the standalone lifecycle only when executed directly. Importing it for Vercel or
tests has no listener side effect.

### `server/src/setup.js`

Runs migrations and closes the database pool. It is used by the npm `prestart`
hook and the Docker startup command.

### `server/src/config/index.js`

Parses and validates environment configuration for HTTP, PostgreSQL and tracing.
It enforces numeric bounds, valid URL schemes, safe TLS URL options and valid
sampling ratios. It reports the invalid configuration key without logging secrets.

### `server/src/shared/errors.js`

Defines the error vocabulary:

- `AppError` for controlled HTTP failures;
- `ValidationError` for 400 responses;
- `ConfigurationError` for invalid startup configuration;
- `isUnavailable()` for classifying database/network failures as 503.

## User module

### `server/src/modules/users/routes.js`

Registers `GET`, `POST` and `DELETE /api/users` routes. It performs small HTTP
boundary checks, holds admission capacity while work is active and delegates
business behavior to the service.

### `server/src/modules/users/service.js`

The use-case layer. It validates create input, invokes repository methods,
converts a missing deletion result into 404 and creates named operation spans.

### `server/src/modules/users/validation.js`

Validates and normalizes user creation payloads: strings, control characters,
avatar URL, age, hobby count and hobby uniqueness. It returns a new normalized
object rather than passing untrusted request data through.

### `server/src/modules/users/query.js`

Builds safe query fragments and parameter arrays. Search uses escaped literal
`ILIKE`; nationalities use OR semantics; each hobby uses an independent `EXISTS`
condition for AND semantics. Sort columns are selected from an allowlist and
finish with `id ASC` as a deterministic tie-breaker.

### `server/src/modules/users/repository.js`

Owns PostgreSQL access. The GET operation uses one parameterized statement with
CTEs for scoped users, filtered users, page records and facet aggregation. It
returns page data, pagination metadata, hobby facets and nationality facets.

The current nationality facet behavior intentionally ignores the selected
nationality filter while respecting search and hobbies, preserving a stable
choice set. This is documented as a deviation from the literal exercise
requirement.

POST uses a transaction to insert the user and hobbies. DELETE relies on the
database foreign-key cascade for associated hobbies.

### `server/src/modules/users` data flow

```text
route -> service -> validation/query builder -> repository -> pool -> PostgreSQL
```

The route does not contain SQL, and the repository does not know about Express
request/response objects.

## Database layer

### `server/src/database/pool.js`

Wraps `pg.Pool` with lazy initialization, bounded acquisition capacity, timeouts,
leased-client error handling, idempotent release, broken-client discard and
pool statistics. It exposes both short `query()` calls and explicit `connect()`
leases for transactions.

### `server/src/database/transaction.js`

Provides one reusable transaction wrapper: acquire, BEGIN, execute work, COMMIT,
rollback on failure and release/discard. It preserves the original failure if
rollback or release also fails.

### `server/src/database/migrate.js`

Applies migration files in order inside a transaction. A schema-scoped advisory
lock prevents concurrent migration runners, and `schema_migrations` makes the
process idempotent.

### `server/src/database/migrations/001-initial.sql`

Creates normalized `users` and `hobbies` tables, primary keys, age constraints,
foreign keys, cascade deletion and per-user hobby uniqueness.

### `server/src/database/migrations/002-query-indexes.sql`

Adds indexes used by common nationality, age and hobby access paths. Contains-name
search still has a documented PostgreSQL trigram-index scaling limit.

### `server/src/database/migrations/003-demo-seed.sql`

Locks the users table and seeds an empty database with 1000 deterministic demo
users, nationalities and hobbies. Existing data is preserved and repeated
startup does not refill or duplicate records.

## HTTP layer

### `server/src/http/app.js`

Assembles Express middleware, liveness/readiness endpoints, admission control,
JSON parsing, user routes, static client assets, 404 handling and centralized
errors. Dependencies can be injected for tests.

### `server/src/http/middleware/admission.js`

Implements an in-process in-flight request limit. It returns 503 with
`Retry-After` when draining or saturated and keeps a slot until both the response
and held backend work finish.

### `server/src/http/middleware/cors.js`

Applies the configured exact-origin CORS policy and exposes request/trace headers
to the browser. CORS is browser policy, not authentication.

### `server/src/http/middleware/request-log.js`

Creates the server-owned request UUID, adds security response headers, measures
duration and writes a final HTTP completion log. It also places the request ID in
AsyncLocalStorage for downstream logs.

### `server/src/http/middleware/errors.js`

Maps validation, malformed JSON, oversized bodies, unsupported encodings,
unavailable dependencies and unknown exceptions to safe HTTP responses. Internal
500 details are logged but not returned to clients.

## Runtime and observability

### `server/src/runtime/lifecycle.js`

Owns standalone startup and shutdown. It checks the database before listening,
sets Node HTTP timeouts, enters draining on signals, closes active resources
within a deadline and exits non-zero after fatal process errors.

### `server/src/observability/logger.js`

Creates the Pino logger and request context. It formats safe errors, attaches
request IDs to logs and avoids exposing raw payloads or sensitive error details.

### `server/src/observability/tracing.js`

Configures OpenTelemetry provider, sampling, OTLP export and W3C propagation.
It creates HTTP, service, database and transaction spans and emits operation
completion logs even when external tracing is disabled.

## Server tests and tooling

### `server/test/api.test.js`

Unit and HTTP-contract tests for user validation, query semantics, sort allowlist,
service delegation, repeated filter keys, invalid request handling and DELETE
boundaries.

### `server/test/operations.test.js`

Tests configuration validation, pool behavior, admission/backpressure, HTTP
boundaries, CORS, tracing, transaction cleanup, startup, shutdown and process
failure handling.

### `server/test/database.test.js`

Integration tests against PostgreSQL. They create an isolated schema, run
migrations concurrently, verify seed behavior, filters, sorting, facets,
transactions, concurrent operations, tracing and recovery, then remove the schema.

### `server/scripts/load.js`

An executable local smoke/load script for server behavior such as health,
admission and database isolation. It is separate from the ignored k6 workspace
used for longer performance scenarios.

### `server/openapi.json`

The machine-readable API contract for the server endpoints and response shapes.
It complements, but does not replace, runtime validation and tests.

## How one GET request moves through the files

```text
client/src/hooks.js
  -> GET /api/users
server/src/http/middleware/request-log.js
  -> server/src/http/app.js
  -> server/src/modules/users/routes.js
  -> server/src/modules/users/service.js
  -> server/src/modules/users/query.js
  -> server/src/modules/users/repository.js
  -> server/src/database/pool.js
  -> PostgreSQL migrations/schema
  -> response validation in client/src/users.js
  -> client/src/App.jsx / Results.jsx
```

The request ID is generated by the backend, returned in `X-Request-ID`, and
logged by the frontend diagnostics when a response exists. This provides
correlation, but it is not a full browser-to-database distributed trace.

## Important scope note

The guide covers every tracked application, test, deployment and operational file
in the repository. Generated Graphify output and ignored local load-test files are
not source-controlled and are therefore not treated as application modules here.
