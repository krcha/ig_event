/** The handler offers identity JSON. The HTTP transport can encode it for the client. */
function acceptsIdentity(value: string | null): boolean {
  if (!value?.trim()) return true;
  let identity: number | undefined;
  let wildcard: number | undefined;
  for (const entry of value.toLowerCase().split(",")) {
    const [name, ...parameters] = entry.split(";").map(part => part.trim());
    if (name !== "identity" && name !== "*") continue;
    const quality = parameters.find(part => part.startsWith("q="));
    const weight = quality === undefined ? 1 : Number(quality.slice(2));
    const accepted = Number.isFinite(weight) && weight >= 0 && weight <= 1 ? weight : 0;
    if (name === "identity") identity = accepted;
    else wildcard = accepted;
  }
  return identity !== undefined ? identity > 0 : wildcard !== 0;
}

export function publicJsonResponse(data: unknown, requestHeaders: Headers, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  const vary = (headers.get("Vary") ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (!vary.some(value => value.toLowerCase() === "accept-encoding" || value === "*")) vary.push("Accept-Encoding");
  headers.set("Vary", vary.join(", "));
  if (!acceptsIdentity(requestHeaders.get("accept-encoding"))) {
    return new Response(null, { ...init, status: 406, headers });
  }
  // Next strips Content-Encoding from App Router responses. The HTTP server encodes the body and sets its matching header.
  return Response.json(data, { ...init, headers });
}
