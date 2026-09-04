import { formatBytes, formatPercent } from "../lib/format.js";

export function MetricCard(props: {
  label: string;
  value: number;
  kind?: "bytes" | "percent" | "number";
  tone?: "neutral" | "green" | "orange" | "gray";
  note?: string;
}) {
  const displayed =
    props.kind === "percent"
      ? formatPercent(props.value)
      : props.kind === "number"
        ? props.value.toLocaleString()
        : formatBytes(props.value);
  return (
    <div className={`metric-card metric-card--${props.tone ?? "neutral"}`}>
      <span>{props.label}</span>
      <strong>{displayed}</strong>
      {props.note ? <small>{props.note}</small> : null}
    </div>
  );
}
