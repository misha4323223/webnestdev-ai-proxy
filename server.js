// WebNestDev universal AI reverse proxy (Node 18+, без npm-зависимостей, SSE)
// Целевой провайдер задаётся заголовком X-AI-Proxy-Target (или env DEFAULT_TARGET).
// Ключ провайдера приходит в обычном Authorization и прокси его не хранит.

const http = require("node:http");

const PORT = Number(process.env.PORT || 1000);
const PROXY_TOKEN = (process.env.PROXY_TOKEN || "").trim();
const DEFAULT_TARGET = (process.env.DEFAULT_TARGET || "").trim();
const ALLOWED_TARGETS = (process.env.ALLOWED_TARGETS || "")
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean);
const ALLOW_HTTP_TARGETS = process.env.ALLOW_HTTP_TARGETS === "true";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers":
    "content-type, authorization, x-ai-proxy-target, x-proxy-token, proxy-token",
};

const DROP_REQ = new Set([
  "host", "connection", "content-length", "transfer-encoding",
  "accept-encoding", "x-proxy-token", "proxy-token", "x-ai-proxy-target",
]);

const DROP_RES = new Set([
  "connection", "keep-alive", "transfer-encoding", "content-length",
  "content-encoding", "proxy-authenticate", "proxy-authorization", "te", "trailer", "upgrade",
]);

function sendJson(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...CORS });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(chunks.length ? Buffer.concat(chunks) : undefined));
    req.on("error", reject);
  });
}

function targetAllowed(url) {
  if (!ALLOWED_TARGETS.length) return true;
  const origin = url.origin;
  const href = url.href.replace(/\/+$/, "");
  return ALLOWED_TARGETS.some((t) => href === t || href.startsWith(t + "/") || origin === t);
}

// Если target уже содержит /v1, а путь запроса тоже начинается с /v1 — убираем дубль
function buildUpstream(targetBase, reqUrl) {
  let up = targetBase.replace(/\/+$/, "") + reqUrl;
  up = up.replace(/\/v1\/v1\//g, "/v1/").replace(/\/v1\/v1$/, "/v1");
  return up;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      res.end();
      return;
    }

    if (req.url === "/health" || req.url === "/health/") {
      sendJson(res, 200, {
        ok: true,
        mode: "universal-ai-proxy",
        defaultTarget: DEFAULT_TARGET || null,
        allowedTargets: ALLOWED_TARGETS.length ? ALLOWED_TARGETS : ["*"],
        tokenConfigured: Boolean(PROXY_TOKEN),
      });
      return;
    }

    if (PROXY_TOKEN) {
      const token = req.headers["x-proxy-token"] || req.headers["proxy-token"] || "";
      if (String(token) !== PROXY_TOKEN) {
        sendJson(res, 401, { error: "invalid proxy token", hint: "send X-Proxy-Token header" });
        return;
      }
    }

    const targetBase = (req.headers["x-ai-proxy-target"] || DEFAULT_TARGET || "").trim();
    if (!targetBase) {
      sendJson(res, 400, {
        error: "missing target",
        hint: "send X-AI-Proxy-Target header or set DEFAULT_TARGET",
      });
      return;
    }

    let targetUrl;
    try {
      targetUrl = new URL(targetBase);
    } catch {
      sendJson(res, 400, { error: "invalid target url", target: targetBase });
      return;
    }

    if (targetUrl.protocol !== "https:" && !ALLOW_HTTP_TARGETS) {
      sendJson(res, 400, { error: "target must be https", target: targetBase });
      return;
    }

    if (!targetAllowed(targetUrl)) {
      sendJson(res, 403, { error: "target not allowed", origin: targetUrl.origin, allowedTargets: ALLOWED_TARGETS });
      return;
    }

    const upstreamUrl = buildUpstream(targetUrl.origin + targetUrl.pathname, req.url || "/");

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!DROP_REQ.has(k.toLowerCase())) headers[k] = v;
    }
    headers["accept-encoding"] = "identity";

    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);

    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body,
      redirect: "follow",
    });

    const outHeaders = {};
    for (const [k, v] of upstream.headers.entries()) {
      if (!DROP_RES.has(k.toLowerCase())) outHeaders[k] = v;
    }
    res.writeHead(upstream.status, { ...outHeaders, ...CORS });

    if (!upstream.body) {
      res.end();
      return;
    }

    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    console.error("proxy error:", err && err.stack ? err.stack : err);
    if (!res.headersSent) {
      sendJson(res, 502, { error: "proxy error", detail: String((err && err.message) || err) });
    }
    res.end();
  }
});

server.listen(PORT, () => {
  console.log("universal AI proxy listening on " + PORT);
  if (!PROXY_TOKEN) console.warn("WARN: PROXY_TOKEN empty - proxy is public. Set it in Render.");
});
