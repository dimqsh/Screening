const { desktopCapturer, nativeImage, systemPreferences } = require("electron");

// Snapshots are sized like the window list's: at most 1600 by 1200.
const MAX = { width: 1600, height: 1200 };

// No stream or timer: each operation follows an explicit workspace button press.
class WindowCapture {
  constructor(excludedIds = () => []) {
    this.excludedIds = excludedIds;
    this.available = new Map();
  }
  async sources(size) {
    if (
      process.platform === "darwin" &&
      systemPreferences.getMediaAccessStatus("screen") !== "granted"
    )
      throw new Error(
        "Allow Screening in System Settings → Privacy & Security → Screen & System Audio Recording, then reopen the app.",
      );
    const excluded = new Set(this.excludedIds());
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: size,
    });
    return sources.filter(
      (source) => !excluded.has(source.id) && !source.thumbnail.isEmpty(),
    );
  }
  async list() {
    const sources = await this.sources({ width: 320, height: 200 });
    this.available = new Map(sources.map((source) => [source.id, source.name]));
    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      thumbnail: source.thumbnail.toDataURL(),
    }));
  }
  async capture(id) {
    if (typeof id !== "string" || !this.available.has(id))
      throw new Error("Select a window first.");
    const sources = await this.sources(MAX);
    const source = sources.find(
      (source) => source.id === id && source.name === this.available.get(id),
    );
    if (!source)
      throw new Error(
        "The selected window changed or closed. Choose it again.",
      );
    return attachment(source.thumbnail, source.name);
  }
  // A frame from the system window picker on macOS 15+. The person chose the
  // window there, so this needs no screen recording access.
  fromImage({ name, dataUrl } = {}) {
    if (
      typeof dataUrl !== "string" ||
      !dataUrl.startsWith("data:image/png;base64,") ||
      dataUrl.length > 32_000_000
    )
      throw new Error("The snapshot could not be read. Try again.");
    let image = nativeImage.createFromDataURL(dataUrl);
    if (image.isEmpty())
      throw new Error("The snapshot could not be read. Try again.");
    const { width, height } = image.getSize();
    const scale = Math.min(1, MAX.width / width, MAX.height / height);
    if (scale < 1)
      image = image.resize({
        width: Math.round(width * scale),
        height: Math.round(height * scale),
        quality: "best",
      });
    const title = typeof name === "string" ? name.trim().slice(0, 200) : "";
    return attachment(image, title || "Window");
  }
}

function attachment(image, name) {
  const size = image.getSize();
  if (size.width < 40 || size.height < 40)
    throw new Error(
      "This window has no readable image. Restore it and try again.",
    );
  return {
    name,
    dataUrl: image.toDataURL(),
    // Buddy shows this small copy; only ChatGPT gets the full image.
    preview: `data:image/jpeg;base64,${image.resize({ width: 240 }).toJPEG(75).toString("base64")}`,
    width: size.width,
    height: size.height,
    time: new Date().toISOString(),
  };
}
module.exports = { WindowCapture };
