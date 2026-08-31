export function formatGreeting(name) {
  return `Hello, ${name}`;
}

export function unusedFormatter(value) {
  return `This function is exported but not called: ${value}`;
}

export function removedByTreeShaking() {
  return "No final mapping should be required for this unused export.";
}
