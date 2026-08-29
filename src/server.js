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

async function rawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? "");
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary) throw new Error("attachment upload boundary is missing");
  const marker = Buffer.from(`--${boundary}`);
  let cursor = 0;
  while (true) {
    const start = buffer.indexOf(marker, cursor);
    if (start < 0) break;
    const contentStart = start + marker.length;
    if (buffer.subarray(contentStart, contentStart + 2).toString() === "--") break;
    const partStart = contentStart + 2;
    const next = buffer.indexOf(marker, partStart);
    if (next < 0) break;
    const part = buffer.subarray(partStart, Math.max(partStart, next - 2));
    const separator = part.indexOf(Buffer.from("\r\n\r\n"));
    if (separator >= 0) {
      const headers = part.subarray(0, separator).toString("utf8");
      const disposition = /content-disposition:[^\r\n]*name="[^"]*"[^\r\n]*filename="([^"]*)"/i.exec(headers);
      if (disposition) {
        const mediaType = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim() || "application/octet-stream";
        return { filename: disposition[1], contentType: mediaType, bytes: part.subarray(separator + 4) };
      }
    }
    cursor = next;
  }
  throw new Error("attachment file is required");
}

async function attachmentBody(req) {
  const contentType = req.headers["content-type"] ?? "";
  if (contentType.toLowerCase().startsWith("multipart/form-data")) return parseMultipart(await rawBody(req), contentType);
  const value = await body(req);
  const bytes = Array.isArray(value.bytes)
    ? Buffer.from(value.bytes)
    : typeof value.bytes === "string" ? Buffer.from(value.bytes, value.encoding === "utf8" ? "utf8" : "base64")
      : typeof value.content === "string" ? Buffer.from(value.content, value.encoding === "base64" ? "base64" : "utf8")
        : Buffer.alloc(0);
  return { filename: value.filename, contentType: value.contentType, bytes };
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
export function createAgentServer(service, { getService = () => service } = {}) {
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
      const currentService = getService();
      if (req.method === "GET" && parts.length === 2 && parts[1] === "health") {
        return currentService ? json(res, 200, { status: "ok" }) : json(res, 503, { status: "error", error: "The Local Agent Service is unavailable. Retry when it is available." });
      }
      if (!currentService) return json(res, 503, { error: "The Local Agent Service is unavailable. Retry when it is available." });
      if (req.method === "GET" && parts.length === 2 && parts[1] === "agents") return json(res, 200, currentService.listAgents());
      if (req.method === "POST" && parts.length === 2 && parts[1] === "agents") return json(res, 201, currentService.createAgent(await body(req)));
      if (parts[1] !== "agents" || !parts[2]) return json(res, 404, { error: "not found" });
      const agentId = parts[2];
      if (req.method === "GET" && parts.length === 3) {
        const snapshot = currentService.getAgent(agentId);
        return snapshot ? json(res, 200, snapshot) : json(res, 404, { error: "agent not found" });
      }
      if (req.method === "GET" && parts[3] === "attachments" && parts.length === 4) {
        return json(res, 200, currentService.listAttachments(agentId));
      }
      if (req.method === "POST" && parts[3] === "attachments" && parts.length === 4) {
        return json(res, 201, { attachment: currentService.stageAttachment(agentId, await attachmentBody(req)) });
      }
      if (req.method === "DELETE" && parts[3] === "attachments" && parts.length === 5) {
        return json(res, 200, { attachment: currentService.releaseAttachment(agentId, parts[4]) });
      }
      if (req.method === "POST" && parts[3] === "turns" && parts.length === 4) {
        const request = await body(req);
        return json(res, 201, currentService.sendMessage(agentId, request.message, { attachments: request.attachments }));
      }
      if (req.method === "POST" && parts[3] === "interrupt" && parts.length === 4) return json(res, 200, currentService.interrupt(agentId, (await body(req)).turnId));
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
        const unsubscribe = currentService.subscribe(agentId, send);
        const unsubscribeRoster = currentService.subscribeRoster(send);
        send({ type: "roster_updated", roster: currentService.listAgents() });
        send({ type: "snapshot", snapshot: currentService.getAgent(agentId) });
        req.on("close", () => { unsubscribe(); unsubscribeRoster(); });
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
  service,
} = {}) {
  let runningService = service;
  let startupError = null;
  const getService = () => {
    if (runningService) return runningService;
    try {
      runningService = new AgentService();
      startupError = null;
    } catch (error) {
      startupError = error;
    }
    return runningService;
  };
  const server = createAgentServer(runningService, { getService });
  server.listen(port, LOCAL_HOST, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    const suffix = startupError ? " (Local Agent Service unavailable; Desktop Retry is available)" : "";
    console.log(`pi-sand listening on http://${LOCAL_HOST}:${actualPort}${suffix}`);
  });
  return {
    server,
    get service() { return runningService; },
    get startupError() { return startupError; },
  };
}

const invokedPath = process.argv[1] && resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const runtime = startServer();
  const shutdown = () => {
    runtime.service?.close();
    runtime.server.close(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
