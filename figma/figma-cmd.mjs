// figma-cmd.mjs - talk to Figma through the bridge WITHOUT the MCP server.
//
// Sends any plugin command over the WebSocket relay and writes the JSON result
// to a file (or stdout). No dependencies: built-in global WebSocket (Node 22+/Bun).
// Works locally or through a Cloudflare tunnel.
//
// Single command:
//   node figma-cmd.mjs <command> [--params='{...}'] [--out=result.json] [--server=host] [--channel=figma]
//
// Batch (many requests from one file -> many result files):
//   node figma-cmd.mjs --batch=requests.json [--server=host] [--channel=figma]
//   where requests.json is a JSON array like:
//   [
//     { "command": "get_document_info", "out": "out/doc.json" },
//     { "command": "get_node_info", "params": { "nodeId": "351:5563" }, "out": "out/banner.json" }
//   ]
//
// Read commands (return JSON info):
//   get_document_info                              whole document / pages
//   get_pages_info     {includeTopLevelChildren?}  all pages + top-level nodes
//   get_selection                                  current selection
//   get_node_info      {nodeId}                    one node, full REST-shaped JSON
//   get_nodes_info     {nodeIds:[...]}             several nodes
//   read_my_design                                 detailed dump of current selection
//   get_styles                                     color/text/effect styles
//   get_local_components                           local components
//   get_annotations    {nodeId?, includeCategories?}
//   scan_text_nodes    {nodeId}                    all text under a node (chunked)
//   scan_nodes_by_types{nodeId, types:[...]}       find nodes by type
//   scan_all_pages_by_types{types:[...]}           find nodes by type across all pages
//   get_reactions      {nodeIds:[...]}             prototype reactions
//   get_instance_overrides {nodeId?}
// For rendered PNGs use figma-save.mjs instead (export_node_as_image returns base64).
//
// Params note: pass JSON with --params='{"nodeId":"351:5563"}' (mind shell quoting),
// or put it in a file and use --params-file=path.json.

import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const argv = process.argv.slice(2);
const opts = { server: "ws://localhost:3055", channel: "figma", timeout: 30000, out: null, params: null, "params-file": null, batch: null };
let command = null;
for (const a of argv) {
  if (a.startsWith("--")) {
    const i = a.indexOf("=");
    const k = i === -1 ? a.slice(2) : a.slice(2, i);
    const v = i === -1 ? "true" : a.slice(i + 1);
    if (k in opts) opts[k] = (k === "timeout") ? Number(v) : v;
  } else if (!command) {
    command = a;
  }
}

if (!command && !opts.batch) {
  console.error("usage: node figma-cmd.mjs <command> [--params='{...}'] [--out=file.json] [--server=host] [--channel=figma]");
  console.error("   or: node figma-cmd.mjs --batch=requests.json");
  console.error("run with a command like get_document_info; see the header of this file for the full list.");
  process.exit(1);
}

function resolveUrl(s) {
  if (s.includes("://")) return s;
  if (s === "localhost" || s.startsWith("localhost:")) return `ws://${s.includes(":") ? s : "localhost:3055"}`;
  return `wss://${s}`;
}
const url = resolveUrl(opts.server);
const uuid = () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 0x3) | 0x8).toString(16); });

// build the work list
let work;
if (opts.batch) {
  work = JSON.parse(readFileSync(opts.batch, "utf8"));
  if (!Array.isArray(work)) { console.error("--batch file must be a JSON array"); process.exit(1); }
} else {
  let params = {};
  if (opts["params-file"]) params = JSON.parse(readFileSync(opts["params-file"], "utf8"));
  else if (opts.params) params = JSON.parse(opts.params);
  work = [{ command, params, out: opts.out }];
}

console.error(`Connecting ${url} | channel "${opts.channel}" | ${work.length} request(s)`);
const ws = new WebSocket(url);
const pending = new Map();
let joinedResolve;
const joined = new Promise((r) => (joinedResolve = r));

ws.addEventListener("message", (ev) => {
  let d; try { d = JSON.parse(ev.data); } catch { return; }
  if (typeof d.message === "string" && d.message.includes("Joined channel")) { joinedResolve(); return; }
  const m = d.message;
  if (m && typeof m === "object" && m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    if (m.error) { clearTimeout(p.timer); pending.delete(m.id); p.reject(new Error(typeof m.error === "string" ? m.error : JSON.stringify(m.error))); }
    else if (m.result !== undefined) { clearTimeout(p.timer); pending.delete(m.id); p.resolve(m.result); }
  }
});
ws.addEventListener("error", (e) => { console.error("WS error:", e.message || e); process.exit(2); });

function sendCommand(cmd, params) {
  return new Promise((resolve, reject) => {
    const id = uuid();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("timeout")); }, opts.timeout);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ type: "message", channel: opts.channel, id, message: { id, command: cmd, params: params || {} } }));
  });
}

await new Promise((r) => (ws.readyState === 1 ? r() : ws.addEventListener("open", r, { once: true })));
ws.send(JSON.stringify({ type: "join", channel: opts.channel, id: uuid() }));
await joined;

let ok = 0;
for (const item of work) {
  const label = item.command + (item.params ? " " + JSON.stringify(item.params) : "");
  try {
    const res = await sendCommand(item.command, item.params);
    const json = JSON.stringify(res, null, 2);
    if (item.out) {
      mkdirSync(dirname(item.out) || ".", { recursive: true });
      writeFileSync(item.out, json);
      console.error(`  ok  ${label} -> ${item.out} (${json.length} bytes)`);
    } else {
      process.stdout.write(json + "\n");
      console.error(`  ok  ${label}`);
    }
    ok++;
  } catch (e) {
    console.error(`  ERR ${label}: ${e.message}`);
  }
}

console.error(`Done: ${ok}/${work.length}`);
ws.close();
process.exit(ok === work.length ? 0 : 1);
