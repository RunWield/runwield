import { join } from "node:path";
import { createBundledAssetDirectory } from "@runwield/bundled-assets";
import { getHomeDir, SKILLS_DIR } from "../../constants.ts";

export const bundledSkills = createBundledAssetDirectory(SKILLS_DIR, () => {
    const homeDir = getHomeDir();
    return homeDir ? join(homeDir, ".wld", "bundled-skills") : null;
});
