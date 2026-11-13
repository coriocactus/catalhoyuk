import assert from "node:assert/strict";
import { test } from "node:test";
import { load } from "../../test/pi.ts";

const { showCommand } = await load<typeof import("../shell.ts")>("../shell.ts", import.meta.url);
type Paint = import("../shell.ts").ShellPaint;

const plain: Paint = {
  command: (s) => s,
  flag: (s) => s,
  string: (s) => s,
  variable: (s) => s,
  operator: (s) => s,
  redirect: (s) => s,
  comment: (s) => s,
  dim: (s) => s,
};
/** Marks each token's kind, to check what is highlighted as what. */
const tagged: Paint = {
  command: (s) => `<c>${s}</c>`,
  flag: (s) => `<f>${s}</f>`,
  string: (s) => `<s>${s}</s>`,
  variable: (s) => `<v>${s}</v>`,
  operator: (s) => `<o>${s}</o>`,
  redirect: (s) => `<r>${s}</r>`,
  comment: (s) => `<#>${s}</#>`,
  dim: (s) => `<d>${s}</d>`,
};
const lines = (command: string) => showCommand(command, plain).lines;

test("a chain shows a step per line, each ending in its operator and a backslash", () => {
  assert.deepEqual(lines("jj status && printf '\\nRemaining:\\n' && jj resolve --list"), [
    "jj status && \\",
    "printf '\\nRemaining:\\n' && \\",
    "jj resolve --list",
  ]);
  assert.deepEqual(lines("make || true; ls | head -2"), [
    "make || \\",
    "true; \\",
    "ls | \\",
    "head -2",
  ]);
  assert.deepEqual(lines("git log --oneline -5"), ["git log --oneline -5"]);
});

test("operators inside quotes, substitutions, subshells and loops do not split", () => {
  assert.deepEqual(lines(`echo "a && b" 'c | d' $(x; y) \`p | q\``), [
    `echo "a && b" 'c | d' $(x; y) \`p | q\``,
  ]);
  assert.deepEqual(lines("(cd x && make) && ls"), ["(cd x && make) && \\", "ls"]);
  assert.deepEqual(lines("for f in *; do echo $f; done && echo ok"), [
    "for f in *; do echo $f; done && \\",
    "echo ok",
  ]);
  assert.deepEqual(lines("if [ -f x ]; then a; else b; fi; { c; d; } | sort"), [
    "if [ -f x ]; then a; else b; fi; \\",
    "{ c; d; } | \\",
    "sort",
  ]);
});

test("a leading cd becomes where the command ran", () => {
  assert.deepEqual(showCommand("cd ~/src/app && just format", plain), {
    lines: ["just format"],
    cwd: "~/src/app",
    elided: false,
  });
  assert.equal(showCommand("cd '/tmp/a b'; ls", plain).cwd, "/tmp/a b");
  // A cd on its own, or one that is not the first step, stays.
  assert.deepEqual(showCommand("cd project", plain), { lines: ["cd project"], elided: false });
  assert.equal(showCommand("ls && cd x && make", plain).cwd, undefined);
});

test("scripts keep their lines, and heredoc bodies are counted instead of shown", () => {
  const shown = showCommand(
    "cd ~/x && python3 - <<'EOF'\np = 1\nprint(p)\nEOF\ngrep -n y z",
    plain,
  );
  assert.deepEqual(shown, {
    lines: ["python3 - <<'EOF' … 2 lines", "grep -n y z"],
    cwd: "~/x",
    elided: true,
  });
  // A here-string has no body, so the lines after it stay.
  assert.deepEqual(lines("cat <<<word\nls\nEOF"), ["cat <<<word", "ls", "EOF"]);
  // A backslash-newline is one line continued, laid out like any chain.
  assert.deepEqual(lines("make \\\n  && make test"), ["make && \\", "make test"]);
  // Indentation the later lines share goes, as the row indents them itself; more stays.
  assert.deepEqual(lines("cd x &&\n     ls tests &&\n     wc -l *.ts"), [
    "cd x &&",
    "ls tests &&",
    "wc -l *.ts",
  ]);
  assert.deepEqual(lines("  for f in *; do\n    echo $f\n\n  done"), [
    "for f in *; do",
    "  echo $f",
    "done",
  ]);
  // A heredoc's body is not shown, so it does not count.
  assert.deepEqual(lines("cat <<EOF\nbody\nEOF\n  ls\n  pwd"), ["cat <<EOF … 1 line", "ls", "pwd"]);
});

test("long commands stop after eight lines", () => {
  const shown = showCommand(Array.from({ length: 12 }, (_, i) => `step${i}`).join(" && "), plain);
  assert.equal(shown.lines.length, 8);
  assert.equal(shown.lines[7], "… 5 more lines");
  assert.equal(shown.elided, true);
});

test("commands are bold, with flags, strings, variables, redirects and operators marked", () => {
  assert.deepEqual(showCommand(`FOO=1 rg -n "^x" "$DIR" 2>&1 | head # done`, tagged).lines, [
    '<v>FOO=1</v> <c>rg</c> <f>-n</f> <s>"^x"</s> <s>"$DIR"</s> <r>2>&1</r> <o>|</o> <o>\\</o>',
    "<c>head</c> <#># done</#>",
  ]);
  const braced = ["$", "{X}"].join(""); // shell's ${X}, not a template placeholder
  assert.deepEqual(showCommand(`echo $HOME ${braced} -`, tagged).lines, [
    `<c>echo</c> <v>$HOME</v> <v>${braced}</v> -`,
  ]);
});
