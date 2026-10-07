---
name: ducttape
description: Draw, update, explain and review AI architecture diagrams on DuctTape.io (theducttape.io). Use when the user wants an architecture diagram of an AI application from code or a description, wants an existing DuctTape.io diagram kept in step with the code, wants a diagram explained or reviewed, or asks for a diagram file to import into DuctTape.io.
license: MIT
metadata:
  version: "1.4.1"
  released: "2026-10-08"
  repository: https://github.com/DuctTape-io/ducttape-skill
  homepage: https://theducttape.io/claude-skill
---

# DuctTape.io

DuctTape.io is an editor for AI architecture diagrams. A diagram is made of typed
components (an LLM, a vector DB, an agent, an MCP server, guardrails, ...) and labelled
connections. This skill teaches you to model such diagrams well and to get them
into the user's account.

## Two ways to deliver a diagram

1. **MCP server connected** (tools `list_catalog`, `list_diagrams`, `get_diagram`,
   `create_diagram`, `update_diagram`, `rename_diagram`, `list_fields`,
   `create_field`, `list_attachments`, `get_attachment_url` are available): create or update the draft directly. The
   result you hand to the user is the `editorUrl`.
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
2. Compare with the code. List what changes first: components added, removed,
   renamed, connections changed. Wait for the user's go-ahead.
3. `update_diagram` with the full new graph and the `version` you read. It
   replaces the whole draft, so carry over every node and edge that stays, with
   the same ids, the same `display` and the same `fields`. If the version is
   refused, read again and redo the comparison.

## Meta fields

A component can carry meta field values: private key-value data such as an
owner, a monthly cost, a review date, a ticket link or a status. They stay with
the owner: never on a public page or in a copy someone imports. The user's account has one catalog of fields (name, type,
whether a component may hold several values); the values at the components
point at a field by its id and carry a copy of its name and type.

- `get_diagram` returns each component's values as `fields`:
  `[{ "fieldId", "name", "type", "value", "shown" }]`.
- Set values with `fields` on a node of `create_diagram` or `update_diagram`:
  `[{ "fieldId", "value", "shown"? }]`. Call `list_fields` first; the ids come from
  there. A missing field you may add with `create_field` (name, type `text`,
  `number`, `date`, `link`, `select` or `boolean`, optional `multiple`,
  `options`, `description`); reuse a field of the same meaning instead of
  creating a near duplicate.
- Values: text is a string (at most 2000 characters), number a number, date
  `YYYY-MM-DD`, link an `http(s)` address, select one of the field's options,
  boolean `true` or `false`. An unknown field id, a value that does not fit
  the type, or two values of a field that is not `multiple` are refused.
- Attachments (type `file`) are private files the user added in the editor
  (PDF, text, Markdown, JSON or an image); the value is the attachment's id.
  Carry their values over as `get_diagram` returned them; you cannot upload
  or set new ones. To read one, `list_attachments` lists them and
  `get_attachment_url` gives a download link that works for ten minutes;
  do not show that link to anyone else.
- `shown: true` draws a value under the component's name in the owner's
  editor, presentation and PNG/SVG exports (at most three lines, then "+n");
  never on a public page. Missing or `false` means hidden: set it only when the
  user wants the value visible in the picture, and carry it over on updates.
- `update_diagram` replaces the whole draft: carry over every component's
  `fields` (with `shown`) or its values are removed. Notes carry no fields.
- In a JSON file, `data.fields` keeps the copy of name and type, so the file
  is complete in itself: `[{ "fieldId", "name", "type", "value", "shown"? }]`. The
  import matches a value to the user's catalog by id, else by name and type,
  and creates the field when neither exists. `scripts/prepare-diagram.mjs`
  checks the values the way the server does.
- Mention values only when the user asks about them or they matter for the
  task; do not read them out by default.

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
- No new images: the user uploads them in the editor. `get_diagram` returns them
  as nodes of kind `image`; pass these on to `update_diagram` with their id
  unchanged, or the image leaves the draft.
- At most 500 components and 1000 connections; a readable diagram has 8 to 25 components.
- Vendor names and logos belong to their owners. Name a vendor only where the
  system really uses it.
