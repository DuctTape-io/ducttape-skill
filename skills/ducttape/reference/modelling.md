# Modelling rules

## Node fields

| Field | Use |
|---|---|
| `id` | Your own short id, unique in the diagram (`api`, `llm-answer`). Keep ids stable across updates. |
| `kind` | A component kind from the catalog. `note` is a free text note. |
| `label` | What this part is called in this system ("Support agent", not "Agent"). Leave out to get the catalog name. |
| `vendor` | Vendor id from the catalog (`anthropic`, `pinecone`). Only when it is really used. |
| `model` | Concrete model, for components of category `model` ("Claude Opus 5"). |
| `description` | One or two sentences: what it does here, limits, config worth knowing. |
| `display` | How the component is drawn: `block` (a card, the default) or `icon` (a large icon with the labels below, narrower). Leave out for `block`. Notes have no display. |

Edges: `source`, `target`, optional `label`.

## Which component for what

- The person or system that starts a request: `end-user`, or a client component (`web-app`, `mobile-app`, `cli`, `chat-bot`).
- Your own server code: `api-server`, `serverless-function`, `worker`; `queue` and `cron` for async work.
- Something that decides and calls tools in a loop: `agent`. A fixed sequence of steps: `workflow`. A choice between paths: `router`.
- Every model that is called gets its own component: `llm`, `embedding-model`, `reranker`, `image-model`, `audio-model`. Two different models are two components; the same model used in two roles is two components only when the roles matter.
- Between your code and the model providers: `ai-gateway` (one entry point, keys, logging), `model-router` (picks a model), `cache`, `rate-limiter`.
- Retrieval: `document-loader` and `chunker` on the ingestion side, `vector-db` or `hybrid-search` on the query side, `knowledge-graph` when relations are stored.
- Plain data: `relational-db`, `object-storage`, `data-warehouse`, `external-api`, `file`.
- What an agent can use: `mcp-server`, `function-tool`, `code-sandbox`, `browser-tool`, `web-search`.
- State across turns: `short-term-memory`, `long-term-memory`, `session-store`.
- Safety: `guardrails` (input or output checks), `pii-filter`, `auth`, `secrets-manager`.
- Quality: `tracing`, `evals`, `feedback-loop`, `prompt-registry`.
- People in the loop: `human-in-the-loop`, `admin`.
- Nothing fits: `box` with a clear label. Do not bend a typed component into something it is not.

## Edges

- Direction is the direction of the call or the data: caller to callee.
- Label what flows, in two to four words: "question", "top 5 chunks", "tool call", "embeddings". An unlabelled edge is fine when it is obvious.
- A return path is its own edge only when the answer is worth showing (e.g. "streamed answer"). Do not mirror every call.
- No edge from a component to itself.

## Layout and size

- One diagram answers one question ("how does a request flow?", "how are documents ingested?"). Two questions are two diagrams.
- 8 to 25 components read well. Above that, merge details (three similar tools become one `function-tool` with a description) or split.
- Reading direction is left to right: who asks on the left, models and data on the right. The layout follows the edges, so the first edge between two components should point in reading direction.
- Display: stay with `block` unless the user asks for icons or the diagram should read like a classic architecture diagram; then set `display: "icon"` on every component, not on a few. Colour, category, vendor and model show in both.
- Groups mark boundaries (a VPC, a team, a vendor). They are placed by hand in the editor; through MCP and the script use a `note` instead ("Everything right of the gateway runs in the EU region").

## Typical architectures

**RAG**
`end-user` → `web-app` → `api-server` → `llm`; `api-server` → `embedding-model` ("embed question") → `vector-db` ("top k chunks") → optional `reranker` → back into the prompt. Ingestion as a second path: `document-loader` → `chunker` → `embedding-model` → `vector-db`. Add `guardrails` before the answer leaves and `tracing` on the server.

**Agent with tools**
`end-user` → `chat-bot` → `agent` → `llm` ("plan and decide"); `agent` → one `mcp-server` or `function-tool` per backend system ("tool call"); `agent` → `short-term-memory`. `human-in-the-loop` where actions need approval, `guardrails` around tool input, `tracing` on the agent.

**Gateway with fallback**
`api-server` → `ai-gateway` → primary `llm` ("primary") and second `llm` ("fallback on error or timeout"); `ai-gateway` → `cache`, `rate-limiter`, `tracing`. Put vendor and model on each model component.

## Review checklist

- Guardrails: is user input checked before the model, and output before it reaches the user or a tool with side effects?
- Tracing: can a single request be followed across model and tool calls?
- Fallback: what happens when the primary model or provider fails or times out?
- Auth: who may call the entry point, and with whose rights do tools act?
- Secrets: where do provider keys live?
- Evals and feedback: how does the team notice the system getting worse?
- Data: where does personal data flow, is there a `pii-filter` before it leaves?
- Memory: what is stored across sessions, and for how long?
- Single points: one component every path depends on, without cache or queue in front?

Name only what is relevant for the system at hand; a prototype does not need all nine.
