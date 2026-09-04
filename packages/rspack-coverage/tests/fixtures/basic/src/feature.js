export function runFeature() {
  return "The async chunk loaded.";
}

export function coldFeatureBranch(flag) {
  if (flag) return "This branch was requested.";
  return "This branch remains cold in the default scenario.";
}
