/**
 * WorkflowEdge — the user-drawn connection between workflow-participable
 * tiles (trigger→agent, agent→agent, agent→cmdButton). Unlike the ephemeral
 * `dataflow`/`spawn` edges in canvas-pipe-edge.tsx, this edge is Handle-
 * anchored (both endpoints come from real `<Handle>`s — see canvas-nodes.tsx),
 * so it uses xyflow's given coordinates directly via `getBezierPath`, no
 * floating-edge intersection math needed.
 *
 * Quiet/static at rest — a small dot badge shows whether a prompt is set (a
 * fresh connect leaves it empty until the popover is saved — see
 * EdgePromptPopover). While the edge is the one the workflow engine is
 * currently executing (`data.active`), it switches to the same animated
 * traveling-dot idiom as DataFlowEdge so a run is visibly "moving" through
 * the graph. Double-click opens the prompt popover (wired in Canvas.tsx).
 */
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";

export interface WorkflowEdgeRenderData {
  active?: boolean;
  hasPrompt?: boolean;
  [key: string]: unknown;
}

export function WorkflowEdgeComponent({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, data,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition,
  });
  const d = (data ?? {}) as WorkflowEdgeRenderData;
  const active = !!d.active;
  const hasPrompt = !!d.hasPrompt;
  const color = active ? "var(--color-brand)" : hasPrompt ? "var(--color-fg2)" : "var(--color-err)";

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{ stroke: color, strokeWidth: active ? 3.5 : 2.5, strokeOpacity: active ? 0.95 : 0.7, ...style }}
      />
      {active && (
        <circle r={4} fill="var(--color-brand)">
          <animateMotion dur="1.2s" repeatCount="indefinite" path={edgePath} />
        </circle>
      )}
      {/* A prompt-less edge (fresh connect, popover dismissed empty) reads as
          an error state — the run will refuse to fire it — so flag it inline
          rather than only at run time. */}
      {!hasPrompt && !active && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-none absolute text-[9px] font-medium px-1 py-0.5 rounded"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              background: "var(--color-bg2)",
              color: "var(--color-err)",
              border: "1px solid var(--color-err)",
            }}
          >
            no prompt
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/** Stable edgeTypes entry for <ReactFlow edgeTypes={{...pipeEdgeTypes, ...workflowEdgeTypes}}>. */
export const workflowEdgeTypes = { workflow: WorkflowEdgeComponent };
