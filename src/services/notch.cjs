// Notch geometry for the Buddy island. Pure functions, tested without Electron.
const ESTIMATE = { width: 180, height: 32 };
const NOTCH_MENU_BAR = 30;
const WINDOW = { width: 760, height: 660 };
const PILL_HEIGHT = 30;
const finite = (n) => typeof n === "number" && Number.isFinite(n);

// Reads the JSON printed by scripts/notch-info.swift.
function parseNotch(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (data?.hasNotch === false) return { hasNotch: false };
  const notch = data?.hasNotch === true ? data.notch : null;
  if (
    !notch ||
    ![notch.x, notch.width, notch.height].every(finite) ||
    notch.width <= 0 ||
    notch.height <= 0
  )
    return null;
  return {
    hasNotch: true,
    x: notch.x,
    width: notch.width,
    height: notch.height,
  };
}

// Notched MacBooks reserve a menu bar at least as tall as the camera housing.
function estimateNotch(display, platform = process.platform) {
  const menuBar = display.workArea.y - display.bounds.y;
  if (platform !== "darwin" || !display.internal || menuBar < NOTCH_MENU_BAR)
    return { hasNotch: false };
  return {
    hasNotch: true,
    x: (display.bounds.width - ESTIMATE.width) / 2,
    ...ESTIMATE,
  };
}

async function detectNotch({ display, helper, run }) {
  if (helper && run) {
    try {
      const { stdout } = await run(helper, [], { timeout: 3000 });
      const parsed = parseNotch(stdout);
      if (parsed) return parsed;
    } catch {
      /* The estimate below covers missing helpers and older systems. */
    }
  }
  return estimateNotch(display);
}

// A fixed transparent window at the top edge. The island inside it grows and
// shrinks with CSS, so the native window never resizes while it animates.
function islandLayout({ display, notch }) {
  const bounds = display.bounds;
  const width = Math.min(WINDOW.width, bounds.width);
  const height = Math.min(WINDOW.height, bounds.height);
  const hasNotch = Boolean(notch?.hasNotch);
  const center = hasNotch
    ? bounds.x + notch.x + notch.width / 2
    : bounds.x + bounds.width / 2;
  const x = Math.round(
    Math.min(
      Math.max(center - width / 2, bounds.x),
      bounds.x + bounds.width - width,
    ),
  );
  return {
    window: { x, y: bounds.y, width, height },
    layout: {
      hasNotch,
      notchWidth: hasNotch ? notch.width : 0,
      notchHeight: hasNotch ? notch.height : PILL_HEIGHT,
      notchLeft: hasNotch ? bounds.x + notch.x - x : width / 2,
    },
  };
}

module.exports = { parseNotch, estimateNotch, detectNotch, islandLayout };
