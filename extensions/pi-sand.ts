import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPiSandExtension } from "./runtime.js";

export default function (pi: ExtensionAPI) {
  registerPiSandExtension(pi);
}
