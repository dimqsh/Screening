// Buddy's view of the shared interview snapshot. Loaded as a classic script in
// the Buddy window and required by the unit tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.buddyModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function formatElapsed(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const minutes = String(Math.floor(total / 60)).padStart(2, "0");
    return `${minutes}:${String(total % 60).padStart(2, "0")}`;
  }

  function deriveBuddy(snapshot, { now = Date.now(), dismissedId = null } = {}) {
    const interview = snapshot?.interview;
    const recording = Boolean(interview?.recording);
    const transcript = interview?.transcript || [];
    const view = {
      mode: "idle",
      recording,
      elapsed:
        recording && interview.startedAt
          ? formatElapsed(now - interview.startedAt)
          : "00:00",
      lastLine: transcript.length ? transcript[transcript.length - 1].text : "",
      question: "",
      answer: "",
      answerId: null,
      answerPending: false,
      error: "",
      protection: snapshot?.protection !== false,
      needsWhisper: false,
      needsAccount: false,
      modelLoading: interview?.whisper?.status === "loading",
      modelProgress: interview?.whisper?.progress ?? null,
      signingIn: interview?.ai?.status === "signing-in",
    };
    if (!snapshot?.buddy?.enabled) return { ...view, mode: "off" };
    const needsWhisper = !interview?.whisper?.ready;
    const needsAccount = !interview?.ai?.connected;
    if (needsWhisper || needsAccount)
      return { ...view, mode: "setup", needsWhisper, needsAccount };

    const messages = interview.messages || [];
    let index = messages.length - 1;
    while (index >= 0 && messages[index].role !== "assistant") index--;
    const reply = messages[index];
    if (reply && reply.id !== dismissedId) {
      let ask = index - 1;
      while (ask >= 0 && messages[ask].role !== "user") ask--;
      const turn = {
        question: ask >= 0 ? messages[ask].text : "",
        answerId: reply.id,
        error: reply.error || "",
      };
      if (reply.text)
        return {
          ...view,
          ...turn,
          mode: "answer",
          answer: reply.text,
          answerPending: reply.status === "pending",
        };
      if (reply.status === "pending")
        return { ...view, ...turn, mode: "thinking" };
      if (reply.status === "error") return { ...view, ...turn, mode: "error" };
    }
    if (interview.ai.busy) return { ...view, mode: "thinking" };
    return { ...view, mode: recording ? "listening" : "idle" };
  }

  // Pairs each question with the answer that followed it, oldest first.
  function listTurns(messages = []) {
    const turns = [];
    let question = null;
    for (const message of messages) {
      if (message.role === "user") question = message;
      else if (message.role === "assistant") {
        turns.push({
          id: message.id,
          question: question?.text || "",
          attachment: question?.attachment?.name || "",
          answer: message.text || "",
          status: message.status || "done",
          error: message.error || "",
        });
        question = null;
      }
    }
    return turns;
  }

  return { deriveBuddy, formatElapsed, listTurns };
});
