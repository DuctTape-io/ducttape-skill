#!/usr/bin/env node
// Turns a graph of nodes and edges into a file for "Import from JSON" on
// DuctTape.io: validates it against the diagram format and arranges the nodes.
// No dependencies; needs Node.js 18 or later.
//
//   node prepare-diagram.mjs graph.json "My title.json" [--direction LR|TB]
//   (--direction is for AI diagrams; pools, EPK, UML and DMN are arranged in their own way.)
//
// graph.json is either
//   { "nodes": [{ "id", "kind", "label"?, "vendor"?, "model"?, "description"?, "href"?, "display"?, "role"?, "fields"?,
//                 "parent"?, "bpmn"?, "band"?, "uml"?, "table"? }],
//     "edges": [{ "source", "target", "label"?, "flow"?, "notation"?, "directed"?, "sourceLabel"?, "targetLabel"? }] }
// or a finished diagram file (with "schemaVersion"), which is only validated.
// "fields" are private meta field values: [{ "fieldId", "name", "type", "value", "shown"? }], see SKILL.md.
// "parent", "bpmn" and "band" are BPMN's (pools, lanes, events); "uml" holds a UML class's
// attributes, operations and category; "table" a DMN decision table (decision, hitPolicy,
// aggregation, columns, rules); "notation" names the kind of connection at a BPMN, EPK, UML or
// DMN shape, "sourceLabel"/"targetLabel" the texts at the ends of a UML relation. The same
// fields as the MCP tools take; the kinds and notations are in reference/catalog.json.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LIMITS = { nodes: 500, edges: 1000, bytes: 512 * 1024, images: 20 };
// Shape of an address in the app's own file storage (ASSET_URL in the app).
const IMAGE_URL = /^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\/assets\/[A-Za-z0-9_-]+\.(?:png|jpg|webp|svg)$/;
const DISPLAYS = ["block", "icon"];
// Meta fields (FIELD_LIMITS and fieldValueFits in the app).
const FIELD = { types: ["text", "number", "date", "link", "select", "boolean", "file"], perNode: 50, name: 60, text: 2000, link: 2000, option: 80 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const GAP = { rank: 64, node: 32 };
// Edge labels as the editor draws them (EDGE_LABEL in the app's lib/edge-label-spot.ts): the gap
// between two layers is at least the widest label in it plus a free line on each side.
const EDGE_LABEL = { charWidth: 7, padding: 18, margin: 16 };
// Notes grow with their text (NOTE_NODE in the app's lib/node-display.ts).
const NOTE = { width: 200, minHeight: 112, padding: 12, border: 1, lineHeight: 20, charsPerLine: 24 };
// Shown meta fields: lines under a component's name (FIELD_LINES in the app's lib/node-display.ts).
const FIELD_LINES = { lineHeight: 14, gap: 4, max: 3 };

const args = process.argv.slice(2);
const flag = args.indexOf("--direction");
const direction = flag >= 0 ? args[flag + 1] : "LR";
if (flag >= 0) args.splice(flag, 2);
const [inPath, outPath] = args;
if (!inPath || !["LR", "TB"].includes(direction)) {
  console.error('Usage: node prepare-diagram.mjs graph.json "My title.json" [--direction LR|TB]');
  process.exit(2);
}

const catalog = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "reference", "catalog.json"), "utf8"),
);
const kindName = new Map(catalog.blocks.map((b) => [b.kind, b.name]));
// The diagram check (lib/check.ts in the app): a default role per kind, "role" on a node overrides it.
const ROLES = ["start", "pass", "end", "free"];
const kindRole = new Map(catalog.blocks.map((b) => [b.kind, b.role]));
const vendorIds = new Set(catalog.vendors.map((v) => v.id));

let input;
try {
  input = JSON.parse(readFileSync(inPath, "utf8"));
} catch (e) {
  console.error(`Cannot read ${inPath}: ${e.message}`);
  process.exit(1);
}

const errors = [];
const warnings = [];
const isStr = (v, max, min = 0) => typeof v === "string" && v.length >= min && v.length <= max;
const optStr = (v, max) => v === undefined || v === null || isStr(v, max);
const isHttp = (v) => {
  try {
    return /^https?:$/.test(new URL(v).protocol);
  } catch {
    return false;
  }
};

/** Whether a meta field value fits its type (fieldValueFits in the app); an empty value is allowed for every type but "file". */
function fieldValueFits(type, value) {
  switch (type) {
    case "text":
      return typeof value === "string" && value.length <= FIELD.text;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "date":
      return typeof value === "string" && DATE.test(value) && !Number.isNaN(Date.parse(value));
    case "link":
      return typeof value === "string" && value.length <= FIELD.link && /^https?:\/\/\S+$/.test(value);
    case "select":
      return typeof value === "string" && value.length >= 1 && value.length <= FIELD.option;
    case "boolean":
      return typeof value === "boolean";
    case "file":
      return typeof value === "string" && UUID.test(value);
    default:
      return false;
  }
}

/** Checks the meta field values of one node; `at` names the node in messages. */
function validateFields(at, fields, nodeType) {
  if (fields === undefined) return;
  if (!Array.isArray(fields)) return errors.push(`${at}: "fields" must be an array.`);
  if (fields.length > FIELD.perNode) errors.push(`${at}: more than ${FIELD.perNode} meta field values.`);
  // Components, images and the notations' shapes carry fields (isShapeType in the app).
  if (fields.length > 0 && !["aiNode", "imageNode", ...SHAPE_TYPES].includes(nodeType)) {
    errors.push(`${at}: groups and notes carry no meta fields (nor pools, lanes or decision tables).`);
  }
  fields.forEach((f, i) => {
    const here = `${at}.fields[${i}]`;
    if (!f || typeof f !== "object") return errors.push(`${here}: not an object.`);
    if (!isStr(f.fieldId, 36, 36) || !UUID.test(f.fieldId)) errors.push(`${here}: "fieldId" must be a UUID.`);
    if (!isStr(f.name, FIELD.name, 1)) errors.push(`${here}: "name" must be a string of 1 to ${FIELD.name} characters.`);
    if (!FIELD.types.includes(f.type)) errors.push(`${here}: "type" must be one of ${FIELD.types.join(", ")}.`);
    // Not yet filled: an empty string passes for text, link and date (as in the app's schema).
    else if (!((f.value === "" && f.type !== "file") || fieldValueFits(f.type, f.value))) {
      errors.push(`${here}: the value does not fit the type ${f.type}.`);
    }
    if (f.shown !== undefined && typeof f.shown !== "boolean") errors.push(`${here}: "shown" must be true or false.`);
  });
}

/** Room for the shown meta fields: one line per field with a shown value, at most three (fieldLinesHeight in the app). */
function fieldLinesHeight(fields) {
  if (!Array.isArray(fields)) return 0;
  const shown = new Set(fields.filter((f) => f && f.shown === true && f.value !== "").map((f) => f.fieldId)).size;
  const lines = Math.min(FIELD_LINES.max, shown);
  return lines > 0 ? FIELD_LINES.gap + lines * FIELD_LINES.lineHeight : 0;
}

/** The block and the icon as the app draws them (BLOCK_NODE, ICON_NODE in lib/node-display.ts). */
const BLOCK = { width: 200, frame: 26, chip: 32, labelLine: 18, categoryLine: 14, detailLine: 16, charsPerLine: 13 };
const ICON = { width: 136, top: 72, labelLine: 18, categoryLine: 14, detailLine: 16, charsPerLine: 16, maxLines: 3 };

/** Lines a paragraph takes when wrapped at word boundaries; a word longer than a line is broken. */
function wrappedLines(paragraph, width) {
  let lines = 1;
  let used = 0;
  for (const word of String(paragraph).split(/\s+/).filter(Boolean)) {
    let w = word.length;
    if (used > 0 && used + 1 + w > width) {
      lines++;
      used = 0;
    }
    while (w > width) {
      lines++;
      w -= width;
    }
    used += (used > 0 ? 1 : 0) + w;
  }
  return lines;
}

/** The name as shown: the label, else the kind's catalog name. */
const shownName = (label, kind) => label || kindName.get(kind) || kind || "";

/** Whether the icon display cuts the name short (more than three lines); the check's note "truncated". */
const iconNameCut = (name) => wrappedLines(name, ICON.charsPerLine) > ICON.maxLines;

/**
 * Size of a node for the layout (aiNodeSize in the app): the block keeps 200px and grows downwards
 * with its name, the icon shows at most three lines of it.
 */
function sizeOf(n) {
  if (n.type === "note") return noteSize(n.label);
  if (n.kind === "bpmn-pool") return CONTAINER.pool;
  if (n.kind === "bpmn-lane") return { width: CONTAINER.pool.width - CONTAINER.title, height: CONTAINER.laneHeight };
  if (isBpmn(n.kind)) return bpmnSize(n);
  // EPK and DMN shapes by their standard sizes, a UML class and a decision table by their texts.
  if (isEpk(n.kind)) return { width: epkKind.get(n.kind).width, height: epkKind.get(n.kind).height };
  if (isDmn(n.kind)) return { width: dmnKind.get(n.kind).width, height: dmnKind.get(n.kind).height };
  if (isUml(n.kind)) return umlSize(n.kind, n.label ?? kindName.get(n.kind), n.uml ?? undefined);
  if (isTable(n.kind)) return tableSize(n.storedTable);
  const fieldRoom = fieldLinesHeight(n.fields);
  const name = shownName(n.label, n.kind);
  if (n.display !== "icon") {
    const lines = wrappedLines(name, BLOCK.charsPerLine);
    const column = lines * BLOCK.labelLine + BLOCK.categoryLine + (n.model ? BLOCK.detailLine : 0) + fieldRoom;
    return { width: BLOCK.width, height: BLOCK.frame + Math.max(BLOCK.chip, column) };
  }
  const lines = Math.min(ICON.maxLines, wrappedLines(name, ICON.charsPerLine));
  return {
    width: ICON.width,
    height: ICON.top + lines * ICON.labelLine + ICON.categoryLine + (n.vendor || n.model ? ICON.detailLine : 0) + fieldRoom,
  };
}

/** A note as high as its text, at least 112px (noteSize in the app). */
function noteSize(text) {
  let lines = 0;
  for (const paragraph of String(text ?? "").split("\n")) lines += wrappedLines(paragraph, NOTE.charsPerLine);
  const height = 2 * (NOTE.padding + NOTE.border) + lines * NOTE.lineHeight;
  return { width: NOTE.width, height: Math.max(NOTE.minHeight, Math.ceil(height / 8) * 8) };
}

const labelWidth = (label) => (label ? Math.ceil(String(label).length * EDGE_LABEL.charWidth) + EDGE_LABEL.padding : 0);

// BPMN (B1d), mirrored from the app: lib/bpmn.ts (kinds, sizes, details), lib/containers.ts
// (pools and lanes), lib/auto-layout.ts (bands) and lib/check.ts (the BPMN rules).
const BPMN = catalog.bpmn ?? { kinds: [], bands: [] };
const bpmnKind = new Map(BPMN.kinds.map((k) => [k.kind, k]));
const isBpmn = (kind) => bpmnKind.has(kind);
const groupOf = (kind) => bpmnKind.get(kind)?.group;
const isEvent = (kind) => groupOf(kind) === "events";
const isGateway = (kind) => groupOf(kind) === "gateways";
const isTask = (kind) => groupOf(kind) === "tasks";
const isFlowElement = (kind) => isTask(kind) || isEvent(kind) || isGateway(kind);
const labelBelow = (kind) => isEvent(kind) || isGateway(kind) || kind === "bpmn-data-object" || kind === "bpmn-data-store";
const CONTAINER = { title: 28, lane: 24, pool: { width: 720, height: 200 }, poolMin: { width: 320, height: 120 }, poolMinVertical: { width: 120, height: 320 }, laneMinHeight: 96, laneMinWidth: 120, laneHeight: 160 };
const BAND = { pad: 24, gap: 32 };
const LABEL_BELOW = { gap: 6, height: 30 };
const BPMN_NOTATIONS = ["sequence", "message", "association"];
const TRIGGERS = ["none", "message", "timer"];

// EPK, UML and DMN (#44), mirrored from the app the same way: lib/epk.ts, lib/uml.ts, lib/dmn.ts
// and lib/dmn-table.ts (kinds, sizes, notations and limits, read from catalog.json),
// lib/notations.ts (the notation a connection gets), lib/auto-layout.ts (epkLayout, umlLayout,
// dmnLayout) and lib/check.ts (epkRules, umlRules, dmnRules).
const EPK = catalog.epk ?? { kinds: [], notations: [] };
const UML = catalog.uml ?? { kinds: [], notations: [], generalizations: [], categories: [], limits: {}, box: {} };
const DMN = catalog.dmn ?? { kinds: [], notations: [], table: null };
const epkKind = new Map(EPK.kinds.map((k) => [k.kind, k]));
const umlKind = new Map(UML.kinds.map((k) => [k.kind, k]));
const dmnKind = new Map(DMN.kinds.map((k) => [k.kind, k]));
const TABLE = DMN.table;
const isEpk = (kind) => epkKind.has(kind);
const isEpkFunction = (kind) => epkKind.get(kind)?.function === true;
const isEpkConnector = (kind) => epkKind.get(kind)?.connector === true;
/** What EPK's control flow runs through (isEpkFlowElement): events, functions, connectors, process paths. */
const isEpkFlow = (kind) => kind === "epk-event" || isEpkFunction(kind) || isEpkConnector(kind) || kind === "epk-process-path";
const isUml = (kind) => umlKind.has(kind);
/** DMN's shapes (isDmnKind); the decision table is a kind of its own (isDmnTableKind). */
const isDmn = (kind) => dmnKind.has(kind);
const isDmnDecision = (kind) => dmnKind.get(kind)?.decision === true;
const isTable = (kind) => !!TABLE && kind === TABLE.kind;
const EPK_NOTATIONS = EPK.notations.map((n) => n.id);
const UML_NOTATIONS = UML.notations.map((n) => n.id);
const DMN_NOTATIONS = DMN.notations.map((n) => n.id);
const isEpkNotation = (v) => EPK_NOTATIONS.includes(v);
const isUmlNotation = (v) => UML_NOTATIONS.includes(v);
const isDmnNotation = (v) => DMN_NOTATIONS.includes(v);
/** Every notation a connection can carry (NOTATIONS in the app's lib/bpmn.ts). */
const NOTATIONS = [...BPMN_NOTATIONS, ...EPK_NOTATIONS, ...UML_NOTATIONS, ...DMN_NOTATIONS];
/** A connection's notation as stored, or null (notationOf in the app). */
const notationOf = (e) => (typeof e?.notation === "string" && NOTATIONS.includes(e.notation) ? e.notation : null);
/** The node types the notations draw their shapes with (isShapeType in the app). */
const SHAPE_TYPES = ["bpmnNode", "dmnNode", "umlNode", "epkNode"];
for (const k of [...EPK.kinds, ...UML.kinds, ...DMN.kinds, ...(TABLE ? [TABLE] : [])]) kindName.set(k.kind, k.name);

const typeOfKind = (kind) =>
  kind === "bpmn-pool"
    ? "pool"
    : kind === "bpmn-lane"
      ? "lane"
      : isBpmn(kind)
        ? "bpmnNode"
        : isEpk(kind)
          ? "epkNode"
          : isUml(kind)
            ? "umlNode"
            : isTable(kind)
              ? "dmnTable"
              : isDmn(kind)
                ? "dmnNode"
                : kind === "note"
                  ? "note"
                  : "aiNode";

/** The notation of a new connection at an EPK shape (epkNotationFor in the app); null when no end is EPK. */
function epkNotationFor(s, t) {
  if (s === undefined || t === undefined) return null;
  if (!isEpk(s) && !isEpk(t)) return null;
  if (s === "epk-info-object" || t === "epk-info-object") return "epk-information";
  if (!isEpk(s) || !isEpk(t) || s === "epk-org-unit" || t === "epk-org-unit") return "epk-assignment";
  return "epk-control";
}

/** The relation of a new connection at a class (umlNotationFor in the app); null when no end is UML. */
function umlNotationFor(s, t) {
  if (s === undefined || t === undefined) return null;
  if (!isUml(s) && !isUml(t)) return null;
  if (!isUml(s) || !isUml(t)) return "uml-dependency";
  if (t === "uml-interface" && s !== "uml-interface") return "uml-realization";
  return "uml-association";
}

/** The requirement of a new connection at a DMN shape (dmnNotationFor in the app); null when no end is DMN. */
function dmnNotationFor(s, t) {
  if (s === undefined || t === undefined) return null;
  if (!isDmn(s) && !isDmn(t)) return null;
  if (!isDmn(s) || !isDmn(t)) return "dmn-association";
  if (s === "dmn-knowledge-source") return "dmn-authority";
  if (s === "dmn-bkm") return "dmn-knowledge";
  return "dmn-information";
}

/** The notation a connection gets when none is given, EPK's rule first, then DMN's, UML's, BPMN's (notationForConnection in the app). */
function connectionNotation(source, target, byId) {
  const s = byId.get(source)?.kind;
  const t = byId.get(target)?.kind;
  if ((s && isEpk(s)) || (t && isEpk(t))) return epkNotationFor(s, t);
  if ((s && isDmn(s)) || (t && isDmn(t))) return dmnNotationFor(s, t);
  if ((s && isUml(s)) || (t && isUml(t))) return umlNotationFor(s, t);
  return notationFor(source, target, byId);
}

/** A class as wide as its longest text and as high as its rows (umlSizeOf in the app). */
function umlSize(kind, label, uml) {
  const B = UML.box;
  const lines = (l) => (Array.isArray(l) ? l : []).slice(0, UML.limits.maxLines).map((x) => String(x).slice(0, UML.limits.maxLine));
  const attributes = lines(uml?.attributes);
  const operations = lines(uml?.operations);
  const head = umlKind.get(kind)?.stereotype ? B.headStereotype : B.head;
  const compartment = (n) => Math.max(1, n) * B.row + B.pad;
  const longest = Math.max(0, ...[...attributes, ...operations].map((l) => l.length));
  const text = Math.max(String(label ?? "").length * B.nameChar + B.nameInset, longest * B.rowChar + B.rowInset);
  const width = Math.min(B.maxWidth, Math.max(B.minWidth, Math.ceil(text / 8) * 8));
  return { width, height: head + compartment(attributes.length) + compartment(operations.length) };
}

/** A class's data as stored: only the parts that hold something (umlOut in the app's lib/mcp.ts). */
function umlOut(uml) {
  if (!uml || typeof uml !== "object") return undefined;
  const out = {
    ...(uml.attributes?.length ? { attributes: uml.attributes } : {}),
    ...(uml.operations?.length ? { operations: uml.operations } : {}),
    ...(uml.category ? { category: uml.category } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

/** A decision table's size on the canvas: up to six columns and ten rules shown (tableLayout in the app). */
function tableSize(t) {
  if (!t || !Array.isArray(t.columns) || !Array.isArray(t.rules)) return { width: 200, height: 68 };
  const B = TABLE.box;
  const columnWidth = (index) => {
    const col = t.columns[index];
    const shownRules = t.rules.slice(0, B.maxShownRules);
    const longest = Math.max(String(col.name ?? "").length * B.headChar, ...shownRules.map((r) => String(r.cells?.[index] || "–").length * B.cellChar));
    return Math.max(B.minCol, Math.min(B.maxCol, Math.round(longest + B.pad)));
  };
  const order = [...t.columns.filter((c) => c.side === "in"), ...t.columns.filter((c) => c.side === "out")].map((c) => t.columns.indexOf(c));
  const ins = order.filter((i) => t.columns[i].side === "in");
  const outs = order.filter((i) => t.columns[i].side === "out");
  const keepOut = Math.min(outs.length, Math.max(1, B.maxShownColumns - ins.length));
  const shown = [...ins.slice(0, B.maxShownColumns - keepOut), ...outs.slice(0, keepOut)];
  const hiddenColumns = order.length - shown.length;
  const firstOut = shown.findIndex((i) => t.columns[i].side === "out");
  const rules = t.rules.slice(0, B.maxShownRules);
  const width = B.mark + shown.map(columnWidth).reduce((a, b) => a + b, 0) + (firstOut > 0 ? B.double : 0) + (hiddenColumns > 0 ? B.more : 0);
  const height = B.head + rules.length * B.row + (t.rules.length > rules.length ? B.row : 0);
  return { width: Math.ceil(width), height };
}

/** Whether a table keeps its rules (tableFits in the app); the app's message, or null. */
function tableFits(t) {
  const L = TABLE.limits;
  if (!t.columns.some((c) => c.side === "in")) return "A decision table needs at least one input column.";
  if (!t.columns.some((c) => c.side === "out")) return "A decision table needs at least one output column.";
  if (t.columns.length > L.columns) return `A decision table has at most ${L.columns} columns.`;
  if (t.rules.length === 0) return "A decision table needs at least one rule.";
  if (t.rules.length > L.rules) return `A decision table has at most ${L.rules} rules.`;
  if (t.rules.some((r) => r.cells.length !== t.columns.length)) return "Every rule of a decision table has one cell per column.";
  if (t.aggregation && t.hitPolicy !== "C") return "Only the hit policy C (collect) has an aggregation.";
  return null;
}

/** Texts within the limits: column names, cells and notes (tableTextsFit in the app). */
function tableTextsFit(t) {
  const L = TABLE.limits;
  const name = t.columns.findIndex((c) => !c.name || c.name.length > L.name);
  if (name >= 0) return `Column ${name + 1} of the decision table needs a name of 1 to ${L.name} characters.`;
  for (const [i, r] of t.rules.entries()) {
    const c = r.cells.findIndex((x) => x.length > L.cell);
    if (c >= 0) return `Rule ${i + 1}, column ${c + 1} of the decision table has ${r.cells[c].length} characters, at most ${L.cell}.`;
    if ((r.note?.length ?? 0) > L.cell) return `The note of rule ${i + 1} of the decision table has more than ${L.cell} characters.`;
  }
  return null;
}

/** Short ids for a table's columns and rules, as the server gives them. */
const shortId = () => Math.random().toString(36).slice(2, 10).padEnd(8, "0");

/**
 * A table as the graph gives it (MCP's `table`: no ids, cells in the order of the columns) in the
 * stored form (tableFromInput in the app), or an error. The shape is checked first, then
 * tableFits and tableTextsFit as the server does.
 */
function tableFromInput(at, t) {
  if (!t || typeof t !== "object") return { error: `${at}: a decision table needs "table" with its columns and rules.` };
  if (t.decision !== undefined && t.decision !== null && !isStr(t.decision, 64, 1)) return { error: `${at}: "table.decision" must be the id of a DMN decision.` };
  if (t.hitPolicy !== undefined && !TABLE.hitPolicies.includes(t.hitPolicy)) return { error: `${at}: "table.hitPolicy" must be one of ${TABLE.hitPolicies.join(", ")}.` };
  if (t.aggregation !== undefined && t.aggregation !== null && !TABLE.aggregations.includes(t.aggregation)) {
    return { error: `${at}: "table.aggregation" must be one of ${TABLE.aggregations.join(" ")}.` };
  }
  if (!Array.isArray(t.columns) || t.columns.length < 2) return { error: `${at}: "table.columns" needs at least one input and one output column.` };
  for (const [i, c] of t.columns.entries()) {
    if (!c || typeof c !== "object" || typeof c.name !== "string") return { error: `${at}: column ${i + 1} of the decision table needs a "name".` };
    if (c.side !== "in" && c.side !== "out") return { error: `${at}: column ${i + 1} of the decision table needs "side": "in" or "out".` };
    if (c.type !== undefined && !TABLE.columnTypes.includes(c.type)) return { error: `${at}: the type of column ${i + 1} must be one of ${TABLE.columnTypes.join(", ")}.` };
  }
  if (!Array.isArray(t.rules)) return { error: `${at}: "table.rules" must be an array.` };
  for (const [i, r] of t.rules.entries()) {
    if (!r || typeof r !== "object" || !Array.isArray(r.cells) || r.cells.some((x) => typeof x !== "string")) {
      return { error: `${at}: rule ${i + 1} of the decision table needs "cells", one text per column.` };
    }
    if (r.note !== undefined && r.note !== null && typeof r.note !== "string") return { error: `${at}: the note of rule ${i + 1} must be text.` };
  }
  const table = {
    ...(t.decision ? { decision: t.decision } : {}),
    hitPolicy: t.hitPolicy ?? "U",
    ...(t.aggregation ? { aggregation: t.aggregation } : {}),
    columns: t.columns.map((c) => ({ id: shortId(), name: c.name.trim(), type: c.type ?? "string", side: c.side })),
    rules: t.rules.map((r) => ({ id: shortId(), cells: r.cells.map((c) => c.trim()), ...(r.note?.trim() ? { note: r.note.trim() } : {}) })),
  };
  const wrong = tableFits(table) ?? tableTextsFit(table);
  if (wrong) return { error: `${at}: ${wrong}` };
  return { table };
}

/** Whether a stored table has the shape the app's schema takes (dmnTableSchema), plus tableFits. */
function storedTableError(t) {
  const L = TABLE.limits;
  if (!t || typeof t !== "object") return "is not an object";
  if (t.decision !== undefined && !isStr(t.decision, 64, 1)) return '"decision" must be a node id';
  if (!TABLE.hitPolicies.includes(t.hitPolicy)) return `"hitPolicy" must be one of ${TABLE.hitPolicies.join(", ")}`;
  if (t.aggregation !== undefined && !TABLE.aggregations.includes(t.aggregation)) return `"aggregation" must be one of ${TABLE.aggregations.join(" ")}`;
  if (!Array.isArray(t.columns) || t.columns.length < 2 || t.columns.length > L.columns) return `needs 2 to ${L.columns} columns`;
  const badColumn = t.columns.findIndex((c) => !c || !isStr(c.id, 64, 1) || !isStr(c.name, L.name) || !TABLE.columnTypes.includes(c.type) || (c.side !== "in" && c.side !== "out"));
  if (badColumn >= 0) return `column ${badColumn + 1} needs an id, a name of at most ${L.name} characters, a type (${TABLE.columnTypes.join(", ")}) and a side (in, out)`;
  if (!Array.isArray(t.rules) || t.rules.length < 1 || t.rules.length > L.rules) return `needs 1 to ${L.rules} rules`;
  const badRule = t.rules.findIndex(
    (r) => !r || !isStr(r.id, 64, 1) || !Array.isArray(r.cells) || r.cells.length > L.columns || r.cells.some((c) => !isStr(c, L.cell)) || (r.note !== undefined && !isStr(r.note, L.cell)),
  );
  if (badRule >= 0) return `rule ${badRule + 1} needs an id, at most ${L.columns} cells of at most ${L.cell} characters, and a note of at most ${L.cell}`;
  return tableFits(t);
}

/** The triggers an event offers (triggersFor in the app). */
const triggersFor = (kind, throwing) => (kind === "bpmn-end-event" || (kind === "bpmn-intermediate-event" && throwing) ? ["none", "message"] : TRIGGERS);

/** Whether `bpmn` fits the kind (bpmnDataFits in the app). */
function bpmnFits(kind, b) {
  if (b === undefined || b === null) return true;
  if (typeof b !== "object") return false;
  // A business rule task names the DMN decision it applies, nothing else; no other kind names one.
  if (kind === "bpmn-business-rule-task") return Object.keys(b).every((k) => k === "decision") && (b.decision === undefined || isStr(b.decision, 64, 1));
  if (b.decision !== undefined) return false;
  if (kind === "bpmn-pool") return b.trigger === undefined && b.throwing === undefined && b.aiLane === undefined;
  if (b.vertical !== undefined) return false;
  if (kind === "bpmn-lane") return b.trigger === undefined && b.throwing === undefined;
  if (b.aiLane !== undefined || !isEvent(kind)) return false;
  if (b.throwing !== undefined && kind !== "bpmn-intermediate-event") return false;
  return triggersFor(kind, b.throwing === true).includes(b.trigger ?? "none");
}

/** `bpmn` as it is stored: only what differs from a catching "none" (cleanBpmnData in the app). */
function cleanBpmn(kind, b) {
  if (kind === "bpmn-business-rule-task") return b?.decision ? { decision: b.decision } : undefined;
  if (kind === "bpmn-lane") return b?.aiLane ? { aiLane: true } : undefined;
  if (kind === "bpmn-pool") return b?.vertical ? { vertical: true } : undefined;
  if (!b || !isEvent(kind)) return undefined;
  const throwing = kind === "bpmn-intermediate-event" && b.throwing === true;
  const trigger = triggersFor(kind, throwing).includes(b.trigger ?? "none") ? (b.trigger ?? "none") : "none";
  const out = { ...(trigger !== "none" ? { trigger } : {}), ...(throwing ? { throwing } : {}) };
  return Object.keys(out).length ? out : undefined;
}

/** The pool a node sits in, through its lane; null outside pools. */
function poolOf(id, byId) {
  const seen = new Set();
  for (let n = byId.get(id); n && !seen.has(n.id); n = n.parentId ? byId.get(n.parentId) : undefined) {
    seen.add(n.id);
    if (n.kind === "bpmn-pool") return n.id;
  }
  return null;
}

/** The notation a connection gets when none is given (notationFor in the app). */
function notationFor(s, t, byId) {
  const a = byId.get(s)?.kind;
  const b = byId.get(t)?.kind;
  if (a === undefined || b === undefined) return null;
  if (!isBpmn(a) && !isBpmn(b)) return null;
  if (!isBpmn(a) || !isBpmn(b) || groupOf(a) === "data" || groupOf(b) === "data") return "association";
  if (isFlowElement(a) && isFlowElement(b)) return poolOf(s, byId) === poolOf(t, byId) ? "sequence" : "message";
  return "message";
}

/** The size of a BPMN shape in the layout, its name below it where it hangs there. */
function bpmnSize(n) {
  const k = bpmnKind.get(n.kind);
  return { width: k.width, height: k.height + (n.label && labelBelow(n.kind) ? LABEL_BELOW.gap + LABEL_BELOW.height : 0) };
}

/** The rules of pools and lanes for the short form, as the server's create_diagram refuses them. */
function bpmnShapeErrors(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    const at = `Node "${n.id}"`;
    if (n.bpmn !== undefined && !(isBpmn(n.kind) && bpmnFits(n.kind, n.bpmn))) {
      errors.push(`${at}: "bpmn" does not fit a ${n.kind} (trigger and throwing on events, aiLane on lanes, vertical on pools, decision on business rule tasks).`);
    }
    if (n.band !== undefined && n.band !== null) {
      if (n.kind !== "bpmn-pool" && n.kind !== "bpmn-lane") errors.push(`${at}: only pools and lanes have a band colour.`);
      else if (!BPMN.bands.includes(n.band)) errors.push(`${at}: "band" must be one of ${BPMN.bands.join(", ")}.`);
    }
    if (n.kind === "bpmn-lane" && (!n.parent || byId.get(n.parent)?.kind !== "bpmn-pool")) {
      errors.push(`${at}: a lane needs "parent", the id of its pool.`);
      continue;
    }
    if (!n.parent) continue;
    const holder = byId.get(n.parent);
    if (!holder) {
      errors.push(`${at}: "parent" ${n.parent} is not a node of this file.`);
      continue;
    }
    if (n.kind === "bpmn-lane") continue;
    if (n.kind === "bpmn-pool") errors.push(`${at}: a pool sits in nothing; leave "parent" out.`);
    else if (holder.kind !== "bpmn-pool" && holder.kind !== "bpmn-lane") errors.push(`${at}: "parent" must be a pool or a lane.`);
    else if (holder.kind === "bpmn-pool" && nodes.some((m) => m.kind === "bpmn-lane" && m.parent === holder.id)) {
      errors.push(`${at}: pool ${holder.id} has lanes; put the node into one of them.`);
    } else if (n.kind === "note") errors.push(`${at}: a note sits in no pool or lane.`);
    // Only BPMN shapes and AI components go into pools and lanes (accepts in the app's lib/containers.ts).
    else if (isEpk(n.kind) || isUml(n.kind) || isDmn(n.kind) || isTable(n.kind)) errors.push(`${at}: a ${n.kind} sits in no pool or lane; only BPMN shapes and, in an AI lane, AI components do.`);
    else if (holder.bpmn?.aiLane && isBpmn(n.kind)) errors.push(`${at}: an AI lane holds AI components only.`);
    else if (!holder.bpmn?.aiLane && !isBpmn(n.kind)) errors.push(`${at}: AI components sit only in an AI lane.`);
  }
  for (const e of edges) {
    if (!e) continue;
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    const bpmnEnd = (s && isBpmn(s.kind)) || (t && isBpmn(t.kind));
    // EPK's, UML's and DMN's connections are theirs to check (notationErrors), as in MCP's bpmnShape.
    if (isEpkNotation(e.notation) || isUmlNotation(e.notation) || isDmnNotation(e.notation)) continue;
    if ([s, t].some((x) => x && (isEpk(x.kind) || isUml(x.kind) || isDmn(x.kind)))) continue;
    if (BPMN_NOTATIONS.includes(e.notation) && !bpmnEnd) errors.push(`Edge ${e.source} -> ${e.target}: a notation belongs to connections at a BPMN shape.`);
    if (bpmnEnd && e.flow && e.flow !== "none") errors.push(`Edge ${e.source} -> ${e.target}: a BPMN connection carries a notation, not a flow.`);
  }
}

/**
 * The rules of the other notations for the short form, as the server's create_diagram refuses
 * them (buildContent in the app's lib/mcp.ts): "uml" only on classes and within its limits, a
 * decision table with its "table" (tableFits, tableTextsFit), belonging to a decision of the file
 * and one per decision, no connections at a table, a notation of its ends' notation and no flow
 * beside it, texts at the ends of UML relations only, "directed" on associations only. Returns
 * the stored tables by node id.
 */
function notationErrors(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const tables = new Map();
  for (const n of nodes) {
    const at = `Node "${n.id}"`;
    if (n.uml !== undefined && n.uml !== null) {
      if (!isUml(n.kind)) errors.push(`${at}: only UML classes have "uml" (attributes, operations, category).`);
      else if (typeof n.uml !== "object") errors.push(`${at}: "uml" must be an object with attributes, operations and category.`);
      else {
        for (const part of ["attributes", "operations"]) {
          const lines = n.uml[part] ?? [];
          if (!Array.isArray(lines) || lines.some((l) => typeof l !== "string")) {
            errors.push(`${at}: "uml.${part}" must be a list of lines.`);
            continue;
          }
          if (lines.length > UML.limits.maxLines) errors.push(`${at}: "uml.${part}" has ${lines.length} lines, at most ${UML.limits.maxLines}.`);
          const long = lines.findIndex((l) => l.length > UML.limits.maxLine);
          if (long >= 0) errors.push(`${at}: line ${long + 1} of "uml.${part}" has ${lines[long].length} characters, at most ${UML.limits.maxLine}.`);
        }
        if (n.uml.category !== undefined && !UML.categories.includes(n.uml.category)) errors.push(`${at}: "uml.category" must be one of ${UML.categories.join(", ")}.`);
      }
    }
    if (n.table !== undefined && n.table !== null && !isTable(n.kind)) errors.push(`${at}: only decision tables (${TABLE?.kind ?? "dmn-decision-table"}) have "table".`);
    if (isTable(n.kind)) {
      const r = tableFromInput(at, n.table);
      if (r.error) errors.push(r.error);
      else tables.set(n.id, r.table);
    }
  }
  // Each table belongs to a decision of the file, one table per decision.
  const taken = new Map();
  for (const [id, t] of tables) {
    if (!t.decision) continue;
    if (!isDmnDecision(byId.get(t.decision)?.kind)) errors.push(`Node "${id}": "table.decision" must be the id of a DMN decision in this diagram.`);
    else if (taken.has(t.decision)) errors.push(`Node "${id}": the decision "${t.decision}" already has the table "${taken.get(t.decision)}"; one table per decision.`);
    else taken.set(t.decision, id);
  }
  const parented = new Map(nodes.map((n) => [n.id, { id: n.id, kind: n.kind, parentId: n.parent }]));
  for (const e of edges) {
    if (!e) continue;
    const at = `Edge ${e.source} -> ${e.target}`;
    const s = byId.get(e.source)?.kind ?? "";
    const t = byId.get(e.target)?.kind ?? "";
    if (e.notation !== undefined && e.notation !== null && !NOTATIONS.includes(e.notation)) {
      errors.push(`${at}: "notation" must be one of ${NOTATIONS.join(", ")}.`);
      continue;
    }
    if (isTable(s) || isTable(t)) {
      errors.push(`${at}: a decision table has no connections; it belongs to its decision through "table.decision".`);
      continue;
    }
    for (const field of ["sourceLabel", "targetLabel"]) {
      if (e[field] === undefined || e[field] === null) continue;
      if (typeof e[field] !== "string") errors.push(`${at}: "${field}" must be text.`);
      else if (e[field].length > UML.limits.maxEnd) errors.push(`${at}: "${field}" has ${e[field].length} characters, at most ${UML.limits.maxEnd}.`);
    }
    const flows = e.flow && e.flow !== "none";
    // EPK (N1): a notation only at an EPK shape, of EPK's values, and no flow beside it.
    const epkEnd = isEpk(s) || isEpk(t);
    if (isEpkNotation(e.notation) && !epkEnd) errors.push(`${at}: an EPK notation belongs to connections at an EPK shape.`);
    if (epkEnd && e.notation && !isEpkNotation(e.notation)) errors.push(`${at}: at an EPK shape the notation is ${EPK_NOTATIONS.join(", ")}.`);
    if (epkEnd && flows) errors.push(`${at}: an EPK connection carries a notation, not a flow.`);
    // DMN (D1): the same for requirements.
    const dmnEnd = isDmn(s) || isDmn(t);
    if (isDmnNotation(e.notation) && !dmnEnd) errors.push(`${at}: a DMN requirement belongs to connections at a DMN shape.`);
    if (dmnEnd && e.notation && !isDmnNotation(e.notation)) errors.push(`${at}: at a DMN shape the notation is ${DMN_NOTATIONS.join(", ")}.`);
    if (dmnEnd && flows) errors.push(`${at}: a DMN requirement carries a notation, not a flow.`);
    // UML (U1): the same for relations, and texts at the ends only on a relation.
    if (!epkEnd && !dmnEnd) {
      const umlEnd = isUml(s) || isUml(t);
      if (isUmlNotation(e.notation) && !umlEnd) errors.push(`${at}: a UML relation belongs to connections at a UML class.`);
      if (umlEnd && e.notation && !isUmlNotation(e.notation)) errors.push(`${at}: at a UML class the notation is ${UML_NOTATIONS.join(", ")}.`);
      if (umlEnd && flows) errors.push(`${at}: a UML relation carries a notation, not a flow.`);
      if ((e.sourceLabel || e.targetLabel) && !umlEnd) errors.push(`${at}: only a UML relation has texts at its ends ("sourceLabel", "targetLabel").`);
    } else if (e.sourceLabel || e.targetLabel) errors.push(`${at}: only a UML relation has texts at its ends ("sourceLabel", "targetLabel").`);
    // An open head only on an association: BPMN's, or a UML association (the schema's rule).
    if (e.directed !== undefined && e.directed !== null) {
      const notation = e.notation ?? connectionNotation(e.source, e.target, parented);
      if (typeof e.directed !== "boolean") errors.push(`${at}: "directed" must be true or false.`);
      else if (e.directed && notation !== "association" && notation !== "uml-association") errors.push(`${at}: "directed" is for associations only.`);
    }
  }
  return tables;
}

/**
 * Pools and lanes in bands (layoutDiagram in the app): each pool on its own, its contents ranked
 * along its flow, each lane a band with rows where two share a rank, lanes flush, pools stacked,
 * everything outside pools below them. Returns positions (relative to the parent) and sizes.
 */
function bandLayout(nodes, edges) {
  const positions = new Map();
  const sizes = new Map();
  const inPool = new Set();
  const pools = nodes.filter((n) => n.kind === "bpmn-pool");
  for (const pool of pools) {
    const vertical = pool.bpmn?.vertical === true;
    const lanes = nodes.filter((n) => n.kind === "bpmn-lane" && n.parent === pool.id);
    const laneIds = new Set(lanes.map((l) => l.id));
    const content = nodes.filter((n) => n.kind !== "bpmn-lane" && n.kind !== "bpmn-pool" && (n.parent === pool.id || laneIds.has(n.parent)));
    for (const n of [pool, ...lanes, ...content]) inPool.add(n.id);
    const size = new Map(content.map((n) => [n.id, sizeOf(n)]));
    const main = (p) => (vertical ? p.y : p.x);
    const cross = (p) => (vertical ? p.x : p.y);
    const mainSize = (id) => (vertical ? size.get(id).height : size.get(id).width);
    const crossSize = (id) => (vertical ? size.get(id).width : size.get(id).height);
    const at = (m, c) => (vertical ? { x: c, y: m } : { x: m, y: c });
    const ids = new Set(content.map((n) => n.id));
    const ranked = content.length ? layout(content, edges.filter((e) => ids.has(e.source) && ids.has(e.target)), vertical ? "TB" : "LR") : new Map();
    const start = content.length ? Math.min(...content.map((n) => main(ranked.get(n.id)))) : 0;
    const along = new Map(content.map((n) => [n.id, main(ranked.get(n.id)) - start]));
    const span = content.reduce((m, n) => Math.max(m, along.get(n.id) + mainSize(n.id)), 0);
    const bands = lanes.length ? lanes.map((l) => l.id) : [pool.id];
    const bandOf = (n) => (laneIds.has(n.parent) ? n.parent : lanes.length ? lanes[0].id : pool.id);
    const thickness = new Map();
    const across = new Map();
    for (const band of bands) {
      const members = content.filter((n) => bandOf(n) === band).sort((a, b) => cross(ranked.get(a.id)) - cross(ranked.get(b.id)));
      const rows = [];
      const rowOf = new Map();
      for (const n of members) {
        const from = along.get(n.id);
        const to = from + mainSize(n.id);
        let r = rows.findIndex((row) => row.items.every((o) => to + BAND.gap <= along.get(o) || along.get(o) + mainSize(o) + BAND.gap <= from));
        if (r < 0) {
          rows.push({ items: [], size: 0 });
          r = rows.length - 1;
        }
        rows[r].items.push(n.id);
        rows[r].size = Math.max(rows[r].size, crossSize(n.id));
        rowOf.set(n.id, r);
      }
      const offsets = [];
      let c = BAND.pad;
      for (const row of rows) {
        offsets.push(c);
        c += row.size + BAND.gap;
      }
      const inner = rows.length ? c - BAND.gap + BAND.pad : 0;
      const least = band === pool.id ? (vertical ? CONTAINER.poolMinVertical.width : CONTAINER.poolMin.height) : vertical ? CONTAINER.laneMinWidth : CONTAINER.laneMinHeight;
      const thick = Math.max(least, inner);
      thickness.set(band, thick);
      const slack = (thick - inner) / 2;
      for (const n of members) {
        const r = rowOf.get(n.id);
        across.set(n.id, slack + offsets[r] + (rows[r].size - crossSize(n.id)) / 2);
      }
    }
    const lead = lanes.length ? CONTAINER.title + CONTAINER.lane : CONTAINER.title;
    const length = Math.max(vertical ? CONTAINER.poolMinVertical.height : CONTAINER.poolMin.width, lead + BAND.pad + span + BAND.pad);
    let offset = 0;
    for (const lane of lanes) {
      const t = thickness.get(lane.id);
      positions.set(lane.id, at(CONTAINER.title, offset));
      sizes.set(lane.id, vertical ? { width: t, height: length - CONTAINER.title } : { width: length - CONTAINER.title, height: t });
      offset += t;
    }
    const poolThick = lanes.length ? offset : thickness.get(pool.id);
    sizes.set(pool.id, vertical ? { width: poolThick, height: length } : { width: length, height: poolThick });
    for (const n of content) {
      const m = (lanes.length ? CONTAINER.lane : CONTAINER.title) + BAND.pad + along.get(n.id);
      const p = at(m, across.get(n.id));
      positions.set(n.id, { x: Math.round(p.x), y: Math.round(p.y) });
    }
  }
  let y = 16;
  let right = 16;
  for (const p of pools.filter((q) => !q.bpmn?.vertical)) {
    positions.set(p.id, { x: 16, y });
    y += sizes.get(p.id).height + 48;
    right = Math.max(right, 16 + sizes.get(p.id).width + 48);
  }
  let x = right;
  let bottom = y > 16 ? y - 48 : 16;
  for (const p of pools.filter((q) => q.bpmn?.vertical)) {
    positions.set(p.id, { x, y: 16 });
    x += sizes.get(p.id).width + 48;
    bottom = Math.max(bottom, 16 + sizes.get(p.id).height);
  }
  const rest = nodes.filter((n) => !inPool.has(n.id));
  if (rest.length) {
    const ids = new Set(rest.map((n) => n.id));
    const outside = layout(rest, edges.filter((e) => ids.has(e.source) && ids.has(e.target)));
    const top = Math.min(...[...outside.values()].map((p) => p.y));
    for (const [id, p] of outside) positions.set(id, { x: p.x, y: p.y - top + bottom + 48 });
  }
  return { positions, sizes };
}

/** The BPMN rules of the check (bpmnRules in the app's lib/check.ts), as English notes. */
function bpmnNotes(c, nameOf) {
  const flow = c.nodes.filter((n) => isFlowElement(n.data?.kind ?? ""));
  if (flow.length === 0) return [];
  const byId = new Map(c.nodes.map((n) => [n.id, { id: n.id, parentId: n.parentId, kind: n.data?.kind ?? "" }]));
  const node = new Map(c.nodes.map((n) => [n.id, n]));
  const kindOf = (id) => node.get(id)?.data?.kind ?? "";
  const notation = (e) => (NOTATIONS.includes(e.notation) ? e.notation : isFlowElement(kindOf(e.source)) && isFlowElement(kindOf(e.target)) ? "sequence" : null);
  const valid = c.edges.filter((e) => e && e.source !== e.target && node.has(e.source) && node.has(e.target));
  const sequence = valid.filter((e) => notation(e) === "sequence");
  const outs = new Map();
  const ins = new Map();
  for (const e of sequence) {
    outs.set(e.source, [...(outs.get(e.source) ?? []), e]);
    ins.set(e.target, [...(ins.get(e.target) ?? []), e]);
  }
  const connected = new Set(valid.flatMap((e) => [e.source, e.target]));
  const notes = [];
  const scopes = new Map();
  for (const n of flow) {
    const pool = poolOf(n.id, byId);
    scopes.set(pool, [...(scopes.get(pool) ?? []), n]);
  }
  const reading = (a, b) => (a.position?.y ?? 0) - (b.position?.y ?? 0) || (a.position?.x ?? 0) - (b.position?.x ?? 0);
  for (const [pool, members] of scopes) {
    const name = nameOf(node.get(pool ?? [...members].sort(reading)[0].id));
    if (!members.some((n) => n.data.kind === "bpmn-start-event")) notes.push(pool ? `The pool “${name}” has no start event.` : `The process that “${name}” belongs to has no start event.`);
    if (!members.some((n) => n.data.kind === "bpmn-end-event")) notes.push(pool ? `The pool “${name}” has no end event.` : `The process that “${name}” belongs to has no end event.`);
  }
  for (const n of flow) {
    if (n.data.kind === "bpmn-start-event" && ins.has(n.id)) notes.push(`“${nameOf(n)}” is a start event, but a sequence flow leads into it.`);
    if (n.data.kind === "bpmn-end-event" && outs.has(n.id)) notes.push(`“${nameOf(n)}” is an end event, but a sequence flow leads out of it.`);
  }
  const walk = (from, next, step) => {
    const seen = new Set(from);
    const queue = [...from];
    while (queue.length) {
      for (const e of next.get(queue.shift()) ?? []) {
        const id = step(e);
        if (!seen.has(id)) {
          seen.add(id);
          queue.push(id);
        }
      }
    }
    return seen;
  };
  const fromStart = walk(flow.filter((n) => n.data.kind === "bpmn-start-event").map((n) => n.id), outs, (e) => e.target);
  const toEnd = walk(flow.filter((n) => n.data.kind === "bpmn-end-event").map((n) => n.id), ins, (e) => e.source);
  const scopeHas = (n, kind) => (scopes.get(poolOf(n.id, byId)) ?? []).some((m) => m.data.kind === kind);
  for (const n of flow) {
    const kind = n.data.kind;
    if (!(isTask(kind) || isGateway(kind)) || !connected.has(n.id)) continue;
    if (scopeHas(n, "bpmn-start-event") && !fromStart.has(n.id)) notes.push(`No start event leads to “${nameOf(n)}”.`);
    if (scopeHas(n, "bpmn-end-event") && !toEnd.has(n.id)) notes.push(`There is no way from “${nameOf(n)}” to an end event.`);
  }
  for (const n of flow) {
    const kind = n.data.kind;
    const out = outs.get(n.id) ?? [];
    const into = ins.get(n.id) ?? [];
    if (kind === "bpmn-parallel-gateway" && out.length > 1) {
      const joinsOn = (start) =>
        [...walk([start], outs, (e) => e.target)].filter((id) => id !== n.id && kindOf(id) === "bpmn-parallel-gateway" && (ins.get(id)?.length ?? 0) > 1);
      const [first, ...rest] = out.map((e) => new Set(joinsOn(e.target)));
      if (![...first].some((id) => rest.every((r) => r.has(id)))) notes.push(`The paths that split at “${nameOf(n)}” do not meet again at a parallel gateway.`);
    }
    if (kind === "bpmn-exclusive-gateway" && out.length > 1 && out.some((e) => !String(e.label ?? "").trim())) {
      notes.push(`Not every way out of the decision “${nameOf(n)}” has a label.`);
    }
    if (isGateway(kind) && out.length === 1 && into.length === 1) notes.push(`“${nameOf(n)}” has only one way in and one way out, so it is not needed.`);
  }
  for (const e of valid) {
    const kind = notation(e);
    const a = poolOf(e.source, byId);
    const b = poolOf(e.target, byId);
    if (kind === "sequence" && a !== b) {
      notes.push(`The sequence flow from “${nameOf(node.get(e.source))}” to “${nameOf(node.get(e.target))}” crosses a pool boundary. Between pools, use a message flow.`);
    }
    if (kind === "message" && a !== null && a === b) {
      notes.push(`The message flow from “${nameOf(node.get(e.source))}” to “${nameOf(node.get(e.target))}” stays in one pool. Inside a pool, use a sequence flow.`);
    }
  }
  for (const n of flow) {
    if (n.data.kind !== "bpmn-ai-task" && n.data.kind !== "bpmn-agent-task") continue;
    const bridged = valid.some((e) => {
      const other = e.source === n.id ? e.target : e.target === n.id ? e.source : null;
      const o = other ? node.get(other) : undefined;
      return !!o && (o.type ?? "aiNode") === "aiNode" && !isBpmn(o.data?.kind) && !["note", "group", "image"].includes(o.data?.kind);
    });
    if (!bridged) notes.push(`“${nameOf(n)}” is not connected to an AI component.`);
  }
  return notes;
}
for (const k of BPMN.kinds) kindName.set(k.kind, k.name);

/** The pair of sides, one on each box, whose middles are nearest (nearestHandlePair in the app). */
function nearestHandles(a, b, avoid = {}) {
  const points = (r) => ({
    l: { x: r.x, y: r.y + r.height / 2 },
    r: { x: r.x + r.width, y: r.y + r.height / 2 },
    t: { x: r.x + r.width / 2, y: r.y },
    b: { x: r.x + r.width / 2, y: r.y + r.height },
  });
  const from = points(a);
  const to = points(b);
  let best = { sourceHandle: "r", targetHandle: "l" };
  let bestD = Infinity;
  for (const s of ["l", "r", "t", "b"]) {
    if (avoid.source?.includes(s)) continue;
    for (const t of ["l", "r", "t", "b"]) {
      if (avoid.target?.includes(t)) continue;
      const d = (from[s].x - to[t].x) ** 2 + (from[s].y - to[t].y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { sourceHandle: s, targetHandle: t };
      }
    }
  }
  return best;
}

/** The node types of the diagram format (NODE_TYPES in the app's lib/diagram-schema.ts). */
const NODE_TYPES = ["aiNode", "group", "note", "imageNode", "bpmnNode", "pool", "lane", "epkNode", "umlNode", "dmnNode", "dmnTable"];

/** Which shapes may point to another diagram of the account (canLinkDiagram in the app). */
function canLinkDiagram(type, kind) {
  if (type === "aiNode" || type === undefined || type === "group") return true;
  if (type === "bpmnNode") return isTask(kind);
  if (type === "epkNode") return isEpkFunction(kind) || kind === "epk-process-path";
  if (type === "dmnNode") return isDmnDecision(kind);
  return false;
}

/** Checks a finished diagram the way the server does on import. */
function validate(content) {
  if (content.schemaVersion !== 1) errors.push("schemaVersion must be 1.");
  if (!Array.isArray(content.nodes) || !Array.isArray(content.edges)) {
    errors.push('"nodes" and "edges" must be arrays.');
    return;
  }
  if (content.nodes.length > LIMITS.nodes) errors.push(`More than ${LIMITS.nodes} nodes.`);
  if (content.edges.length > LIMITS.edges) errors.push(`More than ${LIMITS.edges} edges.`);
  const ids = new Set();
  content.nodes.forEach((n, i) => {
    const at = `nodes[${i}]${n && n.id ? ` (${n.id})` : ""}`;
    if (!n || typeof n !== "object") return errors.push(`${at}: not an object.`);
    if (!isStr(n.id, 64, 1)) errors.push(`${at}: "id" must be a string of 1 to 64 characters.`);
    else if (ids.has(n.id)) errors.push(`${at}: id is used twice.`);
    else ids.add(n.id);
    if (!NODE_TYPES.includes(n.type)) errors.push(`${at}: "type" must be one of ${NODE_TYPES.join(", ")}.`);
    if (!n.position || typeof n.position.x !== "number" || typeof n.position.y !== "number") {
      errors.push(`${at}: "position" needs numeric x and y.`);
    }
    const d = n.data;
    if (!d || typeof d !== "object") return errors.push(`${at}: "data" is missing.`);
    if (!isStr(d.kind, 64, 1)) errors.push(`${at}: "kind" must be a string of 1 to 64 characters.`);
    else if (!kindName.has(d.kind) && d.kind !== "group" && n.type !== "imageNode") {
      warnings.push(`${at}: kind "${d.kind}" is not in the catalog; it will show as a generic component.`);
    }
    if (!optStr(d.label, 200)) errors.push(`${at}: "label" is longer than 200 characters.`);
    if (!optStr(d.vendor, 120)) errors.push(`${at}: "vendor" is longer than 120 characters.`);
    else if (d.vendor && !vendorIds.has(d.vendor)) {
      warnings.push(`${at}: vendor "${d.vendor}" is not in the catalog; it will show as plain text without a logo.`);
    }
    if (!optStr(d.model, 120)) errors.push(`${at}: "model" is longer than 120 characters.`);
    if (!optStr(d.description, 2000)) errors.push(`${at}: "description" is longer than 2000 characters.`);
    // The id in the Mermaid text it came from, as the server keeps it (diagramContentSchema).
    if (d.mermaidId !== undefined && !isStr(d.mermaidId, 64)) {
      errors.push(`${at}: "mermaidId" must be text of at most 64 characters.`);
    }
    if (d.role !== undefined && !ROLES.includes(d.role)) {
      errors.push(`${at}: "role" must be one of ${ROLES.join(", ")}.`);
    }
    if (d.display !== undefined && !DISPLAYS.includes(d.display)) {
      errors.push(`${at}: "display" must be block or icon.`);
    }
    if (d.href != null && !isHttp(d.href)) errors.push(`${at}: "href" must be an http or https link.`);
    if (!optStr(d.href, 2000)) errors.push(`${at}: "href" is longer than 2000 characters.`);
    // A link to another diagram of the account (#51): its id; the import keeps it only when that diagram is the importer's.
    if (d.diagramRef !== undefined && !(typeof d.diagramRef === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(d.diagramRef))) {
      errors.push(`${at}: "diagramRef" must be the id of a diagram.`);
    }
    validateFields(at, d.fields, n.type);
    // BPMN (B1d), as the server's schema checks it.
    if ((n.type === "bpmnNode") !== (isBpmn(d.kind) && d.kind !== "bpmn-pool" && d.kind !== "bpmn-lane")) {
      errors.push(`${at}: BPMN shapes (tasks, events, gateways, data) are of type bpmnNode, and only they are.`);
    }
    if ((n.type === "pool") !== (d.kind === "bpmn-pool") || (n.type === "lane") !== (d.kind === "bpmn-lane")) {
      errors.push(`${at}: a pool is of kind bpmn-pool and a lane of kind bpmn-lane, and only they are.`);
    }
    if (d.band !== undefined && (!(n.type === "pool" || n.type === "lane") || !BPMN.bands.includes(d.band))) {
      errors.push(`${at}: only a pool or lane has a band colour, one of ${BPMN.bands.join(", ")}.`);
    }
    if (!bpmnFits(d.kind, d.bpmn)) errors.push(`${at}: only events carry a trigger; only intermediate events throw, and a timer never throws.`);
    // EPK, DMN and UML (#44), as the server's schema checks them: each kind with its node type.
    if ((n.type === "epkNode") !== isEpk(d.kind)) errors.push(`${at}: EPK components are of type epkNode, and only they are.`);
    if ((n.type === "dmnNode") !== isDmn(d.kind)) errors.push(`${at}: DMN components are of type dmnNode, and only they are.`);
    if ((n.type === "umlNode") !== isUml(d.kind)) errors.push(`${at}: UML classes are of type umlNode, and only they are.`);
    if ((n.type === "dmnTable") !== isTable(d.kind) || (n.type === "dmnTable") !== (d.dmnTable !== undefined)) {
      errors.push(`${at}: a DMN decision table is a dmnTable node with its table ("dmnTable"), and only it is.`);
    } else if (d.dmnTable !== undefined) {
      const wrong = storedTableError(d.dmnTable);
      if (wrong) errors.push(`${at}: the decision table ${wrong.replace(/\.$/, "")}.`);
    }
    if (d.uml !== undefined) {
      const u = d.uml;
      const lines = (l) => l === undefined || (Array.isArray(l) && l.length <= UML.limits.maxLines && l.every((x) => isStr(x, UML.limits.maxLine)));
      if (n.type !== "umlNode") errors.push(`${at}: only a UML class has attributes and operations ("uml").`);
      else if (!u || typeof u !== "object" || !lines(u.attributes) || !lines(u.operations)) {
        errors.push(`${at}: "uml" holds at most ${UML.limits.maxLines} attributes and operations of at most ${UML.limits.maxLine} characters each.`);
      } else if (u.category !== undefined && !UML.categories.includes(u.category)) errors.push(`${at}: "uml.category" must be one of ${UML.categories.join(", ")}.`);
    }
    // Which shapes may point to another diagram (canLinkDiagram in the app's lib/diagram-links.ts).
    if (d.diagramRef !== undefined && !canLinkDiagram(n.type, d.kind)) {
      errors.push(`${at}: only components, groups, BPMN tasks, EPK functions and process paths and DMN decisions point to a diagram.`);
    }
    // An image the user placed in the editor: passed through as it is, never made up.
    if ((n.type === "imageNode") !== (d.image !== undefined)) {
      errors.push(`${at}: an image node needs "image", and only an image node has one.`);
    } else if (d.image !== undefined) {
      const im = d.image;
      const px = (v) => Number.isInteger(v) && v > 0 && v <= 20000;
      if (!im || typeof im !== "object") errors.push(`${at}: "image" is not an object.`);
      else {
        if (!isStr(im.assetId, 36, 36)) errors.push(`${at}: "image.assetId" must be the id from the editor.`);
        if (!isStr(im.url, 300) || !IMAGE_URL.test(im.url)) {
          errors.push(`${at}: "image.url" must be an image of the DuctTape.io image library; other addresses are refused.`);
        }
        if (!px(im.width) || !px(im.height)) errors.push(`${at}: "image.width" and "image.height" must be whole numbers.`);
        if (!optStr(im.alt, 300)) errors.push(`${at}: "image.alt" is longer than 300 characters.`);
      }
    }
  });
  const byId = new Map(content.nodes.filter((n) => n && n.id).map((n) => [n.id, n]));
  for (const n of content.nodes) {
    if (!n || !n.id) continue;
    const parent = n.parentId ? byId.get(n.parentId) : undefined;
    if (n.parentId !== undefined && !parent) errors.push(`nodes (${n.id}): "parentId" ${n.parentId} is not a node.`);
    const fits = n.type === "lane" ? parent?.type === "pool" : n.type === "pool" ? n.parentId === undefined : !parent || !(parent.type === "pool" || parent.type === "lane") || ["aiNode", "imageNode", ...SHAPE_TYPES].includes(n.type);
    if (!fits) errors.push(`nodes (${n.id}): a lane sits in a pool, a pool in nothing, and only components and images in a pool or lane.`);
  }
  if (content.nodes.filter((n) => n && n.type === "imageNode").length > LIMITS.images) {
    errors.push(`More than ${LIMITS.images} images.`);
  }
  content.edges.forEach((e, i) => {
    const at = `edges[${i}]`;
    if (!e || typeof e !== "object") return errors.push(`${at}: not an object.`);
    if (!ids.has(e.source)) errors.push(`${at}: source "${e.source}" is not a node.`);
    if (!ids.has(e.target)) errors.push(`${at}: target "${e.target}" is not a node.`);
    if (e.source === e.target) errors.push(`${at}: a node cannot be connected to itself (${e.source}).`);
    if (e.flow !== undefined && !["none", "data", "stream", "document"].includes(e.flow)) {
      errors.push(`${at}: "flow" must be none, data, stream or document.`);
    }
    if (!optStr(e.label, 200)) errors.push(`${at}: "label" is longer than 200 characters.`);
    if (e.notation !== undefined && !NOTATIONS.includes(e.notation)) errors.push(`${at}: "notation" must be one of ${NOTATIONS.join(", ")}.`);
    if (e.notation !== undefined && ((e.flow ?? "none") !== "none" || e.animated === true)) errors.push(`${at}: a BPMN connection carries no flow.`);
    if (e.directed !== undefined && e.notation !== "association" && e.notation !== "uml-association") errors.push(`${at}: only an association can be directed.`);
    // UML relations (U1): texts at their ends, at most the limit.
    for (const field of ["sourceLabel", "targetLabel"]) {
      if (e[field] !== undefined && !isStr(e[field], UML.limits.maxEnd)) errors.push(`${at}: "${field}" must be text of at most ${UML.limits.maxEnd} characters.`);
    }
    if ((e.sourceLabel !== undefined || e.targetLabel !== undefined) && !isUmlNotation(e.notation)) errors.push(`${at}: only a UML relation has labels at its ends.`);
  });
}

/**
 * Layers by longest path along the edges, then orders each layer by its neighbours. `gap` is the
 * space between two nodes of a layer (nodesep in the app's dagre runs), `sizeOf` a node's room.
 */
function layout(nodes, edges, dir = direction, { gap = GAP.node, size: roomOf = sizeOf } = {}) {
  const ids = nodes.map((n) => n.id);
  const out = new Map(ids.map((id) => [id, []]));
  const seen = new Set();
  for (const e of edges) {
    // A return path must not pull the layout the other way.
    if (seen.has(`${e.target}>${e.source}`) || seen.has(`${e.source}>${e.target}`)) continue;
    seen.add(`${e.source}>${e.target}`);
    out.get(e.source).push(e.target);
  }
  // Depth-first: edges that close a cycle are ignored for the layering.
  const state = new Map();
  const forward = new Map(ids.map((id) => [id, []]));
  const visit = (id) => {
    state.set(id, 1);
    for (const t of out.get(id)) {
      if (state.get(t) === 1) continue;
      forward.get(id).push(t);
      if (!state.has(t)) visit(t);
    }
    state.set(id, 2);
  };
  for (const id of ids) if (!state.has(id)) visit(id);

  const rank = new Map(ids.map((id) => [id, 0]));
  let changed = true;
  for (let round = 0; changed && round <= ids.length; round++) {
    changed = false;
    for (const id of ids) {
      for (const t of forward.get(id)) {
        if (rank.get(t) < rank.get(id) + 1) {
          rank.set(t, rank.get(id) + 1);
          changed = true;
        }
      }
    }
  }
  const layers = [];
  for (const id of ids) (layers[rank.get(id)] ??= []).push(id);
  const preds = new Map(ids.map((id) => [id, []]));
  for (const id of ids) for (const t of forward.get(id)) preds.get(t).push(id);
  const order = new Map();
  layers.forEach((layer, r) => {
    if (r > 0) {
      const weight = (id) => {
        const p = preds.get(id).map((x) => order.get(x)).filter((x) => x !== undefined);
        return p.length ? p.reduce((a, b) => a + b, 0) / p.length : Number.MAX_SAFE_INTEGER;
      };
      layer.sort((a, b) => weight(a) - weight(b));
    }
    layer.forEach((id, i) => order.set(id, i));
  });

  const size = new Map(nodes.map((n) => [n.id, roomOf(n)]));
  const breadth = (layer) =>
    layer.reduce((sum, id) => sum + (dir === "LR" ? size.get(id).height : size.get(id).width), 0) +
    gap * (layer.length - 1);
  const widest = Math.max(...layers.map(breadth), 0);
  // The widest label leaving each layer (only for the left-to-right reading, where labels sit
  // across the gap; top to bottom they sit beside the line).
  const labelGap = layers.map(() => 0);
  for (const e of edges) {
    const r = rank.get(e.source);
    if (r === undefined || rank.get(e.target) === undefined) continue;
    const from = Math.min(r, rank.get(e.target));
    // A labelled connection with a flow keeps 40px more for its still mark (FLOW_MARK_ROOM in the app).
    const markRoom = e.label && e.flow && e.flow !== "none" ? 40 : 0;
    if (dir === "LR") labelGap[from] = Math.max(labelGap[from], labelWidth(e.label) + 2 * EDGE_LABEL.margin + markRoom);
  }
  const pos = new Map();
  let along = 0;
  for (const [r, layer] of layers.entries()) {
    let across = (widest - breadth(layer)) / 2;
    let depth = 0;
    for (const id of layer) {
      const s = size.get(id);
      pos.set(id, dir === "LR" ? { x: along, y: Math.round(across) } : { x: Math.round(across), y: along });
      across += (dir === "LR" ? s.height : s.width) + gap;
      depth = Math.max(depth, dir === "LR" ? s.width : s.height);
    }
    along += depth + Math.max(GAP.rank, labelGap[r]);
  }
  return pos;
}

const snap16 = (v) => Math.round(v / 16) * 16;
const among = (ids, edges) => edges.filter((e) => ids.has(e.source) && ids.has(e.target));

/**
 * EPK (epkLayout in the app): the chain of events, functions, connectors and process paths top
 * to bottom, branches 72px apart, and beside each function what is joined to it: organisational
 * units on its left, information objects and AI components on its right, stacked 16px apart.
 * What belongs to no function stands with the chain.
 */
function chainLayout(nodes, edges) {
  const kinds = new Map(nodes.map((n) => [n.id, n.kind]));
  const isFunction = (id) => isEpkFunction(kinds.get(id));
  const besideOf = new Map();
  for (const n of nodes) {
    if (isEpkFlow(n.kind) || n.type === "note") continue;
    const e = edges.find((x) => (x.source === n.id && isFunction(x.target)) || (x.target === n.id && isFunction(x.source)));
    if (e) besideOf.set(n.id, e.source === n.id ? e.target : e.source);
  }
  const chain = nodes.filter((n) => !besideOf.has(n.id));
  const positions = layout(chain, among(new Set(chain.map((n) => n.id)), edges), "TB", { gap: 72 });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const used = new Map();
  for (const [id, fn] of besideOf) {
    const at = positions.get(fn);
    if (!at) continue;
    const f = sizeOf(byId.get(fn));
    const n = sizeOf(byId.get(id));
    const side = kinds.get(id) === "epk-org-unit" ? "left" : "right";
    const taken = used.get(fn) ?? { left: 0, right: 0 };
    const y = at.y + (f.height - n.height) / 2 + taken[side];
    positions.set(id, { x: snap16(side === "left" ? at.x - 48 - n.width : at.x + f.width + 48), y: snap16(y) });
    taken[side] += n.height + 16;
    used.set(fn, taken);
  }
  return positions;
}

/**
 * UML (umlLayout in the app): classes in levels top to bottom, 64px apart, the general class above
 * the special one: an inheritance or realization points up, so it is read backwards.
 */
function levelLayout(nodes, edges) {
  const read = edges.map((e) => (UML.generalizations.includes(e.notation) ? { ...e, source: e.target, target: e.source } : e));
  return layout(nodes, among(new Set(nodes.map((n) => n.id)), read), "TB", { gap: 64 });
}

/**
 * DMN (dmnLayout in the app): bottom up, a decision above what it requires, so every requirement
 * is read backwards. A decision table stands to the right of its decision, same top, 64px between:
 * the two take part as one box that keeps as much room left of the decision as the table takes
 * right of it, so what the decision requires stands below the decision, not below the table.
 */
function requirementLayout(nodes, edges) {
  const GAP_TABLE = 64;
  const ids = new Set(nodes.map((n) => n.id));
  const tables = nodes.filter((n) => isTable(n.kind) && n.storedTable?.decision && ids.has(n.storedTable.decision));
  const tableOf = new Map(tables.map((t) => [t.storedTable.decision, t]));
  const boxes = nodes.filter((n) => !tables.includes(n));
  const room = (n) => {
    const own = sizeOf(n);
    const t = tableOf.get(n.id);
    if (!t) return own;
    const ts = sizeOf(t);
    return { width: own.width + 2 * (GAP_TABLE + ts.width), height: Math.max(own.height, ts.height) };
  };
  const read = among(ids, edges).map((e) => ({ ...e, source: e.target, target: e.source }));
  const at = layout(boxes, among(new Set(boxes.map((n) => n.id)), read), "TB", { gap: 64, size: room });
  for (const t of tables) {
    const d = nodes.find((n) => n.id === t.storedTable.decision);
    const p = at.get(d.id);
    if (!p) continue;
    const x = p.x + GAP_TABLE + sizeOf(t).width;
    at.set(d.id, { x, y: p.y });
    at.set(t.id, { x: x + sizeOf(d).width + GAP_TABLE, y: p.y });
  }
  return at;
}

let content;
if (input && typeof input === "object" && "schemaVersion" in input) {
  content = input;
} else if (input && Array.isArray(input.nodes)) {
  const edges = Array.isArray(input.edges) ? input.edges : [];
  const nodes = input.nodes.map((n) => ({ ...n, type: typeOfKind(n?.kind) }));
  for (const n of nodes) {
    if (n.kind === "group") errors.push(`Node "${n.id}": groups are drawn in the editor and cannot be created; use a note instead. An update_diagram keeps the groups get_diagram returned when you pass them on with their id.`);
    if (n.kind === "image") errors.push(`Node "${n.id}": images are uploaded in the editor and cannot be created here.`);
  }
  if (nodes.some((n) => isBpmn(n.kind) || n.parent || n.bpmn || n.band) || edges.some((e) => e?.notation || e?.directed)) bpmnShapeErrors(nodes, edges);
  // EPK, UML and DMN (#44): their data and connections; the decision tables in their stored form.
  const tables = notationErrors(nodes, edges);
  for (const n of nodes) if (tables.has(n.id)) n.storedTable = tables.get(n.id);
  const known = new Set(nodes.map((n) => n.id));
  const notationById = new Map(nodes.map((n) => [n.id, { id: n.id, kind: n.kind, parentId: n.parent }]));
  // Each connection with its notation (given, or chosen as the editor does), for the layouts.
  const usable = edges
    .filter((e) => e && known.has(e.source) && known.has(e.target) && e.source !== e.target)
    .map((e) => ({ ...e, notation: e.notation ?? connectionNotation(e.source, e.target, notationById) }));
  // The arrangement the app picks (layoutDiagram in lib/auto-layout.ts): pools in bands (B1d);
  // without pools an EPK top to bottom, UML classes in levels, DMN bottom up; else the layers.
  const banded = nodes.some((n) => n.kind === "bpmn-pool") && !errors.length ? bandLayout(nodes, usable) : null;
  const pos = banded
    ? banded.positions
    : nodes.some((n) => n.type === "epkNode")
      ? chainLayout(nodes, usable)
      : nodes.some((n) => n.type === "umlNode")
        ? levelLayout(nodes, usable)
        : nodes.some((n) => n.type === "dmnNode")
          ? requirementLayout(nodes, usable)
          : layout(nodes, usable);
  const size = new Map(nodes.map((n) => [n.id, banded?.sizes.get(n.id) ?? sizeOf(n)]));
  const parentOf = new Map(nodes.filter((n) => n.parent).map((n) => [n.id, n.parent]));
  const absolute = (id) => {
    let x = 0;
    let y = 0;
    for (let at = id, depth = 0; at && depth < 4; at = parentOf.get(at), depth++) {
      const p = pos.get(at) ?? { x: 0, y: 0 };
      x += p.x;
      y += p.y;
    }
    return { x, y };
  };
  const boxOf = (id) => ({ ...absolute(id), ...(size.get(id) ?? { width: 0, height: 0 }) });
  // The side of a decision its table stands at (as MCP's create_diagram).
  const tableAt = new Map(nodes.filter((n) => n.storedTable?.decision && known.has(n.storedTable.decision)).map((n) => [n.storedTable.decision, n.id]));
  // Not from or into the bottom of a BPMN shape whose name hangs there (as the app), nor the side
  // of a decision where its table stands.
  const belowOf = (id) => {
    const n = nodes.find((m) => m.id === id);
    const sides = n && isBpmn(n.kind) && n.label && labelBelow(n.kind) ? ["b"] : [];
    if (tableAt.has(id)) {
      const d = boxOf(id);
      const t = boxOf(tableAt.get(id));
      sides.push(t.x >= d.x + d.width ? "r" : t.x + t.width <= d.x ? "l" : t.y >= d.y ? "b" : "t");
    }
    return sides;
  };
  content = {
    schemaVersion: 1,
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: pos.get(n.id) ?? { x: 0, y: 0 },
      ...(n.parent ? { parentId: n.parent } : {}),
      ...(n.type === "note" ? noteSize(n.label) : {}),
      // Pools and lanes with the size of their bands; a task, an EPK shape that can be resized
      // (all but the connectors) and a DMN shape with its standard size. Classes and decision
      // tables follow their texts and store none.
      ...(n.type === "pool" || n.type === "lane"
        ? size.get(n.id)
        : (n.type === "bpmnNode" && isTask(n.kind)) || (n.type === "epkNode" && !isEpkConnector(n.kind)) || n.type === "dmnNode"
          ? sizeOf({ kind: n.kind })
          : {}),
      data: {
        kind: n.kind,
        // Tasks are named like a component; events, gateways, data, pools, lanes and EPK's connectors may stay unnamed.
        label: n.label ?? (n.type === "note" || (isBpmn(n.kind) && !isTask(n.kind)) || isEpkConnector(n.kind) ? "" : (kindName.get(n.kind) ?? n.kind)),
        vendor: n.vendor ?? null,
        model: n.model ?? null,
        description: n.description ?? null,
        color: null,
        background: null,
        icon: null,
        href: n.href ?? null,
        // Only components have a second display; "block" is the default and is left out.
        ...(n.type === "aiNode" && n.display !== undefined && n.display !== "block" ? { display: n.display } : {}),
        // A role only where it differs from the kind's default.
        ...(n.type === "aiNode" && n.role !== undefined && n.role !== kindRole.get(n.kind) ? { role: n.role } : {}),
        // The id in a Mermaid text it came from, kept for "Update from Mermaid".
        ...(typeof n.mermaidId === "string" && n.mermaidId ? { mermaidId: n.mermaidId.slice(0, 64) } : {}),
        // Meta field values travel as given and are checked below with the rest.
        ...(n.fields !== undefined ? { fields: n.fields } : {}),
        ...(isBpmn(n.kind) && cleanBpmn(n.kind, n.bpmn) ? { bpmn: cleanBpmn(n.kind, n.bpmn) } : {}),
        ...((n.type === "pool" || n.type === "lane") && n.band ? { band: n.band } : {}),
        // A class's attributes, operations and category; a decision table's table.
        ...(n.type === "umlNode" && umlOut(n.uml) ? { uml: umlOut(n.uml) } : {}),
        ...(n.type === "dmnTable" && n.storedTable ? { dmnTable: n.storedTable } : {}),
      },
    })),
    edges: edges.map((e, i) => ({
      id: `e${i + 1}`,
      source: e?.source,
      target: e?.target,
      // The nearest pair of sides: a return path does not loop around its ends.
      ...(known.has(e?.source) && known.has(e?.target)
        ? nearestHandles(boxOf(e.source), boxOf(e.target), { source: belowOf(e.source), target: belowOf(e.target) })
        : { sourceHandle: "r", targetHandle: "l" }),
      ...(e?.label ? { label: e.label } : {}),
      type: "smoothstep",
      markerEnd: "arrowclosed",
      // A connection at a BPMN, EPK, UML or DMN shape carries its notation (given, or chosen as
      // the editor does) and no flow; otherwise what moves along it (lib/flow.ts in the app):
      // "data", "stream" or "document".
      ...((() => {
        const notation = e?.notation ?? connectionNotation(e?.source, e?.target, notationById);
        if (!notation) return e?.flow && e.flow !== "none" ? { flow: e.flow } : {};
        return {
          notation,
          ...((notation === "association" || notation === "uml-association") && e.directed ? { directed: true } : {}),
          // UML (U1): the texts at the ends (multiplicity, role).
          ...(isUmlNotation(notation) && typeof e.sourceLabel === "string" && e.sourceLabel.trim() ? { sourceLabel: e.sourceLabel.trim() } : {}),
          ...(isUmlNotation(notation) && typeof e.targetLabel === "string" && e.targetLabel.trim() ? { targetLabel: e.targetLabel.trim() } : {}),
        };
      })()),
    })),
    viewport: { x: 0, y: 0, zoom: 1 },
  };
} else {
  errors.push('The file needs "nodes" (and "edges"), or must be a diagram file with "schemaVersion".');
}

if (content) validate(content);
const json = content ? JSON.stringify(content, null, 2) : "";
if (Buffer.byteLength(json) > LIMITS.bytes) errors.push("The diagram is larger than 512 KB.");

for (const w of warnings) console.error(`Warning: ${w}`);
// Notes of the check, the same as the app gives: only what is missing, never errors.
if (content && !errors.length) for (const note of checkNotes(content)) console.log(`Check: ${note}`);
if (errors.length) {
  for (const e of errors) console.error(`Error: ${e}`);
  console.error(`\n${errors.length} error(s). Nothing was written.`);
  process.exit(1);
}
if (outPath) {
  writeFileSync(outPath, json + "\n");
  console.log(`Wrote ${outPath}: ${content.nodes.length} components, ${content.edges.length} connections.`);
  console.log('Open it with "Import from JSON" at https://theducttape.io/app. The file name becomes the title.');
} else {
  console.log(`Valid: ${content.nodes.length} components, ${content.edges.length} connections. Give an output path to write the file.`);
}

/**
 * The diagram check (checkDiagram in the app's lib/check.ts), in the app's order: what is
 * missing per component, then the rules of BPMN, EPK, UML and DMN, then the notes about the
 * picture (a name the icon cuts short, components lying over each other).
 */
function checkNotes(c) {
  const stored = new Map(c.nodes.map((n) => [n.id, n]));
  // The components the check looks at (isComponent in the app): no notes, groups, pools, lanes or images.
  const parts = c.nodes.filter((n) => !["note", "group", "pool", "lane", "imageNode"].includes(n.type) && !["note", "group", "image"].includes(n.data?.kind));
  const nameOf = (n) => shownName(n.data?.label, n.data?.kind);
  // Positions on the canvas: a shape in a lane sits relative to it, the lane to its pool.
  const absoluteOf = (n) => {
    let x = 0;
    let y = 0;
    for (let at = n, depth = 0; at && depth < 8; at = at.parentId ? stored.get(at.parentId) : undefined, depth++) {
      x += at.position?.x ?? 0;
      y += at.position?.y ?? 0;
    }
    return { x, y };
  };
  // Sizes as the app's check estimates them (sizeOf in lib/check.ts): a shape by its stored or
  // standard size, a class and a table by their texts, a component at least as high as its estimate.
  const sizeInCheck = (n) => {
    const d = n.data ?? {};
    const std = n.type === "bpmnNode" ? bpmnKind.get(d.kind) : n.type === "epkNode" ? epkKind.get(d.kind) : n.type === "dmnNode" ? dmnKind.get(d.kind) : null;
    if (std) return { width: n.width ?? std.width, height: n.height ?? std.height };
    if (n.type === "dmnTable") return tableSize(d.dmnTable);
    if (n.type === "umlNode") return umlSize(d.kind, d.label, d.uml);
    const est = sizeOf({ ...d, type: n.type, kind: d.kind });
    return { width: n.width ?? est.width, height: Math.max(n.height ?? 0, est.height) };
  };
  // About the picture (10h): a name the icon cuts short, and components lying over each other.
  const picture = [];
  for (const n of parts) {
    if (n.data?.display === "icon" && iconNameCut(nameOf(n))) {
      picture.push(`The name of “${nameOf(n)}” is cut short as an icon. As a block it shows in full.`);
    }
  }
  const boxes = parts.filter((n) => n.position).map((n) => ({ n, ...absoluteOf(n), ...sizeInCheck(n) }));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) {
        picture.push(`“${nameOf(a.n)}” and “${nameOf(b.n)}” overlap. Move one aside or use Auto-layout.`);
      }
    }
  }
  const rules = [...bpmnNotes(c, nameOf), ...epkNotes(c, nameOf), ...umlNotes(c, nameOf), ...dmnNotes(c, nameOf)];
  // A decision table has no handles: it belongs to its decision by reference, not by a line.
  const checked = parts.filter((n) => n.type !== "dmnTable");
  // With a single component there is nothing to connect yet.
  if (checked.length < 2) return [...rules, ...picture];
  const into = new Set();
  const out = new Set();
  // A bridge line (an association, assignment or dependency that ties an AI component to a
  // notation's shape) has no direction for the roles: both ends count as joined both ways.
  const bridge = new Set(["association", "epk-assignment", "dmn-association", "uml-dependency"]);
  for (const e of c.edges) {
    if (!e || e.source === e.target) continue;
    out.add(e.source);
    into.add(e.target);
    if (bridge.has(notationOf(e))) {
      out.add(e.target);
      into.add(e.source);
    }
  }
  const notes = [];
  for (const n of checked) {
    const kind = n.data?.kind ?? "";
    const name = n.data?.label || kindName.get(kind) || kind;
    const hasIn = into.has(n.id);
    const hasOut = out.has(n.id);
    if (!hasIn && !hasOut) {
      notes.push(`“${name}” is not connected to anything.`);
      continue;
    }
    // EPK, UML and DMN kinds have no default role: they are only checked for being connected.
    const role = ROLES.includes(n.data?.role) ? n.data.role : (kindRole.get(kind) ?? "free");
    if (role === "pass") {
      if (!hasIn) notes.push(`Nothing leads into “${name}”.`);
      if (!hasOut) notes.push(`Nothing leads out of “${name}”.`);
    } else if (role === "start" && !hasOut) notes.push(`“${name}” is a starting point, but nothing leads out of it.`);
    else if (role === "end" && !hasIn) notes.push(`“${name}” is an end point, but nothing leads into it.`);
  }
  return [...notes, ...rules, ...picture];
}

/** Whether a stored node is an AI component (an aiNode that is not a note, group or image). */
function isAiComponent(n) {
  return !!n && (n.type ?? "aiNode") === "aiNode" && !isBpmn(n.data?.kind) && !isEpk(n.data?.kind) && !["note", "group", "image"].includes(n.data?.kind);
}

/**
 * The EPK rules (epkRules in the app's lib/check.ts), only for diagrams with EPK flow elements:
 * a chain begins and ends with an event (or a process path); events and functions take turns
 * along the control flow, connectors pass through; paths split and meet only at connectors; no
 * OR or XOR split right after an event; every split meets a join of its kind again; a function
 * has an organisational unit; an AI or agent function is connected to an AI component.
 */
function epkNotes(c, nameOf) {
  const node = new Map(c.nodes.map((n) => [n.id, n]));
  const kindOf = (id) => node.get(id)?.data?.kind ?? "";
  const name = (id) => nameOf(node.get(id));
  const flow = c.nodes.filter((n) => isEpkFlow(n.data?.kind ?? ""));
  if (flow.length === 0) return [];
  // A connection between two flow elements without a notation reads as a control flow.
  const notation = (e) => notationOf(e) ?? (isEpkFlow(kindOf(e.source)) && isEpkFlow(kindOf(e.target)) ? "epk-control" : null);
  const valid = c.edges.filter((e) => e && e.source !== e.target && node.has(e.source) && node.has(e.target));
  const outs = new Map();
  const ins = new Map();
  for (const e of valid.filter((x) => notation(x) === "epk-control")) {
    outs.set(e.source, [...(outs.get(e.source) ?? []), e.target]);
    ins.set(e.target, [...(ins.get(e.target) ?? []), e.source]);
  }
  const connected = new Set(valid.flatMap((e) => [e.source, e.target]));
  const notes = [];
  const isEvent = (id) => kindOf(id) === "epk-event";
  const isFunction = (id) => isEpkFunction(kindOf(id));
  const endsOk = (id) => isEvent(id) || kindOf(id) === "epk-process-path";
  // A chain begins and ends with an event (a process path may stand at either end).
  for (const n of flow) {
    if (!connected.has(n.id) || isEpkConnector(n.data.kind)) continue;
    if (!ins.has(n.id) && outs.has(n.id) && !endsOk(n.id)) notes.push(`The chain begins with “${name(n.id)}”, but an EPC begins with an event.`);
    if (!outs.has(n.id) && ins.has(n.id) && !endsOk(n.id)) notes.push(`The chain ends with “${name(n.id)}”, but an EPC ends with an event.`);
  }
  // The next (or previous) events and functions along the control flow, past connectors.
  const beyond = (id, step) => {
    const found = new Set();
    const seen = new Set([id]);
    const queue = [...(step.get(id) ?? [])];
    while (queue.length) {
      const at = queue.shift();
      if (seen.has(at)) continue;
      seen.add(at);
      if (isEpkConnector(kindOf(at))) queue.push(...(step.get(at) ?? []));
      else found.add(at);
    }
    return found;
  };
  for (const n of flow) {
    if (!(isEvent(n.id) || isFunction(n.id))) continue;
    for (const next of beyond(n.id, outs)) {
      if (isEvent(n.id) && isEvent(next)) notes.push(`The event “${name(next)}” follows the event “${name(n.id)}”; a function goes between them.`);
      if (isFunction(n.id) && isFunction(next)) notes.push(`The function “${name(next)}” follows the function “${name(n.id)}”; an event goes between them.`);
    }
  }
  // Paths split and meet only at connectors: an event or a function with two flows out or in.
  for (const n of flow) {
    if (!(isEvent(n.id) || isFunction(n.id))) continue;
    if ((outs.get(n.id)?.length ?? 0) > 1) notes.push(`Several connections go out from “${name(n.id)}”. In an EPC, paths split at a connector (AND, OR or XOR).`);
    if ((ins.get(n.id)?.length ?? 0) > 1) notes.push(`Several connections lead into “${name(n.id)}”. In an EPC, paths meet at a connector (AND, OR or XOR).`);
  }
  const reach = (start) => {
    const seen = new Set();
    const queue = [start];
    while (queue.length) {
      const at = queue.shift();
      if (seen.has(at)) continue;
      seen.add(at);
      queue.push(...(outs.get(at) ?? []));
    }
    return seen;
  };
  for (const n of flow) {
    const kind = n.data.kind;
    const out = outs.get(n.id) ?? [];
    if (!isEpkConnector(kind) || out.length < 2) continue;
    // An event decides nothing: no OR or XOR split right after one (past other connectors).
    if ((kind === "epk-or" || kind === "epk-xor") && [...beyond(n.id, ins)].some(isEvent)) {
      notes.push(`“${name(n.id)}” branches right after an event. An event decides nothing, so an OR or XOR connector needs a function before it.`);
    }
    // The join of the same kind that every branch reaches; a branch that comes back to the split is a loop and needs none.
    const ahead = out.map(reach).filter((seen) => !seen.has(n.id));
    const joins = ahead.map((seen) => new Set([...seen].filter((id) => id !== n.id && kindOf(id) === kind && (ins.get(id)?.length ?? 0) > 1)));
    const [head, ...rest] = joins;
    if (joins.length > 1 && ![...head].some((id) => rest.every((r) => r.has(id)))) notes.push(`The paths that split at “${name(n.id)}” do not meet again at a connector of the same kind.`);
  }
  // Who does a function: an organisational unit assigned; the bridge of an AI or agent function.
  for (const n of flow) {
    if (!isFunction(n.id) || !connected.has(n.id)) continue;
    const linked = valid.filter((e) => e.source === n.id || e.target === n.id).map((e) => (e.source === n.id ? e.target : e.source));
    if (!linked.some((id) => kindOf(id) === "epk-org-unit")) notes.push(`No organisational unit is assigned to the function “${name(n.id)}”.`);
    if ((n.data.kind === "epk-ai-function" || n.data.kind === "epk-agent-function") && !linked.some((id) => isAiComponent(node.get(id)))) {
      notes.push(`“${name(n.id)}” is not connected to an AI component.`);
    }
  }
  return notes;
}

/**
 * The UML rules (umlRules in the app's lib/check.ts), only for relations between classes: a
 * realization ends at an interface, and inheritance runs one way (no class inherits from itself
 * through others; one note per cycle, at the first class of the diagram in it).
 */
function umlNotes(c, nameOf) {
  const node = new Map(c.nodes.map((n) => [n.id, n]));
  const kindOf = (id) => node.get(id)?.data?.kind ?? "";
  const name = (id) => nameOf(node.get(id));
  const between = c.edges.filter((e) => e && e.source !== e.target && isUml(kindOf(e.source)) && isUml(kindOf(e.target)));
  if (between.length === 0) return [];
  const notes = [];
  for (const e of between) {
    if (notationOf(e) === "uml-realization" && kindOf(e.target) !== "uml-interface") {
      notes.push(`“${name(e.source)}” realizes “${name(e.target)}”, but “${name(e.target)}” is not an interface. A class inherits from a class and realizes an interface.`);
    }
  }
  const parents = new Map();
  for (const e of between) if (notationOf(e) === "uml-inheritance") parents.set(e.source, [...(parents.get(e.source) ?? []), e.target]);
  const noted = new Set();
  for (const n of c.nodes) {
    if (!parents.has(n.id) || noted.has(n.id)) continue;
    // A path back to the start: breadth first, keeping where each class was reached from.
    const from = new Map();
    const queue = [...parents.get(n.id)];
    for (const p of queue) from.set(p, n.id);
    let back = false;
    while (queue.length && !back) {
      const at = queue.shift();
      if (at === n.id) back = true;
      for (const p of parents.get(at) ?? []) {
        if (!from.has(p)) {
          from.set(p, at);
          queue.push(p);
        }
      }
    }
    if (!back) continue;
    const ring = [];
    for (let at = from.get(n.id); at !== n.id && ring.length < c.nodes.length; at = from.get(at)) ring.push(at);
    for (const id of [n.id, ...ring]) noted.add(id);
    notes.push(`“${name(n.id)}” inherits from itself through “${name(ring[ring.length - 1] ?? n.id)}”; inheritance runs in one direction only.`);
  }
  return notes;
}

/**
 * The DMN rules (dmnRules in the app's lib/check.ts): a business rule task names a decision of
 * the diagram; each decision table belongs to a decision, a decision has one table; for diagrams
 * with DMN shapes: each requirement joins shapes it can, a decision requires something, an AI
 * decision is joined to an AI component, and requirements form no loop.
 */
function dmnNotes(c, nameOf) {
  const node = new Map(c.nodes.map((n) => [n.id, n]));
  const kindOf = (id) => node.get(id)?.data?.kind ?? "";
  const name = (id) => nameOf(node.get(id));
  const notes = [];
  // Business rule tasks first: they matter without DMN shapes too.
  for (const n of c.nodes) {
    if (n.data?.kind !== "bpmn-business-rule-task") continue;
    const ref = n.data.bpmn?.decision;
    if (!ref || !isDmnDecision(kindOf(ref))) notes.push(`The business rule task “${name(n.id)}” is not linked to a decision in this diagram.`);
  }
  const tableOf = new Map();
  for (const n of c.nodes) {
    if (n.type !== "dmnTable") continue;
    const ref = n.data?.dmnTable?.decision;
    if (!ref || !isDmnDecision(kindOf(ref))) notes.push(`The decision table “${name(n.id)}” is not linked to any decision in this diagram.`);
    else if (tableOf.has(ref)) notes.push(`The decision “${name(ref)}” has two decision tables: “${name(n.id)}” is the second.`);
    else tableOf.set(ref, n.id);
  }
  const shapes = c.nodes.filter((n) => isDmn(n.data?.kind ?? "") && n.type !== "dmnTable");
  if (shapes.length === 0) return notes;
  const reqs = c.edges.filter((e) => e && e.source !== e.target && isDmn(kindOf(e.source)) && isDmn(kindOf(e.target)));
  for (const e of reqs) {
    const r = notationOf(e);
    const s = kindOf(e.source);
    const t = kindOf(e.target);
    const fits =
      r === "dmn-information"
        ? (isDmnDecision(s) || s === "dmn-input-data") && isDmnDecision(t)
        : r === "dmn-knowledge"
          ? s === "dmn-bkm" && (isDmnDecision(t) || t === "dmn-bkm")
          : r === "dmn-authority"
            ? isDmnDecision(t) || t === "dmn-bkm" || t === "dmn-knowledge-source"
            : true;
    if (!fits) {
      notes.push(
        `The requirement from “${name(e.source)}” to “${name(e.target)}” does not fit. Information goes from input data or a decision into a decision. Knowledge comes from a business knowledge model. Authority goes into a decision, a business knowledge model or a knowledge source.`,
      );
    }
  }
  for (const n of shapes) {
    if (!isDmnDecision(n.data.kind)) continue;
    const into = reqs.some((e) => e.target === n.id);
    const anyLine = c.edges.some((e) => e && (e.source === n.id || e.target === n.id));
    if (anyLine && !into) notes.push(`The decision “${name(n.id)}” requires nothing: no input data, other decision, knowledge or authority leads into it.`);
    if (n.data.kind === "dmn-ai-decision") {
      const linked = c.edges.flatMap((e) => (!e ? [] : e.source === n.id ? [e.target] : e.target === n.id ? [e.source] : []));
      if (!linked.some((id) => node.get(id)?.type === "aiNode")) notes.push(`The AI decision “${name(n.id)}” is not connected to an AI component.`);
    }
  }
  // A loop of requirements: one note per loop, at the first shape of the diagram in it.
  const next = new Map();
  for (const e of reqs) next.set(e.source, [...(next.get(e.source) ?? []), e.target]);
  const noted = new Set();
  for (const n of shapes) {
    if (noted.has(n.id) || !next.has(n.id)) continue;
    const seen = new Set();
    const stack = [...next.get(n.id)];
    let back = false;
    while (stack.length && !back) {
      const at = stack.pop();
      if (at === n.id) back = true;
      else if (!seen.has(at)) {
        seen.add(at);
        stack.push(...(next.get(at) ?? []));
      }
    }
    if (!back) continue;
    for (const id of seen) noted.add(id);
    noted.add(n.id);
    notes.push(`The requirements of “${name(n.id)}” form a loop; a decision cannot require itself.`);
  }
  return notes;
}
