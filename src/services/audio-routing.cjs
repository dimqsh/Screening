// One renderer owns microphone/Windows loopback capture; both windows control it.
class AudioRouting {
  constructor(send, timeout = 30000) {
    this.send = send;
    this.timeout = timeout;
    this.nextId = 0;
    this.pending = new Map();
  }
  command(action, kind) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            "Audio control timed out. Reopen Screening and check audio permissions.",
          ),
        );
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, action, kind });
      } catch (error) {
        this.complete(id, error.message);
      }
    });
  }
  complete(id, error) {
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    clearTimeout(request.timer);
    error
      ? request.reject(new Error(String(error).slice(0, 500)))
      : request.resolve();
  }
  close() {
    for (const id of this.pending.keys())
      this.complete(id, "Audio control closed.");
  }
}
module.exports = { AudioRouting };
