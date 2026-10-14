---
name: ducttape
description: Draw, update, explain and review AI architecture diagrams on DuctTape.io (theducttape.io). Use when the user wants an architecture diagram of an AI application from code or a description, wants an existing DuctTape.io diagram kept in step with the code, wants a diagram explained or reviewed, or asks for a diagram file to import into DuctTape.io.
license: MIT
metadata:
  version: "1.14.0"
  released: "2026-10-14"
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
   `create_field`, `list_attachments`, `get_attachment_url`, `trash_diagram`,
   `archive_diagram`, `restore_diagram` are available): create or update the draft directly. The
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
3. `update_diagram` with the full new graph and the `version` you read.
   Components and connections you leave out are removed, so send every one
   that stays, with the same id. Properties you leave out at a component keep
   their value (name, description, vendor, model, `href`, `display`, `role`,
   `fields`); `null` (or `""`, `[]` for fields) removes one on purpose. A
   connection between the same two components in the same direction keeps its
   label and flow the same way. If the version is refused, read again and redo
   the comparison.

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
- `update_diagram` keeps a component's `fields` when you leave them out; a list
  you send replaces them, `[]` removes all. Notes carry no fields.
- In a JSON file, `data.fields` keeps the copy of name and type, so the file
  is complete in itself: `[{ "fieldId", "name", "type", "value", "shown"? }]`. The
  import matches a value to the user's catalog by id, else by name and type,
  and creates the field when neither exists. `scripts/prepare-diagram.mjs`
  checks the values the way the server does.
- Mention values only when the user asks about them or they matter for the
  task; do not read them out by default.

## Mermaid in and out

Over MCP, `import_mermaid` turns Mermaid text (`flowchart`/`graph` or `architecture-beta`, or the
first mermaid block of a Markdown file with `markdown: true`) into a new diagram: labels are
matched against the catalog (kinds, vendors, model families), the rest becomes a generic box,
subgraphs become groups, styling is skipped, the server arranges everything and returns `check`.
`export_mermaid` gives a diagram back as `flowchart` (or `architecture-beta`) with stable ids in
`%% ducttape:<nodeId>` comments, so a text edited by hand can update the diagram in the editor
("Update from Mermaid") without losing positions or meta fields. Without MCP, the editor's
"New diagram" offers "From Mermaid" for pasted text or an .mmd/.md file.

Mermaid draws one diagram type per text. For a diagram that mixes UML classes with other
components, `export_mermaid` with `parts: ["flowchart", "class"]` returns one text per type for
docs; the plain `flowchart` is the whole diagram, its classes kept in `%% uml:` comments, and the
one to use for the way back into DuctTape.io.

`export_d2` gives a diagram as D2 text (d2lang.com): shapes with a class per category, groups,
pools and lanes nested, arrows by their heads, `# ducttape:<nodeId>` comments; positions do not go
along, D2 lays out by itself. `export_document` writes it as an AsciiDoc (`adoc`) or Markdown (`md`)
document: title, description, the diagram as a mermaid block (or `[d2]` in AsciiDoc), tables of the
components and connections. Meta fields are private: pass `metadata: true` only when the user asks.

## Flow on a connection

An edge may carry `"flow": "data"` (a dot, for single requests or messages), `"flow": "stream"`
(fine dashes, for streamed answers or event streams) or `"flow": "document"` (an upright sheet that
moves slowly, for files, uploads, documents on their way to indexing, batches or objects in storage).
The arrowheads decide the way: a connection has its arrow at the target, so the flow runs from source
to target; with arrows at both ends (set in the editor) it runs both ways, without arrows it stands
still. Leave it out where
nothing in particular flows; any other value is refused. It moves in the editor and on the public
page and shows as a still mark in images. MCP takes and returns it as `flow`.

## The check

DuctTape.io checks every diagram and gives notes, never errors: a component with no connection at
all; a pass-through (for example an API server or an agent) with nothing leading in or out; a
starting point (an app, a user, a cron job) with nothing leading out; an end point (a model, a
database, a tool) with nothing leading in. Connections show the direction of a call, so a model an
agent calls is an end point even though answers flow back. Each kind has a default role
(`role` in `reference/catalog.json`); set `"role": "start" | "pass" | "end" | "free"` on a node
only when it plays another part ("free" is only checked for being connected). Notes and groups are
not checked. Two notes are about the picture: components lying over each other, and a name the
icon display cuts short. A block shows the whole name and grows downwards; an icon shows at most
three lines of it, so keep icon names short or use the block. `create_diagram`, `update_diagram`
and `get_diagram` return the notes as `check`;
`prepare-diagram.mjs` prints them as `Check:` lines. Fix what the notes point at where the
architecture really has that connection; leave them where it does not.

## Processes in BPMN notation

A diagram can also show a business process in BPMN notation, joined to the AI system it uses.
Over MCP this needs the BPMN licence on the user's account: `list_catalog` says
`"bpmnLicensed": true` and lists the BPMN kinds with `"area": "bpmn"`; without it MCP refuses to
create them, and `prepare-diagram.mjs` still writes the file (the editor opens it). The kinds are in
`reference/catalog.json` under `bpmn` (tasks, events, gateways, data, containers).

- A pool (`bpmn-pool`) holds lanes (`bpmn-lane` with `"parent": "<pool id>"`, in the order they
  should stand). Tasks, events, gateways and data shapes go into a lane with `"parent": "<lane id>"`,
  or into a pool without lanes. A pool never sits inside another container.
- An AI lane (`bpmn-lane` with `"bpmn": {"aiLane": true}`, name left empty) holds the AI components
  a task uses, and only those; connect the AI task (`bpmn-ai-task`), agent task or human review to
  them. A pool may hold several AI lanes.
- Events take `"bpmn": {"trigger": "message" | "timer"}` (a timer only catches); an intermediate
  event may throw (`"throwing": true`). `"bpmn": {"vertical": true}` on a pool stands its lanes
  side by side. Pools and lanes may carry `"band"`, the colour of their title band.
- Connections at BPMN shapes carry a `notation` instead of a flow: `sequence` (the order of steps
  in one pool), `message` (between pools), `association` (to data, annotations and AI components,
  dotted; `"directed": true` adds an open head). Leave it out and it is chosen as the editor does.
- Give no coordinates: each lane becomes a band, the steps line up in one rank across the lanes.
- `update_diagram` with the licence takes the list as the whole diagram: shapes, pools and lanes
  you leave out are removed, as with every other component. Send every node you want to keep.
- The check adds the BPMN rules: a start and an end event per pool, nothing into a start or out of
  an end, every task and gateway reached from a start and leading to an end, a parallel split joined
  again, labelled ways out of an exclusive gateway, no gateway with one way in and one out, sequence
  flows inside their pool and message flows between pools, and an AI or agent task connected to an
  AI component. They are notes, like the others.

Mermaid has no BPMN: `export_mermaid` writes events as circles, gateways as diamonds, pools and
lanes as nested subgraphs and message flows as dotted arrows, with `%% bpmn:` comments that
`import_mermaid` reads back for licensed accounts.

## EPK, UML and DMN: the licences

Three more notations work like BPMN, each with a licence of its own: `list_catalog` returns
`"licences": {"bpmn", "dmn", "uml", "epk"}` and lists a notation's kinds (`"area": "epk"`, `"uml"`,
`"dmn"`) only when it is licensed. Without the licence MCP refuses to create them, and
`prepare-diagram.mjs` still writes the file (the editor opens it). Kinds, sizes and notations are
in `reference/catalog.json` under `epk`, `uml` and `dmn`. Give no coordinates: the server and the
script arrange each notation in its own way. Connections at their shapes carry a `notation`
instead of a flow; leave it out and it is chosen by the ends, as the editor does. `update_diagram`
takes the list as the whole diagram, as for BPMN.

## Process chains in EPK notation

An event-driven process chain (EPC) shows a business process as events and functions taking turns,
joined to the AI system it uses. Kinds: `epk-event`, functions (`epk-function`; the bridge
functions `epk-ai-function`, `epk-agent-function`, `epk-review-function`), connectors (`epk-and`,
`epk-or`, `epk-xor`, unnamed), `epk-org-unit`, `epk-info-object`, `epk-process-path` (a link to
another process). No pools, lanes or containers.

- Notations: `epk-control` (the chain, between events, functions, connectors and process paths),
  `epk-information` (to or from an information object), `epk-assignment` (an organisational unit
  or an AI component to its function).
- Paths split and meet only at connectors: an event or a function has one control flow in and one
  out. A split is joined again by a connector of the same kind.
- Layout: the chain top to bottom; units on the left of their function, information objects and AI
  components on its right.
- The check: a chain begins and ends with an event (or a process path); events and functions take
  turns (connectors pass through); no OR or XOR right after an event (an event decides nothing);
  every split meets a join of its kind; several flows out of or into an event or function need a
  connector; every function has an organisational unit; an AI or agent function is connected to an
  AI component.

Mermaid: `export_mermaid` writes an EPC as a flowchart (events as stadiums, functions as
rectangles, connectors as circles) with `%% epk:<id> <kind>` comments; `import_mermaid` reads such
a flowchart back as an EPC with the EPK licence.

## Class diagrams in UML notation

A UML class diagram shows the code of an AI system: `uml-class`, `uml-interface`, `uml-abstract`,
`uml-enum`. A class carries `"uml"`: `attributes` and `operations`, one line each with its
visibility (`"+ id: UUID"`, `"+ search(q: Query): Chunk[*]"`; an enumeration's values as
attributes; see "Limits"), and `category` (an AI category
such as `"model"` or `"retrieval"`) for a class that stands for an AI component. The box grows with
its texts.

- Relations (`notation`): `uml-association` (`"directed": true` adds an open head at the target),
  `uml-inheritance` (source = the special class, target = the general one), `uml-realization`
  (source = the class, target = the interface), `uml-aggregation` and `uml-composition` (source =
  the whole, target = the part), `uml-dependency` (source uses target). Left out: an association,
  a realization towards an interface, a dependency to an AI component.
- `sourceLabel` and `targetLabel` put a multiplicity or a role at the ends
  (`"1"`, `"0..*"`); only on UML relations. `directed` only on associations.
- Layout: in levels, the general class above the special ones.
- The check: a realization ends at an interface; inheritance runs one way (no class inherits from
  itself through others).

Mermaid: a diagram of classes exports as `classDiagram`, and `import_mermaid` turns a
`classDiagram` into classes with the UML licence. In a diagram that also has other components, the
plain `flowchart` keeps the classes in `%% uml:` comments (the way back); `parts: ["flowchart",
"class"]` gives one text per type for docs.

## Decisions in DMN notation

A DMN decision requirements diagram shows what a decision needs: `dmn-decision`, `dmn-ai-decision`
(a decision a model takes), `dmn-input-data`, `dmn-knowledge-source` (a policy, a regulation),
`dmn-bkm` (a business knowledge model: rules, a scoring function).

- Requirements (`notation`): `dmn-information` (input data or a decision into a decision),
  `dmn-knowledge` (from a business knowledge model into a decision or another model),
  `dmn-authority` (from a knowledge source into a decision, a model or another source),
  `dmn-association` (to an AI component). Left out: chosen by the source.
- A decision's logic is a decision table: a node of kind `dmn-decision-table` with `"table"`:
  `decision` (the id of its decision; one table per decision), `hitPolicy` (`U` unique, the default,
  `A`, `F`, `P`, `C`, `R`, `O`), `aggregation` (only with `C`: `+`, `<`, `>`, `#`), `columns`
  (`{ "name", "type"?: "string" | "number" | "boolean" | "date", "side": "in" | "out" }`, at least
  one of each side) and `rules` (`{ "cells": [...one text per column...], "note"? }`, at least
  one; a cell like `">= 700"` or `"-"` is shown as written, nothing is
  evaluated). A table has no connections; it stands to the right of its decision.
- A BPMN business rule task names the decision it applies: `"bpmn": {"decision": "<node id>"}`.
- Layout: bottom up, a decision above what it requires.
- The check: each requirement joins shapes it can; a decision requires something; an AI decision
  is connected to an AI component; requirements form no loop; a table belongs to a decision of the
  diagram, and a decision has at most one; a business rule task names a decision of the diagram.

Mermaid has no DMN: `export_mermaid` writes the shapes as plain flowchart nodes and leaves the
decision tables out; `import_mermaid` does not bring them back as DMN shapes.

## Workflow: explain or review

Read the diagram with `get_diagram` (or the JSON file the user gives you).
Explain it along the path of a request, from the user to the answer. For a
review use the checklist in `reference/modelling.md` ("Review checklist"): name
what is missing (guardrails, tracing, fallback, auth, evals) and why it matters
for this system. Suggest, do not change, unless asked.

## Documentation

Only on request: put the diagram's public link into a README. You cannot publish;
the user publishes in the app and gives you the link (`https://theducttape.io/d/...`).

## Links between diagrams

A component, a group, a BPMN task or sub-process, an EPK function or process path and a DMN
decision can point to another of the user's diagrams: `linkedDiagram` with that diagram's id
(from `list_diagrams`) on `create_diagram` or `update_diagram`; `get_diagram` returns it. Use it
for views of one system, an overview whose component opens the diagram that details it. Only the
user's own diagrams; in the editor a click on the mark opens the target, and the public page shows
the link only when the target is published too.

## Limits

- You cannot publish, withdraw or delete a diagram for good, and you must not try to
  work around that. Say so and point to the app.
- Move diagrams to the trash or the archive only when the user explicitly asks,
  and ask which diagrams they mean before you do. Deleting for good and emptying
  the trash only happen in the app.
- Ask before `update_diagram` on a diagram you did not create in this conversation.
- No new groups through MCP or the script; use a note or naming to mark boundaries. The groups
  the user drew come with `get_diagram` as nodes of kind `group`: pass them on to
  `update_diagram` with their id unchanged, and their members stay in them.
- No new images: the user uploads them in the editor. `get_diagram` returns them
  as nodes of kind `image`; pass these on to `update_diagram` with their id
  unchanged, or the image leaves the draft.
<!-- limits:start (written by scripts/pack-skill.mjs from the app's constants) -->
- Text lengths: a component's name, a note's text and a connection's label at most 200 characters each; a description at most 2000; a link (`href`, http or https) at most 2000. A longer text is refused with the component, the field and the limit: shorten that one and send again.
- At most 500 components and 1000 connections; at most 50 field values per component, a text value at most 2000 characters.
- A UML class at most 50 attributes and 50 operations of at most 160 characters each; a text at a relation's end at most 40. A decision table at most 30 columns and 500 rules, a column name at most 80 characters, a cell or a rule's note at most 200.
<!-- limits:end -->
- A readable diagram has 8 to 25 components.
- Vendor names and logos belong to their owners. Name a vendor only where the
  system really uses it.
