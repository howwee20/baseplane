import { createControlApiHandler } from "../runtime/control-api/server.js";

let handler;

export default function atollControlApi(request, response) {
  try {
    handler = handler || createControlApiHandler();
    return handler(request, response);
  } catch (error) {
    response.statusCode = 500;
    response.setHeader("content-type", "application/json; charset=utf-8");
    return response.end(JSON.stringify({
      error: "control_api_not_configured",
      message: error.message
    }));
  }
}
