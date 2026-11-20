// Where a command's lines split: never at an escaped operator, nor inside a `[[ … ]]` test, the
// quotes inside a `$(…)`, or a function's body; and a line ends in a backslash only before another.
import assert from "node:assert/strict";
import { test } from "node:test";
import { load } from "../../test/pi.ts";

const { showCommand } = await load<typeof import("../shell.ts")>("../shell.ts", import.meta.url);
type Paint = import("../shell.ts").ShellPaint;

const keep = (text: string) => text;
const plain: Paint = {
  command: keep,
  flag: keep,
  string: keep,
  variable: keep,
  operator: keep,
  redirect: keep,
  comment: keep,
  dim: keep,
};
const lines = (command: string) => showCommand(command, plain).lines;

test("an operator escaped with a backslash belongs to its word", () => {
  const find = 'find . -name "*.ts" -exec grep -l foo {} \\;';
  assert.deepEqual(lines(find), [find]);
  assert.deepEqual(lines(`${find} | head -3`), [`${find} | \\`, "head -3"]);
  assert.deepEqual(lines("echo a\\|b"), ["echo a\\|b"]);
});

test("a line ends in a backslash only when another step follows it", () => {
  assert.deepEqual(lines("make test;"), ["make test;"]);
  assert.deepEqual(lines("make && make test &&"), ["make && \\", "make test &&"]);
});

test("tests, quotes inside substitutions, and functions' bodies stay on their line", () => {
  assert.deepEqual(lines('[[ -n "$x" && -f "$y" ]] && echo yes'), [
    '[[ -n "$x" && -f "$y" ]] && \\',
    "echo yes",
  ]);
  const log = 'echo "$(git log --format="%h | %s" | head -1)"';
  assert.deepEqual(lines(log), [log]);
  assert.deepEqual(lines("f() { a; b; }; f"), ["f() { a; b; }; \\", "f"]);
});

test("deeply nested quotes and substitutions take one pass and no call stack", () => {
  for (const command of ['"$('.repeat(20000), "$(".repeat(20000), '"$(echo "'.repeat(10000)])
    assert.equal(lines(command).length, 1);
});
