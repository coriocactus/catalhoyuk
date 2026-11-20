// Pi's MCP extension gives every MCP tool renderers of its own, registered or not, and loads after
// user extensions, so its resolver comes after mirage's. Mirage draws MCP tools all the same.
import assert from "node:assert/strict";
import { test } from "node:test";
import { piModule } from "../../test/pi.ts";
import { assistant } from "../../test/transcript.ts";
import { fixture, plain, result } from "./fixture.ts";

type McpTools = typeof import("@earendil-works/pi-coding-agent/dist/extensions/mcp/tools.js");
const { createMcpToolRenderers } = await piModule<McpTools>("dist/extensions/mcp/tools.js");

/** Mirage beside Pi's MCP extension, whose resolver is the one in its dist/extensions/mcp. */
async function withMcp() {
  const f = await fixture();
  f.pi.api.registerToolRenderer((name, next) => {
    const match = /^mcp__(.+?)__(.+)$/.exec(name);
    return next() ?? (match ? createMcpToolRenderers(`${match[1]}/${match[2]}`) : undefined);
  });
  return f;
}

test("mirage draws an MCP server's tool, though Pi's MCP extension gives it renderers", async () => {
  const f = await withMcp();
  const read = f.call("read", "read", { path: "a.ts" });
  read.result(result("x"));
  const search = f.call("mcp__docs__search", "search", { query: "auth bug" });
  search.result(result('{"hits":[]}'));
  assert.equal(plain(read.view), "✓ Read 1 file, called 1 docs tool ▸");
  assert.equal(plain(search.view), "", "its group draws it, at the group's first call");
  // The renderers of an MCP tool Pi has registered are the MCP extension's too.
  const own = createMcpToolRenderers("docs/search");
  assert.notEqual(
    f.pi.renderers("mcp__docs__search", () => own),
    own,
  );
});

test("an MCP call joins its group as soon as it is seen, before Pi resolves its renderers", async () => {
  const f = await withMcp();
  const read = f.call("read", "read", { path: "a.ts" });
  const call = { type: "toolCall" as const, id: "fetch", name: "mcp__docs__fetch", arguments: {} };
  await f.pi.event("message_end", { message: assistant("", [call]) }, f.ctx);
  assert.equal(plain(read.view), "… Reading 1 file, calling 1 docs tool ▸");
});
