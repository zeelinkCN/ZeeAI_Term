import test from "node:test";
import assert from "node:assert/strict";
import { ProgramStatusParser } from "../src/lib/program-status.ts";

const ESC = "\x1b";
const BEL = "\x07";
const ST = ESC + "\\";
const bytes = (text) => Buffer.from(text, "utf8");
const b64 = (text) => bytes(text).toString("base64");
const osc = (body, end = ST) => `${ESC}]7501;${body}${end}`;
const status = (report) => ({ type: "status", report: { id: "", ...report } });
const report = (body, end) => new ProgramStatusParser().push(bytes(osc(body, end)));
const tmux = (payload) => `${ESC}Ptmux;${payload.replaceAll(ESC, ESC + ESC)}${ST}`;

function everySplit(input, expected) {
  const inputBytes = typeof input === "string" ? bytes(input) : input;
  for (let split = 0; split <= inputBytes.length; split++) {
    const parser = new ProgramStatusParser();
    assert.deepEqual([
      ...parser.push(inputBytes.subarray(0, split)),
      ...parser.push(inputBytes.subarray(split)),
    ], expected, `split at byte ${split}`);
  }
  const parser = new ProgramStatusParser();
  assert.deepEqual([...inputBytes].flatMap((byte) => parser.push(Uint8Array.of(byte))), expected, "one byte per push");
}

test("all lifecycle states, UTF-8 text, prompts and queries survive every byte split", () => {
  const message = "正在分析 source.ts 🚀 — café";
  const title = "审批 / Review";
  const input = "正常终端输出\r\n" + osc("state=idle:app=codex", BEL)
    + osc(`state=blocked:app=claude-code:id=agent/2:kind=permission:progress=42:title=${b64(title)}:msg=${b64(message)}`)
    + osc("state=working:app=codex:progress=100", BEL)
    + osc("state=done:app=codex") + osc("state=error:app=codex", BEL)
    + osc("state=clear:id=agent/2") + osc("?", BEL) + `${ESC}]133;A;redraw=1${ST}`;
  everySplit(input, [
    status({ state: "idle", app: "codex" }),
    status({ state: "blocked", app: "claude-code", id: "agent/2", kind: "permission", progress: 42, title, message }),
    status({ state: "working", app: "codex", progress: 100 }),
    status({ state: "done", app: "codex" }), status({ state: "error", app: "codex" }),
    status({ state: "clear", id: "agent/2" }), { type: "query", reply: osc("?", BEL) }, { type: "prompt" },
  ]);
});

test("feature detection echoes only the fixed query, with the original terminator", () => {
  for (const end of [BEL, ST]) everySplit(osc("?", end), [{ type: "query", reply: osc("?", end) }]);
  for (const body of ["?:states=idle,working,done,blocked,error:kinds=permission,question,auth", "?garbage", "??", " ? ", "state=?"]) {
    assert.deepEqual(report(body), []);
  }
  assert.deepEqual(report(`state=working:app=codex:msg=${b64("?; dangerous reply text")}`), [
    status({ state: "working", app: "codex", message: "?; dangerous reply text" }),
  ]);
});

test("malformed pairs are skipped, unknown keys ignored, and the last duplicate wins", () => {
  assert.deepEqual(report(`state=idle:broken:=no:APP=claude-code:bad!=no:bad=has;semicolon:state=working:app=claude-code:app=codex:future=ok:msg=${b64("old")}:msg=${b64("new")}`), [
    status({ state: "working", app: "codex", message: "new" }),
  ]);
  assert.deepEqual(report(" state = working : app = codex : progress = 7 "), [status({ state: "working", app: "codex", progress: 7 })]);
  assert.deepEqual(report("state=working:app=codex:msg=not%base64"), [status({ state: "working", app: "codex" })]);
  assert.deepEqual(report("state=working:app=codex:app=other/app"), [status({ state: "working" })]);
});

test("unrecognized or missing states never become idle, and ids never fall back to root", () => {
  for (const body of ["", "app=codex", "state=failed:app=codex", "state=Working:app=codex", "state=working:state=unknown:app=codex"]) {
    assert.deepEqual(report(body), []);
  }
  for (const id of ["", "/agent", "agent/", "agent//2", "agent,2", "agent=2", "x".repeat(33), Array(9).fill("x").join("/")]) {
    assert.deepEqual(report(`state=working:app=codex:id=${id}`), [], id);
  }
  const maxId = ["a".repeat(31), "b".repeat(31), "c".repeat(31), "d".repeat(32)].join("/");
  assert.equal(maxId.length, 128);
  assert.deepEqual(report(`state=working:app=codex:id=${maxId}`), [status({ state: "working", app: "codex", id: maxId })]);
  const deepId = "agent/1/./../a_b/A.B/+x/-x";
  assert.deepEqual(report(`state=clear:id=${deepId}`), [status({ state: "clear", id: deepId })]);
});

test("a report replaces fields; kind and percentage apply only to their specified states", () => {
  const parser = new ProgramStatusParser();
  assert.deepEqual(parser.push(bytes(osc("state=blocked:app=codex:kind=auth:progress=70"))), [
    status({ state: "blocked", app: "codex", kind: "auth", progress: 70 }),
  ]);
  assert.deepEqual(parser.push(bytes(osc("state=idle"))), [status({ state: "idle" })]);
  for (const state of ["idle", "done", "error", "clear"]) {
    assert.deepEqual(report(`state=${state}:app=codex:kind=permission:progress=42`), [status({ state, app: "codex" })]);
  }
  assert.deepEqual(report("state=working:app=codex:kind=question"), [status({ state: "working", app: "codex" })]);
  assert.deepEqual(report("state=blocked:app=codex:kind=future:progress=101"), [status({ state: "blocked", app: "codex" })]);
  for (const progress of ["", "-1", "+1", "1.2", "1/2", "100.0", "Infinity", "1e2", "101", "9".repeat(100)]) {
    assert.deepEqual(report(`state=working:app=codex:progress=${progress}`), [status({ state: "working", app: "codex" })], progress);
  }
  for (const progress of ["0", "42", "100", "001"]) {
    assert.deepEqual(report(`state=working:app=codex:progress=${progress}`), [status({ state: "working", app: "codex", progress: Number(progress) })]);
  }
});

test("standard base64 supports optional padding and plain untrusted UTF-8 text", () => {
  for (const message of ["", "f", "fo", "foo", "你好🌍", "<script>alert('x')</script>", "literal \\x1b]7501;state=done"]) {
    for (const encoded of [b64(message), b64(message).replace(/=+$/, "")]) {
      assert.deepEqual(report(`state=working:app=codex:msg=${encoded}`), [status({ state: "working", app: "codex", message })]);
    }
  }
});

test("malformed base64 discards the whole report, including invalid overwritten text", () => {
  for (const bad of ["A", "=", "==", "Zg=", "Zg===", "Z=g=", "Zm9v=", "A===", "Zh==", "Zh", "Zm9=", "Zm9", "_w==", "-w=="]) {
    for (const field of ["msg", "title"]) {
      assert.deepEqual(report(`state=working:app=codex:${field}=${bad}`), [], `${field}=${bad}`);
    }
  }
  assert.deepEqual(report(`state=working:app=codex:msg=A:msg=${b64("valid later duplicate")}`), []);
});

test("invalid UTF-8 and every C0/C1 decoded control are rejected atomically", () => {
  const malformedUtf8 = [[0xff], [0xc3], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x28, 0xa1]];
  for (const value of malformedUtf8) {
    assert.deepEqual(report(`state=done:app=codex:msg=${Buffer.from(value).toString("base64")}`), []);
  }
  for (const codePoint of [...Array.from({ length: 32 }, (_, n) => n), ...Array.from({ length: 33 }, (_, n) => 127 + n)]) {
    for (const field of ["msg", "title"]) {
      assert.deepEqual(report(`state=done:app=codex:${field}=${b64("before" + String.fromCodePoint(codePoint) + "after")}`), [], `U+${codePoint.toString(16)} in ${field}`);
    }
  }
});

test("all field limits are hard caps even for overwritten or ignored-state fields", () => {
  const title = "界".repeat(64); // 192 UTF-8 bytes.
  const message = "界".repeat(682) + "ok"; // 2048 UTF-8 bytes.
  assert.deepEqual(report(`state=working:app=${"a".repeat(32)}:title=${b64(title)}:msg=${b64(message)}`), [
    status({ state: "working", app: "a".repeat(32), title, message }),
  ]);
  const badPairs = [
    `${"z".repeat(17)}=ignored`, `app=${"a".repeat(33)}`, `id=${"a".repeat(129)}`,
    `title=${"A".repeat(257)}`, `msg=${"A".repeat(2733)}`,
    `title=${b64("a".repeat(193))}`, `msg=${b64("a".repeat(2049))}`,
  ];
  for (const pair of badPairs) {
    assert.deepEqual(report(`state=clear:${pair}:app=codex:title=${b64("later valid value")}`), [], pair.slice(0, 60));
  }
  assert.deepEqual(report(`${"x".repeat(16)}=unknown:state=working:app=codex`), [status({ state: "working", app: "codex" })]);
});

test("whole sequence cap includes both introducer and the chosen terminator", () => {
  for (const end of [BEL, ST]) {
    const prefix = `${ESC}]7501;state=working:app=codex:extra=`;
    const exact = prefix + "x".repeat(4096 - bytes(prefix + end).length) + end;
    assert.equal(bytes(exact).length, 4096);
    everySplit(exact, [status({ state: "working", app: "codex" })]);
    const over = prefix + "x".repeat(4097 - bytes(prefix + end).length) + end;
    assert.deepEqual(new ProgramStatusParser().push(bytes(over + osc("state=done:app=codex"))), [status({ state: "done", app: "codex" })]);
  }
});

test("oversized and malformed OSCs recover at termination or a new ESC control", () => {
  const parser = new ProgramStatusParser();
  assert.deepEqual(parser.push(bytes(`${ESC}]7501;state=working:app=codex:msg=${"A".repeat(100_000)}`)), []);
  assert.deepEqual(parser.push(bytes(BEL + osc("state=blocked:app=codex:kind=question"))), [status({ state: "blocked", app: "codex", kind: "question" })]);
  everySplit(`${ESC}]7501;state=bad${osc("state=working:app=codex")}`, [status({ state: "working", app: "codex" })]);
  everySplit(`${ESC}]7501;state=working:app=codex${ESC}[31m` + osc("state=done:app=codex"), [status({ state: "done", app: "codex" })]);
});

test("terminal control strings cannot forge reports, queries, prompts or resets", () => {
  const payload = osc("state=done:app=codex", BEL) + osc("?", BEL) + `${ESC}]133;A${BEL}${ESC}c`;
  for (const introducer of ["P", "_", "^", "X"]) {
    everySplit(`${ESC}${introducer}ignored:${payload}${ST}` + osc("state=working:app=codex"), [status({ state: "working", app: "codex" })]);
  }
  const escapedInner = osc("state=done:app=codex");
  everySplit(`${ESC}Pnot-tmux;${escapedInner}${ST}`, []);
  everySplit(`${ESC}_payload${ESC}${ESC}]7501;state=done:app=codex${BEL}${ST}`, []);
});

test("oversized DCS/APC strings remain strings until their terminator", () => {
  for (const introducer of ["P", "_"]) {
    const parser = new ProgramStatusParser();
    assert.deepEqual(parser.push(bytes(`${ESC}${introducer}` + "x".repeat(100_000))), []);
    assert.deepEqual(parser.push(bytes(osc("state=done:app=codex", BEL) + osc("?", BEL))), []);
    assert.deepEqual(parser.push(bytes(ST + osc("state=working:app=codex"))), [status({ state: "working", app: "codex" })]);
  }
});

test("validated tmux passthrough unwraps doubled ESC bytes across every byte split", () => {
  for (const end of [BEL, ST]) {
    const payload = osc(`state=blocked:app=claude-code:kind=permission:msg=${b64("批准 🚀")}`, end) + osc("?", end);
    everySplit(tmux(payload), [
      status({ state: "blocked", app: "claude-code", kind: "permission", message: "批准 🚀" }),
      { type: "query", reply: osc("?", end) },
    ]);
    const parser = new ProgramStatusParser();
    const wire = bytes(tmux(payload));
    assert.deepEqual(parser.push(wire.subarray(0, -1)), [], "do not apply any data before validating the outer terminator");
    assert.equal(parser.push(wire.subarray(-1)).length, 2);
  }
});

test("tmux packets may split a logical OSC, but unrelated output cannot join fragments", () => {
  const first = tmux(`${ESC}]7501;state=work`);
  const second = tmux(`ing:app=codex${ST}`);
  everySplit(first + second, [status({ state: "working", app: "codex" })]);
  everySplit(first + "unrelated output" + second, []);
  everySplit(first + `${ESC}[31m` + second, []);
});

test("malformed tmux escaping, unknown DCS formats and oversized wrappers are discarded", () => {
  for (const input of [
    `${ESC}Ptmux;${osc("state=done:app=codex", BEL)}${ST}`,
    `${ESC}Ptmux;${ESC}${ESC}]7501;state=done:app=codex${BEL}${ESC}x${ST}`,
    `${ESC}Ptmux:${osc("state=done:app=codex", BEL)}${ST}`,
    tmux("x".repeat(100_000) + osc("state=done:app=codex", BEL)),
  ]) {
    assert.deepEqual(new ProgramStatusParser().push(bytes(input + osc("state=working:app=codex"))), [status({ state: "working", app: "codex" })]);
  }
});

test("tmux nesting is supported with a fixed depth bound", () => {
  let payload = osc("state=working:app=codex");
  for (let depth = 1; depth <= 5; depth++) {
    payload = tmux(payload);
    everySplit(payload, depth <= 4 ? [status({ state: "working", app: "codex" })] : []);
  }
});

test("CAN and SUB cancel incomplete strings without creating a report", () => {
  for (const cancel of ["\x18", "\x1a"]) {
    for (const prefix of [`${ESC}]7501;state=done`, `${ESC}Pignored`, `${ESC}_ignored`, `${ESC}[123`, `${ESC}Ptmux;${ESC}${ESC}]7501;state=done`]) {
      everySplit(prefix + cancel + osc("state=working:app=codex"), [status({ state: "working", app: "codex" })]);
    }
  }
});

test("only shell prompt begin drops live state; RIS clears all, DECSTR does not", () => {
  everySplit(`${ESC}]133;A${BEL}${ESC}]133;A;cl=m${ST}${ESC}c`, [{ type: "prompt" }, { type: "prompt" }, status({ state: "clear" })]);
  everySplit(`${ESC}[!p${ESC}[?1049h${ESC}[?1049l${ESC}]133;B${BEL}${ESC}]133;C${ST}${ESC}]133;D;0${BEL}${ESC}]133;AB${ST}`, []);
  everySplit(`${ESC}(c${ESC}#c`, [], "an ESC intermediate cannot turn c into RIS");
});

test("literal escape notation, unrelated OSCs and UTF-8 continuation bytes are ordinary output", () => {
  everySplit("\\x1b]7501;state=done:app=codex\\x1b\\" + "\\033]7501;state=done:app=codex\\a", []);
  everySplit("Claude is working. Codex done. approve? Permission required. 100% Complete.\r\n", []);
  everySplit(`${ESC}]0;codex working${BEL}${ESC}]2;claude done${ST}${ESC}]9;4;1;100${BEL}`, []);
  everySplit("\u009d7501;state=done:app=codex\u009c" + "\u015d7501;state=done:app=codex\u009c" + "🙂", []);
});

test("reset discards incomplete state between PTY lifetimes", () => {
  for (const partial of [`${ESC}]7501;state=work`, `${ESC}Ptmux;${ESC}`, `${ESC}_payload`, tmux(`${ESC}]7501;state=work`)]) {
    const parser = new ProgramStatusParser();
    assert.deepEqual(parser.push(bytes(partial)), []);
    parser.reset();
    assert.deepEqual(parser.push(bytes(`ing:app=codex${BEL}`)), []);
    assert.deepEqual(parser.push(bytes(osc("state=idle:app=codex"))), [status({ state: "idle", app: "codex" })]);
  }
});
