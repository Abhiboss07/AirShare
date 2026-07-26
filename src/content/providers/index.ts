/** Content providers & sinks — plug-and-play over the transfer runtime. */

export { clipboardProvider, clipboardSink } from "./clipboard.js";
export {
  textProvider,
  textSink,
  clipboardTextSink,
  type TextSource,
} from "./text.js";
export {
  imageProvider,
  clipboardImageProvider,
  imageSink,
  type ImageSource,
  type RawImage,
} from "./image.js";
export { fileProvider, fileSink, type PathSource } from "./file.js";
export {
  browserProvider,
  browserSink,
  type UrlSource,
} from "./browser.js";
