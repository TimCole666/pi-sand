import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AgentService } from "./service.js";

const root = dirname(fileURLToPath(import.meta.url));
const service = new AgentService({ dbPath: process.env.PI_SAND_DB ?? join(root, "..", "pi-sand.sqlite") });
const clients = new Map();

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}
async function body(req) {
  let text = ""; for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : {};
}
function route(pathname) { return pathname.split("/").filter(Boolean); }

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const parts = route(url.pathname);
    if (req.method === "GET" && pathnameIsStatic(url.pathname)) {
      const path = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = join(root, "../public", path);
      const content = await readFile(file);
      res.writeHead(200, { "content-type": path.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain" }); res.end(content); return;
    }
    if (parts[0] !== "api") return json(res, 404, { error: "not found" });
    if (req.method === "GET" && parts.length === 2 && parts[1] === "agents") return json(res, 200, service.listAgents());
    if (req.method === "POST" && parts.length === 2 && parts[1] === "agents") return json(res, 201, service.createAgent(await body(req)));
    if (parts[1] !== "agents" || !parts[2]) return json(res, 404, { error: "not found" });
    const agentId = parts[2];
    if (req.method === "GET" && parts.length === 3) {
      const snapshot = service.getAgent(agentId); return snapshot ? json(res, 200, snapshot) : json(res, 404, { error: "agent not found" });
    }
    if (req.method === "POST" && parts[3] === "turns" && parts.length === 4) return json(res, 201, service.sendMessage(agentId, (await body(req)).message));
    if (req.method === "POST" && parts[3] === "interrupt" && parts.length === 4) return json(res, 200, service.interrupt(agentId, (await body(req)).turnId));
    if (req.method === "GET" && parts[3] === "events" && parts.length === 4) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      // Subscribe before taking the snapshot so a turn update cannot land in the
      // gap between reconnect's snapshot request and event subscription. The
      // snapshot is authoritative; the desktop replaces its view with each
      // snapshot rather than appending replayed events.
      const send = (event) => {
        if (!res.writableEnded) {
          if (event.id) res.write(`id: ${event.id}\n`);
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      };
      const unsubscribe = service.subscribe(agentId, send);
      send({ type: "snapshot", snapshot: service.getAgent(agentId) });
      req.on("close", () => unsubscribe());
      return;
    }
    return json(res, 404, { error: "not found" });
  } catch (error) { json(res, error.message === "agent not found" ? 404 : 400, { error: error.message }); }
});

function pathnameIsStatic(pathname) { return pathname === "/" || pathname.startsWith("/index.html"); }
const port = Number(process.env.PORT ?? 4317);
if (process.env.NODE_ENV !== "test") server.listen(port, "127.0.0.1", () => console.log(`pi-sand listening on http://127.0.0.1:${port}`));
export { server, service };
