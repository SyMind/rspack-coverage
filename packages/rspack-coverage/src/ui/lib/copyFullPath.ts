import type { MouseEvent as ReactMouseEvent } from "react";

export const FULL_PATH_COPY_EVENT = "rspack-coverage:full-path-copy";

export interface FullPathCopyResult {
  path: string;
  copied: boolean;
}

function copyWithSelection(path: string): boolean {
  const field = document.createElement("textarea");
  const activeElement =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  field.value = path;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.inset = "-9999px auto auto -9999px";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  let copied = false;
  try {
    copied = document.execCommand?.("copy") ?? false;
  } finally {
    field.remove();
    activeElement?.focus();
  }
  return copied;
}

export async function copyFullPath(path: string): Promise<boolean> {
  let copied = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(path);
      copied = true;
    } else {
      copied = copyWithSelection(path);
    }
  } catch {
    copied = copyWithSelection(path);
  }
  window.dispatchEvent(
    new CustomEvent<FullPathCopyResult>(FULL_PATH_COPY_EVENT, {
      detail: { path, copied },
    }),
  );
  return copied;
}

export function copyablePathProps(path: string) {
  return {
    title: path,
    "data-full-path": path,
    onContextMenu: (event: ReactMouseEvent<Element>) => {
      event.preventDefault();
      event.stopPropagation();
      void copyFullPath(path);
    },
  };
}
