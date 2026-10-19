// What each window receives on every state change. The full state keeps
// snapshot images for ChatGPT; the windows never need them, and copying several
// megabytes per update while an answer streams costs CPU and memory.
function withoutImage(attachment) {
  if (!attachment) return attachment;
  const { dataUrl, ...rest } = attachment;
  return rest;
}

// Buddy shows snapshot names and a small preview, never the full image.
function lightSnapshot(value) {
  const interview = value.interview;
  const light = { ...value };
  if (value.result)
    light.result = { ...value.result, baseline: undefined, protected: undefined };
  if (!interview) return light;
  light.interview = {
    ...interview,
    messages: (interview.messages || []).map((message) =>
      message.attachment
        ? { ...message, attachment: withoutImage(message.attachment) }
        : message,
    ),
    attachment: withoutImage(interview.attachment),
  };
  return light;
}

// The audio engine only needs to know whether listening is on.
function engineSnapshot(value) {
  return { interview: { recording: Boolean(value.interview?.recording) } };
}

module.exports = { lightSnapshot, engineSnapshot };
