export interface ModuleIdentifierLike {
  identifier: string;
  readableIdentifier?: string;
  name?: string;
  resource?: string | null;
}

function firstNonEmpty(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (value?.trim()) return value;
  }
  return null;
}

/** Human-oriented module identity emitted by Rspack for UI labels. */
export function moduleDisplayIdentifier(module: ModuleIdentifierLike): string {
  return (
    firstNonEmpty([module.readableIdentifier, module.name, module.resource, module.identifier]) ??
    "Module unavailable"
  );
}

/** Stable, lossless identity used by hover text and copy-path interactions. */
export function moduleFullIdentifier(module: ModuleIdentifierLike): string {
  return (
    firstNonEmpty([module.resource, module.identifier, module.readableIdentifier, module.name]) ??
    "Module unavailable"
  );
}

/** SVG labels cannot use CSS ellipsis; retain both ends of the readable identity. */
export function compactModuleIdentifier(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  if (maximum <= 3) return value.slice(0, maximum);
  const available = maximum - 1;
  const leading = Math.ceil(available / 2);
  return `${value.slice(0, leading)}…${value.slice(-(available - leading))}`;
}
