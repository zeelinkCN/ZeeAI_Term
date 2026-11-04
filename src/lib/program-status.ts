/** Program Status Protocol (OSC 7501), revision 0.4. */
export interface ProgramStatus {
  state: "idle" | "working" | "blocked" | "done" | "error" | "clear";
  /** An empty id is the terminal's root record. */
  id: string;
  app?: string;
  kind?: "permission" | "question" | "auth";
  title?: string;
  message?: string;
  progress?: number;
}

export type ProgramStatusEvent =
  | { type: "status"; report: ProgramStatus }
  | { type: "query"; reply: string }
  | { type: "prompt" };

const ESC = 0x1b;
const BEL = 0x07;
const MAX_SEQUENCE = 4096;
// A tmux wrapper can double every ESC in a legal sequence, plus its own framing.
const MAX_PASSTHROUGH = MAX_SEQUENCE * 2 + 9;
const MAX_NESTING = 4;
const TMUX_PREFIX = "tmux;";
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const states = new Set<ProgramStatus["state"]>(["idle", "working", "blocked", "done", "error", "clear"]);

function trim(value: string): string {
  return value.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, "");
}

/** Strict standard base64 (optional padding), followed by strict UTF-8. */
function decodeText(value: string, limit: number): string | undefined {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return undefined;
  const firstPadding = value.indexOf("=");
  const count = firstPadding < 0 ? value.length : firstPadding;
  const remainder = count % 4;
  const padding = value.length - count;
  if (remainder === 1 || (padding && (value.length % 4 || padding !== 4 - remainder))) return undefined;
  // RFC 4648 pad bits must be zero, including when the padding is omitted.
  const last = count ? BASE64.indexOf(value[count - 1]) : 0;
  if ((remainder === 2 && (last & 15)) || (remainder === 3 && (last & 3))) return undefined;
  const size = Math.floor(count * 6 / 8);
  if (size > limit) return undefined;
  const bytes = new Uint8Array(size);
  let bits = 0;
  let accumulator = 0;
  let offset = 0;
  for (let i = 0; i < count; i++) {
    accumulator = (accumulator << 6) | BASE64.indexOf(value[i]);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset++] = (accumulator >> bits) & 255;
      accumulator &= (1 << bits) - 1;
    }
  }
  try {
    const result = textDecoder.decode(bytes);
    return /[\u0000-\u001f\u007f-\u009f]/u.test(result) ? undefined : result;
  } catch {
    return undefined;
  }
}

function parseReport(body: string): ProgramStatus | undefined {
  const fields = new Map<string, string>();
  for (const pair of body.split(":")) {
    const equals = pair.indexOf("=");
    if (equals < 0) continue;
    const key = trim(pair.slice(0, equals));
    const value = trim(pair.slice(equals + 1));
    // Check every occurrence, including unknown keys and overwritten values.
    if (key.length > 16) return undefined;
    if ((key === "msg" && value.length > 2732) || (key === "title" && value.length > 256)
      || (key === "app" && value.length > 32) || (key === "id" && value.length > 128)) return undefined;
    if (!/^[a-z]+$/.test(key) || !/^[A-Za-z0-9_.,+/=-]*$/.test(value)) continue;
    if (key === "title" || key === "msg") {
      const decoded = decodeText(value, key === "title" ? 192 : 2048);
      if (decoded === undefined) return undefined;
      fields.set(key, decoded);
    } else if (["state", "id", "app", "kind", "progress"].includes(key)) {
      fields.set(key, value);
    }
  }
  const state = fields.get("state") as ProgramStatus["state"] | undefined;
  if (!state || !states.has(state)) return undefined;
  const id = fields.get("id") ?? "";
  if (fields.has("id") && (!/^[A-Za-z0-9_.+-]{1,32}(?:\/[A-Za-z0-9_.+-]{1,32}){0,7}$/.test(id))) return undefined;
  const report: ProgramStatus = { state, id };
  const app = fields.get("app");
  if (app && /^[A-Za-z0-9_.+-]{1,32}$/.test(app)) report.app = app;
  const kind = fields.get("kind");
  if (state === "blocked" && (kind === "permission" || kind === "question" || kind === "auth")) report.kind = kind;
  const progress = fields.get("progress");
  if ((state === "working" || state === "blocked") && progress !== undefined && /^\d+$/.test(progress)) {
    const number = Number(progress);
    if (number >= 0 && number <= 100) report.progress = number;
  }
  if (fields.has("title")) report.title = fields.get("title");
  if (fields.has("msg")) report.message = fields.get("msg");
  return report;
}

type Mode = "ground" | "escape" | "intermediate" | "csi" | "osc" | "osc-escape" | "string";
type StringKind = "dcs-prefix" | "tmux" | "skip";

/**
 * Observes raw PTY bytes; it never edits output or infers state from screen text.
 * Only 7-bit ESC controls are recognized: UTF-8 continuation bytes cannot become C1 controls.
 * The caller sends query replies before passing the same bytes to the terminal renderer.
 */
export class ProgramStatusParser {
  private mode: Mode = "ground";
  private osc = "";
  private oscLength = 0;
  private oscOversize = false;
  private stringKind: StringKind = "skip";
  private stringPrefix = 0;
  private stringLength = 0;
  private stringEscape = false;
  private stringValid = true;
  private stringBytes: number[] = [];
  private nesting = 0;
  private tmuxParser?: ProgramStatusParser;

  push(bytes: Uint8Array): ProgramStatusEvent[] {
    const events: ProgramStatusEvent[] = [];
    for (const byte of bytes) this.consume(byte, events);
    return events;
  }

  /** Discards incomplete framing when a PTY is replaced or disconnected. */
  reset(): void {
    this.mode = "ground";
    this.osc = "";
    this.oscLength = 0;
    this.oscOversize = false;
    this.stringKind = "skip";
    this.stringPrefix = 0;
    this.stringLength = 0;
    this.stringEscape = false;
    this.stringValid = true;
    this.stringBytes = [];
    this.tmuxParser = undefined;
  }

  private consume(byte: number, events: ProgramStatusEvent[]): void {
    if (this.mode === "string") {
      this.consumeString(byte, events);
      return;
    }
    if (byte === 0x18 || byte === 0x1a) { // CAN / SUB cancel an unfinished control.
      this.mode = "ground";
      this.osc = "";
      this.tmuxParser = undefined;
      return;
    }
    if (this.mode === "osc" || this.mode === "osc-escape") {
      this.oscLength = Math.min(this.oscLength + 1, MAX_SEQUENCE + 1);
      if (this.oscLength > MAX_SEQUENCE) {
        this.oscOversize = true;
        this.osc = "";
      }
      if (this.mode === "osc-escape") {
        if (byte === 0x5c) {
          this.finishOsc("\x1b\\", events);
          return;
        }
        // A new ESC control aborts a malformed OSC, as it does in the emulator.
        this.osc = "";
        this.mode = "escape";
      } else {
        if (byte === BEL) this.finishOsc("\x07", events);
        else if (byte === ESC) this.mode = "osc-escape";
        else if (!this.oscOversize) this.osc += String.fromCharCode(byte);
        return;
      }
    }
    if (byte === ESC) {
      this.mode = "escape";
      return;
    }
    if (this.mode === "ground") {
      // Consecutive tmux packets may contain fragments of one logical sequence.
      this.tmuxParser = undefined;
      return;
    }
    if (this.mode === "csi") {
      if (byte >= 0x40 && byte <= 0x7e) this.mode = "ground";
      return;
    }
    if (byte < 0x20) return; // Other C0 controls execute without ending ESC parsing.
    if (this.mode === "intermediate") {
      if (byte >= 0x30 && byte <= 0x7e) this.mode = "ground";
      return;
    }
    if (byte === 0x50) { // DCS: recognize only the exact tmux passthrough prefix.
      this.beginString("dcs-prefix");
      return;
    }
    this.tmuxParser = undefined;
    if (byte === 0x5d) {
      this.mode = "osc";
      this.osc = "";
      this.oscLength = 2;
      this.oscOversize = false;
    } else if (byte === 0x5b) this.mode = "csi";
    else if (byte === 0x58 || byte === 0x5e || byte === 0x5f) this.beginString("skip"); // SOS / PM / APC
    else if (byte >= 0x20 && byte <= 0x2f) this.mode = "intermediate";
    else {
      this.mode = "ground";
      if (byte === 0x63) events.push({ type: "status", report: { state: "clear", id: "" } }); // RIS
    }
  }

  private finishOsc(terminator: string, events: ProgramStatusEvent[]): void {
    const body = this.osc;
    const valid = !this.oscOversize;
    this.mode = "ground";
    this.osc = "";
    if (!valid) return;
    if (body === "7501;?") {
      // The reply is constant: no bytes from an untrusted report are written back.
      events.push({ type: "query", reply: "\x1b]7501;?" + terminator });
    } else if (body.startsWith("7501;")) {
      const report = parseReport(body.slice(5));
      if (report) events.push({ type: "status", report });
    } else if (body === "133;A" || body.startsWith("133;A;")) events.push({ type: "prompt" });
  }

  private beginString(kind: StringKind): void {
    this.mode = "string";
    this.stringKind = kind;
    this.stringPrefix = 0;
    this.stringLength = 2;
    this.stringEscape = false;
    this.stringValid = true;
    this.stringBytes = [];
  }

  private consumeString(byte: number, events: ProgramStatusEvent[]): void {
    if (byte === 0x18 || byte === 0x1a) {
      this.mode = "ground";
      this.stringBytes = [];
      this.tmuxParser = undefined;
      return;
    }
    this.stringLength = Math.min(this.stringLength + 1, MAX_PASSTHROUGH + 1);
    if (this.stringLength > MAX_PASSTHROUGH) {
      this.stringValid = false;
      this.stringBytes = [];
      this.tmuxParser = undefined;
    }
    if (this.stringEscape) {
      this.stringEscape = false;
      if (byte === 0x5c) {
        const bytes = this.stringBytes;
        const valid = this.stringKind === "tmux" && this.stringValid && this.nesting < MAX_NESTING;
        this.mode = "ground";
        this.stringBytes = [];
        if (valid) {
          if (!this.tmuxParser) {
            this.tmuxParser = new ProgramStatusParser();
            this.tmuxParser.nesting = this.nesting + 1;
          }
          events.push(...this.tmuxParser.push(Uint8Array.from(bytes)));
        } else this.tmuxParser = undefined;
        return;
      }
      if (this.stringKind === "tmux") {
        if (byte === ESC) {
          if (this.stringValid) this.stringBytes.push(ESC);
          return;
        }
        // Inside tmux every payload ESC must be doubled; reject a raw nested OSC.
        this.stringValid = false;
        this.stringBytes = [];
        this.tmuxParser = undefined;
      } else this.stringKind = "skip";
    }
    if (byte === ESC) {
      this.stringEscape = true;
    } else if (this.stringKind === "dcs-prefix") {
      if (byte === TMUX_PREFIX.charCodeAt(this.stringPrefix)) {
        if (++this.stringPrefix === TMUX_PREFIX.length) this.stringKind = "tmux";
      } else {
        this.stringKind = "skip";
        this.tmuxParser = undefined;
      }
    } else if (this.stringKind === "tmux" && this.stringValid) this.stringBytes.push(byte);
    // BEL and nested ESC ] do not end DCS/APC/PM/SOS strings.
  }
}
