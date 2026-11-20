// What PI_COMRADE makes of a Pi that inherits it: a comrade while its host runs, which watches
// that host only if the host started it, and an ordinary Pi once the host is gone.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fakePi } from "../../test/fake-pi.ts";
import { load } from "../../test/pi.ts";

const { default: install } = await load<typeof import("../index.ts")>(
  "../index.ts",
  import.meta.url,
);
const { hostOf, watchHost } = await load<typeof import("../pi.ts")>("../pi.ts", import.meta.url);

/** A process that has exited: its id names nothing now. */
const gone = () => {
  const pid = spawnSync(process.execPath, ["-e", "0"]).pid;
  assert(pid);
  return pid;
};

test("PI_COMRADE names a host only while that host runs", () => {
  assert.equal(hostOf(undefined), undefined);
  assert.equal(hostOf(String(gone())), undefined);
  assert.equal(hostOf("not a process"), undefined);
  assert.equal(hostOf(String(process.pid)), process.pid);
});

test("a Pi that inherited PI_COMRADE from a host that is gone offers comrade", () => {
  process.env.PI_COMRADE = String(gone());
  try {
    const pi = fakePi();
    install({
      ...pi.api,
      registerCommand: () => {},
      registerMessageRenderer: () => {},
      registerEntryRenderer: () => {},
    });
    assert.deepEqual([...pi.tools.keys()].sort(), ["comrade", "comrades"]);
  } finally {
    delete process.env.PI_COMRADE;
  }
});

test("only a Pi its host started stops once the host is gone", async () => {
  const host = gone();
  let stops = 0;
  // Started from something a comrade left running: another process started it.
  const cancel = watchHost(host, 5, () => stops++, process.pid);
  await new Promise((wake) => setTimeout(wake, 30));
  cancel();
  assert.equal(stops, 0);
  await new Promise<void>((resolve) => watchHost(host, 5, resolve, host));
});
