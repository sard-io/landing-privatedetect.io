// figma-save.mjs — download Figma node renders straight to PNG files via the bridge.
//
// No dependencies: uses the built-in global WebSocket (Node 22+ or Bun) and node:fs.
// Works locally or through a Cloudflare tunnel. Bypasses the REST /v1/images rate limit
// (renders happen inside the Figma plugin), and — unlike the MCP export_node_as_image
// tool — writes the image to disk instead of returning base64 inline.
//
// Usage:
//   node figma-save.mjs [options] <nodeId> [<nodeId> ...]
//
// Options:
//   --server=<host|url>  default ws://localhost:3055
//                        bare host  -> wss://host        (e.g. a *.trycloudflare.com tunnel)
//                        localhost  -> ws://localhost:3055
//                        ws://..    / wss://.. used as-is
//   --channel=<name>     default: figma
//   --scale=<n>          default: 2
//   --out=<dir>          default: current directory
//   --retries=<n>        default: 3   (export sometimes times out; retry helps)
//
// Node id may be "15:6239" or the URL form "15-6239" (copied from ?node-id=15-6239).
//
// Examples:
//   node figma-save.mjs 15-6239 15-6478
//   node figma-save.mjs --server=smile-reward-washer-locate.trycloudflare.com --out=shots 15-6239

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opts = { server: "ws://localhost:3055", channel: "figma", scale: 2, out: ".", retries: 3 };
const nodes = [];
for (const a of argv) {
  if (a.startsWith("--")) {
    const [k, v] = a.slice(2).split("=");
    if (k === "scale" || k === "retries") opts[k] = Number(v);
    else if (k in opts) opts[k] = v;
  } else {
    nodes.push(a.includes(":") ? a : a.replace(/^(\d+)-(\d+)$/, "$1:$2"));
  }
}

if (nodes.length === 0) {
  console.error("usage: node figma-save.mjs [--server=host] [--channel=figma] [--scale=2] [--out=dir] <nodeId> [<nodeId> ...]");
  process.exit(1);
}

function resolveUrl(s) {
  if (s.includes("://")) return s;
  if (s === "localhost" || s.startsWith("localhost:")) return `ws://${s.includes(":") ? s : "localhost:3055"}`;
  return `wss://${s}`;
}
const url = resolveUrl(opts.server);
mkdirSync(opts.out, { recursive: true });

const uuid = () =>
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });

console.log(`Connecting ${url} | channel "${opts.channel}" | ${nodes.length} node(s) | scale ${opts.scale}`);
const ws = new WebSocket(url);
const pending = new Map(); // cmdId -> { resolve, reject, timer }
let joinedResolve;
const joined = new Promise((r) => (joinedResolve = r));

ws.addEventListener("message", (ev) => {
  let d;
  try { d = JSON.parse(ev.data); } catch { return; }
  if (typeof d.message === "string" && d.message.includes("Joined channel")) { joinedResolve(); return; }
  const m = d.message;
  if (m && typeof m === "object" && m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    if (m.result && m.result.imageData) { clearTimeout(p.timer); pending.delete(m.id); p.resolve(m.result); }
    else if (m.error) { clearTimeout(p.timer); pending.delete(m.id); p.reject(new Error(String(m.error))); }
  }
});
ws.addEventListener("error", (e) => { console.error("WS error:", e.message || e); process.exit(2); });

function sendCommand(command, params) {
  return new Promise((resolve, reject) => {
    const id = uuid();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("timeout")); }, 30000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ type: "message", channel: opts.channel, id, message: { id, command, params } }));
  });
}

await new Promise((r) => (ws.readyState === 1 ? r() : ws.addEventListener("open", r, { once: true })));
ws.send(JSON.stringify({ type: "join", channel: opts.channel, id: uuid() }));
await joined;

let ok = 0;
for (const node of nodes) {
  let saved = false;
  for (let attempt = 1; attempt <= opts.retries && !saved; attempt++) {
    try {
      const res = await sendCommand("export_node_as_image", { nodeId: node, scale: opts.scale });
      const buf = Buffer.from(res.imageData, "base64");
      const fpath = join(opts.out, node.replace(/[:;/\\]/g, "-") + ".png");
      writeFileSync(fpath, buf);
      console.log(`  saved ${fpath} (${buf.length} bytes)`);
      saved = true;
      ok++;
    } catch (e) {
      console.error(`  ${node}: attempt ${attempt}/${opts.retries} failed (${e.message})`);
      if (attempt < opts.retries) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (!saved) console.error(`  ! ${node}: gave up`);
}

console.log(`Done: ${ok}/${nodes.length} saved to ${opts.out}`);
ws.close();
process.exit(ok === nodes.length ? 0 : 1);
