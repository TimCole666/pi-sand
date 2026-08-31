import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerPiSandActivity from "./pi-sand-activity.js";

export default function (pi: ExtensionAPI) {
  registerPiSandActivity(pi);
}
