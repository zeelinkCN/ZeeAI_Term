type Sink = (bytes: Uint8Array) => void;

/** 终端的输出总线：后端事件可能在 xterm 挂载之前就到达，先在这里缓冲。 */
export class SessionBus {
  private buffers = new Map<string, Uint8Array[]>();
  private sinks = new Map<string, Sink>();

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

  drop(id: string) {
    this.sinks.delete(id);
    this.buffers.delete(id);
  }
}
