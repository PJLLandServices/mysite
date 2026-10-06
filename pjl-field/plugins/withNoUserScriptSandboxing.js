// Turn off Xcode's User Script Sandboxing on every build configuration of
// the generated iOS project.
//
// With it on, Xcode blocks the build's shell scripts from reading the
// project folder, and the Release build (which runs "Bundle React Native
// code and images", skipped in Debug) failed on the Mac with
// "Sandbox: find(…) deny(1) file-read-data …" (2026-09-24). Switching it off
// in Build Settings by hand does not survive `npx expo prebuild --clean`,
// which regenerates the project, so the setting is made here, at prebuild.
// Covered by scripts/test-field-script-sandboxing.mjs.
const { withXcodeProject } = require('expo/config-plugins');

function disableUserScriptSandboxing(project) {
  const configs = project.pbxXCBuildConfigurationSection();
  let changed = 0;
  for (const [id, config] of Object.entries(configs)) {
    if (id.endsWith('_comment') || !config || !config.buildSettings) continue;
    config.buildSettings.ENABLE_USER_SCRIPT_SANDBOXING = 'NO';
    changed += 1;
  }
  return changed;
}

function withNoUserScriptSandboxing(config) {
  return withXcodeProject(config, (mod) => {
    disableUserScriptSandboxing(mod.modResults);
    return mod;
  });
}

module.exports = withNoUserScriptSandboxing;
module.exports.disableUserScriptSandboxing = disableUserScriptSandboxing;
