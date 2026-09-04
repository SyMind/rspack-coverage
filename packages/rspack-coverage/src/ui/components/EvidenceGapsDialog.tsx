import { useEffect, useRef } from "react";

export function EvidenceGapsDialog(props: {
  open: boolean;
  gaps: Array<{ kind: string; message: string }>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (props.open && !dialog.open) dialog.showModal();
    if (!props.open && dialog.open) dialog.close();
  }, [props.open]);
  return (
    <dialog className="evidence-dialog" ref={ref} onClose={props.onClose} onCancel={props.onClose}>
      <header>
        <div>
          <span className="eyebrow">Evidence gaps</span>
          <h2>Unknown stays unknown</h2>
        </div>
        <button type="button" aria-label="Close evidence gaps" onClick={props.onClose}>
          ×
        </button>
      </header>
      <p>
        Missing maps, unsupported targets, and ignored Coverage entries are never painted as
        unexecuted or not emitted.
      </p>
      <div className="evidence-list">
        {props.gaps.length ? (
          props.gaps.map((gap) => (
            <div key={`${gap.kind}:${gap.message}`}>
              <strong>{gap.kind}</strong>
              <span>{gap.message}</span>
            </div>
          ))
        ) : (
          <div>
            <strong>none</strong>
            <span>No explicit evidence gap was reported for this analysis.</span>
          </div>
        )}
      </div>
    </dialog>
  );
}
