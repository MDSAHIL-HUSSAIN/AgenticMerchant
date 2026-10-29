import { EventEmitter } from "node:events";

class SerialTaskQueue extends EventEmitter {
  constructor() {
    super();
    this.pending = [];
    this.running = null;
    this.controllers = new Map();
  }

  enqueue(id, task) {
    if (this.pending.some(item => item.id === id) || this.running?.id === id) return false;
    this.pending.push({ id, task });
    queueMicrotask(() => this.#drain());
    return true;
  }

  cancel(id) {
    const index = this.pending.findIndex(item => item.id === id);
    if (index >= 0) {
      this.pending.splice(index, 1);
      this.emit("cancelled", { id, stage: "queued" });
      return true;
    }
    const controller = this.controllers.get(id);
    if (!controller) return false;
    controller.abort(new Error("Task cancelled."));
    return true;
  }

  snapshot() {
    return { running: this.running?.id || null, pending: this.pending.map(item => item.id) };
  }

  async #drain() {
    if (this.running || !this.pending.length) return;
    const item = this.pending.shift();
    const controller = new AbortController();
    this.running = item;
    this.controllers.set(item.id, controller);
    this.emit("started", { id: item.id });
    try {
      await item.task({ signal: controller.signal });
      this.emit("completed", { id: item.id });
    } catch (error) {
      this.emit("failed", { id: item.id, error });
    } finally {
      this.controllers.delete(item.id);
      this.running = null;
      queueMicrotask(() => this.#drain());
    }
  }
}

export const gpuTaskQueue = new SerialTaskQueue();
