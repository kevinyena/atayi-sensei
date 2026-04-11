/**
 * JSON / error response helpers + CORS.
 */

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Visitor-Id",
  "Access-Control-Max-Age": "86400",
};

export function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

export function errorResponse(errorCode: string, message: string, status = 400, extraFields: Record<string, unknown> = {}): Response {
  return jsonResponse(
    {
      error: errorCode,
      message,
      ...extraFields,
    },
    status,
  );
}

export function corsPreflightResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

export function notFoundResponse(): Response {
  return errorResponse("not_found", "Route not found", 404);
}

export function methodNotAllowedResponse(): Response {
  return errorResponse("method_not_allowed", "Method not allowed", 405);
}
