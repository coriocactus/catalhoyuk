// Comrade in a real Pi session: Pi's own extension loader, tool pipeline, codemode, and message
// delivery, with an offline model as the caller and the stand-in as each comrade's Pi.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { load } from "../../test/pi.ts";
import { ai, script, scriptReturns, startSession, until, userTexts } from "../../test/session.ts";
import { standIn } from "./fixture.ts";

const { register } = await load<typeof import("../index.ts")>("../index.ts", import.meta.url);

/** Comrade, whose comrades the stand-in runs, each playing the scenario named when it starts. */
const comrade = (scenario: { name: string }) => (pi: ExtensionAPI) =>
  register(pi, () => ({ command: process.execPath, args: [standIn, scenario.name] }));

test("a codemode script reads a comrade's run as fields, and its failure too", async (t) => {
  const scenario = { name: "echo" };
  let api: ExtensionAPI | undefined;
  const { session, model } = await startSession(t, {
    codemode: true,
    factories: [
      comrade(scenario),
      (pi) => {
        api = pi;
      },
    ],
  });
  model.setResponses([
    script(`return await tools.comrade({ title: "Echo", task: "Say what reached you" });`),
    () => {
      scenario.name = "error";
      return script(`return await tools.comrade({ title: "Fail", task: "Fail at once" });`);
    },
    script(
      `try { await tools.comrade({ title: "Bad", task: "x", model: "nowhere/none" }); return {}; }
       catch (error) { return { rejected: error.message }; }`,
    ),
    script(`return await tools.comrades({ stop: [9] });`),
    script(`return { declaration: await describeTool("comrade") };`),
    ai.fauxAssistantMessage("Done."),
  ]);
  await session.prompt("Run the comrades");
  const [finished, failed, refused, stop, described] = scriptReturns(session) as Record<
    string,
    unknown
  >[];

  assert.equal(finished.number, 1);
  assert.equal(finished.ending, "finished");
  assert.equal(JSON.parse(String(finished.answer)).task, "Say what reached you");
  assert.equal(finished.error, undefined);
  assert.equal(typeof finished.cost, "number");
  assert.equal(typeof finished.seconds, "number");
  // A failed run resolves, as Pi's codemode resolves any tool that returns its fields.
  assert.deepEqual(
    { ...failed, seconds: undefined },
    {
      number: 2,
      ending: "failed",
      answer: "",
      error: "529 overloaded",
      cost: 0.011,
      seconds: undefined,
    },
  );
  // A call Comrade refuses before any run rejects, with the refusal.
  assert.match(String(refused.rejected), /nowhere\/none/);
  assert.deepEqual(stop, { stopped: [], missing: [9] });
  // What a script's author reads of what the call resolves to.
  const declaration = String(described.declaration);
  assert.match(
    declaration,
    /\n {2}ending: "finished" \| "partial" \| "timed out" \| "failed" \| "stopped";\n/,
  );
  assert.match(declaration, /\n {2}background: true;\n/);
  assert.match(declaration, /\n {2}steered: true;\n/);
  // The hints Pi reports to an extension that confirms calls before they run.
  const hints = (name: string) =>
    api?.getAllTools().find((tool) => tool.name === name)?.annotations;
  assert.deepEqual(hints("comrade"), {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });
  assert.deepEqual(hints("comrades"), {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
});

test("a background answer arrives after the caller settles, starts a turn, and arrives once", async (t) => {
  const { session, model, cwd } = await startSession(t, {
    factories: [comrade({ name: "gated" })],
  });
  const gate = join(cwd, "gate");
  const requests: Message[][] = [];
  const reply = (text: string) => (context: { messages: Message[] }) => {
    requests.push(context.messages);
    return ai.fauxAssistantMessage(text);
  };
  model.setResponses([
    ai.fauxAssistantMessage(
      ai.fauxToolCall("comrade", { title: "Wait for the gate", task: gate, background: true }),
    ),
    reply("It runs in the background."),
    reply("It answered."),
  ]);
  await session.prompt("Start a comrade");
  assert.equal(session.isStreaming, false);
  assert.equal(requests.length, 1);
  writeFileSync(gate, "");
  await until(() => requests.length === 2, "the answer starts a turn");
  await session.waitForIdle();
  const delivery = userTexts(requests[1]).at(-1) ?? "";
  assert.match(delivery, /^\[comrade #1 finished\] /);
  assert.match(delivery, /Opened\./);
  // Past the second the terminal waits before sending again an answer the session lacks.
  await sleep(1500);
  const deliveries = session.sessionManager
    .getEntries()
    .filter((entry) => entry.type === "custom_message" && entry.customType === "comrade");
  assert.equal(deliveries.length, 1);
  // The session holds the answer, so its run record has gone.
  const file = session.sessionManager.getSessionFile() ?? "";
  assert.deepEqual(readdirSync(file.replace(/\.jsonl$/, ".comrades")), ["comrade-1.jsonl"]);
});

test("a background answer reaches a caller still at work, before its next model request", async (t) => {
  let gate = "";
  // A call that runs on until the comrade's answer has been sent, as a caller's work outlasts a
  // quick comrade: it opens the gate the comrade waits on, then waits for its saved answer.
  const work = (pi: ExtensionAPI) =>
    pi.registerTool({
      name: "work",
      label: "Work",
      description: "Some work that takes a while",
      parameters: { type: "object", properties: {} } as unknown as ToolDefinition["parameters"],
      async execute(_id, _params, _signal, _update, ctx) {
        writeFileSync(gate, "");
        const conversation = (ctx.sessionManager.getSessionFile() ?? "").replace(/\.jsonl$/, "");
        const record = join(`${conversation}.comrades`, "comrade-1.runs.json");
        // Saved, then sent at once.
        await until(
          () => existsSync(record) && readFileSync(record, "utf8").includes('"answer"'),
          "the comrade's answer is sent",
        );
        return { content: [{ type: "text", text: "Worked." }], details: undefined };
      },
    });
  const { session, model, cwd } = await startSession(t, {
    factories: [comrade({ name: "gated" }), work],
  });
  gate = join(cwd, "gate");
  const requests: Message[][] = [];
  model.setResponses([
    ai.fauxAssistantMessage(
      ai.fauxToolCall("comrade", { title: "Wait for the gate", task: gate, background: true }),
    ),
    ai.fauxAssistantMessage(ai.fauxToolCall("work", {})),
    (context) => {
      requests.push(context.messages);
      return ai.fauxAssistantMessage("Done, with its answer.");
    },
  ]);
  await session.prompt("Start a comrade, then work");
  // The request after the work carries the answer, in the same run: no turn of its own later.
  assert.equal(requests.length, 1);
  const [after] = requests;
  assert.equal(after.at(-2)?.role, "toolResult");
  const delivery = userTexts(after).at(-1) ?? "";
  assert.match(delivery, /^\[comrade #1 finished\] /);
  assert.match(delivery, /Opened\./);
  assert.equal(model.state.callCount, 3);
});
