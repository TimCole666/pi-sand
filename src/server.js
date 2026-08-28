import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { AgentService } from "./service.js";

const root = dirname(fileURLToPath(import.meta.url));

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

async function body(req) {
  let text = "";
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : {};
}

function route(pathname) { return pathname.split("/").filter(Boolean); }
function pathnameIsStatic(pathname) { return pathname === "/" || pathname === "/index.html" || pathname === "/app.js"; }

/**
 * The semantic local Desktop boundary. Tests inject a deterministic service;
 * the executable entrypoint below constructs the production service.
 */
export function createAgentServer(service) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const parts = route(url.pathname);
      if (req.method === "GET" && pathnameIsStatic(url.pathname)) {
        const path = url.pathname === "/" ? "/index.html" : url.pathname;
        const file = join(root, "../public", path);
        const content = await readFile(file);
        res.writeHead(200, { "content-type": path.endsWith(".html") ? "text/html; charset=utf-8" : path.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/plain" });
        res.end(content);
        return;
      }
      if (parts[0] !== "api") return json(res, 404, { error: "not found" });
      if (req.method === "GET" && parts.length === 2 && parts[1] === "agents") return json(res, 200, service.listAgents());
      if (req.method === "POST" && parts.length === 2 && parts[1] === "agents") return json(res, 201, service.createAgent(await body(req)));
      if (parts[1] !== "agents" || !parts[2]) return json(res, 404, { error: "not found" });
      const agentId = parts[2];
      if (req.method === "GET" && parts.length === 3) {
        const snapshot = service.getAgent(agentId);
        return snapshot ? json(res, 200, snapshot) : json(res, 404, { error: "agent not found" });
      }
      if (req.method === "POST" && parts[3] === "turns" && parts.length === 4) return json(res, 201, service.sendMessage(agentId, (await body(req)).message));
      if (req.method === "POST" && parts[3] === "interrupt" && parts.length === 4) return json(res, 200, service.interrupt(agentId, (await body(req)).turnId));
      if (req.method === "GET" && parts[3] === "events" && parts.length === 4) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        // Subscribe before taking the snapshot so a turn update cannot land in
        // the reconnect gap. Each Desktop render replaces itself from the
        // authoritative snapshot instead of appending replayed messages.
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
    } catch (error) {
      return json(res, error.message === "agent not found" ? 404 : 400, { error: error.message });
    }
  });
}

export function startServer({
  port = Number(process.env.PORT ?? 4317),
  service = new AgentService({ dbPath: process.env.PI_SAND_DB ?? join(root, "..", "pi-sand.sqlite") }),
} = {}) {
  const server = createAgentServer(service);
  server.listen(port, "127.0.0.1", () => console.log(`pi-sand listening on http://127.0.0.1:${port}`));
  return { server, service };
}

const invokedPath = process.argv[1] && resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) startServer();
