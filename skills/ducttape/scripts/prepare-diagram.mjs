#!/usr/bin/env node
// Turns a graph of nodes and edges into a file for "Import from JSON" on
// DuctTape.io: validates it against the diagram format and arranges the nodes.
// No dependencies; needs Node.js 18 or later.
//
//   node prepare-diagram.mjs graph.json "My title.json" [--direction LR|TB]
//
// graph.json is either
//   { "nodes": [{ "id", "kind", "label"?, "vendor"?, "model"?, "description"?, "href"?, "display"? }],
//     "edges": [{ "source", "target", "label"? }] }
// or a finished diagram file (with "schemaVersion"), which is only validated.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LIMITS = { nodes: 500, edges: 1000, bytes: 512 * 1024, images: 20 };
// Shape of an address in the app's own file storage (ASSET_URL in the app).
const IMAGE_URL = /^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\/assets\/[A-Za-z0-9_-]+\.(?:png|jpg|webp|svg)$/;
const SIZE = { note: { width: 200, height: 112 } };
const DISPLAYS = ["block", "icon"];
const GAP = { rank: 64, node: 32 };

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

/** Size of a node for the layout; a component as a block or as an icon with its labels below. */
function sizeOf(n) {
  if (n.type === "note") return SIZE.note;
  if (n.display !== "icon") return { width: 200, height: n.model ? 72 : 56 };
  const label = n.label ?? kindName.get(n.kind) ?? n.kind ?? "";
  return { width: 136, height: 86 + (label.length > 16 ? 36 : 18) + (n.vendor || n.model ? 16 : 0) };
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
    if (!["aiNode", "group", "note", "imageNode"].includes(n.type)) {
      errors.push(`${at}: "type" must be aiNode, group, note or imageNode.`);
    }
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
    if (d.display !== undefined && !DISPLAYS.includes(d.display)) {
      errors.push(`${at}: "display" must be block or icon.`);
    }
    if (d.href != null && !isHttp(d.href)) errors.push(`${at}: "href" must be an http or https link.`);
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
  if (content.nodes.filter((n) => n && n.type === "imageNode").length > LIMITS.images) {
    errors.push(`More than ${LIMITS.images} images.`);
  }
  content.edges.forEach((e, i) => {
    const at = `edges[${i}]`;
    if (!e || typeof e !== "object") return errors.push(`${at}: not an object.`);
    if (!ids.has(e.source)) errors.push(`${at}: source "${e.source}" is not a node.`);
    if (!ids.has(e.target)) errors.push(`${at}: target "${e.target}" is not a node.`);
    if (e.source === e.target) errors.push(`${at}: a node cannot be connected to itself (${e.source}).`);
    if (!optStr(e.label, 200)) errors.push(`${at}: "label" is longer than 200 characters.`);
  });
}

/** Layers by longest path along the edges, then orders each layer by its neighbours. */
function layout(nodes, edges) {
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

  const size = new Map(nodes.map((n) => [n.id, sizeOf(n)]));
  const breadth = (layer) =>
    layer.reduce((sum, id) => sum + (direction === "LR" ? size.get(id).height : size.get(id).width), 0) +
    GAP.node * (layer.length - 1);
  const widest = Math.max(...layers.map(breadth), 0);
  const pos = new Map();
  let along = 0;
  for (const layer of layers) {
    let across = (widest - breadth(layer)) / 2;
    let depth = 0;
    for (const id of layer) {
      const s = size.get(id);
      pos.set(id, direction === "LR" ? { x: along, y: Math.round(across) } : { x: Math.round(across), y: along });
      across += (direction === "LR" ? s.height : s.width) + GAP.node;
      depth = Math.max(depth, direction === "LR" ? s.width : s.height);
    }
    along += depth + GAP.rank;
  }
  return pos;
}

let content;
if (input && typeof input === "object" && "schemaVersion" in input) {
  content = input;
} else if (input && Array.isArray(input.nodes)) {
  const edges = Array.isArray(input.edges) ? input.edges : [];
  const nodes = input.nodes.map((n) => ({ ...n, type: n.kind === "note" ? "note" : "aiNode" }));
  for (const n of nodes) {
    if (n.kind === "group") errors.push(`Node "${n.id}": groups are placed by hand in the editor; use a note instead.`);
    if (n.kind === "image") errors.push(`Node "${n.id}": images are uploaded in the editor and cannot be created here.`);
  }
  const known = new Set(nodes.map((n) => n.id));
  const usable = edges.filter((e) => e && known.has(e.source) && known.has(e.target) && e.source !== e.target);
  const pos = layout(nodes, usable);
  const [from, to] = direction === "LR" ? ["r", "l"] : ["b", "t"];
  content = {
    schemaVersion: 1,
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: pos.get(n.id) ?? { x: 0, y: 0 },
      ...(n.type === "note" ? SIZE.note : {}),
      data: {
        kind: n.kind,
        label: n.label ?? (n.type === "note" ? "" : (kindName.get(n.kind) ?? n.kind)),
        vendor: n.vendor ?? null,
        model: n.model ?? null,
        description: n.description ?? null,
        color: null,
        background: null,
        icon: null,
        href: n.href ?? null,
        // Only components have a second display; "block" is the default and is left out.
        ...(n.type === "aiNode" && n.display !== undefined && n.display !== "block" ? { display: n.display } : {}),
      },
    })),
    edges: edges.map((e, i) => ({
      id: `e${i + 1}`,
      source: e?.source,
      target: e?.target,
      sourceHandle: from,
      targetHandle: to,
      ...(e?.label ? { label: e.label } : {}),
      type: "smoothstep",
      markerEnd: "arrowclosed",
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
