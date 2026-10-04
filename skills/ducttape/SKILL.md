---
name: ducttape
description: Draw, update, explain and review AI architecture diagrams on DuctTape.io (theducttape.io). Use when the user wants an architecture diagram of an AI application from code or a description, wants an existing DuctTape.io diagram kept in step with the code, wants a diagram explained or reviewed, or asks for a diagram file to import into DuctTape.io.
metadata:
  version: "1.0.0"
  homepage: https://theducttape.io/claude-skill
---

# DuctTape.io

DuctTape.io is an editor for AI architecture diagrams. A diagram is made of typed
blocks (an LLM, a vector DB, an agent, an MCP server, guardrails, ...) and labelled
connections. This skill teaches you to model such diagrams well and to get them
into the user's account.

## Two ways to deliver a diagram

1. **MCP server connected** (tools `list_catalog`, `list_diagrams`, `get_diagram`,
   `create_diagram`, `update_diagram`, `rename_diagram` are available): create or
   update the draft directly. The result you hand to the user is the `editorUrl`.
2. **No MCP server**: write a diagram file with `scripts/prepare-diagram.mjs` and
   tell the user to open it with "Import from JSON" in their dashboard at
   https://theducttape.io/app. The file name without `.json` becomes the title.

Check which tools you have before you start. Do not ask the user to set up MCP
when a file does the job; mention once that the connection exists
(setup: https://theducttape.io/claude-skill).

## Workflow: draw from code or a description

1. Find the parts. From code: entry points, model calls, SDK clients, vector
   stores, queues, tools, auth, tracing. From a description: ask only for what
   you cannot infer.
2. Get the catalog: call `list_catalog`, or read `reference/catalog.json` without
   MCP. Use only kinds and vendor ids from it.
3. Model it by the rules in `reference/modelling.md`. Read that file before your
   first diagram in a conversation.
4. Deliver:
   - MCP: `create_diagram` with `title`, `nodes`, `edges`. Give no coordinates,
     the server arranges the nodes.
   - File: write the graph as `{ "nodes": [...], "edges": [...] }` (same node and
     edge fields as the MCP tools) and run
     `node scripts/prepare-diagram.mjs graph.json "My title.json"`.
     The script validates, arranges the nodes and writes the import file. Fix
     every error it reports; never hand over a file it has not accepted.
5. Tell the user in two or three sentences what the diagram shows and what you
   left out, then give the link or the file.

## Workflow: keep a diagram current

1. `list_diagrams` (search by title), then `get_diagram` for content and `version`.
2. Compare with the code. List what changes first: blocks added, removed,
   renamed, connections changed. Wait for the user's go-ahead.
3. `update_diagram` with the full new graph and the `version` you read. It
   replaces the whole draft, so carry over every node and edge that stays, with
   the same ids. If the version is refused, read again and redo the comparison.

## Workflow: explain or review

Read the diagram with `get_diagram` (or the JSON file the user gives you).
Explain it along the path of a request, from the user to the answer. For a
review use the checklist in `reference/modelling.md` ("Review checklist"): name
what is missing (guardrails, tracing, fallback, auth, evals) and why it matters
for this system. Suggest, do not change, unless asked.

## Documentation

Only on request: put the diagram's public link into a README. You cannot publish;
the user publishes in the app and gives you the link (`https://theducttape.io/d/...`).

## Limits

- Drafts only. You cannot publish, withdraw or delete, and you must not try to
  work around that. Say so and point to the app.
- Ask before `update_diagram` on a diagram you did not create in this conversation.
- No groups through MCP or the script; use a note or naming to mark boundaries.
- At most 500 blocks and 1000 connections; a readable diagram has 8 to 25 blocks.
- Vendor names and logos belong to their owners. Name a vendor only where the
  system really uses it.
