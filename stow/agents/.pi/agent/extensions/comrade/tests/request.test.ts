// What the caller may ask of a comrade: tools under the caller's own as the ceiling, and a
// timeout a timer can hold.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Tool } from "../../test/fake-pi.ts";
import { fixture } from "./fixture.ts";

type Result = Awaited<ReturnType<Tool["execute"]>>;

/** The tools the stand-in's Pi was started with. */
const toolsOf = (result: Result) => {
  const [first] = result.content;
  assert(first?.type === "text");
  const { args } = JSON.parse(first.text.replace(/\n\n\[comrade #\d+: [^\n]*\]$/, "")) as {
    args: string[];
  };
  return args[args.indexOf("--tools") + 1];
};

test("a pattern gives a comrade the active tools it matches, each by name", async (t) => {
  const { call } = fixture(t, "echo", { inactive: ["bash", "ls"] });
  const tools = async (asked: string[]) => toolsOf(await call({ task: "x", tools: asked }));
  // Passed on as a pattern, the comrade's Pi would match its own tools, bash and ls among them.
  assert.equal(await tools(["*"]), "read,edit,write,grep,find,codemode");
  assert.equal(await tools(["*a*"]), "read");
  // Each tool once, in the order asked, a pattern's in the order they are active.
  assert.equal(await tools(["write", "*e*", "grep"]), "write,read,edit,grep,codemode");
  await assert.rejects(call({ task: "x", tools: ["*sh"] }), /Tool "\*sh" is not active here/);
});

test("a timeout longer than a timer can hold is refused", async (t) => {
  // Starting anything would report this missing command instead of refusing.
  const { call, tool } = fixture(t, "echo", { command: "/nonexistent/pi" });
  const schema = tool.parameters as { properties: { timeout: { maximum?: number } } };
  assert.equal(schema.properties.timeout.maximum, 2_147_483);
  await assert.rejects(
    call({ task: "x", timeout: 2_147_484 }),
    /^Error: comrade's timeout is at most 2147483 seconds, about 24 days\. Leave it unset for no limit\.$/,
  );
});
