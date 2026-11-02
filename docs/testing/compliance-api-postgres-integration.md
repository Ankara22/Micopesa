# Opt-in Compliance API/PostgreSQL Integration Tests

This workflow runs the real Express compliance and regulator routes against a
fresh, disposable PostgreSQL 18 database using the Unix socket in WSL
`Ubuntu-24.04`. It is intentionally not part of any default root or API test
command. It never runs migrations, uses application credentials, or destroys a
database.

Each run requires a **new uniquely named database**. The runner refuses
databases outside the `micopesa_api_integration_<unique_suffix>` naming
convention, a non-empty fixture database, an unexpected role or server
identity, or a PostgreSQL connection that is not the expected local socket.
The existing integration database and working copy must not be reused.

## Requirements

- WSL distribution `Ubuntu-24.04`, Ubuntu 24.04, PostgreSQL 18, data directory
  `/var/lib/postgresql/18/main`, and socket `/var/run/postgresql`.
- PostgreSQL remains socket-only: `listen_addresses` is empty and no TCP
  listener is enabled.
- User-scoped Node.js 22 or newer and npm.
- A non-superuser PostgreSQL login role matching the Linux account, configured
  for local peer authentication. Do not use an application database role.
- A separate Linux working copy with the API source and `package.json` /
  `package-lock.json`; do not copy `.env*`, `.git`, Windows `node_modules`,
  uploads, logs, or build output.

The test runner explicitly bypasses the API dotenv loader before importing the
database pool. It sets a disposable database URL and a test-only JWT secret
itself, and does not read `.env`, `.env.test`, or any other environment file.
The runner binds its HTTP server to `127.0.0.1` only.

## Prepare one fresh database

Run these commands from Ubuntu-24.04. Choose a new suffix for each run and stop
if the database name already exists. Never reuse an earlier test database.

```bash
set -euo pipefail

DB="micopesa_api_integration_$(date -u +%Y%m%d_%H%M%S)_$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
ROLE="$(id -un)"
REPO="/mnt/d/Users/jumab/MicoPesa"
WORK="$HOME/micopesa-api-integration-$DB"

test "$(lsb_release -rs)" = "24.04"
test "$(/usr/lib/postgresql/18/bin/postgres --version | awk '{print $3}' | cut -d. -f1)" = "18"
test "$(/usr/sbin/runuser -u postgres -- /usr/bin/psql -X -h /var/run/postgresql -d postgres -Atc "SHOW data_directory")" = "/var/lib/postgresql/18/main"
test "$(/usr/sbin/runuser -u postgres -- /usr/bin/psql -X -h /var/run/postgresql -d postgres -Atc "SHOW listen_addresses")" = ""
! ss -ltnp | grep -E 'postgres|:5432'

if /usr/sbin/runuser -u postgres -- /usr/bin/psql -X -h /var/run/postgresql -d postgres -Atc \
  "SELECT 1 FROM pg_database WHERE datname = '$DB'" | grep -q 1; then
  echo "Refusing to reuse existing database: $DB" >&2
  exit 1
fi
```

The commands above inspect only PostgreSQL metadata; they do not read project
environment files. Have the PostgreSQL owner create the peer login role first
if it does not exist. Keep it non-superuser and without `CREATEDB` or
`CREATEROLE`; the API process connects as `"$ROLE"`, never as `postgres`.

Create the new database and initialize it from the current canonical schema:

```bash
/usr/sbin/runuser -u postgres -- /usr/bin/createdb -h /var/run/postgresql "$DB"
cp "$REPO/database/schema.sql" "/tmp/${DB}-schema.sql"
chmod 0644 "/tmp/${DB}-schema.sql"
/usr/sbin/runuser -u postgres -- /usr/bin/psql -X -h /var/run/postgresql \
  -d "$DB" -v ON_ERROR_STOP=1 -f "/tmp/${DB}-schema.sql"
```

Install the guarded, test-only rollback trigger and least-privilege fixture
grants. This step verifies the target database, socket, data directory,
PostgreSQL major version, and non-superuser API role before creating anything.
It also refuses a database with existing application or integration data.

```bash
/usr/sbin/runuser -u postgres -- /usr/bin/psql -X -h /var/run/postgresql \
  -d "$DB" -v ON_ERROR_STOP=1 \
  -v expected_database="$DB" -v api_role="$ROLE" \
  -f "$REPO/database/tests/compliance_api_integration_support.sql"
```

The support SQL is for this disposable test database only. It adds no
application migration and does not remove existing protections or data.

## Create an isolated Linux working copy

Use exact source/manifests rather than copying the repository, so no
environment files or user data enter the test copy:

```bash
mkdir -p "$WORK/apps/api/tests"
cp -R "$REPO/apps/api/src" "$WORK/apps/api/src"
cp "$REPO/apps/api/package.json" "$REPO/apps/api/package-lock.json" "$WORK/apps/api/"
cp "$REPO/apps/api/tests/complianceWorkflow.integration.cjs" "$WORK/apps/api/tests/"

cd "$WORK/apps/api"
npm ci --ignore-scripts --no-audit --no-fund
```

Do not install packages with `npm install`; use the checked-in lockfile. The
compliance routes do not need dependency lifecycle scripts, so `--ignore-scripts`
is intentional.

## Run and interpret the suite

Pass the exact new database name and current Linux role explicitly:

```bash
cd "$WORK/apps/api"
node tests/complianceWorkflow.integration.cjs --database "$DB" --role "$ROLE"
```

Before creating fictional users/funds or starting the API, the runner opens a
Unix-socket connection and verifies the exact database name, role, non-superuser
status, PostgreSQL 18, data directory, empty `listen_addresses`, and NULL server
address/port. It then verifies that the fixture database is empty. Any mismatch
aborts before fixture setup.

The in-process HTTP suite mounts the real manager and regulator routers,
authentication middleware, and controllers. It reports per-scenario results
plus `TESTS`, `PASS`, and `FAIL` totals, and exits nonzero if any scenario fails.
Coverage includes:

- Manager drafts, submissions, snapshots, invalid and repeated submissions.
- Regulator report retrieval, acceptance, rejection, revision, invalid and
  repeated decisions.
- Versioned resubmission with preserved original submission/review history.
- Worker, manager, and inactive-account authorization.
- Two concurrent decisions using separate PostgreSQL sessions.
- Controlled failures after workflow writes, verifying submission and review
  transactions roll back report status, history, notifications, and audit.
- Checked-out-client query warning regression coverage.

The suite leaves its database and fictional records intact for evidence. There
is no automatic teardown. A subsequent run requires a separately created fresh
database and Linux working copy.
