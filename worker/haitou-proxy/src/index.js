export default {
  async fetch(request) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "*",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    const target = new URL(request.url).searchParams.get("url");
    if (!target) {
      return new Response("missing url", { status: 400, headers: cors });
    }

    let allowed;
    try {
      allowed = new URL(target).hostname.endsWith("finance.yahoo.co.jp");
    } catch (e) {
      return new Response("bad url", { status: 400, headers: cors });
    }
    if (!allowed) {
      return new Response("forbidden host", { status: 403, headers: cors });
    }

    try {
      const upstream = await fetch(target, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; haitou/1.0)",
          "Accept-Language": "ja,en;q=0.8",
        },
        cf: { cacheTtl: 300, cacheEverything: true },
      });
      const body = await upstream.text();
      return new Response(body, {
        status: upstream.status,
        headers: { ...cors, "Content-Type": "text/html; charset=utf-8" },
      });
    } catch (e) {
      return new Response("fetch failed: " + e.message, { status: 502, headers: cors });
    }
  },
};
