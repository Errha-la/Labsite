const API_PREFIX = "/api";
const CONTACT_PATH = "/api/contact";

function jsonResponse(body, status, headers = {}) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

function isApiPath(pathname) {
  return pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === CONTACT_PATH) {
      if (request.method !== "POST") {
        return jsonResponse(
          { error: "method_not_allowed" },
          405,
          { Allow: "POST" },
        );
      }

      return jsonResponse({ error: "not_implemented" }, 501);
    }

    if (isApiPath(pathname)) {
      return jsonResponse({ error: "not_found" }, 404);
    }

    return env.ASSETS.fetch(request);
  },
};
