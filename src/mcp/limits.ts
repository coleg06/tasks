// The six task tools need fewer than 40 members/elements, including taskTypes.
// Bound validation work separately from bytes; both limits are required by
// https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-46jr-4wx8-v453.
export const MCP_MAX_TOOL_INPUT_ELEMENTS = 256;
export const MCP_MAX_REQUEST_BODY_SIZE = 65_536;

export async function boundedMcpRequest(request: Request): Promise<Request | null> {
  if (!request.body) return request;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > MCP_MAX_REQUEST_BODY_SIZE) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk.value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request, { body });
}
