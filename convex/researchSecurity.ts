export function strongResearchSecret(value: string | undefined): value is string {
  return value !== undefined && /^[A-Za-z0-9_-]{32,256}$/.test(value);
}

export function authorizedResearchRequest(request: Request, configured: string | undefined): boolean {
  if (!strongResearchSecret(configured)) return false;
  const header = request.headers.get("authorization");
  if (!header || header.length > 512 || !header.startsWith("Bearer ")) return false;
  const supplied = header.slice(7);
  let difference = configured.length ^ supplied.length;
  for (let index = 0; index < configured.length; index++) difference |= configured.charCodeAt(index) ^ (supplied.charCodeAt(index) || 0);
  return difference === 0;
}
