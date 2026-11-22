// Intentionally UNSAFE fixture, used only by mutation-sensitivity.test.mjs.
// It must never be wired into a production socket or accepted as live evidence.
import { MockSocket } from '../mock-socket.mjs';

class FaultySocket extends MockSocket {
  reconnect(id) {
    const t = this.guard(id);
    t.inputUsed = 0;
    t.outputUsed = 0;
    return this.usage(id.taskId);
  }
  directTarget(id, operation) {
    this.guard(id);
    return { allowed: true, operation };
  }
}
export const createAdapter = options => new FaultySocket(options);
