type Sink = (bytes: Uint8Array) => void;
/** 往某个会话送"输入"（发消息用）：submit = 要不要补一个回车 */
type InputSink = (text: string, submit: boolean) => void;

/** 终端的输出总线：后端事件可能在 xterm 挂载之前就到达，先在这里缓冲。 */
export class SessionBus {
  private buffers = new Map<string, Uint8Array[]>();
  private sinks = new Map<string, Sink>();
  /**
   * 输入通道：App（AI 输入窗）想往某个终端里"打字"时走它。
   *
   * 为什么不直接 session_write：xterm 知道远端有没有开 **bracketed paste**
   *（TUI 靠它区分"粘贴的多行文本"和"敲了三次回车"），走 `term.paste()` 才会带上正确的
   * 转义序列 —— 直接写 PTY 的话，多行提示词会被 codex/claude 的界面当成连按回车。
   */
  private inputs = new Map<string, InputSink>();

  push(id: string, bytes: Uint8Array) {
    const sink = this.sinks.get(id);
    if (sink) {
      sink(bytes);
      return;
    }
    const buf = this.buffers.get(id) ?? [];
    buf.push(bytes);
    this.buffers.set(id, buf);
  }

  attach(id: string, sink: Sink) {
    this.sinks.set(id, sink);
    const buf = this.buffers.get(id);
    if (buf) {
      for (const b of buf) sink(b);
      this.buffers.delete(id);
    }
  }

  detach(id: string) {
    this.sinks.delete(id);
  }

  /** 终端挂载时登记"我能接收输入"；返回是否真的送到了（没登记说明这条会话的终端没挂载） */
  sendInput(id: string, text: string, submit = false): boolean {
    const sink = this.inputs.get(id);
    if (!sink) return false;
    sink(text, submit);
    return true;
  }

  attachInput(id: string, sink: InputSink) {
    this.inputs.set(id, sink);
  }

  detachInput(id: string) {
    this.inputs.delete(id);
  }

  drop(id: string) {
    this.sinks.delete(id);
    this.buffers.delete(id);
    this.inputs.delete(id);
  }
}
