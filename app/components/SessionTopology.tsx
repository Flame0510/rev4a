// @ts-nocheck
'use client';

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as d3 from 'd3';
import type { AgentOption, Session, TreeNode } from '@/lib/types';
import { buildSessionTree, topologyFitKey, layoutTree, nodeLabel as nodeText, truncateLabel, LABEL_DY, COST_DY } from '@/lib/patterns/sessionPresentation';

interface SessionTopologyProps {
  sessions: Session[];
  /** The containers, for the agent names and the stopped mark. */
  agents?: AgentOption[];
  filter: string;
  onNodeClick: (sessionId: string) => void;
  emptyMessage?: string;
}

export interface SessionTopologyHandle {
  resetView: () => void;
}

function formatCost(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'not priced';
  return `$${Number(value).toFixed(4)}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/** The cost line under a node; none for a container node. */
function costText(d: TreeNode): string | null {
  return d._agentNode || d._virtualRoot ? null : formatCost(d.cost_usd);
}

function draw(
  svgEl: SVGSVGElement,
  tooltipEl: HTMLDivElement | null,
  width: number,
  height: number,
  treeData: TreeNode,
  isTouch: boolean,
  onNodeClick: (id: string) => void,
  registerReset: (reset: () => void) => void,
): boolean {
  const svg = d3.select(svgEl);
  const fitWasRunning = d3.active(svgEl) !== null;
  // A fit transition scheduled by the previous draw would otherwise drive the old zoom behaviour
  // and leave the new <g> half-way.
  svg.interrupt();
  svg.selectAll('*').remove();
  svg.attr('viewBox', `0 0 ${width} ${height}`);

  const g = svg.append('g');
  const content = g.append('g').attr('transform', 'translate(40,20)');

  const zoom = d3.zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.05, 5])
    .on('zoom', (event) => g.attr('transform', event.transform));
  svg.call(zoom).on('dblclick.zoom', null);
  // A redraw (new data, a resize) keeps the current pan/zoom instead of snapping back to identity.
  g.attr('transform', d3.zoomTransform(svgEl).toString());

  const root = d3.hierarchy<TreeNode>(treeData);
  // Positions come from the measured layout: x is the depth column, y the vertical slot.
  const boxes = new Map(layoutTree(treeData, (n) => [truncateLabel(nodeText(n)), costText(n) ?? '']).map((b) => [b.node, b]));
  root.each((d) => {
    const b = boxes.get(d.data)!;
    (d as any).px = b.x;
    (d as any).py = b.y;
  });

  const linkGen = d3
    .linkHorizontal<d3.HierarchyPointLink<TreeNode>, d3.HierarchyPointNode<TreeNode>>()
    .x((d: any) => d.px)
    .y((d: any) => d.py);

  content
    .selectAll('.link')
    .data(root.links().filter((l) => !l.source.data._virtualRoot))
    .join('path')
    .attr('class', 'link')
    .attr('d', linkGen as any)
    .attr('fill', 'none');

  let lastActivation = { id: '', ts: 0 };
  const activateNode = (d: d3.HierarchyPointNode<TreeNode>) => {
    const id = d.data.uid;
    if (!id || d.data._virtualRoot || d.data._agentNode) return;
    const now = Date.now();
    if (lastActivation.id === id && now - lastActivation.ts < 250) return;
    lastActivation = { id, ts: now };
    onNodeClick(id);
  };

  const node = content
    .selectAll<SVGGElement, d3.HierarchyPointNode<TreeNode>>('.node')
    .data(root.descendants().filter((d) => !d.data._virtualRoot))
    .join('g')
    .attr('class', (d) => `node ${d.data._agentNode ? 'agent' : d.data.state ?? 'idle'}${d.data.stopped ? ' stopped' : ''}`)
    .attr('transform', (d) => `translate(${(d as any).px},${(d as any).py})`)
    .on('mousemove', (event: MouseEvent, d) => {
      if (isTouch || !tooltipEl) return;
      tooltipEl.style.display = 'block';
      const tx = event.clientX + 18;
      const ty = event.clientY + 18;
      // Keep tooltip inside viewport
      const tw = tooltipEl.offsetWidth || 200;
      const th = tooltipEl.offsetHeight || 80;
      tooltipEl.style.left = `${Math.min(tx, window.innerWidth - tw - 8)}px`;
      tooltipEl.style.top = `${Math.min(ty, window.innerHeight - th - 8)}px`;
      tooltipEl.innerHTML = (d.data._agentNode
        ? [`<div><strong>${escapeHtml(nodeText(d.data))}</strong></div>`, `<div>container: ${escapeHtml(d.data.container ?? '-')}</div>`]
        : [
            `<div><strong>${escapeHtml(d.data.name)}</strong></div>`,
            `<div>agent: ${escapeHtml(d.data.container ?? '-')}</div>`,
            `<div>kind: ${escapeHtml(d.data.kind ?? '-')}</div>`,
            `<div>model: ${escapeHtml(d.data.model ?? '-')}</div>`,
            `<div>cost: ${escapeHtml(formatCost(d.data.cost_usd))}</div>`,
            `<div>status: ${escapeHtml(d.data.state ?? 'idle')}</div>`,
            ...(d.data.hint ? [`<div>${escapeHtml(d.data.hint)}</div>`] : []),
          ]
      ).join('');
    })
    .on('mouseleave', () => {
      if (tooltipEl) tooltipEl.style.display = 'none';
    })
    .on('pointerup', (_: PointerEvent, d) => activateNode(d))
    .on('click', (_: MouseEvent, d) => activateNode(d));

  node
    .filter((d) => d.data.state === 'working')
    .append('circle')
    .attr('class', 'pulse-ring')
    .attr('r', 10);

  node.append('circle').attr('r', 8);

  node
    .append('text')
    .text((d) => truncateLabel(nodeText(d.data)))
    .attr('dy', LABEL_DY)
    .attr('text-anchor', 'middle')
    .style('font-size', '10px')
    .style('fill', '#d6e2e8');

  node
    .filter((d) => costText(d.data) !== null)
    .append('text')
    .text((d) => costText(d.data) as string)
    .attr('dy', COST_DY)
    .attr('text-anchor', 'middle')
    .style('font-size', '10px')
    .style('fill', '#89a1ad');

  const resetView = () => {
    const contentNode = content.node();
    if (!contentNode) return;

    const bbox = contentNode.getBBox();
    if (!bbox.width || !bbox.height) {
      svg.transition().duration(250).call(zoom.transform, d3.zoomIdentity.translate(40, 20));
      return;
    }

    const padX = isTouch ? 24 : 48;
    const padY = isTouch ? 24 : 36;
    const scale = Math.max(
      0.05,
      Math.min(
        1.5,
        (width - padX * 2) / bbox.width,
        (height - padY * 2) / bbox.height,
      ),
    );
    const tx = width / 2 - (bbox.x + bbox.width / 2) * scale;
    const ty = height / 2 - (bbox.y + bbox.height / 2) * scale;

    svg
      .transition()
      .duration(250)
      .call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
  };

  registerReset(resetView);
  return fitWasRunning;
}

const SessionTopology = forwardRef<SessionTopologyHandle, SessionTopologyProps>(function SessionTopology(
  { sessions, agents = [], filter, onNodeClick, emptyMessage = 'No sessions visible' },
  ref,
) {
  const svgRef = useRef<SVGSVGElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const resetRef = useRef<() => void>(() => {});
  const prevFitKeyRef = useRef<string>('');
  const fitFrameRef = useRef<number | null>(null);
  const pendingFitRef = useRef(false);
  const [isTouch, setIsTouch] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  const treeData = useMemo(() => buildSessionTree(sessions, agents, filter), [sessions, agents, filter]);
  const hasVisibleNodes = useMemo(() => (treeData.children ?? []).some((node) => node._agentNode ? (node.children?.length ?? 0) > 0 : true), [treeData]);
  const fitKey = useMemo(() => topologyFitKey(filter, treeData), [filter, treeData]);

  useImperativeHandle(ref, () => ({
    resetView: () => resetRef.current(),
  }), []);

  useEffect(() => {
    const check = () => {
      const coarse = window.matchMedia?.('(pointer: coarse)')?.matches;
      setIsTouch(Boolean(coarse || window.innerWidth < 768));
    };
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  useEffect(() => {
    if (!hasVisibleNodes) {
      resetRef.current = () => {};
      prevFitKeyRef.current = '';
    }
  }, [hasVisibleNodes]);

  useEffect(() => () => {
    if (fitFrameRef.current !== null) {
      cancelAnimationFrame(fitFrameRef.current);
    }
  }, []);

  useEffect(() => {
    const svgEl = svgRef.current;
    const tooltipEl = tooltipRef.current;
    if (!svgEl || !hasVisibleNodes) return;
    // A wanted fit stays pending until it has really run: an effect re-run (a poll, isTouch settling)
    // can cancel the scheduled frame before it fires, and the next run must schedule it again.
    if (fitKey !== prevFitKeyRef.current) pendingFitRef.current = true;
    prevFitKeyRef.current = fitKey;

    const scheduleAutoFit = () => {
      if (fitFrameRef.current !== null) {
        cancelAnimationFrame(fitFrameRef.current);
      }

      let attempts = 0;
      const runFit = () => {
        fitFrameRef.current = requestAnimationFrame(() => {
          const contentNode = svgEl.querySelector('g > g');
          const bbox = contentNode && typeof (contentNode as SVGGElement).getBBox === 'function'
            ? (contentNode as SVGGElement).getBBox()
            : null;

          if ((!svgEl.clientWidth || !svgEl.clientHeight || !bbox || !bbox.width || !bbox.height) && attempts < 6) {
            attempts += 1;
            runFit();
            return;
          }

          resetRef.current();
          pendingFitRef.current = false;
          fitFrameRef.current = null;
        });
      };

      runFit();
    };

    const render = (autoFit: boolean) => {
      const width = svgEl.clientWidth || 900;
      const height = svgEl.clientHeight || 480;
      const fitWasRunning = draw(svgEl, tooltipEl, width, height, treeData, isTouch, onNodeClick, (reset) => {
        resetRef.current = reset;
      });

      // A fit that the redraw interrupted runs again on the new drawing.
      if (autoFit || pendingFitRef.current || fitWasRunning) {
        scheduleAutoFit();
      }
    };

    render(pendingFitRef.current);
    // ResizeObserver also fires once right after observe(): redrawing then would wipe the auto-fit
    // that was just scheduled. Redraw only when the size really changed.
    let lastSize = `${svgEl.clientWidth}x${svgEl.clientHeight}`;
    const ro = new ResizeObserver(() => {
      const size = `${svgEl.clientWidth}x${svgEl.clientHeight}`;
      if (size === lastSize) return;
      lastSize = size;
      render(false);
    });
    ro.observe(svgEl);
    return () => {
      ro.disconnect();
      if (fitFrameRef.current !== null) {
        cancelAnimationFrame(fitFrameRef.current);
        fitFrameRef.current = null;
      }
    };
  }, [fitKey, hasVisibleNodes, isTouch, treeData, onNodeClick]);

  return (
    <>
      <div className="graph-shell">
        {hasVisibleNodes ? (
          <svg ref={svgRef} id="graph-svg" />
        ) : (
          <div className="empty-state">
            <span className="empty-state-icon">◎</span>
            <span className="empty-state-msg">{emptyMessage}</span>
          </div>
        )}
      </div>
      {mounted && createPortal(
        <div ref={tooltipRef} className="graph-tooltip" />,
        document.body
      )}
    </>
  );
});

export default SessionTopology;
