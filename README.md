# Presight Frontend Exercise

Build a small full-stack user directory application. The goal is to evaluate how you design a searchable, filterable, paginated UI backed by persisted data and clear API boundaries.

The application should include:

- A React client.
- A Node.js API server.
- A PostgreSQL database used as the source of truth for user data.
- Docker configuration for running the application locally.

## Scenario

Users need to browse a large directory of people, search by name, and narrow results by nationality and hobbies. The filter sidebar should help users discover useful filters based on the result set they are currently viewing.

## Requirements

### Data Model

Create users through `POST /api/users` and read persisted PostgreSQL records
through `GET /api/users`. No external data API is required or configured, and
the application does not generate or load sample users.

Each user should have:

- `avatar`
- `first_name`
- `last_name`
- `age`
- `nationality`
- `hobbies`, from 0 to 10 hobbies per user

Choose a data model that supports the required behavior.

PostgreSQL is the persisted source of user data. This consciously replaces the
original exercise's SQLite requirement, as requested in the updated requirements.

### API

Expose an API that supports:

- Paginated user results.
- Text filtering from user input across `first_name` and `last_name`.
- Filtering by one or more nationalities.
- Filtering by one or more hobbies.
- Sorting by `first_name`, `last_name`, `age`, and `nationality`.
- Pagination metadata so the client can determine whether more results are available.
- Top 20 hobbies for the active text filter and filter state, including `{ value, count }`.
- Top 20 nationalities for the active text filter and filter state, including `{ value, count }`.

Hobby counts reflect all applied filters. Nationality checkboxes intentionally
remain available when nationalities are selected: their counts apply the current
search and hobbies, but ignore their own nationality filter. The top 20
nationalities include global values with zero counts in that scope. This updates
the original result-set-only facet requirement to preserve stable choices.

Filter semantics:

- Multiple selected hobbies should match users who have all selected hobbies.
- Multiple selected nationalities should match users from any selected nationality.
- Text, hobby, and nationality filters should apply together.

Sorting semantics:

- Sorted results must be deterministic. Use `id` as a final tie-breaker when values are equal.
- Pagination must respect the active sort without duplicate or missing users.

### Client

Build a React interface that includes:

- A text filter input for `first_name` and `last_name`.
- A virtualized, infinitely scrolling list of user cards.
- A sidebar containing the top 20 hobbies and top 20 nationalities for the current result set, including counts.
- Controls for applying and removing hobby and nationality filters.
- Controls for choosing sort field and sort direction.
- Loading, empty, and error states.
- A responsive layout that remains usable on desktop and mobile.

User cards should follow this structure:

```text
|----------------------------------|
| avatar      first_name+last_name |
|             nationality      age |
|                                  |
|             (2 hobbies) (+n)     |
|----------------------------------|
```

Show up to 2 hobbies on the card. If the user has more hobbies, display the remaining count as `+n`.

Use a virtual scroll implementation for the list.

When the text filter or selected filters change, the client must refresh both:

- The paginated user list.
- The top 20 hobbies and nationalities in the sidebar.

The text filter value, selected hobbies, selected nationalities, sort field, and sort direction must be reflected in the URL query string. Reloading or sharing the URL should restore the same view state.

## Implementation Notes

- Keep the database setup easy to run locally.
- Include a documented, idempotent command that creates the PostgreSQL schema without modifying existing records.
- Include a `Dockerfile` and `docker-compose.yml` that can run the application locally.

## Evaluation Focus

We will pay particular attention to:

- Correct data persistence and API behavior.
- Correct filtering, sorting, pagination, and top 20 counts.
- Smooth infinite scrolling with virtualization.
- URL-synced state.
- Clear loading, empty, and error states.
- Easy local and Docker-based setup.

## Deliverables

Please provide:

- Source code for the React client and Node.js server.
- A `Dockerfile` and `docker-compose.yml`.
- Instructions for schema setup, API-based data creation, and running locally.
- Instructions for running with Docker Compose.

## Running locally

Requires Node 24+ and a PostgreSQL database (Docker also uses Node 24 LTS).

Install dependencies and configure your database using environment variables.
`.env.example` contains placeholders only; never commit database credentials.
The application reads `DATABASE_URL` from the process environment, not `.env`
automatically. For example, export your own connection URL in each API/setup
terminal, or load your private `.env` with `set -a; . ./.env; set +a`.

```sh
npm ci
export DATABASE_URL='******localhost:5432/directory'
npm run setup
```

`npm run setup` applies versioned, idempotent PostgreSQL DDL only. It uses the
schema-scoped migration ledger in `schema_migrations`, preserves existing data,
and is intended for explicit deployment/setup steps rather than application
startup.

Start the API and client in separate terminals:

```sh
# Terminal 1
npm start

# Terminal 2
npm run dev --workspace client
```

Open the Vite URL shown in the second terminal. The API runs at
`http://localhost:3001`. Vite proxies `/api` to that server, so the client uses
same-origin requests in development and production. Only set `VITE_API_URL` when
intentionally deploying a separate public API origin; never put secrets in it.

The machine-readable OpenAPI 3.1 contract lives at `server/openapi.json`.

Useful API endpoints:

```text
GET /api/live   # liveness only, no database dependency
GET /api/health # readiness, checks PostgreSQL
GET /api/ready  # alias of /api/health
GET /api/users?page=1&limit=40
GET /api/users?search=ava&nationality=American&nationality=British
GET /api/users?hobby=Reading&hobby=Cycling&sort=age&direction=desc
POST /api/users
DELETE /api/users/:id
```

Create a user (all six fields required; hobbies may be empty):

```sh
curl -X POST http://localhost:3001/api/users \
  -H 'Content-Type: application/json' \
  -d '{"avatar":"https://example.com/avatar.png","first_name":"Ava","last_name":"Chen","age":25,"nationality":"American","hobbies":["Reading","Cycling"]}'
```

Returns `201` with the persisted user, including its `id`. Read the persisted
directory:

```sh
curl 'http://localhost:3001/api/users?page=1&limit=40'
```

`GET /api/users` returns:

- `data`: paginated users, with `id` as an integer and `hobbies` sorted ascending.
- `pagination`: `{ page, limit, total, hasMore }`.
- `facets`: top 20 `{ value, count }` entries for `hobbies` and `nationalities`.

Search whitespace is normalized, then truncated to 100 characters.
`page` defaults to `1` and values above `100000` are capped. `limit` defaults to
`40` and values above `100` are capped. Both client URLs and API requests use
repeated `nationality` parameters for OR filtering and repeated `hobby` parameters
for AND filtering. Values are trimmed, empty entries and duplicates ignored, and
only the first 20 unique values are used. Commas are literal characters, not
separators. This replaces the previous plural CSV query parameters; API consumers
must send the singular repeated keys. JSON user/facet fields remain unchanged.
Nationality facet counts intentionally ignore the active
nationality filter while still respecting the current search and hobbies so the
full choice set remains stable.

Creation is atomic. Invalid input returns `400`; disallowed browser origins
return `403`; malformed JSON returns `400`; payloads over 32 KiB `413`;
unsupported content types or encodings `415`; database saturation/drainage or
connection failures `503` with `Retry-After: 1`; unexpected failures return a
generic logged `500`. Every response includes `X-Request-ID`, and `traceparent`
is present when tracing is enabled.

Deletion removes the user plus hobbies atomically. This endpoint is intended for
local cleanup and administrative tooling, not the public browser UI.

Names and nationality must be nonempty trimmed strings up to 100 characters
without control characters. `age` must be an integer from 0–120. `avatar` must
be an absolute HTTP(S) URL without credentials and with a maximum length of
2,048 characters. `hobbies` must contain 0–10 distinct trimmed strings up to
100 characters. Commas in hobby and nationality values are supported.

## Configuration

Configuration is validated without printing secret values:

- `DATABASE_URL`: required PostgreSQL URL. Only `postgres:` / `postgresql:`
  schemes are accepted. URL-level SSL settings other than `sslmode=verify-full`
  are rejected so certificate verification cannot be silently disabled.
- `NODE_ENV`: `development`, `test`, or `production` (`development` default).
- `PORT`: default `3001`, range `1..65535`.
- `SHUTDOWN_TIMEOUT_MS`: default `10000`, range `1..120000`.
- `HTTP_MAX_IN_FLIGHT`: default `64`, max `10000`.
- `HTTP_REQUEST_TIMEOUT_MS`: default `30000`, max `120000`.
- `HTTP_HEADERS_TIMEOUT_MS`: default `10000`, max `120000`.
- `HTTP_KEEP_ALIVE_TIMEOUT_MS`: default `5000`, max `60000`.
- `PG_POOL_MAX`: default `5`, max `100`.
- `PG_MAX_QUEUE`: default `20`, range `1..10000`.
- `PG_CONNECT_TIMEOUT_MS`: default `10000`, range `1..120000`.
- `PG_STATEMENT_TIMEOUT_MS`: default `15000`, range `1..300000`.
- `PG_LOCK_TIMEOUT_MS`: default `3000`, range `1..120000`.
- `PG_IDLE_TRANSACTION_TIMEOUT_MS`: default `10000`, range `1..120000`.
- `PG_SSL`: `true`/`false` only. `true` enables certificate-verified TLS.
- `CLIENT_ORIGIN`: optional exact HTTP(S) browser origin, no path or trailing
  slash.
- `OTEL_ENABLED`: default `false`. Set `true` to enable tracing.
- `OTEL_SAMPLE_RATIO`: default `0.1`, validated in `0..1`.
- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`: optional HTTP(S) endpoint without
  credentials for a user-owned OTLP collector.
- `TEST_DATABASE_URL`: optional separate database URL for isolated test flows.

Each API instance admits at most `HTTP_MAX_IN_FLIGHT` requests at a
time. The PostgreSQL layer allows at most `PG_POOL_MAX` checked-out clients plus
`PG_MAX_QUEUE` waiters (default total `25`), then fails fast with `503` instead
of building an unbounded queue. Admission and database tokens stay held until
the underlying work really settles, even if the client disconnects; HTTP admission
also waits for response completion so slow readers cannot bypass the limit. The server
does not automatically retry writes, including `POST /api/users`.

Both idle and leased PostgreSQL clients have error handlers. An expired idle
transaction or lost connection is discarded and surfaced as an unavailable
operation instead of becoming an unhandled EventEmitter error.

For connection budgeting, reserve headroom for admin sessions and multiply by
replicas: `total connections ~= replicas * PG_POOL_MAX + admin reserve`.
PostgreSQL `max_connections` is not auto-tuned by the app. For larger fleets,
prefer PgBouncer transaction pooling and size it per database policy. The
Node-level HTTP timeout settings apply only when this standalone server owns the
socket; managed gateways such as Vercel enforce their own outer limits.

## Frontend practices

The React/Vite SPA adapts the applicable
[Vercel React Best Practices](https://github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices)
without adding Next.js, server components, a compiler or a request-cache framework:

- One request returns users, metadata and both facets together; pagination has a
  synchronous in-flight guard, validated responses, cleanup/abort and a query
  identity guard that also covers the render-to-effect gap. Network work uses
  ordinary effects, not layout effects.
- Functional filter updates compose correctly; equivalent values preserve state
  identity and primitive request keys prevent unnecessary refetches. Normalized
  search is debounced, and IME composition never submits intermediate text.
- Memoized results isolate raw typing; memoized cards reuse stable user objects
  across pagination and row-window changes. Cheap expressions remain unmemoized.
- Virtualization has one passive scroll listener and one scheduled animation
  frame. Scroll reads cached grid geometry; resize/layout notifications refresh
  it. React state changes only when the rendered row window or columns change.
  Only actual DOM measurements/reset scrolling use layout effects.
- StrictMode exercises development cleanup, and the React Vite plugin provides
  Fast Refresh. A resettable error boundary visibly handles unexpected render
  failures; its own diagnostic contains no user data or raw error details.
- Avatars load lazily with explicit dimensions, asynchronous decoding and no
  referrer. There is no speculative preconnect to an arbitrary avatar host.
  Accessible control labels, status/error announcements and reduced-motion
  styling remain intact.

SSR/RSC, Next-specific waterfall rules and dynamic loading of tiny components do
not apply here. The fixed-height card ceiling is intentional, not a general
variable-height virtualizer. Browser history entries are replaced, not pushed;
the documented URL contract is sharing/reloading, not per-filter Back navigation.

## Dependency policy

All workspaces are private. Node 24 LTS is selected by `.nvmrc`, matches Docker,
and is required by each manifest; `packageManager` records the installed npm
version. Direct dependencies are pinned and the root lockfile is committed;
use `npm ci` for reproducible installs and review deliberate updates with
`npm outdated`, `npm audit` and the checks below.

Native npm workspace scripts replace unused Lerna. The root owns the common
formatter; runtime dependencies live in the consuming workspace, while Vite,
the React plugin and the browser test's mock Express server are client-only
development dependencies. Unused TypeScript declaration packages were removed:
this JavaScript app has no TypeScript/checkJS pipeline.
Vite uses the maintained 7.x line rather than taking the 8.x bundler migration;
React stays on compatible 19.1 patches, Express/pg receive compatible updates,
and Pino stays on its tested major. No forced audit upgrades or runtime framework
dependencies were added. Audit results are a point-in-time registry check, not a
guarantee of security. Review advisories and updates regularly.

## Validation

### Performance testing and observing the UI

The local `load-test/` folder and all its artifacts are ignored by Git. The
performance runner uses **k6**, following the planning, workload, execution,
monitoring, and analysis approach in the
[Microsoft performance-testing playbook](https://microsoft.github.io/code-with-engineering-playbook/automated-testing/performance-testing/load-testing/).
Install k6 (`brew install k6`), or set `K6_BIN` to a downloaded official binary.
The old Node batch scheduler has been replaced; its `USER_COUNT`, `CONCURRENCY`,
`TEST_DURATION_SECONDS`, and `REQUESTS_PER_SECOND` options no longer apply.

```sh
TARGET_URL=https://presight-execise-clean.vercel.app \
PROFILE=baseline SCENARIO=read RATE=5 \
node load-test/run.js
```

Defaults: a separate 15-second read-only warmup, 30-second ramp-up, 120-second
hold, and 30-second ramp-down. `RATE` means workload iterations/second, not
concurrent users. An iteration makes one list or create request and, optionally,
one cleanup request. The open arrival-rate model does not reduce the offered
load when the server slows down. `PREALLOCATED_VUS=20` and `MAX_VUS=100` bound
generator concurrency; any dropped iterations fail the test, indicating that
the intended load was not fully delivered.

| Profile    | Purpose                                                              |
| ---------- | -------------------------------------------------------------------- |
| `smoke`    | 1 iteration/s for 10 seconds to check contracts and connectivity     |
| `baseline` | Ramp, sustained expected load, ramp-down                             |
| `stress`   | Hold at 1x, 2x, 4x RATE, then return to baseline to observe recovery |
| `spike`    | Baseline, one-second jump to 5x RATE, return and observe recovery    |
| `soak`     | Ramp, one-hour sustained hold, ramp-down                             |

Override `WARMUP_SECONDS`, `RAMP_SECONDS`, and `HOLD_SECONDS` as needed. These
are example workloads, not agreed business capacity targets. Define expected
traffic, dataset size, and SLOs before using results as release gates.

`SCENARIO=read` is the default. It varies paging, search, sorting, repeated
nationality and hobby filters. `mixed` uses 70% reads and 30% creates; `write`
only creates users. Payloads use reproducible synthetic names, ages, realistic
nationalities, distinct hobbies, and actual portrait URLs. Images are not
downloaded by the HTTP generator; image and rendering performance belong to
the browser measurement. Writes stay in the target database unless cleanup is
enabled:

```sh
SCENARIO=mixed DELETE_AFTER=true \
node load-test/run.js
```

Cleanup deletes only the ID returned by each successful creation, never other
users. Failed deletions fail the test and log the affected ID. Requests that
time out after a database commit can still leave an unknown record; compare
database counts before/after write runs. This is not a bulk production cleanup
tool.

**Live observation:** open the application URL in one browser tab and
`http://127.0.0.1:5665` in another. While the test runs, exercise search,
nationality/hobby filters, scrolling and pagination; use browser DevTools
Network/Performance to inspect latency, errors, frames and rendering. The
dashboard graphs traffic, errors, latency and VUs in real time. Manual browser
observations are supplementary, not automated frontend performance gates.

Each run gets its own directory under `load-test/reports/` with `summary.json`,
`report.html`, `execution.log`, and `context.json`. The JSON includes per-operation
metrics, p95/p99, thresholds, stages and run metadata; HTML contains time-series
charts. Close the dashboard tab after the run if k6 waits to exit.
For non-interactive runs set `K6_WEB_DASHBOARD_PORT=-1`.

Defaults are p95 < 2000 ms, p99 < 4000 ms, error rate <= 1%, passing checks >=
99%, zero dropped iterations, and zero cleanup failures. Configure
`MAX_P95_MS`, `MAX_P99_MS`, `MAX_ERROR_RATE`, and `REQUEST_TIMEOUT_SECONDS`.
Warmup is excluded from workload acceptance metrics. Failed contracts,
HTTP errors, timeouts, and threshold violations produce a non-zero exit.
Do not disable TLS verification; configure a trusted CA if local trust fails.

Correlate the UTC run window with **Vercel Observability/Functions** (duration,
errors, memory and concurrency) and **Supabase database monitoring** (CPU,
connections, slow queries, disk and locks). HTTP metrics alone cannot identify
resource bottlenecks. Record deployment revision with `REVISION`, dataset
size, region, and platform settings. Repeat the same baseline at least three
times, change one variable at a time, and compare p95/p99, delivered request
rate, errors and resources before drawing capacity conclusions. Multi-IP or
distributed tests and chaos/failover tests require separate infrastructure;
these local scripts do not claim to validate those properties.

The runner's contract, cleanup and threshold checks can be exercised locally:

```sh
node --test load-test/test/*.test.mjs
```

## Checks

```sh
npm run check

# Optional real PostgreSQL integration tests; use a dedicated test database:

TEST_DATABASE_URL='******localhost:5432/directory_test' npm test

# Optional Node test coverage:

npm run test:coverage --workspace server

# HTTP load smoke starts its own local API; not a benchmark:

npm run test:load --workspace server

# Optional browser regression checks, after building; use existing Chrome:

BROWSER_BIN='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
npm run test:browser --workspace client

# Same browser scenarios against Vite development mode, including StrictMode:

BROWSER_BIN='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
npm run test:browser --workspace client -- --dev
```

Unit/API-boundary tests run without a database. PostgreSQL integration flows
should use a dedicated `TEST_DATABASE_URL`, not the primary database. The load
smoke issues a real 100-request concurrent HTTP burst from
`server/scripts/load.js` with `maxInFlight=4`; when `TEST_DATABASE_URL` is set
it also exercises an isolated PostgreSQL schema with pool max `2` and queue `2`,
checking `503` + `Retry-After: 1`, no `500`s, persisted POST counts, recovery,
and zero remaining admission/pool in-flight state. A further 40 requests run with
four workers to verify availability within capacity. It is intentionally not a
benchmark or TPS guarantee. Use staging-only `EXPLAIN (ANALYZE, BUFFERS)` to
inspect real query shapes with your own representative data.

## Backend architecture and operations

The backend keeps `src/index.js` and `src/setup.js` as the entry points while
refactoring the rest of the server into narrower modules:

- `server/src/config/index.js`: validated runtime, database and tracing config.
- `server/src/shared/errors.js`: application/configuration/unavailability errors.
- `server/src/database/pool.js`: bounded pool acquisition and queue admission.
- `server/src/database/transaction.js`: transaction wrapper with rollback cleanup.
- `server/src/database/migrate.js`: explicit migration runner.
- `server/src/database/migrations/*.sql`: deployment-run DDL only.
- `server/src/observability/tracing.js`: manual OpenTelemetry initialization and
  HTTP/database spans.
- `server/src/observability/logger.js`: structured logs with request/trace fields.
- `server/src/modules/users/service.js`: user-level orchestration.
- `server/src/modules/users/repository.js`: SQL for listing, facet counts and create.
- `server/src/modules/users/query.js`: search/filter/sort/pagination normalization.
- `server/src/modules/users/validation.js`: POST body validation.
- `server/src/modules/users/routes.js`: `/api/users` handlers.
- `server/src/http/app.js`: app assembly, health/live endpoints and static assets.
- `server/src/http/middleware/admission.js`: in-flight request backpressure.
- `server/src/http/middleware/cors.js`: exact-origin CORS policy.
- `server/src/http/middleware/errors.js`: HTTP error mapping.
- `server/src/http/middleware/request-log.js`: request IDs and fixed-route logging.
- `server/src/runtime/lifecycle.js`: standalone listen/start/shutdown wiring.

`GET /api/live` never touches the database. `GET /api/health` and `GET /api/ready`
are readiness aliases that reject while the process is draining or saturated and
fail when PostgreSQL is unavailable. The application adds no authentication of
its own: writes should be protected at the gateway, and there is no cluster-wide
rate limiter claim here.

Tracing is implemented manually rather than through broad auto-instrumentation.
When enabled, request logs include `requestId` plus correlated `traceId`/`spanId`,
W3C trace headers are propagated, and manual spans cover HTTP requests, database
transaction acquisition, transactions and individual queries. Span/log content is
PII-conscious: no SQL text, SQL parameters, request bodies, raw URLs, or query
strings are emitted. Exceptions set span status only. If tracing is enabled
without `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, correlation still works locally but
spans are not exported. Export uses `BatchSpanProcessor` with queue `1024`, batch
size `128`, delay `1000ms`, and timeout `3000ms`, and shutdown is bounded by the
existing 10-second process shutdown window.

### Migrations and indexing

The schema migrations are intentionally simple and non-destructive:

- `001-initial.sql`: creates `users` and `hobbies` if missing.
- `002-query-indexes.sql`: maintains
  `users_first_name_id`, `users_last_name_id`, `users_age_id`,
  `users_nationality_id`, and `hobbies_hobby_user_id`, and drops the obsolete
  `hobbies_hobby` index if present.

The migration ledger table is `schema_migrations(version, applied_at)`. Each run
uses a schema-scoped advisory transaction lock, then executes DDL inside one
transaction. That is appropriate for small exercise deployments, but index builds
can still block writes on very large tables; do not blindly claim zero downtime.

Optional substring acceleration with trigram indexes is deliberately separate and
must be applied explicitly, outside the startup path and with the privileges your
deployment expects:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX CONCURRENTLY users_name_trgm
  ON users USING gin ((first_name || ' ' || last_name) gin_trgm_ops);
```

`CREATE INDEX CONCURRENTLY` must run outside the migration transaction and often
deserves its own rollout window. Default deployments do not create that extension
or index automatically. Without it, substring search, deep `OFFSET` scans, and
facet counting remain honest bounded SQL rather than a claim of infinite scale.

### Deployment notes

- Use `NODE_ENV=production` in deployed environments.
- Keep PostgreSQL reachable over private networking where possible and use
  least-privilege runtime credentials.
- Run migrations as a separate deployment step; the app does not apply DDL on
  normal startup.
- Protect writes with gateway authentication/authorization, TLS and whatever
  rate-limiting policy your platform provides.
- Reserve PostgreSQL connection headroom across replicas and background admin
  usage.
- Configure backups, monitoring, restart policy and environment-secret injection
  in the platform, not in this repository.

## Running with Docker Compose

The multi-stage image contains only production dependencies, backend source and
built frontend assets, runs as the non-root `node` user and starts Node directly.
Compose runs setup explicitly, then `exec`s Node so termination signals reach
the API rather than an npm shell.

Docker Compose builds the client and API, starts PostgreSQL with a durable named
volume, and initializes the schema without replacing existing data. Set your own
`POSTGRES_PASSWORD` (use URL-safe characters, or encode reserved characters in
the connection URL):

```sh
export POSTGRES_PASSWORD='replace-with-a-local-password'
docker compose up --build
# In another terminal, create a user through the API:
curl -X POST http://localhost:3001/api/users \
  -H 'Content-Type: application/json' \
  -d '{"avatar":"https://example.com/avatar.png","first_name":"Ava","last_name":"Chen","age":25,"nationality":"American","hobbies":["Reading","Cycling"]}'
curl 'http://localhost:3001/api/users?page=1&limit=40'
```

The frontend and API are available at `http://localhost:3001`. Stop them with:

```sh
docker compose down
```

The named volume survives `down`; `docker compose down -v` deletes its data.

## Vercel

The exported Express app does not listen when imported by Vercel. The existing
multi-service configuration routes `/api/*` to the server and other paths to the
Vite client. Set `DATABASE_URL` and any required TLS/pool/tracing settings in
the server environment, and run schema setup against that database before
deployment. Set `CLIENT_ORIGIN` to the public HTTPS frontend origin in the server
environment when the browser origin differs from what the backend sees. Database
credentials must never use a `VITE_` prefix or enter the client bundle. Vercel
and similar managed gateways enforce their own outer request timeouts; the native
Node HTTP timeout settings described above apply only when this server owns the
listener directly.
