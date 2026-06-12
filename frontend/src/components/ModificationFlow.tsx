'use client';
import React, { useRef, useEffect, useState, useCallback } from 'react';

interface Subprocess {
  id: string;
  name: string;
  description: string;
  input: string;
  output: string;
  timeMs: number;
  accuracy: number;
  riskLevel: 'high' | 'medium' | 'low';
  health: 'green' | 'yellow' | 'red';
  healthScore: number;
  healthIssues: string[];
  order: number;
  systemPrompt?: string;
  userPrompt?: string;
  modified?: boolean;
}

interface PromptVersion {
  round: number;
  modifiedStepIndex: number;
  stages: Subprocess[];
  timestamp: number;
}

interface ModificationFlowProps {
  modificationHistory: PromptVersion[];
  onSelectPoint: (roundIndex: number) => void;
}

export function ModificationFlow({
  modificationHistory,
  onSelectPoint,
}: ModificationFlowProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [hoveredPoint, setHoveredPoint] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pointPositions = useRef<Map<number, { x: number; y: number }>>(new Map());

  const colors = [
    { stroke: '#8b5cf6', fill: '#c4b5fd', text: '#7c3aed' },
    { stroke: '#10b981', fill: '#6ee7b7', text: '#059669' },
    { stroke: '#f59e0b', fill: '#fcd34d', text: '#d97706' },
    { stroke: '#ef4444', fill: '#fca5a5', text: '#dc2626' },
    { stroke: '#06b6d4', fill: '#67e8f9', text: '#0891b2' },
    { stroke: '#ec4899', fill: '#f9a8d4', text: '#db2777' },
    { stroke: '#6366f1', fill: '#a5b4fc', text: '#4f46e5' },
    { stroke: '#14b8a6', fill: '#5eead4', text: '#0d9488' },
  ];

  const getColor = (index: number) => colors[index % colors.length];

  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setDimensions({
          width: Math.max(320, Math.floor(rect.width)),
          height: Math.max(180, Math.floor(rect.height)),
        });
      }
    };
    updateDimensions();
    const observer = new ResizeObserver(updateDimensions);
    if (containerRef.current) observer.observe(containerRef.current);
    window.addEventListener('resize', updateDimensions);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateDimensions);
    };
  }, []);

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    for (const [idx, pos] of pointPositions.current.entries()) {
      const dist = Math.sqrt((x - pos.x) ** 2 + (y - pos.y) ** 2);
      if (dist < 16) {
        onSelectPoint(parseInt(idx.toString()));
        return;
      }
    }
  }, [onSelectPoint]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    for (const [idx, pos] of pointPositions.current.entries()) {
      const dist = Math.sqrt((x - pos.x) ** 2 + (y - pos.y) ** 2);
      if (dist < 16) {
        setHoveredPoint(parseInt(idx.toString()));
        canvas.style.cursor = 'pointer';
        return;
      }
    }
    setHoveredPoint(null);
    canvas.style.cursor = 'default';
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (dimensions.width <= 0 || dimensions.height <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = dimensions.width * dpr;
    canvas.height = dimensions.height * dpr;
    canvas.style.width = `${dimensions.width}px`;
    canvas.style.height = `${dimensions.height}px`;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, dimensions.width, dimensions.height);

    if (modificationHistory.length === 0) return;

    const margin = { top: 28, right: 28, bottom: 48, left: 58 };
    const plotWidth = dimensions.width - margin.left - margin.right;
    const plotHeight = dimensions.height - margin.top - margin.bottom;

    pointPositions.current.clear();

    const n = modificationHistory.length;
    const xStep = n > 1 ? plotWidth / (n - 1) : plotWidth / 2;

    // 找出所有被修改的子过程序号（1-based），0 表示初始基线版本
    const stepIndices = modificationHistory.map(v => v.modifiedStepIndex + 1);
    const maxStep = Math.max(...stepIndices, 1);
    const minStep = Math.min(...stepIndices, 0);
    const stepRange = Math.max(maxStep - minStep + 1, 5);

    // Y轴：子过程序号
    // 计算每个子过程序号对应的Y坐标
    const getY = (stepIndex: number): number => {
      const normalized = (stepIndex - minStep) / (stepRange - 1 || 1);
      return margin.top + plotHeight * (1 - normalized);
    };

    // 计算每个节点的位置
    const points: { x: number; y: number; stepIndex: number }[] = [];
    for (let i = 0; i < n; i++) {
      const record = modificationHistory[i];
      const x = n === 1 ? margin.left + plotWidth / 2 : margin.left + i * xStep;
      const y = getY(record.modifiedStepIndex + 1);
      points.push({ x, y, stepIndex: record.modifiedStepIndex + 1 });
    }

    // 绘制连接线（贝塞尔曲线，颜色渐变）
    if (points.length > 1) {
      for (let i = 0; i < points.length - 1; i++) {
        const p1 = points[i];
        const p2 = points[i + 1];
        const midX = (p1.x + p2.x) / 2;

        const color1 = getColor(i);
        const color2 = getColor(i + 1);

        const gradient = ctx.createLinearGradient(p1.x, p1.y, p2.x, p2.y);
        gradient.addColorStop(0, color1.stroke);
        gradient.addColorStop(1, color2.stroke);

        ctx.beginPath();
        ctx.strokeStyle = gradient;
        ctx.lineWidth = 2.5;
        ctx.lineCap = 'round';
        ctx.moveTo(p1.x, p1.y);
        ctx.bezierCurveTo(midX, p1.y, midX, p2.y, p2.x, p2.y);
        ctx.stroke();
      }
    }

    // 绘制节点
    points.forEach((point, i) => {
      const record = modificationHistory[i];
      const color = getColor(i);
      const isHovered = hoveredPoint === i;
      const radius = isHovered ? 12 : 10;

      pointPositions.current.set(i, { x: point.x, y: point.y });

      if (isHovered) {
        ctx.shadowColor = color.stroke;
        ctx.shadowBlur = 18;
      }

      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = color.fill;
      ctx.fill();
      ctx.strokeStyle = color.stroke;
      ctx.lineWidth = 2.5;
      ctx.stroke();

      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;

      ctx.fillStyle = color.text;
      ctx.font = `bold 10px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`R${record.round}`, point.x, point.y);
    });

    // Y轴刻度和标签
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;

    const yTickCount = Math.min(stepRange, 10);
    for (let i = 0; i < yTickCount; i++) {
      const stepVal = minStep + Math.round(i * (stepRange - 1) / (yTickCount - 1 || 1));
      const y = getY(stepVal);

      ctx.strokeStyle = '#f1f5f9';
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(margin.left + plotWidth, y);
      ctx.stroke();

      ctx.fillStyle = '#64748b';
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillText(stepVal === 0 ? '基线' : `${stepVal}`, margin.left - 10, y);
    }

    // Y轴标签
    ctx.fillStyle = '#94a3b8';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.save();
    ctx.translate(18, margin.top + plotHeight / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('步骤', 0, 0);
    ctx.restore();

    // X轴刻度标签
    ctx.fillStyle = '#64748b';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    points.forEach((point, i) => {
      const record = modificationHistory[i];
      ctx.fillText(`R${record.round}`, point.x, margin.top + plotHeight + 6);
    });

    // X轴标题
    ctx.fillStyle = '#94a3b8';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('版本 Round', margin.left + plotWidth / 2, dimensions.height - 18);

    // Y轴线
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(margin.left, margin.top);
    ctx.lineTo(margin.left, margin.top + plotHeight);
    ctx.stroke();

    // X轴线
    ctx.beginPath();
    ctx.moveTo(margin.left, margin.top + plotHeight);
    ctx.lineTo(margin.left + plotWidth, margin.top + plotHeight);
    ctx.stroke();

    // hover tooltip
    if (hoveredPoint !== null && hoveredPoint < modificationHistory.length) {
      const record = modificationHistory[hoveredPoint];
      const pos = pointPositions.current.get(hoveredPoint);
      if (pos && record) {
        const stepLabel = record.modifiedStepIndex < 0 ? '基线版本' : `步骤${record.modifiedStepIndex + 1}`;
        const label = `Round ${record.round}: ${stepLabel}`;

        ctx.font = '11px system-ui, sans-serif';
        const textWidth = ctx.measureText(label).width;

        let tooltipX = pos.x - textWidth / 2 - 10;
        tooltipX = Math.max(4, Math.min(tooltipX, dimensions.width - textWidth - 20));
        const tooltipY = pos.y + 25;

        ctx.fillStyle = 'rgba(30, 41, 59, 0.95)';
        ctx.beginPath();
        ctx.roundRect(tooltipX, tooltipY, textWidth + 20, 22, 4);
        ctx.fill();

        ctx.fillStyle = '#f8fafc';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, tooltipX + 10, tooltipY + 11);
      }
    }

  }, [modificationHistory, dimensions, hoveredPoint]);

  return (
    <div ref={containerRef} className="h-full w-full relative overflow-hidden">
      <canvas
        ref={canvasRef}
        className="block"
        onClick={handleClick}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoveredPoint(null)}
      />
      {modificationHistory.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="text-slate-300 text-xs">Prompt历史将显示在此</span>
        </div>
      )}
    </div>
  );
}

export default ModificationFlow;
