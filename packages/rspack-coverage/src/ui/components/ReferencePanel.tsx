import { useEffect, useRef, useState } from "react";
import type {
  CodeCoverageState,
  CodeViewResponse,
  ExportImporterBinding,
  ExportImporterChainResponse,
  ExportImporterChainStep,
  ExportModuleInstance,
  ExportUsagePrecision,
  ExportUsageState,
  ModuleReferenceGraphEdge,
  ModuleReferenceGraphNode,
  ModuleReferenceGraphResponse,
  ModuleReferencesResponse,
  ReferenceEdgeReport,
  ReferenceSnippetResponse,
  SourceExportUsage,
} from "../../shared/types.js";
import { copyablePathProps } from "../lib/copyFullPath.js";
import { formatPercent } from "../lib/format.js";
import {
  compactModuleIdentifier,
  moduleDisplayIdentifier,
  moduleFullIdentifier,
} from "../lib/moduleIdentifier.js";
import { SearchableCoverageCode } from "./CoverageCode.js";

const STATUS_LABELS: Record<CodeCoverageState, string> = {
  executed: "Executed",
  unexecuted: "Loaded / unexecuted",
  "not-emitted": "Not emitted",
  unloaded: "Not loaded",
  unknown: "Unknown",
  neutral: "No coverage evidence",
};

const EXPORT_STATE_LABELS: Record<ExportUsageState, string> = {
  used: "Used",
  unused: "Unused",
  unknown: "Unknown",
  "type-only": "Type only",
};

const PRECISION_LABELS: Record<ExportUsagePrecision, string> = {
  exact: "Exact",
  conservative: "Conservative",
  unavailable: "Unavailable",
};

function shortName(value: string, maximum = 31): string {
  const name = value.split(/[\\/]/).at(-1) ?? value;
  return name.length > maximum ? `${name.slice(0, maximum - 1)}…` : name;
}

function edgeNeighbor(edge: ReferenceEdgeReport, selectedId: string) {
  return edge.originId === selectedId ? edge.target : edge.origin;
}

function referenceLocation(line: number | null, column: number | null): string {
  if (line === null) return "location unavailable";
  return column === null ? `line ${line}` : `${line}:${column + 1}`;
}

function edgeLocation(edge: ReferenceEdgeReport): string {
  const location = edge.sourceLocation ?? edge.location;
  return referenceLocation(location?.start.line ?? null, location?.start.column ?? null);
}

function chainStepPath(step: ExportImporterChainStep): string {
  return step.edge.sourcePath ?? moduleFullIdentifier(step.edge.origin);
}

function chainStepName(step: ExportImporterChainStep): string {
  return moduleDisplayIdentifier(step.edge.origin);
}

function bindingLabel(binding: ExportImporterBinding): string {
  if (binding.exportedName === "*") return "all exports (*)";
  if (!binding.localName || binding.localName === binding.exportedName) return binding.exportedName;
  return binding.exportedName === "default"
    ? `${binding.localName} (default)`
    : `${binding.localName} (exported as ${binding.exportedName})`;
}

function chainStepRelation(step: ExportImporterChainStep): string {
  const imported = bindingLabel(
    step.importedBinding ?? { exportedName: step.importedExport, localName: null },
  );
  const importerBindings = step.importerBindings?.length
    ? step.importerBindings
    : step.importerExports.map((exportedName) => ({ exportedName, localName: null }));
  if (!importerBindings.length) return `uses ${imported} · module execution only`;
  const carriers = importerBindings.map(bindingLabel).join(", ");
  return step.relationPrecision === "exact"
    ? `uses ${imported} → continues as ${carriers}`
    : `uses ${imported} → may continue as ${carriers}`;
}

interface ChainTreeNode {
  step: ExportImporterChainStep;
  children: ChainTreeNode[];
}

interface ChainGraphPosition {
  step: ExportImporterChainStep;
  x: number;
  y: number;
  parentX: number;
  parentY: number;
}

interface ChainDependencyPosition {
  edge: ReferenceEdgeReport;
  x: number;
  y: number;
}

interface ChainFileGroupPosition {
  key: string;
  moduleId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  count: number;
}

interface ChainGraphLayout {
  width: number;
  height: number;
  rootX: number;
  rootY: number;
  nodes: ChainGraphPosition[];
  groups: ChainFileGroupPosition[];
  dependencies: ChainDependencyPosition[];
}

interface ModuleGraphNodePosition {
  node: ModuleReferenceGraphNode;
  x: number;
  y: number;
}

interface ModuleGraphEdgePosition {
  edge: ModuleReferenceGraphEdge;
  path: string;
}

interface ModuleGraphLayout {
  width: number;
  height: number;
  rootX: number;
  rootY: number;
  nodes: ModuleGraphNodePosition[];
  edges: ModuleGraphEdgePosition[];
}

const GRAPH_NODE_WIDTH = 150;
const GRAPH_NODE_HEIGHT = 44;
const GRAPH_ROOT_WIDTH = 180;
const GRAPH_ROOT_HEIGHT = 58;
const GRAPH_COLUMN_STEP = 172;
const GRAPH_ROW_STEP = 54;
const GRAPH_PADDING = 18;
const GRAPH_FILE_TONE_COUNT = 8;

function graphFileTones(moduleIds: string[]): Map<string, number> {
  const tones = new Map<string, number>();
  for (const moduleId of moduleIds) {
    if (!tones.has(moduleId)) tones.set(moduleId, tones.size % GRAPH_FILE_TONE_COUNT);
  }
  return tones;
}

function chainTree(steps: ExportImporterChainStep[]): ChainTreeNode[] {
  const nodes = new Map(steps.map((step) => [step.id, { step, children: [] } as ChainTreeNode]));
  const roots: ChainTreeNode[] = [];
  for (const step of steps) {
    const node = nodes.get(step.id);
    if (!node) continue;
    const parent = step.parentId ? nodes.get(step.parentId) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function collapsedChainSteps(steps: ExportImporterChainStep[]): ExportImporterChainStep[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visible = new Set<string>();
  const addWithParents = (step: ExportImporterChainStep) => {
    visible.add(step.id);
    let parentId = step.parentId;
    while (parentId) {
      const parent = byId.get(parentId);
      if (!parent || visible.has(parent.id)) break;
      visible.add(parent.id);
      parentId = parent.parentId;
    }
  };
  for (const step of steps) {
    if (step.depth > 3 || visible.size >= 24) continue;
    addWithParents(step);
  }
  return steps.filter((step) => visible.has(step.id));
}

function layoutChainGraph(
  steps: ExportImporterChainStep[],
  dependencies: ReferenceEdgeReport[],
): ChainGraphLayout {
  const byDepth = new Map<number, ExportImporterChainStep[]>();
  for (const step of steps) {
    const column = byDepth.get(step.depth) ?? [];
    column.push(step);
    byDepth.set(step.depth, column);
  }
  for (const [depth, column] of byDepth) {
    const moduleGroups = new Map<string, ExportImporterChainStep[]>();
    for (const step of column) {
      const group = moduleGroups.get(step.edge.originId) ?? [];
      group.push(step);
      moduleGroups.set(step.edge.originId, group);
    }
    byDepth.set(depth, Array.from(moduleGroups.values()).flat());
  }
  const maxDepth = Math.max(1, ...byDepth.keys());
  const largestColumn = Math.max(
    1,
    dependencies.length,
    ...Array.from(byDepth.values(), (column) => column.length),
  );
  const height = Math.max(
    330,
    GRAPH_PADDING * 2 + largestColumn * GRAPH_ROW_STEP - (GRAPH_ROW_STEP - GRAPH_NODE_HEIGHT),
  );
  const rootX = GRAPH_PADDING + maxDepth * GRAPH_COLUMN_STEP;
  const rootY = Math.round((height - GRAPH_ROOT_HEIGHT) / 2);
  const positions = new Map<string, { x: number; y: number }>();

  for (const [depth, column] of byDepth) {
    const columnHeight = column.length * GRAPH_ROW_STEP - (GRAPH_ROW_STEP - GRAPH_NODE_HEIGHT);
    const startY = Math.round((height - columnHeight) / 2);
    column.forEach((step, index) => {
      positions.set(step.id, {
        x: rootX - depth * GRAPH_COLUMN_STEP,
        y: startY + index * GRAPH_ROW_STEP,
      });
    });
  }

  const nodes = steps.flatMap((step) => {
    const position = positions.get(step.id);
    if (!position) return [];
    const parent = step.parentId ? positions.get(step.parentId) : null;
    return [
      {
        step,
        ...position,
        parentX: parent?.x ?? rootX,
        parentY: parent?.y ?? rootY,
      },
    ];
  });
  const groupedNodes = new Map<string, ChainGraphPosition[]>();
  for (const node of nodes) {
    const key = `${node.step.depth}:${node.step.edge.originId}`;
    const group = groupedNodes.get(key) ?? [];
    group.push(node);
    groupedNodes.set(key, group);
  }
  const groups = Array.from(groupedNodes, ([key, group]) => {
    const first = group[0];
    if (!first) throw new Error("Expected a chain graph file group.");
    const top = Math.min(...group.map((node) => node.y));
    const bottom = Math.max(...group.map((node) => node.y + GRAPH_NODE_HEIGHT));
    return {
      key,
      moduleId: first.step.edge.originId,
      x: first.x - 5,
      y: top - 5,
      width: GRAPH_NODE_WIDTH + 10,
      height: bottom - top + 10,
      count: group.length,
    };
  });
  const dependencyX = rootX + GRAPH_ROOT_WIDTH + 32;
  const dependencyColumnHeight =
    dependencies.length * GRAPH_ROW_STEP - (GRAPH_ROW_STEP - GRAPH_NODE_HEIGHT);
  const dependencyStartY = Math.round((height - Math.max(0, dependencyColumnHeight)) / 2);
  const dependencyPositions = dependencies.map((edge, index) => ({
    edge,
    x: dependencyX,
    y: dependencyStartY + index * GRAPH_ROW_STEP,
  }));
  const contentWidth = dependencies.length
    ? dependencyX + GRAPH_NODE_WIDTH + GRAPH_PADDING
    : rootX + GRAPH_ROOT_WIDTH + GRAPH_PADDING;
  return {
    width: Math.max(520, contentWidth),
    height,
    rootX,
    rootY,
    nodes,
    groups,
    dependencies: dependencyPositions,
  };
}

function layoutModuleGraph(
  graph: ModuleReferenceGraphResponse | null,
  rootId: string,
): ModuleGraphLayout {
  const byDepth = new Map<number, ModuleReferenceGraphNode[]>();
  for (const node of graph?.nodes ?? []) {
    if (node.module.id === rootId || node.depth === 0) continue;
    const column = byDepth.get(node.depth) ?? [];
    column.push(node);
    byDepth.set(node.depth, column);
  }
  for (const column of byDepth.values()) {
    column.sort((left, right) =>
      moduleDisplayIdentifier(left.module).localeCompare(moduleDisplayIdentifier(right.module)),
    );
  }
  const minimumDepth = Math.min(0, ...byDepth.keys());
  const maximumDepth = Math.max(0, ...byDepth.keys());
  const incomingDepth = Math.abs(minimumDepth);
  const largestColumn = Math.max(1, ...Array.from(byDepth.values(), (column) => column.length));
  const height = Math.max(
    330,
    GRAPH_PADDING * 2 + largestColumn * GRAPH_ROW_STEP - (GRAPH_ROW_STEP - GRAPH_NODE_HEIGHT),
  );
  const rootX = GRAPH_PADDING + incomingDepth * GRAPH_COLUMN_STEP;
  const rootY = Math.round((height - GRAPH_ROOT_HEIGHT) / 2);
  const positions = new Map<string, { x: number; y: number; width: number; height: number }>();
  positions.set(rootId, {
    x: rootX,
    y: rootY,
    width: GRAPH_ROOT_WIDTH,
    height: GRAPH_ROOT_HEIGHT,
  });

  const nodes: ModuleGraphNodePosition[] = [];
  for (const [depth, column] of byDepth) {
    const columnHeight = column.length * GRAPH_ROW_STEP - (GRAPH_ROW_STEP - GRAPH_NODE_HEIGHT);
    const startY = Math.round((height - columnHeight) / 2);
    column.forEach((node, index) => {
      const x =
        depth < 0
          ? rootX + depth * GRAPH_COLUMN_STEP
          : rootX + GRAPH_ROOT_WIDTH + 32 + (depth - 1) * GRAPH_COLUMN_STEP;
      const y = startY + index * GRAPH_ROW_STEP;
      nodes.push({ node, x, y });
      positions.set(node.module.id, {
        x,
        y,
        width: GRAPH_NODE_WIDTH,
        height: GRAPH_NODE_HEIGHT,
      });
    });
  }

  const edges = (graph?.edges ?? []).flatMap((edge) => {
    const origin = positions.get(edge.originId);
    const target = positions.get(edge.targetId);
    if (!origin || !target) return [];
    const originCenterY = origin.y + origin.height / 2;
    const targetCenterY = target.y + target.height / 2;
    if (origin.x === target.x) {
      const bendX = origin.x - 18;
      return [
        {
          edge,
          path: `M ${origin.x} ${originCenterY} C ${bendX} ${originCenterY}, ${bendX} ${targetCenterY}, ${target.x} ${targetCenterY}`,
        },
      ];
    }
    const leftToRight = origin.x < target.x;
    const startX = leftToRight ? origin.x + origin.width : origin.x;
    const endX = leftToRight ? target.x : target.x + target.width;
    const middleX = Math.round((startX + endX) / 2);
    return [
      {
        edge,
        path: `M ${startX} ${originCenterY} C ${middleX} ${originCenterY}, ${middleX} ${targetCenterY}, ${endX} ${targetCenterY}`,
      },
    ];
  });
  const outgoingWidth = maximumDepth
    ? 32 + maximumDepth * GRAPH_COLUMN_STEP - (GRAPH_COLUMN_STEP - GRAPH_NODE_WIDTH)
    : 0;
  return {
    width: Math.max(520, rootX + GRAPH_ROOT_WIDTH + outgoingWidth + GRAPH_PADDING),
    height,
    rootX,
    rootY,
    nodes,
    edges,
  };
}

function legacySnippetCode(snippet: ReferenceSnippetResponse): CodeViewResponse | null {
  if (snippet.code) return snippet.code;
  if (snippet.content === undefined) return null;
  const content = snippet.content;
  const status = snippet.highlight?.coverageStatus ?? "unknown";
  return {
    view: "source",
    sourceId: null,
    filename: snippet.filename ?? "Unavailable",
    language: "javascript",
    content,
    spans: content ? [{ start: 0, end: content.length, status }] : [],
    offset: 0,
    endOffset: content.length,
    startLine: snippet.startLine ?? 1,
    totalCharacters: content.length,
    hasPrevious: false,
    hasNext: false,
    provenance: "reference-snippet",
    gap: snippet.gap,
  };
}

function moduleGraphOptionLabel(
  instance: ExportModuleInstance,
  references: ModuleReferencesResponse | null,
): string {
  const name =
    references?.module.id === instance.moduleId
      ? moduleDisplayIdentifier(references.module)
      : moduleDisplayIdentifier(instance);
  return instance.chunks.length
    ? `Chunk graph ${instance.chunks.join(", ")} · ${name}`
    : `Unchunked graph · ${name}`;
}

function directionLabel(direction: "in" | "out" | "both"): string {
  return direction === "in" ? "Importers" : direction === "out" ? "Dependencies" : "All";
}

function directionEdgeLabel(direction: "in" | "out" | "both", count: number | null): string {
  const value = count === null ? "—" : count.toLocaleString();
  const edge = count === 1 ? "edge" : "edges";
  return direction === "in"
    ? `${value} importer ${edge}`
    : direction === "out"
      ? `${value} dependency ${edge}`
      : `${value} total ${edge}`;
}

function emptyDirectionLabel(direction: "in" | "out" | "both"): string {
  return direction === "in"
    ? "No importer uses this export"
    : direction === "out"
      ? "No dependency edges captured"
      : "No module edges captured";
}

function edgeForExportReference(
  edges: ReferenceEdgeReport[],
  reference: SourceExportUsage["references"][number],
): ReferenceEdgeReport | undefined {
  if (reference.line === null) return edges[0];
  const lineMatches = edges.filter(
    (edge) => (edge.sourceLocation ?? edge.location)?.start.line === reference.line,
  );
  const referenceColumn = reference.column;
  if (lineMatches.length <= 1 || referenceColumn === null) return lineMatches[0] ?? edges[0];
  return lineMatches.reduce((closest, edge) => {
    const closestColumn = (closest.sourceLocation ?? closest.location)?.start.column;
    const edgeColumn = (edge.sourceLocation ?? edge.location)?.start.column;
    if (edgeColumn === undefined) return closest;
    if (closestColumn === undefined) return edge;
    return Math.abs(edgeColumn - referenceColumn) < Math.abs(closestColumn - referenceColumn)
      ? edge
      : closest;
  });
}

function SnippetCard(props: {
  snippet: ReferenceSnippetResponse | null;
  flashKey: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!props.snippet) return;
    if (ref.current) ref.current.dataset.flashKey = String(props.flashKey);
    ref.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }, [props.snippet, props.flashKey]);
  if (!props.snippet) return null;
  const snippet = props.snippet;
  const code = legacySnippetCode(snippet);
  const filename = code?.filename ?? snippet.filename ?? null;
  const status = snippet.highlight?.coverageStatus ?? "unknown";
  const location = snippet.location;
  return (
    <div className="reference-snippet reference-coverage-detail" ref={ref}>
      <header>
        <div>
          <span>{snippet.kind === "declaration" ? "Export definition" : "Usage location"}</span>
          <strong {...(filename ? copyablePathProps(filename) : {})}>
            {filename ?? "Unavailable"}
          </strong>
        </div>
        <button type="button" aria-label="Close usage location" onClick={props.onClose}>
          ×
        </button>
      </header>
      {snippet.available ? (
        <>
          <div className="snippet-facts">
            <span className={`coverage-badge coverage-${status}`}>{STATUS_LABELS[status]}</span>
            <span>
              Module usage {formatPercent(snippet.coverage?.usageRatio ?? null)} ·{" "}
              {snippet.kind === "declaration" ? "definition" : "use"} at line{" "}
              {location?.start.line ?? "—"}
            </span>
          </div>
          <div className="coverage-code-legend">
            <span>
              <i className="legend-executed" /> executed
            </span>
            <span>
              <i className="legend-unexecuted" /> loaded / unexecuted
            </span>
            <span>
              <i className="legend-unloaded" /> not loaded
            </span>
            <span>
              <i className="legend-not-emitted" /> not emitted
            </span>
            <span>
              <i className="legend-unknown" /> unknown
            </span>
          </div>
          {code ? (
            <SearchableCoverageCode
              key={snippet.edge.id}
              code={code}
              scrollClassName="reference-coverage-scroll"
              highlight={
                snippet.highlight
                  ? {
                      start: snippet.highlight.start,
                      end: snippet.highlight.end,
                      flashKey: props.flashKey,
                    }
                  : null
              }
            />
          ) : (
            <p>Full source code is unavailable.</p>
          )}
        </>
      ) : (
        <p>{snippet.gap}</p>
      )}
    </div>
  );
}

export function ReferencePanel(props: {
  exportUsage: SourceExportUsage | null;
  moduleInstance: ExportModuleInstance | null;
  references: ModuleReferencesResponse | null;
  importerChain?: ExportImporterChainResponse | null;
  direction: "in" | "out" | "both";
  loading: boolean;
  importerChainLoading?: boolean;
  error: string | null;
  importerChainError?: string | null;
  snippet: ReferenceSnippetResponse | null;
  snippetFlashKey: number;
  onDirectionChange: (direction: "in" | "out" | "both") => void;
  onSelectEdge: (edgeId: string) => void;
  onSelectCarrier: (moduleId: string, exportedName: string) => void;
  onLoadMore: () => void;
  onLoadGraphDepth?: (depth: number) => void;
  onModuleChange: (moduleId: string) => void;
  onClose?: () => void;
  onCloseSnippet: () => void;
}) {
  const [expandedChainKey, setExpandedChainKey] = useState<string | null>(null);
  const [workspaceView, setWorkspaceView] = useState<"export" | "module">(() =>
    props.exportUsage ? "export" : "module",
  );
  const [exportView, setExportView] = useState<"graph" | "chain">("graph");
  const graphScrollRef = useRef<HTMLDivElement>(null);
  const references = props.references;
  const exportUsage = props.exportUsage;
  const selectedModuleId = references?.module.id ?? props.moduleInstance?.moduleId ?? "";
  const selectedExportReferences =
    exportUsage?.references.filter((reference) => reference.targetModuleId === selectedModuleId) ??
    [];
  const selectedReferenceCount = exportUsage
    ? (exportUsage.referenceCountByModule[selectedModuleId] ?? selectedExportReferences.length)
    : (references?.counts.in ?? 0);
  const directReferenceModules = new Set(
    selectedExportReferences.map((reference) => reference.moduleId),
  );
  const explicitReferenceModules = new Set(
    references?.edges
      .filter(
        (edge) =>
          edge.targetId === selectedModuleId &&
          exportUsage &&
          edge.exports?.includes(exportUsage.exportedName),
      )
      .map((edge) => edge.originId) ?? [],
  );
  const edgeMatchesExport = (edge: ReferenceEdgeReport) =>
    Boolean(
      exportUsage &&
        edge.active !== false &&
        edge.targetId === selectedModuleId &&
        (edge.exports?.includes(exportUsage.exportedName) ||
          (!edge.exports?.length &&
            directReferenceModules.has(edge.originId) &&
            !explicitReferenceModules.has(edge.originId))),
    );
  const matchingEdge = (reference: SourceExportUsage["references"][number]) =>
    edgeForExportReference(
      references?.edges.filter(
        (edge) =>
          edge.originId === reference.moduleId &&
          edge.targetId === selectedModuleId &&
          edgeMatchesExport(edge),
      ) ?? [],
      reference,
    );
  const displayedEdges = references?.edges ?? [];
  const visibleEdges = displayedEdges.slice(0, 12);
  const moduleLabel =
    (references?.module && moduleDisplayIdentifier(references.module)) ??
    (props.moduleInstance ? moduleDisplayIdentifier(props.moduleInstance) : "Module unavailable");
  const selectedModulePath = references?.module
    ? moduleFullIdentifier(references.module)
    : props.moduleInstance
      ? moduleFullIdentifier(props.moduleInstance)
      : "Module unavailable";
  const importerChain =
    props.importerChain?.module.id === selectedModuleId &&
    props.importerChain.exportedName === exportUsage?.exportedName
      ? props.importerChain
      : null;
  const chainSteps = importerChain?.steps ?? [];
  const directionCounts = references?.counts ?? null;
  const currentDirectionCount = directionCounts?.[props.direction] ?? null;
  const showChainGraph = workspaceView === "export" && Boolean(exportUsage);
  const moduleGraph = workspaceView === "module" ? (references?.graph ?? null) : null;
  const chainDependencies: ReferenceEdgeReport[] = [];
  const chainGraph = layoutChainGraph(chainSteps, chainDependencies);
  const moduleGraphLayout = layoutModuleGraph(moduleGraph, selectedModuleId);
  const fileTones = graphFileTones([
    ...chainGraph.nodes.map(({ step }) => step.edge.originId),
    ...chainGraph.dependencies.map(({ edge }) => edgeNeighbor(edge, selectedModuleId).id),
    ...moduleGraphLayout.nodes.map(({ node }) => node.module.id),
    ...visibleEdges.map((edge) => edgeNeighbor(edge, selectedModuleId).id),
  ]);
  const fileToneClass = (moduleId: string) => `file-tone-${fileTones.get(moduleId) ?? 0}`;
  const moduleGraphDepths = new Map(
    moduleGraph?.nodes.map((node) => [node.module.id, node.depth] as const) ?? [],
  );
  const moduleGraphEdgeForNode = (node: ModuleReferenceGraphNode) => {
    const depth = node.depth;
    const preferred = moduleGraph?.edges.find((edge) => {
      if (depth < 0 && edge.originId === node.module.id) {
        return (moduleGraphDepths.get(edge.targetId) ?? 0) > depth;
      }
      if (depth > 0 && edge.targetId === node.module.id) {
        return (moduleGraphDepths.get(edge.originId) ?? 0) < depth;
      }
      return false;
    });
    return (
      preferred ??
      moduleGraph?.edges.find(
        (edge) => edge.originId === node.module.id || edge.targetId === node.module.id,
      )
    );
  };
  const chainKey = `${selectedModuleId}:${exportUsage?.exportedName ?? ""}`;
  const chainExpanded = expandedChainKey === chainKey;
  const initialChainSteps = collapsedChainSteps(chainSteps);
  const visibleChainSteps = chainExpanded ? chainSteps : initialChainSteps;
  const visibleChainTree = chainTree(visibleChainSteps);
  const graphVisible = showChainGraph || workspaceView === "module";
  const scrollRootX =
    workspaceView === "module" && moduleGraph ? moduleGraphLayout.rootX : chainGraph.rootX;
  const scrollRootY =
    workspaceView === "module" && moduleGraph ? moduleGraphLayout.rootY : chainGraph.rootY;
  useEffect(() => {
    const graph = graphScrollRef.current;
    if (!graph || !graphVisible) return;
    graph.scrollLeft = Math.max(0, scrollRootX + GRAPH_ROOT_WIDTH / 2 - graph.clientWidth / 2);
    graph.scrollTop = Math.max(0, scrollRootY + GRAPH_ROOT_HEIGHT / 2 - graph.clientHeight / 2);
  }, [graphVisible, scrollRootX, scrollRootY]);
  const renderChainNodes = (nodes: ChainTreeNode[]) => (
    <ol>
      {nodes.map(({ step, children }) => {
        const path = chainStepPath(step);
        return (
          <li key={step.id}>
            <div className="export-chain-step">
              <button
                type="button"
                className="export-chain-usage"
                onClick={() => props.onSelectEdge(step.usageEdgeId ?? step.edge.id)}
                aria-label={`Open importer chain usage ${path}`}
              >
                <span>{step.depth === 1 ? "direct importer" : "used by"}</span>
                <strong {...copyablePathProps(path)}>{chainStepName(step)}</strong>
                <small>
                  {chainStepRelation(step)} · {edgeLocation(step.edge)}
                </small>
                <code {...copyablePathProps(path)}>{path}</code>
              </button>
              {step.importerBindings.length ? (
                <details className="export-carrier-menu">
                  <summary>
                    Carried by {step.importerBindings.length.toLocaleString()} symbol
                    {step.importerBindings.length === 1 ? "" : "s"}
                  </summary>
                  <div>
                    {step.importerBindings.map((binding) => (
                      <button
                        type="button"
                        key={binding.exportPath?.join(".") ?? binding.exportedName}
                        onClick={() =>
                          props.onSelectCarrier(step.edge.origin.id, binding.exportedName)
                        }
                      >
                        <strong>{bindingLabel(binding)}</strong>
                        <small>Open definition and continue this branch</small>
                      </button>
                    ))}
                  </div>
                </details>
              ) : (
                <span className="export-chain-terminal">Module execution · chain ends here</span>
              )}
            </div>
            {children.length ? renderChainNodes(children) : null}
          </li>
        );
      })}
    </ol>
  );
  return (
    <aside
      className={`reference-workbench${props.snippet ? " has-snippet" : ""}`}
      aria-label="Export references and module graph"
    >
      <div className="reference-toolbar">
        <div>
          <span className="eyebrow">
            {exportUsage ? "Export investigation" : "Module investigation"}
          </span>
          <h3>{exportUsage?.exportedName ?? "Module graph"}</h3>
        </div>
        <div className="reference-toolbar-actions">
          <span className="reference-count" title="Direct importer references">
            {exportUsage
              ? selectedReferenceCount.toLocaleString()
              : (currentDirectionCount?.toLocaleString() ?? "—")}
          </span>
          {props.onClose ? (
            <button
              type="button"
              className="reference-close-button"
              aria-label="Back to source code"
              onClick={props.onClose}
            >
              ×
            </button>
          ) : null}
        </div>
      </div>

      {exportUsage ? (
        <nav className="reference-view-tabs" aria-label="Investigation view">
          <button
            type="button"
            className={workspaceView === "export" ? "active" : ""}
            aria-pressed={workspaceView === "export"}
            onClick={() => setWorkspaceView("export")}
          >
            Export Usage
          </button>
          <button
            type="button"
            className={workspaceView === "module" ? "active" : ""}
            aria-pressed={workspaceView === "module"}
            onClick={() => setWorkspaceView("module")}
          >
            Module Graph
          </button>
        </nav>
      ) : null}

      <div className={`reference-workspace${props.snippet ? " has-snippet" : ""}`}>
        <div className="reference-navigation">
          {exportUsage ? (
            <section
              className="export-reference-chain"
              aria-label="Export importer chain"
              hidden={workspaceView !== "export"}
            >
              <div className="export-chain-summary">
                <div>
                  <span className="eyebrow">Importer chain</span>
                  <strong>
                    {bindingLabel(
                      importerChain?.binding ?? {
                        exportedName: exportUsage.exportedName,
                        localName: exportUsage.localName,
                      },
                    )}
                  </strong>
                </div>
                <span className={`export-state state-${exportUsage.state}`}>
                  {EXPORT_STATE_LABELS[exportUsage.state]}
                </span>
              </div>
              <div className="export-chain-facts">
                <span>
                  <small>Precision</small>
                  {PRECISION_LABELS[exportUsage.precision]}
                </span>
                <span>
                  <small>Direct refs</small>
                  {selectedReferenceCount.toLocaleString()}
                </span>
                <span>
                  <small>Modules</small>
                  {exportUsage.moduleInstances.length.toLocaleString()}
                </span>
                <span>
                  <small>Ownership</small>
                  {importerChain?.precision === "native"
                    ? "Rspack graph"
                    : importerChain?.precision === "mixed"
                      ? "Rspack + inferred"
                      : "Source inferred"}
                </span>
              </div>
              <nav className="export-view-tabs" aria-label="Export usage presentation">
                <button
                  type="button"
                  className={exportView === "graph" ? "active" : ""}
                  aria-pressed={exportView === "graph"}
                  onClick={() => setExportView("graph")}
                >
                  Graph
                </button>
                <button
                  type="button"
                  className={exportView === "chain" ? "active" : ""}
                  aria-pressed={exportView === "chain"}
                  onClick={() => setExportView("chain")}
                >
                  Chain
                </button>
              </nav>
              <div hidden={exportView !== "chain"}>
                {props.importerChainLoading ? (
                  <div className="export-chain-loading">Tracing importer exports…</div>
                ) : importerChain?.steps.length ? (
                  <section
                    className="export-importer-chain-list"
                    aria-label="Transitive export importer chain"
                  >
                    {renderChainNodes(visibleChainTree)}
                    {chainSteps.length > initialChainSteps.length ? (
                      <button
                        type="button"
                        className="export-chain-toggle"
                        onClick={() => setExpandedChainKey(chainExpanded ? null : chainKey)}
                      >
                        {chainExpanded
                          ? "Show first 3 chain levels"
                          : `Show all ${chainSteps.length.toLocaleString()} chain steps`}
                      </button>
                    ) : null}
                    {importerChain.truncated ? (
                      <div className="export-chain-note">
                        The importer chain reached its bounded {importerChain.maxDepth}-level
                        preview.
                      </div>
                    ) : null}
                    {importerChain.diagnostics?.[0] ? (
                      <div className="export-chain-note">{importerChain.diagnostics[0]}</div>
                    ) : null}
                  </section>
                ) : props.importerChainError ? (
                  <div className="export-chain-note">
                    Importer chain unavailable: {props.importerChainError}
                  </div>
                ) : null}
                {importerChain?.precision === "native" ? null : selectedExportReferences.length ? (
                  <div className="export-reference-list">
                    {selectedExportReferences.map((reference, index) => {
                      const edge = matchingEdge(reference);
                      const key = `${reference.moduleId}:${reference.line}:${reference.column}:${index}`;
                      const content = (
                        <>
                          <span>← importer · {reference.dependencyType || "module reference"}</span>
                          <strong {...copyablePathProps(reference.path)}>{reference.path}</strong>
                          <small>
                            {referenceLocation(reference.line, reference.column)} ·{" "}
                            {reference.referencedPath?.join(".") ||
                              reference.request ||
                              "export usage"}
                          </small>
                          {reference.snippet ? <code>{reference.snippet}</code> : null}
                        </>
                      );
                      return edge ? (
                        <button
                          type="button"
                          key={key}
                          onClick={() => props.onSelectEdge(edge.id)}
                          aria-label={`Open importer usage ${reference.path}`}
                        >
                          {content}
                        </button>
                      ) : (
                        <div key={key}>{content}</div>
                      );
                    })}
                  </div>
                ) : selectedReferenceCount > 0 ? (
                  <div className="export-chain-empty">
                    {selectedReferenceCount.toLocaleString()} importer references were captured for
                    this module graph, but their location details are outside the retained preview.
                  </div>
                ) : (
                  <div className="export-chain-empty">
                    No importer uses this export in the selected module graph. Structural module
                    edges remain available below.
                  </div>
                )}
                {exportUsage.truncated ? (
                  <div className="export-chain-note">
                    Only the first captured direct references are shown.
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}

          <div className="module-graph-toolbar" hidden={workspaceView !== "module"}>
            <div>
              <span className="eyebrow">
                {showChainGraph ? "Complete export usage graph" : "Corresponding module graph"}
              </span>
              <strong {...copyablePathProps(selectedModulePath)}>{moduleLabel}</strong>
            </div>
            <span>{directionEdgeLabel(props.direction, currentDirectionCount)}</span>
          </div>
          {workspaceView === "module" && exportUsage && exportUsage.moduleInstances.length > 1 ? (
            <label className="module-graph-picker">
              Module graph
              <select
                value={props.moduleInstance?.moduleId ?? selectedModuleId}
                {...copyablePathProps(selectedModulePath)}
                onChange={(event) => props.onModuleChange(event.target.value)}
              >
                {exportUsage.moduleInstances.map((instance) => (
                  <option
                    value={instance.moduleId}
                    key={instance.moduleId}
                    title={moduleFullIdentifier(instance)}
                  >
                    {moduleGraphOptionLabel(instance, references)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <fieldset className="segmented reference-direction" hidden={workspaceView !== "module"}>
            <legend className="sr-only">Reference direction</legend>
            {(["in", "both", "out"] as const).map((direction) => (
              <button
                type="button"
                className={props.direction === direction ? "active" : ""}
                key={direction}
                aria-label={`${directionLabel(direction)}: ${directionCounts?.[direction].toLocaleString() ?? "unknown"} ${directionCounts?.[direction] === 1 ? "edge" : "edges"}`}
                onClick={() => props.onDirectionChange(direction)}
              >
                <span>{directionLabel(direction)}</span>
                <small>{directionCounts?.[direction].toLocaleString() ?? "—"}</small>
              </button>
            ))}
          </fieldset>
          {workspaceView === "module" && references?.entryPath.length ? (
            <nav className="entry-path" aria-label="Shortest path to an entry">
              <small>Shortest path to entry</small>
              <div>
                {references.entryPath.map((module, index) => (
                  <span key={module.id} {...copyablePathProps(moduleFullIdentifier(module))}>
                    {index ? "→ " : ""}
                    {moduleDisplayIdentifier(module)}
                  </span>
                ))}
              </div>
            </nav>
          ) : null}
          <div
            className={`reference-graph-wrap${showChainGraph ? " is-chain" : ""}${workspaceView === "module" && moduleGraph ? " is-transitive" : ""}`}
            ref={graphScrollRef}
            hidden={workspaceView === "export" && exportView !== "graph"}
          >
            {props.loading || (workspaceView === "export" && props.importerChainLoading) ? (
              <div className="reference-loading">Loading references…</div>
            ) : null}
            {props.error ? <div className="reference-error">{props.error}</div> : null}
            {selectedModuleId && showChainGraph ? (
              <svg
                className="reference-graph is-chain"
                viewBox={`0 0 ${chainGraph.width} ${chainGraph.height}`}
                width={chainGraph.width}
                height={chainGraph.height}
                role="img"
              >
                <title>
                  {props.direction === "both"
                    ? "Complete importer export chain and module dependencies"
                    : "Complete importer export chain"}
                </title>
                {chainGraph.groups.map((group) => (
                  <g
                    className={`graph-file-group ${fileToneClass(group.moduleId)}${group.count > 1 ? " is-multi" : ""}`}
                    data-module-id={group.moduleId}
                    key={group.key}
                  >
                    <rect
                      x={group.x}
                      y={group.y}
                      width={group.width}
                      height={group.height}
                      rx="11"
                    />
                  </g>
                ))}
                <g className="graph-current-module" {...copyablePathProps(selectedModulePath)}>
                  <title>{selectedModulePath}</title>
                  <rect
                    className="graph-center"
                    x={chainGraph.rootX}
                    y={chainGraph.rootY}
                    width={GRAPH_ROOT_WIDTH}
                    height={GRAPH_ROOT_HEIGHT}
                    rx="10"
                  />
                  <text
                    className="graph-label graph-label-center"
                    x={chainGraph.rootX + GRAPH_ROOT_WIDTH / 2}
                    y={chainGraph.rootY + 24}
                    textAnchor="middle"
                  >
                    {compactModuleIdentifier(moduleLabel, 27)}
                  </text>
                  <text
                    className="graph-export graph-export-center"
                    x={chainGraph.rootX + GRAPH_ROOT_WIDTH / 2}
                    y={chainGraph.rootY + 42}
                    textAnchor="middle"
                  >
                    {exportUsage?.exportedName ?? "module"}
                  </text>
                </g>
                {chainGraph.nodes.map(({ step, x, y, parentX, parentY }) => {
                  const startX = x + GRAPH_NODE_WIDTH;
                  const startY = y + GRAPH_NODE_HEIGHT / 2;
                  const endX = parentX;
                  const endY =
                    parentY + (step.parentId === null ? GRAPH_ROOT_HEIGHT : GRAPH_NODE_HEIGHT) / 2;
                  const middleX = Math.round((startX + endX) / 2);
                  const name = moduleDisplayIdentifier(step.edge.origin);
                  const path = chainStepPath(step);
                  return (
                    <a
                      className={`graph-node is-export-edge is-chain-step ${fileToneClass(step.edge.originId)}`}
                      data-module-id={step.edge.originId}
                      key={step.id}
                      href={`#reference-${step.usageEdgeId ?? step.edge.id}`}
                      aria-label={`Show usage ${name}`}
                      {...copyablePathProps(path)}
                      onClick={(event) => {
                        event.preventDefault();
                        props.onSelectEdge(step.usageEdgeId ?? step.edge.id);
                      }}
                    >
                      <title>{path}</title>
                      <path
                        className="graph-edge"
                        d={`M ${startX} ${startY} C ${middleX} ${startY}, ${middleX} ${endY}, ${endX} ${endY}`}
                      />
                      <rect
                        x={x}
                        y={y}
                        width={GRAPH_NODE_WIDTH}
                        height={GRAPH_NODE_HEIGHT}
                        rx="8"
                      />
                      <text className="graph-label" x={x + 10} y={y + 19}>
                        {compactModuleIdentifier(name, 21)}
                      </text>
                      <text className="graph-export" x={x + 10} y={y + 34}>
                        {shortName(bindingLabel(step.importedBinding), 24)}
                      </text>
                    </a>
                  );
                })}
                {chainGraph.dependencies.map(({ edge, x, y }) => {
                  const neighbor = edgeNeighbor(edge, selectedModuleId);
                  const name = moduleDisplayIdentifier(neighbor);
                  const path = moduleFullIdentifier(neighbor);
                  const startX = chainGraph.rootX + GRAPH_ROOT_WIDTH;
                  const startY = chainGraph.rootY + GRAPH_ROOT_HEIGHT / 2;
                  const endY = y + GRAPH_NODE_HEIGHT / 2;
                  const middleX = Math.round((startX + x) / 2);
                  return (
                    <a
                      className={`graph-node is-dependency ${fileToneClass(neighbor.id)}`}
                      data-module-id={neighbor.id}
                      key={edge.id}
                      href={`#reference-${edge.id}`}
                      aria-label={`Show usage ${name}`}
                      {...copyablePathProps(path)}
                      onClick={(event) => {
                        event.preventDefault();
                        props.onSelectEdge(edge.id);
                      }}
                    >
                      <title>{path}</title>
                      <path
                        className="graph-edge"
                        d={`M ${startX} ${startY} C ${middleX} ${startY}, ${middleX} ${endY}, ${x} ${endY}`}
                      />
                      <rect
                        x={x}
                        y={y}
                        width={GRAPH_NODE_WIDTH}
                        height={GRAPH_NODE_HEIGHT}
                        rx="8"
                      />
                      <text className="graph-label" x={x + 10} y={y + 19}>
                        {compactModuleIdentifier(name, 21)}
                      </text>
                      <text className="graph-export" x={x + 10} y={y + 34}>
                        {shortName(
                          edge.exports?.join(", ") ||
                            edge.request ||
                            edge.dependencyType ||
                            "module edge",
                          24,
                        )}
                      </text>
                    </a>
                  );
                })}
                <text
                  className="graph-chain-summary"
                  x={chainGraph.rootX + GRAPH_ROOT_WIDTH / 2}
                  y={chainGraph.rootY + GRAPH_ROOT_HEIGHT + 18}
                  textAnchor="middle"
                >
                  {chainSteps.length.toLocaleString()} chain steps
                  {importerChain?.truncated ? " · bounded preview" : ""}
                </text>
                {!props.importerChainLoading && chainSteps.length === 0 ? (
                  <text
                    className="graph-empty-label"
                    x={chainGraph.rootX + GRAPH_ROOT_WIDTH / 2}
                    y={chainGraph.rootY - 18}
                    textAnchor="middle"
                  >
                    No importer export carries this symbol further
                  </text>
                ) : null}
              </svg>
            ) : selectedModuleId && moduleGraph ? (
              <svg
                className="reference-graph is-module-graph"
                viewBox={`0 0 ${moduleGraphLayout.width} ${moduleGraphLayout.height}`}
                width={moduleGraphLayout.width}
                height={moduleGraphLayout.height}
                role="img"
              >
                <title>Transitive structural module graph</title>
                <g className="module-graph-edges">
                  {moduleGraphLayout.edges.map(({ edge, path }) => (
                    <path
                      className="graph-edge"
                      data-origin-id={edge.originId}
                      data-target-id={edge.targetId}
                      d={path}
                      key={`${edge.originId}:${edge.targetId}`}
                    />
                  ))}
                </g>
                <g className="graph-current-module" {...copyablePathProps(selectedModulePath)}>
                  <title>{selectedModulePath}</title>
                  <rect
                    className="graph-center"
                    x={moduleGraphLayout.rootX}
                    y={moduleGraphLayout.rootY}
                    width={GRAPH_ROOT_WIDTH}
                    height={GRAPH_ROOT_HEIGHT}
                    rx="10"
                  />
                  <text
                    className="graph-label graph-label-center"
                    x={moduleGraphLayout.rootX + GRAPH_ROOT_WIDTH / 2}
                    y={moduleGraphLayout.rootY + 24}
                    textAnchor="middle"
                  >
                    {compactModuleIdentifier(moduleLabel, 27)}
                  </text>
                  <text
                    className="graph-export graph-export-center"
                    x={moduleGraphLayout.rootX + GRAPH_ROOT_WIDTH / 2}
                    y={moduleGraphLayout.rootY + 42}
                    textAnchor="middle"
                  >
                    {exportUsage?.exportedName ?? "module"}
                  </text>
                </g>
                {moduleGraphLayout.nodes.map(({ node, x, y }) => {
                  const edge = moduleGraphEdgeForNode(node);
                  const name = moduleDisplayIdentifier(node.module);
                  const path = moduleFullIdentifier(node.module);
                  const edgeLabel = edge
                    ? `${edge.referenceCount > 1 ? `${edge.referenceCount} refs · ` : ""}${edge.exports?.join(", ") || edge.dependencyType || "module edge"}`
                    : "module edge";
                  return (
                    <a
                      className={`graph-node is-module-node ${fileToneClass(node.module.id)}`}
                      data-module-id={node.module.id}
                      data-depth={node.depth}
                      key={node.module.id}
                      href={edge ? `#reference-${edge.id}` : `#module-${node.module.id}`}
                      aria-label={`Show usage ${name}`}
                      {...copyablePathProps(path)}
                      onClick={(event) => {
                        event.preventDefault();
                        if (edge) props.onSelectEdge(edge.id);
                      }}
                    >
                      <title>{path}</title>
                      <rect
                        x={x}
                        y={y}
                        width={GRAPH_NODE_WIDTH}
                        height={GRAPH_NODE_HEIGHT}
                        rx="8"
                      />
                      <text className="graph-label" x={x + 10} y={y + 19}>
                        {compactModuleIdentifier(name, 21)}
                      </text>
                      <text className="graph-export" x={x + 10} y={y + 34}>
                        {shortName(edgeLabel, 24)}
                      </text>
                    </a>
                  );
                })}
              </svg>
            ) : selectedModuleId ? (
              <svg className="reference-graph" viewBox="0 0 520 330" role="img">
                <title>
                  {props.direction === "in"
                    ? "Importers using the current module export"
                    : "Corresponding module and its structural module edges"}
                </title>
                <g className="graph-current-module" {...copyablePathProps(selectedModulePath)}>
                  <title>{selectedModulePath}</title>
                  <rect className="graph-center" x="170" y="135" width="180" height="58" rx="10" />
                  <text
                    className="graph-label graph-label-center"
                    x="260"
                    y="159"
                    textAnchor="middle"
                  >
                    {compactModuleIdentifier(moduleLabel, 27)}
                  </text>
                  <text
                    className="graph-export graph-export-center"
                    x="260"
                    y="177"
                    textAnchor="middle"
                  >
                    {exportUsage?.exportedName ?? "module"}
                  </text>
                </g>
                {visibleEdges.map((edge) => {
                  const incoming = edge.targetId === selectedModuleId;
                  const sideEdges = visibleEdges.filter(
                    (candidate) => (candidate.targetId === selectedModuleId) === incoming,
                  );
                  const sideIndex = sideEdges.findIndex((candidate) => candidate.id === edge.id);
                  const x = incoming ? 8 : 372;
                  const y = 18 + sideIndex * Math.min(62, 285 / Math.max(1, sideEdges.length));
                  const lineStartX = incoming ? x + 140 : 350;
                  const lineEndX = incoming ? 170 : x;
                  const lineY = y + 22;
                  const lineStartY = incoming ? lineY : 164;
                  const lineEndY = incoming ? 164 : lineY;
                  const neighbor = edgeNeighbor(edge, selectedModuleId);
                  const name = moduleDisplayIdentifier(neighbor);
                  const path = moduleFullIdentifier(neighbor);
                  return (
                    <a
                      className={`graph-node ${fileToneClass(neighbor.id)}${edgeMatchesExport(edge) ? " is-export-edge" : ""}`}
                      data-module-id={neighbor.id}
                      key={edge.id}
                      href={`#reference-${edge.id}`}
                      aria-label={`Show usage ${name}`}
                      {...copyablePathProps(path)}
                      onClick={(event) => {
                        event.preventDefault();
                        props.onSelectEdge(edge.id);
                      }}
                    >
                      <title>{path}</title>
                      <line
                        className="graph-edge"
                        x1={lineStartX}
                        y1={lineStartY}
                        x2={lineEndX}
                        y2={lineEndY}
                      />
                      <rect x={x} y={y} width="140" height="44" rx="8" />
                      <text className="graph-label" x={x + 10} y={y + 19}>
                        {compactModuleIdentifier(name, 20)}
                      </text>
                      <text className="graph-export" x={x + 10} y={y + 34}>
                        {edge.exports?.join(", ") || edge.dependencyType || "module edge"}
                      </text>
                    </a>
                  );
                })}
                {!props.loading && references && visibleEdges.length === 0 ? (
                  <text className="graph-empty-label" x="260" y="232" textAnchor="middle">
                    {emptyDirectionLabel(props.direction)}
                  </text>
                ) : null}
              </svg>
            ) : (
              <div className="reference-empty">
                No module instance is available for this export.
              </div>
            )}
          </div>
          {workspaceView === "module" && moduleGraph ? (
            <div className="module-graph-summary" role="status">
              <span>
                {moduleGraph.reachedDepth.toLocaleString()} level
                {moduleGraph.reachedDepth === 1 ? "" : "s"} ·{" "}
                {moduleGraph.nodes.length.toLocaleString()} modules ·{" "}
                {moduleGraph.edges.length.toLocaleString()} module edges
              </span>
              {moduleGraph.truncation.depth &&
              !moduleGraph.truncation.nodes &&
              !moduleGraph.truncation.edges &&
              moduleGraph.requestedDepth < moduleGraph.limits.maxDepth &&
              props.onLoadGraphDepth ? (
                <button
                  type="button"
                  onClick={() =>
                    props.onLoadGraphDepth?.(
                      Math.min(moduleGraph.limits.maxDepth, moduleGraph.requestedDepth + 2),
                    )
                  }
                >
                  Show 2 more levels
                </button>
              ) : null}
              {moduleGraph.truncation.nodes || moduleGraph.truncation.edges ? (
                <small>
                  Preview capped at {moduleGraph.limits.maxNodes.toLocaleString()} modules and{" "}
                  {moduleGraph.limits.maxEdges.toLocaleString()} edges.
                </small>
              ) : moduleGraph.truncation.perModule ? (
                <small>High-fan-out modules are shown as a bounded preview.</small>
              ) : moduleGraph.truncation.depth &&
                moduleGraph.requestedDepth >= moduleGraph.limits.maxDepth ? (
                <small>Preview reached the {moduleGraph.limits.maxDepth}-level safety bound.</small>
              ) : null}
            </div>
          ) : null}
          {workspaceView === "module" && displayedEdges.length ? (
            <div className="reference-list">
              {displayedEdges.map((edge) => {
                const neighbor = edgeNeighbor(edge, selectedModuleId);
                const incoming = edge.targetId === selectedModuleId;
                const path = moduleFullIdentifier(neighbor);
                return (
                  <button
                    type="button"
                    className={edgeMatchesExport(edge) ? "is-export-edge" : undefined}
                    key={edge.id}
                    onClick={() => props.onSelectEdge(edge.id)}
                  >
                    <span>{incoming ? "← importer" : "→ dependency"}</span>
                    <strong {...copyablePathProps(path)}>
                      {moduleDisplayIdentifier(neighbor)}
                    </strong>
                    <small>
                      {edge.exports?.join(", ") || edge.request || edge.dependencyType || "module"}
                    </small>
                  </button>
                );
              })}
            </div>
          ) : null}
          {workspaceView === "module" &&
          references?.nextCursor !== null &&
          references?.nextCursor !== undefined ? (
            <button className="load-more-references" type="button" onClick={props.onLoadMore}>
              Load more references
            </button>
          ) : null}
        </div>
        <SnippetCard
          snippet={props.snippet}
          flashKey={props.snippetFlashKey}
          onClose={props.onCloseSnippet}
        />
      </div>
    </aside>
  );
}
