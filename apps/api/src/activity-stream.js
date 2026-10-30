import { EventEmitter } from "node:events";

const emitter = new EventEmitter();
emitter.setMaxListeners(100);
const traces = new Map();

export function publishActivity(traceId, entry) {
  if (!traceId || !entry) return;
  const history = traces.get(traceId) || [];
  history.push(entry);
  if (history.length > 500) history.splice(0, history.length - 500);
  traces.set(traceId, history);
  emitter.emit(traceId, entry);
}

export function activityTrace(traceId) {
  return { history: traces.get(traceId) || [], emitter };
}

export function finishActivity(traceId) {
  if (!traceId) return;
  setTimeout(() => traces.delete(traceId), 10 * 60_000).unref?.();
}
