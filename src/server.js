import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { AgentService } from "./service.js";

const root = dirname(fileURLToPath(import.meta.url));
export const LOCAL_HOST = "127.0.0.1";

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

function isProtectedMutation(req) {
  return req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE";
}

/**
 * Browser requests carry an Origin header even for simple cross-origin POSTs.
 * Accept only the origin that served this Desktop, while retaining support for
 * non-browser local clients and the existing service integration seam that has
 * no Origin header.
 */
function loopbackHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

export function isAllowedLocalOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (origin === "null") return false;
  try {
    if (!req.headers.host) return false;
    const parsed = new URL(origin);
    const requestUrl = new URL(`http://${req.headers.host}`);
    const requestHost = requestUrl.hostname;
    const requestPort = req.socket?.localPort ?? Number(requestUrl.port || 80);
    return parsed.protocol === "http:"
      && loopbackHost(parsed.hostname)
      && parsed.hostname === requestHost
      && Number(parsed.port || 80) === Number(requestPort);
  } catch {
    return false;
  }
}

function controlPlaneDenied(res) {
  return json(res, 403, { error: "This local control operation is only available to the pi-sand Desktop." });
}

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
      if (isProtectedMutation(req) && !isAllowedLocalOrigin(req)) return controlPlaneDenied(res);
      if (req.method === "GET" && parts.length === 2 && parts[1] === "health") return json(res, 200, { status: "ok" });
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
  service = new AgentService(),
} = {}) {
  const server = createAgentServer(service);
  server.listen(port, LOCAL_HOST, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`pi-sand listening on http://${LOCAL_HOST}:${actualPort}`);
  });
  return { server, service };
}

const invokedPath = process.argv[1] && resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) startServer();
