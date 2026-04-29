'use client';
import { useRef, useEffect, useState } from 'react';
import { Subprocess } from '../types';

interface InteractionFlowProps {
  subprocesses: Subprocess[];
  userInput: string;
  finalOutput?: string;
  currentEditingId?: string;
  editingRound?: number;
}

// Dagre布局算法
interface Node {
  id: string;
  label: string;
  width: number;
  height: number;
  x?: number;
  y?: number;
}

interface Edge {
  id: string;
  source: string;
  target: string;
  round?: number;
}

function dagreLayout(nodes: Node[], _edges: Edge[]): Node[] {
  if (nodes.length === 0) return [];

  // 分层：输入 -> 规划器 -> 子过程 -> 输出
  const layers: Map<string, number> = new Map();
  nodes.forEach(n => {
    if (n.id === 'input') layers.set(n.id, 0);
    else if (n.id === 'planner') layers.set(n.id, 1);
    else if (n.id === 'output') layers.set(n.id, 3);
    else layers.set(n.id, 2);
  });

  // 按层级分组
  const layerGroups: Map<number, Node[]> = new Map();
  nodes.forEach(n => {
    const layer = layers.get(n.id) || 0;
    if (!layerGroups.has(layer)) layerGroups.set(layer, []);
    layerGroups.get(layer)!.push(n);
  });

  // 计算位置
  const layerGapX = 160;
  const nodeGapY = 80;
  const startX = 60;
  const startY = 40;

  layerGroups.forEach((group, layer) => {
    const totalHeight = group.length * nodeGapY;
    group.forEach((node, idx) => {
      node.x = startX + layer * layerGapX;
      node.y = startY + (nodes.length > 6 ? idx * 60 : 20) + (totalHeight / 2) - (nodeGapY / 2);
    });
  });

  return nodes;
}

// 轮次颜色映射
const roundColors = [
  { stroke: '#8b5cf6', fill: '#f3e8ff', text: '#7c3aed' },  // 紫色
  { stroke: '#10b981', fill: '#d1fae5', text: '#059669' },  // 绿色
  { stroke: '#f59e0b', fill: '#fef3c7', text: '#d97706' },  // 橙色
  { stroke: '#ef4444', fill: '#fee2e2', text: '#dc2626' },  // 红色
  { stroke: '#06b6d4', fill: '#cffafe', text: '#0891b2' },  // 青色
];

export function InteractionFlow({
  subprocesses,
  userInput,
  finalOutput,
  currentEditingId,
  editingRound = 0,
}: InteractionFlowProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        setDimensions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    };
    updateDimensions();
    window.addEventListener('resize', updateDimensions);
    return () => window.removeEventListener('resize', updateDimensions);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = dimensions.width * dpr;
    canvas.height = dimensions.height * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, dimensions.width, dimensions.height);

    if (subprocesses.length === 0 && !userInput) return;

    // 构建节点
    const nodes: Node[] = [];
    const edges: Edge[] = [];

    // 输入节点
    const displayInput = userInput.length > 30 ? userInput.substring(0, 30) + '...' : userInput;
    nodes.push({ id: 'input', label: `输入: ${displayInput}`, width: 120, height: 50 });

    // 规划器节点
    nodes.push({ id: 'planner', label: '问题分析\n规划器', width: 100, height: 50 });

    // 子过程节点
    const nodeMap = new Map<string, Node>();
    subprocesses.forEach((sub, idx) => {
      const subNode: Node = {
        id: sub.id,
        label: `${idx + 1}. ${sub.name}`,
        width: 100,
        height: 40,
      };
      nodes.push(subNode);
      nodeMap.set(sub.id, subNode);
    });

    // 输出节点
    if (finalOutput) {
      const displayOutput = finalOutput.length > 30 ? finalOutput.substring(0, 30) + '...' : finalOutput;
      nodes.push({ id: 'output', label: `输出: ${displayOutput}`, width: 120, height: 50 });
    }

    // 布局
    const layoutedNodes = dagreLayout(nodes, edges);

    // 重新调整Y坐标以适应画布
    if (layoutedNodes.length > 0) {
      const maxY = Math.max(...layoutedNodes.map(n => n.y || 0)) + 80;
      const offsetY = Math.max(0, (dimensions.height - maxY) / 2);
      layoutedNodes.forEach(n => {
        if (n.y !== undefined) n.y += offsetY;
      });
    }

    // 绘制连线
    const nodePos = new Map<string, { x: number; y: number; w: number; h: number }>();
    layoutedNodes.forEach(n => {
      nodePos.set(n.id, { x: n.x || 0, y: n.y || 0, w: n.width, h: n.height });
    });

    // 输入 -> 规划器
    const inputPos = nodePos.get('input');
    const plannerPos = nodePos.get('planner');
    if (inputPos && plannerPos) {
      ctx.beginPath();
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 2;
      ctx.moveTo(inputPos.x + inputPos.w, inputPos.y + inputPos.h / 2);
      ctx.lineTo(plannerPos.x, plannerPos.y + plannerPos.h / 2);
      ctx.stroke();
      // 箭头
      drawArrow(ctx, plannerPos.x, plannerPos.y + plannerPos.h / 2, '#94a3b8');
    }

    // 规划器 -> 各子过程
    if (plannerPos) {
      subprocesses.forEach((sub) => {
        const subPos = nodePos.get(sub.id);
        if (subPos) {
          const roundIdx = Math.min(editingRound, roundColors.length - 1);
          const color = currentEditingId === sub.id ? roundColors[roundIdx].stroke : '#a78bfa';
          ctx.beginPath();
          ctx.strokeStyle = color;
          ctx.lineWidth = currentEditingId === sub.id ? 2.5 : 1.5;
          ctx.moveTo(plannerPos.x + plannerPos.w, plannerPos.y + plannerPos.h / 2);
          const midX = (plannerPos.x + plannerPos.w + subPos.x) / 2;
          ctx.bezierCurveTo(
            midX, plannerPos.y + plannerPos.h / 2,
            midX, subPos.y + subPos.h / 2,
            subPos.x, subPos.y + subPos.h / 2
          );
          ctx.stroke();
          drawArrow(ctx, subPos.x, subPos.y + subPos.h / 2, color);
        }
      });
    }

    // 绘制节点
    layoutedNodes.forEach(node => {
      const pos = nodePos.get(node.id);
      if (!pos) return;

      const isInput = node.id === 'input';
      const isPlanner = node.id === 'planner';
      const isOutput = node.id === 'output';
      const isSubprocess = nodeMap.has(node.id);
      const isEditing = currentEditingId === node.id;

      let bgColor = '#f8fafc';
      let borderColor = '#e2e8f0';
      let textColor = '#475569';
      let fontWeight = 'normal';

      if (isInput) {
        bgColor = '#fef3c7';
        borderColor = '#fbbf24';
        textColor = '#92400e';
      } else if (isPlanner) {
        bgColor = '#ede9fe';
        borderColor = '#a78bfa';
        textColor = '#5b21b6';
        fontWeight = 'bold';
      } else if (isOutput) {
        bgColor = '#d1fae5';
        borderColor = '#34d399';
        textColor = '#065f46';
      } else if (isSubprocess) {
        const sub = subprocesses.find(s => s.id === node.id);
        if (sub) {
          const roundIdx = editingRound % roundColors.length;
          const baseColor = roundColors[roundIdx];
          bgColor = isEditing ? baseColor.fill : '#faf5ff';
          borderColor = isEditing ? baseColor.stroke : '#d8b4fe';
          textColor = isEditing ? baseColor.text : '#6b21a8';
        }
      }

      // 阴影
      ctx.shadowColor = 'rgba(0, 0, 0, 0.1)';
      ctx.shadowBlur = isEditing ? 12 : 4;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 2;

      // 圆角矩形
      const radius = 8;
      ctx.beginPath();
      ctx.roundRect(pos.x, pos.y, pos.w, pos.h, radius);
      ctx.fillStyle = bgColor;
      ctx.fill();
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = isEditing ? 2.5 : 1.5;
      ctx.stroke();

      // 重置阴影
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;

      // 文字
      ctx.fillStyle = textColor;
      ctx.font = `${fontWeight} 11px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const lines = node.label.split('\n');
      const lineHeight = 14;
      const startY = pos.y + pos.h / 2 - ((lines.length - 1) * lineHeight) / 2;
      lines.forEach((line, i) => {
        ctx.fillText(line, pos.x + pos.w / 2, startY + i * lineHeight);
      });
    });

    // 图例
    drawLegend(ctx, dimensions.width, dimensions.height, editingRound);

  }, [subprocesses, userInput, finalOutput, dimensions, currentEditingId, editingRound]);

  return (
    <div ref={containerRef} className="h-full w-full relative">
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%' }}
        className="absolute inset-0"
      />
    </div>
  );
}

function drawArrow(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  ctx.beginPath();
  ctx.fillStyle = color;
  ctx.moveTo(x, y);
  ctx.lineTo(x - 8, y - 4);
  ctx.lineTo(x - 8, y + 4);
  ctx.closePath();
  ctx.fill();
}

function drawLegend(ctx: CanvasRenderingContext2D, _width: number, height: number, currentRound: number) {
  const legendX = 10;
  const legendY = height - 60;

  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  ctx.fillStyle = 'rgba(248, 250, 252, 0.95)';
  ctx.beginPath();
  ctx.roundRect(legendX - 5, legendY - 5, 180, 55, 6);
  ctx.fill();
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = '#64748b';
  ctx.fillText('轮次图例:', legendX, legendY);

  const maxRound = Math.min(currentRound + 2, roundColors.length);
  for (let i = 0; i < maxRound; i++) {
    const color = roundColors[i];
    ctx.fillStyle = color.fill;
    ctx.strokeStyle = color.stroke;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(legendX + (i * 38), legendY + 15, 32, 18, 4);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = color.text;
    ctx.font = 'bold 9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`第${i + 1}轮`, legendX + (i * 38) + 16, legendY + 24);
    ctx.textAlign = 'left';
  }
}

export default InteractionFlow;
