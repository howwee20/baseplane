import http from "node:http";
import fs from "node:fs";
import { authorizeAgentRequest } from "../../packages/agent-gateway/index.js";

const graphPath = process.env.BASEPLANE_GRAPH || "examples/generic-telemetry/baseplane.json";
const port = Number(process.env.PORT || 8787);

function readGraph() {
  return JSON.parse(fs.readFileSync(graphPath, "utf8"));
}

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    return send(response, 200, { ok: true, service: "baseplane-agent-gateway" });
  }

  if (request.method === "POST" && request.url === "/v1/authorize") {
    try {
      const body = await readJson(request);
      const result = authorizeAgentRequest(readGraph(), body);
      return send(response, result.decision === "ALLOW" ? 200 : 403, result);
    } catch (error) {
      return send(response, 400, { error: error.message });
    }
  }

  send(response, 404, { error: "not found" });
});

server.listen(port, () => {
  console.log(`Baseplane Agent Gateway listening on :${port}`);
});

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error("request too large"));
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    request.on("error", reject);
  });
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}
