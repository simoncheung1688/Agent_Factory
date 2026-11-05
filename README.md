# Agent Factory demo

A local demo of the AI Control Framework workflow from `AI_Control_Framework_updated.pptx`.

The Pipeline Runner receives any free-form request and asks an LLM for one or more agent specifications in the same shape as `capabilityCatalog.js`. It **looks in the Agent Pool first**. A healthy match is reused. A miss calls the Agent Factory, which registers a new specialist and marks it `predefined` (a catalogue capability) or `dynamic` (invented for this request). Agents then run in sequence and pass a structured payload forward. Each specialist executes through a pi.dev adapter (`@earendil-works/pi-agent-core`).

```
Request → Pipeline Runner → Pool lookup → Reuse or Factory → Execute → Response
```

Specialist output and the five MCP servers are simulated in this process. The gateway still enforces which specialist may call which server.

Agents pass a structured payload directly to the next step. PostgreSQL `agent_events` is an audit log for that run. It is not the channel that carries the work.

## Run

Requires Node.js 18 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000

You can also start it with `node src/server.js`. Set `PORT` to change the port.

`node src/server.js` plans with **grok-4.7**. Copy `.env.example` to `.env` and set your xAI key. The server sends it as `Authorization: Bearer` to `https://api.x.ai/v1/responses`. The key stays in `.env`, which git ignores.

```bash
XAI_API_KEY=your-xai-api-key
```

`PI_MODEL` overrides the model. When it is unset, the planner uses `grok-4.7`. A variable already set in the shell is left as-is. Without `XAI_API_KEY`, the pipeline responds with a 503 naming that variable.

### Guardrail

Specialized agents call `execute(input) → output`. That call goes through `src/piHarness.js`, which owns the pi Agent loop. The adapter's `beforeToolCall` hook is the access check for `agent_events.read`:

- A **predefined** agent, one whose capability is in `capabilityCatalog.js`, may read rows for the current run.
- A **dynamic** agent, one the LLM invented, is blocked before the read runs. The tool returns a forbidden result, and the pipeline writes an `audit_denied` row.

The result page shows Predefined or Dynamic, the generated specification for a dynamic agent, and whether `agent_events` access was allowed or blocked.

If `DATABASE_URL` is unset, the server starts a local PostgreSQL cluster in `.pgdata`, creates `agent_factory`, and applies `migrations/`. Events then go to `agent_events`. If that cluster cannot start, events stay in the in-memory run log returned by the API. If a configured database becomes unreachable, new events are printed to the console and the pipeline still finishes.

## Event log

Copy `.env.example` to `.env` when you want rows in PostgreSQL. A variable already set in the shell is left as-is.

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/agent_factory
```

The same settings can be split into `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, and `PGDATABASE`. `DATABASE_URL` wins when both are present.

### Local PostgreSQL

Docker:

```bash
docker run --name agent-factory-pg \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=agent_factory \
  -p 5432:5432 \
  -d postgres:16
```

Homebrew:

```bash
brew install postgresql@16
brew services start postgresql@16
createdb agent_factory
```

Postgres.app works too. Create a database named `agent_factory`, then point `DATABASE_URL` at it.

### Migration

```bash
npm run migrate
```

That applies `migrations/*.sql` once and records them in `schema_migrations`. To apply the file yourself:

```bash
psql "$DATABASE_URL" -f migrations/001_create_agent_events.sql
```

On startup the server logs either `PostgreSQL logging enabled` or that logging is not configured.

Each pipeline response includes `runId`. The status line under the request box shows the same id. `GET /api/agent-events?runId=<uuid>` returns the stored rows when the database is up.

### Example queries

```sql
-- One run, in order
SELECT sequence_num, event_type, agent_name, status, duration_ms, error_message
FROM agent_events
WHERE run_id = '00000000-0000-0000-0000-000000000000'
ORDER BY sequence_num;

-- What a run handed between steps
SELECT sequence_num, agent_name, input_payload, output_payload
FROM agent_events
WHERE run_id = '00000000-0000-0000-0000-000000000000'
  AND event_type = 'handoff'
ORDER BY sequence_num;

-- Recent failures
SELECT created_at, run_id, agent_name, error_message
FROM agent_events
WHERE status = 'error'
ORDER BY created_at DESC
LIMIT 20;

-- Tool calls for one agent
SELECT sequence_num, tool_name, tool_args, tool_result
FROM agent_events
WHERE run_id = '00000000-0000-0000-0000-000000000000'
  AND event_type = 'tool_call'
ORDER BY sequence_num;
```

Event types written by the Pipeline Runner: `run_start`, `agent_selected`, `agent_created`, `agent_start`, `tool_call`, `agent_end`, `handoff`, `error`, `run_end`. `agent_created` is written only when the factory is called. A pool hit writes `agent_selected` with `decision: "reuse"` and does not write `agent_created`.

## Tests

```bash
npm test
```

The suite uses the built-in Node.js test runner (`node --test`). It covers:

- factory creation, skill loading, policy, and pool registration
- pool lookup by capability, skill, status, and metadata
- pipeline create path, reuse path, mixed path, and payload hand-off
- `agent_events` rows for the create path, the reuse path, and a failed database write
- dynamic agent creation from arbitrary input, the pi.dev harness, and the `agent_events` guardrail
- the HTTP portal from request to response

## Try these requests

1. `Investigate the RAN drop at cell site TST-12, check the SOP, and draft an incident report`
2. Run that same sentence again. The pool hits, and all three agents are reused.
3. `Look up the SOP for handover failures and summarize the steps`
4. `Research private 5G trends and write a short briefing`
5. `Triage critical alarms at TST-12 and map neighbour topology`
6. `Review who can access radio operations in Keycloak and open a vendor ticket for site TST-12`
7. `Plan a maintenance window for site TST-12`
8. **Clear pool**, then run the first sentence again. The factory creates new agents.

`GET /api/mcp` lists the five servers: RAN, Knowledge, Topology, Identity, and Vendor. A tool call is routed only when the agent's policy includes that server. The Change Planner is authorized for Knowledge MCP and Topology MCP. The Alarm Triage agent is authorized for RAN MCP only.

## Layout

| Path | Role |
| --- | --- |
| `src/agentPool.js` | In-memory registry |
| `src/agentFactory.js` | `AgentFactory.createAgent(spec)` |
| `src/specializedAgent.js` | Structured task execution |
| `src/pipelineRunner.js` | Planning, lookup, orchestration, and event logging |
| `src/llmPlanner.js` | LLM planner that returns catalogue-shaped agent specs |
| `src/piHarness.js` | pi.dev adapter and the `agent_events` guardrail |
| `src/eventLogger.js` | Writes `agent_events` rows; falls back to the console |
| `src/eventLog.js` | In-memory trail returned with the pipeline response |
| `src/db.js` | PostgreSQL pool from `DATABASE_URL` or `PG*` |
| `src/localPostgres.js` | Local cluster used when no external database is configured |
| `src/migrate.js` | Applies `migrations/*.sql` |
| `src/mcpGateway.js` | Five MCP servers, tool routing, and authorization |
| `src/server.js` | HTTP API and static portal |
| `migrations/` | `agent_events` schema |
| `public/` | Request portal |
| `skills/` | `skill.md` documents the factory loads |
| `tests/` | Pool, factory, pipeline, event log, and end-to-end tests |

`POST /api/pipeline` with `{ "request": "..." }` returns the final text, the agents that were created or reused, the in-memory run log, and `runId` for the `agent_events` rows.
