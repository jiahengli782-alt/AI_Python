import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import type { AgentFailureType, AgentTraceDiagnosis, PropagationEdge, ProvenanceEdge, ProvenanceNode } from './AgentDiagnosisPanel';

interface Subprocess {
  id: string;
  name: string;
  description: string;
  input: string;
  output: string;
  riskLevel: 'high' | 'medium' | 'low';
  health: 'green' | 'yellow' | 'red';
  healthScore: number;
  order: number;
  systemPrompt?: string;
  userPrompt?: string;
  userPromptTemplate?: string;
  failure_type?: AgentFailureType;
  failure_label?: string;
  failure_confidence?: number;
  failure_reason?: string;
  diagnosis_status?: 'normal' | 'warning' | 'failure';
  diagnosis_evidence?: string[];
  provenance_nodes?: ProvenanceNode[];
  provenance_edges?: ProvenanceEdge[];
  observed_signals?: string[];
  evidence_source?: string;
  potential_risks?: {
    failure_type: AgentFailureType;
    label?: string;
    confidence?: number;
    reason?: string;
    source_excerpt?: string;
    suggested_fix?: string;
    suggested_fixes?: string[];
    severity?: 'low' | 'medium' | 'high';
  }[];
  potential_issue_tags?: string[];
  source_refs?: string[];
  where_to_steps?: number[];
  affected_steps?: number[];
  propagation_edges?: PropagationEdge[];
}

export interface TreePreviewResult {
  stepId: string;
  name: string;
  status: 'unchanged' | 'changed' | 'affected';
  summary: string;
  fullResult?: string;
}

export interface TreePromptOpenRequest {
  stepId: string;
  prompt: string;
  nonce: number;
}

interface TreeSuggestion {
  id: string;
  stepId: string;
  title: string;
  summary: string;
  prompt: string;
}

type EditingTarget =
  | { type: 'current'; stepId: string }
  | { type: 'suggestion'; stepId: string; suggestionId: string };

type DetailTarget =
  | EditingTarget
  | { type: 'final' };

type TreeViewMode = 'flow' | 'provenance' | 'propagation';

interface PromptTreePanelProps {
  goal: string;
  subprocesses: Subprocess[];
  selectedStepId: string | null;
  editingStepId: string | null;
  editedSystemPrompt: string;
  promptDrafts: Record<string, string>;
  previewResults: TreePreviewResult[];
  previewFinalOutput: string;
  externalPromptRequest?: TreePromptOpenRequest | null;
  traceDiagnosis?: AgentTraceDiagnosis | null;
  canUndoTreeChange: boolean;
  isPreviewing: boolean;
  resetSignal: number;
  onSelectStep: (stepId: string) => void;
  onApplyPrompt: (stepId: string, prompt: string, source: 'current' | 'suggestion') => void;
  onPreviewPrompt: (stepId: string, prompt: string, source: 'current' | 'suggestion') => void;
  onUndoPreview: () => void;
}

const marker = '【树状图摘要Prompt】';

function compactText(text: string, maxLength = 74) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '等待生成结果摘要';
  return clean.length > maxLength ? `${clean.slice(0, maxLength)}...` : clean;
}

function compactResult(text: string, maxLength = 24) {
  const clean = (text || '')
    .replace(/[#*_`>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const firstClause = clean.split(/[。；;.!?？\n]/).find(Boolean) || clean;
  const meaningful = /^\d+[\.\)、)]?$/.test(firstClause) ? clean : firstClause;
  return meaningful.length > maxLength ? meaningful.slice(0, maxLength) : meaningful;
}

// 用于编辑框的"取值"：返回完整内容，不截断（编辑时用户需要看到完整 prompt）
function extractTreePromptForEdit(text: string) {
  if (!text) return '';
  const markerIndex = text.indexOf(marker);
  if (markerIndex >= 0) {
    const afterMarker = text.slice(markerIndex + marker.length).trim();
    // 只取摘要 marker 后第一段，但不再做长度截断
    return afterMarker.split(/\n\s*\n/)[0].trim();
  }
  return text.trim();
}

function buildStepSuggestions(step: Subprocess, index: number): TreeSuggestion[] {
  const base = step.name || `步骤${index + 1}`;
  const resultSeed = compactResult(step.output || step.description || step.input || base, 18);
  const sourceHint = compactResult(step.description || step.input || base, 18);
  return [
    {
      id: `${step.id}-popular-next`,
      stepId: step.id,
      title: '常见追问结果',
      summary: `可能输出：把“${resultSeed}”转成用户最常追问的下一步清单`,
      prompt: `在“${base}”中模拟用户看到“${resultSeed}”后最可能继续追问的方向，输出3个高频追问点、每个追问点的简短回答，以及它们对后续步骤的影响。`,
    },
    {
      id: `${step.id}-alternative-plan`,
      stepId: step.id,
      title: '替代方案结果',
      summary: `可能输出：围绕“${sourceHint}”给出另一条可执行方案`,
      prompt: `在“${base}”中不要沿用当前结论，而是基于“${sourceHint}”生成一个可替代的解决方向：说明适用场景、关键步骤、预期结果和主要风险。`,
    },
  ];
}

export function PromptTreePanel({
  goal,
  subprocesses,
  selectedStepId,
  editingStepId,
  editedSystemPrompt,
  promptDrafts,
  previewResults,
  previewFinalOutput,
  externalPromptRequest,
  traceDiagnosis,
  canUndoTreeChange,
  isPreviewing,
  resetSignal,
  onSelectStep,
  onApplyPrompt,
  onPreviewPrompt,
  onUndoPreview,
}: PromptTreePanelProps) {
  const [editingTarget, setEditingTarget] = useState<EditingTarget | null>(null);
  const [resultDetail, setResultDetail] = useState<{ title: string; content: string } | null>(null);
  const [detailTarget, setDetailTarget] = useState<DetailTarget | null>(null);
  const [isDetailExpanded, setIsDetailExpanded] = useState(false);
  const [draftPrompt, setDraftPrompt] = useState('');
  const [zoom, setZoom] = useState(0.92);
  const [treeView, setTreeView] = useState<TreeViewMode>('flow');
  const suggestionsByStep = useMemo(() => {
    const result: Record<string, TreeSuggestion[]> = {};
    subprocesses.forEach((step, index) => {
      result[step.id] = buildStepSuggestions(step, index);
    });
    return result;
  }, [subprocesses]);

  const selectedStep = subprocesses.find(step => step.id === selectedStepId);
  const isEvidenceFailure = (step: Subprocess) => step.diagnosis_status === 'failure';
  const evidenceFailures = subprocesses.filter(isEvidenceFailure);
  const affectedStepOrders = new Set<number>(
    evidenceFailures.flatMap(step => step.affected_steps || [])
  );
  const propagationEdges = [
    ...(traceDiagnosis?.propagation_edges || []),
    ...evidenceFailures.flatMap(step => step.propagation_edges || []),
  ].filter((edge, index, arr) =>
    edge.from_step > 0 &&
    edge.to_step > 0 &&
    edge.to_step <= subprocesses.length &&
    arr.findIndex(item => item.from_step === edge.from_step && item.to_step === edge.to_step) === index
  );
  const dataflowEdges = subprocesses.flatMap(step =>
    (step.where_to_steps || [])
      .filter(target => target > step.order && target <= subprocesses.length)
      .map(target => ({ from_step: step.order, to_step: target }))
  ).filter((edge, index, arr) =>
    arr.findIndex(item => item.from_step === edge.from_step && item.to_step === edge.to_step) === index
  );
  const firstStep = subprocesses[0];
  const goalSuggestions: TreeSuggestion[] = useMemo(() => firstStep ? [
      {
        id: `${firstStep.id}-goal-user`,
        stepId: firstStep.id,
        title: '高频用户问题',
        summary: `可能输出：围绕“${compactResult(goal, 16)}”拆出最多人会问的3个问题`,
        prompt: `围绕目标“${goal}”，先预测真实用户最可能追问的3个高频问题，再把这些问题转成后续推理必须覆盖的目标。`,
      },
      {
        id: `${firstStep.id}-goal-constraint`,
        stepId: firstStep.id,
        title: '现实约束结果',
        summary: `可能输出：先得到“${compactResult(goal, 16)}”最关键的限制条件`,
        prompt: `围绕目标“${goal}”，优先输出真实使用中最可能限制结果质量的约束、风险、资源条件和不可做事项，再决定后续步骤。`,
      },
    ] : [],
    [firstStep, goal]
  );

  const changeZoom = (delta: number) => {
    setZoom(prev => Math.max(0.68, Math.min(1.35, Number((prev + delta).toFixed(2)))));
  };

  // 编辑用：返回完整 prompt，不截断
  const getCurrentPrompt = (step: Subprocess) => {
    if (editingStepId === step.id && editedSystemPrompt) return extractTreePromptForEdit(editedSystemPrompt);
    if (promptDrafts[step.id]) return promptDrafts[step.id];
    return extractTreePromptForEdit(step.systemPrompt || step.description || step.input);
  };

  const getStepResultSummary = (step: Subprocess) =>
    compactResult(step.output || step.description || step.input || '等待该步骤产生结果', 22);

  const getStepFullResult = (step: Subprocess) =>
    step.output || step.description || step.input || '该步骤还没有完整结果';

  const getStepDetailContent = (step: Subprocess) => {
    const blocks: string[] = [];
    const whereToText = step.where_to_steps?.length
      ? `Step ${step.where_to_steps.join(', Step ')}`
      : '没有直接下游步骤';
    blocks.push(`【真实到哪里去】${whereToText}`);
    if (step.potential_risks?.length) {
      blocks.push(`【可能出现的推理风险】\n${step.potential_risks.map((risk, idx) => {
        const confidence = Math.round((risk.confidence || 0) * 100);
        return `${idx + 1}. ${risk.label || risk.failure_type}（${confidence}%）\n原因：${risk.reason || '基于问题/文档/日志特征推断'}\n来源：${risk.source_excerpt || '当前问题上下文'}`;
      }).join('\n\n')}`);
    }
    if (step.diagnosis_status === 'failure') {
      blocks.push(`【错误类型】${step.failure_label || step.failure_type || '未知错误'}`);
      if (step.evidence_source) {
        blocks.push(`【错误证据文字源头】\n${step.evidence_source}`);
      }
      if (step.failure_reason) {
        blocks.push(`【为什么错】\n${step.failure_reason}`);
      }
      if (step.affected_steps?.length) {
        blocks.push(`【真实影响到】Step ${step.affected_steps.join(', Step ')}`);
      }
      if (step.diagnosis_evidence?.length) {
        blocks.push(`【真实证据】\n${step.diagnosis_evidence.join('\n')}`);
      }
      blocks.push(`【完整输出】\n${getStepFullResult(step)}`);
      return blocks.join('\n\n');
    }
    if (step.diagnosis_status === 'warning') {
      blocks.push(`【性能/上下文提示】${step.failure_label || step.failure_type || '成本/延迟/上下文提示'}`);
      if (step.evidence_source) blocks.push(`【提示来源】\n${step.evidence_source}`);
      blocks.push(`【完整输出】\n${getStepFullResult(step)}`);
      return blocks.join('\n\n');
    }
    blocks.push(`【完整输出】\n${getStepFullResult(step)}`);
    return blocks.join('\n\n');
  };

  const openCurrentStep = (step: Subprocess, preview?: TreePreviewResult) => {
    onSelectStep(step.id);
    setEditingTarget({ type: 'current', stepId: step.id });
    setDetailTarget({ type: 'current', stepId: step.id });
    setDraftPrompt(getCurrentPrompt(step));
    if (preview?.fullResult) {
      setResultDetail({ title: `${preview.name} 的完整试运行结果`, content: preview.fullResult });
    } else {
      setResultDetail({ title: `${step.name} 的完整结果`, content: getStepDetailContent(step) });
    }
  };

  const openSuggestion = (suggestion: TreeSuggestion, preview?: TreePreviewResult) => {
    onSelectStep(suggestion.stepId);
    setEditingTarget({ type: 'suggestion', stepId: suggestion.stepId, suggestionId: suggestion.id });
    setDetailTarget({ type: 'suggestion', stepId: suggestion.stepId, suggestionId: suggestion.id });
    setDraftPrompt(suggestion.prompt);
    if (preview?.fullResult) {
      setResultDetail({ title: `${suggestion.title} 的试运行结果`, content: preview.fullResult });
    } else {
      setResultDetail({ title: `${suggestion.title} 的预期结果`, content: suggestion.summary });
    }
  };

  const closeEditor = () => {
    setEditingTarget(null);
    setResultDetail(null);
    setDetailTarget(null);
    setIsDetailExpanded(false);
    setDraftPrompt('');
  };

  const openFinalResult = () => {
    setEditingTarget(null);
    setDraftPrompt('');
    setDetailTarget({ type: 'final' });
    setResultDetail({
      title: '预测产生的完整结果',
      content: previewFinalOutput,
    });
  };

  const applyPrompt = () => {
    if (!editingTarget || !draftPrompt.trim()) return;
    onApplyPrompt(editingTarget.stepId, draftPrompt.trim(), editingTarget.type);
  };

  const previewPrompt = () => {
    if (!editingTarget || !draftPrompt.trim()) return;
    onPreviewPrompt(editingTarget.stepId, draftPrompt.trim(), editingTarget.type);
  };

  useEffect(() => {
    closeEditor();
  }, [resetSignal]);

  useEffect(() => {
    if (!externalPromptRequest) return;
    const step = subprocesses.find(item => item.id === externalPromptRequest.stepId);
    if (!step) return;
    onSelectStep(step.id);
    setEditingTarget({ type: 'current', stepId: step.id });
    setDetailTarget({ type: 'current', stepId: step.id });
    setDraftPrompt(externalPromptRequest.prompt);
    setIsDetailExpanded(false);
    setResultDetail({
      title: `${step.name} 的修复 Prompt 已同步`,
      content: '已同步到下方 Prompt 编辑框。你可以继续人工修改，确认后点击左侧弹窗里的“试运行”查看该指定步骤及后续链路变化。',
    });
  }, [externalPromptRequest?.nonce]);

  useEffect(() => {
    if (!detailTarget) return;

    if (detailTarget.type === 'final') {
      setResultDetail({
        title: '预测产生的完整结果',
        content: previewFinalOutput || '等待试运行生成最终结果',
      });
      return;
    }

    const step = subprocesses.find(item => item.id === detailTarget.stepId);
    if (!step) return;
    const preview = previewResults.find(item => item.stepId === detailTarget.stepId && item.status !== 'unchanged');

    if (detailTarget.type === 'current') {
      if (preview?.fullResult) {
        setResultDetail({ title: `${preview.name} 的完整试运行结果`, content: preview.fullResult });
      } else {
        setResultDetail({ title: `${step.name} 的完整结果`, content: getStepDetailContent(step) });
      }
      return;
    }

    const suggestion = [...(suggestionsByStep[detailTarget.stepId] || []), ...goalSuggestions]
      .find(item => item.id === detailTarget.suggestionId);
    if (preview?.fullResult) {
      setResultDetail({ title: `${suggestion?.title || step.name} 的试运行结果`, content: preview.fullResult });
    } else if (suggestion) {
      setResultDetail({ title: `${suggestion.title} 的预期结果`, content: suggestion.summary });
    }
  }, [detailTarget, previewResults, previewFinalOutput, subprocesses, suggestionsByStep, goalSuggestions]);

  const editorTitle = (() => {
    if (!editingTarget) return '';
    const step = subprocesses.find(item => item.id === editingTarget.stepId);
    if (!step) return '';
    return editingTarget.type === 'current' ? `${step.name} 的摘要 Prompt` : `${step.name} 的建议方向`;
  })();
  const hasActivePreview = previewResults.some(item => item.status !== 'unchanged') || Boolean(previewFinalOutput);
  const canApplyCurrentPreview = Boolean(
    editingTarget &&
    previewResults.some(item => item.stepId === editingTarget.stepId && item.status === 'changed')
  );

  const sourceTypeLabel = (type: string) => {
    const labels: Record<string, string> = {
      question: '用户问题',
      previous_step: '上一步',
      step: '当前步骤',
      downstream_step: '下游步骤',
      prompt: 'Prompt',
      document: '文档证据',
      tool: '工具/API',
      log: '日志错误',
      memory: '上下文',
    };
    return labels[type] || type;
  };

  const edgeLabel = (relation: string) => {
    const labels: Record<string, string> = {
      initial_input: '作为初始输入',
      previous_output_to_input: '上一步输出进入本步',
      controls_generation: '控制本步生成',
      document_evidence_used: '文档证据进入本步',
      cited_evidence: '引用证据进入本步',
      tool_result_used: '工具结果进入本步',
      runtime_signal: '日志/错误信号进入本步',
      context_carried: '上下文被带入',
      output_used_by_downstream: '本步输出进入下游',
    };
    return labels[relation] || relation;
  };

  const buildProvenanceNodeDetail = (
    step: Subprocess,
    node: ProvenanceNode,
    graph: { nodes: ProvenanceNode[]; edges: ProvenanceEdge[] }
  ) => {
    const relatedEdges = graph.edges.filter(edge => edge.source === node.id || edge.target === node.id);
    const edgeBlocks = relatedEdges.map((edge, index) => [
      `${index + 1}. ${edgeLabel(edge.relation)}`,
      `from: ${edge.source}`,
      `to: ${edge.target}`,
      edge.status ? `status: ${edge.status}` : '',
      edge.evidence ? `完整证据:\n${edge.evidence}` : '',
    ].filter(Boolean).join('\n')).join('\n\n');

    return [
      `【节点类型】\n${sourceTypeLabel(node.type)}`,
      `【节点标题】\n${node.label}`,
      node.status ? `【节点状态】\n${node.status}` : '',
      `【节点完整内容】\n${node.detail || '暂无节点详情'}`,
      edgeBlocks ? `【与该节点相关的信息流向】\n${edgeBlocks}` : '',
      step.evidence_source ? `【当前 Step 的完整错误/证据源】\n${step.evidence_source}` : '',
      step.output ? `【当前 Step 输出】\n${step.output}` : '',
      step.input ? `【当前 Step 输入】\n${step.input}` : '',
    ].filter(Boolean).join('\n\n');
  };

  const renderExpandedDetailContent = (content: string) => {
    const lines = (content || '').split('\n');
    return (
      <div className="min-h-0 flex-1 overflow-auto px-5 py-4 font-sans text-base leading-8 text-slate-700">
        {lines.map((line, index) => {
          const headingMatch = line.trim().match(/^【(.+)】$/);
          if (headingMatch) {
            return (
              <div key={index} className={clsx(index > 0 && 'mt-5', 'text-lg font-bold text-red-600')}>
                {line}
              </div>
            );
          }
          if (!line.trim()) return <div key={index} className="h-3" />;
          return (
            <div key={index} className="whitespace-pre-wrap break-words text-base leading-8 text-slate-700">
              {line}
            </div>
          );
        })}
      </div>
    );
  };

  const renderProvenanceView = () => (
    <div className="min-w-[620px] space-y-3">
      {subprocesses.map((step) => {
        const nodes = step.provenance_nodes || [];
        const edges = step.provenance_edges || [];
        const warningNodes = nodes.filter(node => node.status === 'warning' || node.status === 'failure');
        return (
          <button
            key={step.id}
            onClick={() => openCurrentStep(step)}
            className={clsx(
              'w-full rounded-xl border bg-white p-3 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md',
              step.diagnosis_status === 'failure' ? 'border-red-300 bg-red-50/50' :
                warningNodes.length ? 'border-amber-200 bg-amber-50/40' :
                  'border-slate-200'
            )}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-semibold text-slate-800">Step {step.order}: {step.name}</div>
              <div className="flex flex-wrap gap-1">
                {nodes.slice(0, 5).map(node => (
                  <span
                    key={node.id}
                    className={clsx(
                      'rounded-full px-2 py-0.5 text-[10px] font-medium ring-1',
                      node.type === 'document' ? 'bg-emerald-50 text-emerald-700 ring-emerald-100' :
                        node.type === 'log' || node.type === 'tool' ? 'bg-amber-50 text-amber-700 ring-amber-100' :
                          node.type === 'prompt' ? 'bg-purple-50 text-purple-700 ring-purple-100' :
                            'bg-slate-50 text-slate-600 ring-slate-100'
                    )}
                    title={node.detail || node.label}
                  >
                    {sourceTypeLabel(node.type)}
                  </span>
                ))}
              </div>
            </div>
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              <div className="rounded-lg border border-slate-100 bg-slate-50 p-2">
                <div className="text-[11px] font-semibold text-slate-500">证据来源节点</div>
                <div className="mt-1 space-y-1">
                  {nodes.length ? nodes.slice(0, 6).map(node => (
                    <div key={node.id} className="truncate text-[11px] text-slate-600" title={node.detail || node.label}>
                      <span className="font-medium text-slate-700">{sourceTypeLabel(node.type)}</span> · {node.label}
                    </div>
                  )) : (
                    <div className="text-[11px] text-slate-400">暂无可观测来源节点</div>
                  )}
                </div>
              </div>
              <div className="rounded-lg border border-slate-100 bg-slate-50 p-2">
                <div className="text-[11px] font-semibold text-slate-500">信息流向边</div>
                <div className="mt-1 space-y-1">
                  {edges.length ? edges.slice(0, 6).map((edge, idx) => (
                    <div key={`${edge.source}-${edge.target}-${idx}`} className="truncate text-[11px] text-slate-600" title={edge.evidence || edge.relation}>
                      <span className={clsx('font-medium', edge.status === 'warning' || edge.status === 'failure' ? 'text-red-600' : 'text-slate-700')}>
                        {edgeLabel(edge.relation)}
                      </span>
                      {' '}· {edge.source} → {edge.target}
                    </div>
                  )) : (
                    <div className="text-[11px] text-slate-400">暂无可观测流向边</div>
                  )}
                </div>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );

  const renderPropagationView = () => (
    <div className="min-w-[620px] space-y-3">
      {subprocesses.map((step) => {
        const isFailure = step.diagnosis_status === 'failure';
        const isAffected = affectedStepOrders.has(step.order);
        const preview = previewResults.find(item => item.stepId === step.id && item.status !== 'unchanged');
        const risks = step.potential_risks || [];
        return (
          <button
            key={step.id}
            onClick={() => openCurrentStep(step, preview)}
            className={clsx(
              'w-full rounded-xl border p-3 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md',
              isFailure ? 'border-red-300 bg-red-50' :
                isAffected ? 'border-amber-300 bg-amber-50' :
                  risks.length ? 'border-sky-200 bg-sky-50/70' :
                    'border-slate-200 bg-white'
            )}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-semibold text-slate-800">Step {step.order}: {step.name}</div>
              <div className="flex flex-wrap gap-1.5 text-[10px]">
                {isFailure && <span className="rounded-full bg-red-100 px-2 py-0.5 font-medium text-red-700">错误源</span>}
                {isAffected && <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-700">受影响</span>}
                {risks.length > 0 && <span className="rounded-full bg-sky-100 px-2 py-0.5 font-medium text-sky-700">可能风险</span>}
              </div>
            </div>
            <div className="mt-2 grid gap-2 text-[11px] md:grid-cols-3">
              <div className="rounded-lg bg-white/70 p-2 text-slate-600">
                <span className="font-semibold text-slate-500">Where 去向：</span>
                {step.where_to_steps?.length ? `Step ${step.where_to_steps.join(', Step ')}` : '暂无下游'}
              </div>
              <div className="rounded-lg bg-white/70 p-2 text-slate-600">
                <span className="font-semibold text-slate-500">影响：</span>
                {step.affected_steps?.length ? `Step ${step.affected_steps.join(', Step ')}` : isAffected ? '来自上游错误' : '无红色传播'}
              </div>
              <div className="rounded-lg bg-white/70 p-2 text-slate-600">
                <span className="font-semibold text-slate-500">依据：</span>
                {compactText(step.evidence_source || step.observed_signals?.join(', ') || risks[0]?.reason || '暂无错误证据', 52)}
              </div>
            </div>
            {step.propagation_edges?.length ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {step.propagation_edges.map((edge, idx) => (
                  <span key={idx} className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-medium text-red-700">
                    Step {edge.from_step} → Step {edge.to_step}
                  </span>
                ))}
              </div>
            ) : null}
          </button>
        );
      })}
    </div>
  );

  const visualNodeTone = (type: string, status?: string) => {
    if (status === 'failure') return 'border-red-300 bg-red-50 text-red-800 shadow-red-100';
    if (status === 'warning') return 'border-amber-300 bg-amber-50 text-amber-800 shadow-amber-100';
    if (type === 'document') return 'border-emerald-200 bg-emerald-50 text-emerald-800';
    if (type === 'log' || type === 'tool') return 'border-amber-200 bg-amber-50 text-amber-800';
    if (type === 'prompt') return 'border-purple-200 bg-purple-50 text-purple-800';
    if (type === 'downstream_step') return 'border-sky-200 bg-sky-50 text-sky-800';
    return 'border-slate-200 bg-white text-slate-700';
  };

  const fallbackProvenanceGraph = (step: Subprocess): { nodes: ProvenanceNode[]; edges: ProvenanceEdge[] } => {
    const nodes: ProvenanceNode[] = [];
    const edges: ProvenanceEdge[] = [];
    const stepNode = `step:${step.order}`;
    const logPattern = /(API调用失败|SetLimitExceeded|quota|429|401|403|404|exception|traceback|failed|error|错误码|报错|调用失败)/i;
    const documentPattern = /(已上传文档|片段\s*\d+|文件名|来源|引用|\.pdf|\.docx|\.csv|\.txt|网上搜索|检索结果|网页|资料)/i;
    const fullEvidence = (text?: string) => (text || '').trim();
    const addNode = (node: ProvenanceNode) => {
      if (!nodes.some(item => item.id === node.id)) nodes.push(node);
    };
    const addEdge = (edge: ProvenanceEdge) => {
      if (!edges.some(item => item.source === edge.source && item.target === edge.target && item.relation === edge.relation)) edges.push(edge);
    };

    addNode({ id: stepNode, type: 'step', label: `Step ${step.order}: ${step.name}`, detail: step.output || step.description || step.input, status: step.diagnosis_status });
    if (step.order === 1) {
      addNode({ id: 'source:user_query', type: 'question', label: 'User question', detail: step.input || goal });
      addEdge({ source: 'source:user_query', target: stepNode, relation: 'initial_input', evidence: step.input || goal });
    } else {
      const prev = subprocesses[step.order - 2];
      const inheritedText = prev?.output || prev?.description || '';
      addNode({ id: `step:${step.order - 1}`, type: 'previous_step', label: `上游输出 Step ${step.order - 1}: ${prev?.name || 'previous step'}`, detail: inheritedText });
      addEdge({ source: `step:${step.order - 1}`, target: stepNode, relation: 'previous_output_to_input', evidence: step.input || inheritedText });
    }
    if (step.systemPrompt || step.userPrompt || step.userPromptTemplate) {
      addNode({ id: `prompt:${step.order}`, type: 'prompt', label: `Prompt for Step ${step.order}`, detail: step.systemPrompt || step.userPromptTemplate || step.userPrompt });
      addEdge({ source: `prompt:${step.order}`, target: stepNode, relation: 'controls_generation', evidence: step.systemPrompt || step.userPromptTemplate });
    }
    (step.source_refs || []).filter(ref => ref !== 'user_query' && !ref.startsWith('previous_step')).slice(0, 3).forEach((ref, idx) => {
      const id = `source:${step.order}:${idx}`;
      const refText = ref.toLowerCase();
      const type = refText.includes('tool') || refText.includes('api') ? 'tool' : refText.includes('log') ? 'log' : 'document';
      const detail = type === 'log'
        ? (logPattern.test(step.evidence_source || '') ? step.evidence_source : '')
        : type === 'tool'
          ? fullEvidence(step.output || step.input)
          : fullEvidence(documentPattern.test(step.output || '') ? step.output : step.input || step.output);
      addNode({ id, type, label: type === 'document' ? `外部资料/检索来源：${ref}` : ref, detail });
      addEdge({ source: id, target: stepNode, relation: type === 'tool' ? 'tool_result_used' : 'document_evidence_used', evidence: step.evidence_source });
    });
    if (step.evidence_source && logPattern.test(step.evidence_source)) {
      const id = `evidence:${step.order}`;
      addNode({ id, type: 'log', label: '日志/API错误源头', detail: step.evidence_source, status: step.diagnosis_status });
      addEdge({ source: id, target: stepNode, relation: 'runtime_signal', status: step.diagnosis_status, evidence: step.evidence_source });
    } else if (step.evidence_source && documentPattern.test(step.evidence_source)) {
      const id = `evidence:${step.order}`;
      addNode({ id, type: 'document', label: '文档/检索证据片段', detail: step.evidence_source, status: step.diagnosis_status });
      addEdge({ source: id, target: stepNode, relation: 'document_evidence_used', status: step.diagnosis_status, evidence: step.evidence_source });
    }
    (step.where_to_steps || []).slice(0, 3).forEach(target => {
      const targetStep = subprocesses[target - 1];
      addNode({ id: `step:${target}`, type: 'downstream_step', label: `Step ${target}: ${targetStep?.name || 'downstream'}`, detail: targetStep?.input || targetStep?.output || '' });
      addEdge({ source: stepNode, target: `step:${target}`, relation: 'output_used_by_downstream', evidence: step.output });
    });
    return { nodes, edges };
  };

  const getVisibleProvenanceGraph = (step: Subprocess) => {
    const fallback = fallbackProvenanceGraph(step);
    return {
      nodes: step.provenance_nodes?.length ? step.provenance_nodes : fallback.nodes,
      edges: step.provenance_edges?.length ? step.provenance_edges : fallback.edges,
    };
  };

  const renderVisualProvenanceView = () => (
    <div
      className="min-w-[900px] space-y-4 pb-3 transition-transform duration-150"
      style={{ transform: `scale(${zoom})`, transformOrigin: 'top left' }}
    >
      {subprocesses.map((step) => {
        const graph = getVisibleProvenanceGraph(step);
        const currentNode = graph.nodes.find(node => node.type === 'step' || node.id === `step:${step.order}`) || graph.nodes[0];
        const sourceNodes = graph.nodes.filter(node => node.id !== currentNode?.id && node.type !== 'downstream_step').slice(0, 5);
        const downstreamNodes = graph.nodes
          .filter(node => node.type === 'downstream_step' || (/^step:\d+/.test(node.id) && node.id !== `step:${step.order}` && Number(node.id.split(':')[1]) > step.order))
          .slice(0, 4);
        const rowHeight = Math.max(230, Math.max(sourceNodes.length, downstreamNodes.length, 1) * 54 + 78);
        const centerY = Math.round(rowHeight / 2);
        const sourceY = (idx: number) => 44 + idx * Math.max(44, Math.min(58, (rowHeight - 96) / Math.max(sourceNodes.length, 1)));
        const downstreamY = (idx: number) => 44 + idx * Math.max(44, Math.min(58, (rowHeight - 96) / Math.max(downstreamNodes.length, 1)));

        return (
          <div key={step.id} className="relative w-[900px] rounded-2xl border border-slate-200 bg-white/95 p-3 shadow-sm">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-xs font-semibold text-slate-700">Step {step.order} 证据来源图</div>
              <div className="flex gap-1 text-[10px] text-slate-400">
                <span>{sourceNodes.length} 个来源节点</span><span>·</span><span>{graph.edges.length} 条信息边</span>
              </div>
            </div>
            <div className="relative rounded-xl bg-slate-50" style={{ height: rowHeight }}>
              <svg className="absolute inset-0 h-full w-full overflow-visible" aria-hidden="true">
                {sourceNodes.map((node, idx) => (
                  <path key={`source-${node.id}`} d={`M 230 ${sourceY(idx) + 18} C 300 ${sourceY(idx) + 18}, 318 ${centerY}, 385 ${centerY}`} stroke={node.status === 'failure' ? '#ef4444' : node.status === 'warning' ? '#f59e0b' : '#94a3b8'} strokeWidth={node.status === 'failure' ? 2.6 : 1.8} fill="none" strokeLinecap="round" strokeDasharray={node.type === 'prompt' ? '4 4' : undefined} />
                ))}
                {downstreamNodes.map((node, idx) => {
                  const order = Number(node.id.split(':')[1]);
                  const affected = step.diagnosis_status === 'failure' && step.affected_steps?.includes(order);
                  return <path key={`downstream-${node.id}`} d={`M 515 ${centerY} C 585 ${centerY}, 600 ${downstreamY(idx) + 18}, 670 ${downstreamY(idx) + 18}`} stroke={affected ? '#ef4444' : '#38bdf8'} strokeWidth={affected ? 2.6 : 1.8} fill="none" strokeLinecap="round" strokeDasharray={affected ? '6 4' : undefined} />;
                })}
              </svg>

              {sourceNodes.map((node, idx) => (
                <button key={node.id} onClick={() => setResultDetail({ title: `${sourceTypeLabel(node.type)}：${node.label}`, content: buildProvenanceNodeDetail(step, node, graph) })} className={clsx('absolute left-5 w-[205px] rounded-lg border px-2 py-1.5 text-left text-[11px] shadow-sm transition hover:-translate-y-0.5', visualNodeTone(node.type, node.status))} style={{ top: sourceY(idx) }} title={node.detail || node.label}>
                  <div className="font-semibold">{sourceTypeLabel(node.type)}</div>
                  <div className="mt-0.5 truncate">{node.label}</div>
                </button>
              ))}

              <button onClick={() => openCurrentStep(step)} className={clsx('absolute left-[385px] w-[130px] rounded-xl border-2 px-3 py-3 text-left shadow-md transition hover:-translate-y-0.5', step.diagnosis_status === 'failure' ? 'border-red-400 bg-red-50 text-red-800' : step.potential_risks?.length ? 'border-sky-300 bg-sky-50 text-sky-800' : 'border-slate-300 bg-white text-slate-800')} style={{ top: centerY - 45 }} title={currentNode?.detail || getStepFullResult(step)}>
                <div className="text-[11px] font-semibold">STEP {step.order}</div>
                <div className="mt-1 text-xs font-bold leading-4">{compactText(step.name, 26)}</div>
                <div className="mt-1 text-[10px] leading-4 text-slate-500">{compactText(getStepResultSummary(step), 34)}</div>
              </button>

              {downstreamNodes.map((node, idx) => (
                <button key={node.id} onClick={() => setResultDetail({ title: `${sourceTypeLabel(node.type)}：${node.label}`, content: buildProvenanceNodeDetail(step, node, graph) })} className={clsx('absolute left-[670px] w-[205px] rounded-lg border px-2 py-1.5 text-left text-[11px] shadow-sm transition hover:-translate-y-0.5', visualNodeTone(node.type, node.status))} style={{ top: downstreamY(idx) }} title={node.detail || node.label}>
                  <div className="font-semibold">下游使用</div>
                  <div className="mt-0.5 truncate">{node.label}</div>
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );

  const renderVisualPropagationView = () => {
    const height = Math.max(360, subprocesses.length * 112 + 80);
    const flowEdges = dataflowEdges.filter(edge => edge.to_step <= subprocesses.length);
    const redEdges = (propagationEdges.length ? propagationEdges : subprocesses.flatMap(step => (
      step.diagnosis_status === 'failure'
        ? (step.affected_steps || step.where_to_steps || []).map(target => ({ from_step: step.order, to_step: target, failure_type: step.failure_type, reason: step.failure_reason, source_excerpt: step.evidence_source }))
        : []
    ))).filter(edge => edge.to_step > 0 && edge.to_step <= subprocesses.length);
    const yOf = (order: number) => 42 + (order - 1) * 112;

    return (
      <div className="min-w-[880px] pb-4 transition-transform duration-150" style={{ transform: `scale(${zoom})`, transformOrigin: 'top left' }}>
        <div className="relative w-[880px] rounded-2xl border border-slate-200 bg-white p-3 shadow-sm" style={{ height }}>
          <div className="absolute left-5 top-3 text-[11px] font-semibold text-slate-500">错误/风险源</div>
          <div className="absolute left-[340px] top-3 text-[11px] font-semibold text-slate-500">工作流 Step</div>
          <div className="absolute right-8 top-3 text-[11px] font-semibold text-slate-500">受影响位置</div>
          <svg className="absolute inset-0 h-full w-full overflow-visible" aria-hidden="true">
            {flowEdges.map(edge => <path key={`flowgraph-${edge.from_step}-${edge.to_step}`} d={`M 420 ${yOf(edge.from_step) + 46} C 300 ${yOf(edge.from_step) + 46}, 300 ${yOf(edge.to_step) + 46}, 420 ${yOf(edge.to_step) + 46}`} stroke="#cbd5e1" strokeWidth="1.5" fill="none" strokeLinecap="round" />)}
            {redEdges.map((edge, idx) => <path key={`redgraph-${edge.from_step}-${edge.to_step}-${idx}`} d={`M 510 ${yOf(edge.from_step) + 34} C 610 ${yOf(edge.from_step) + 34}, 615 ${yOf(edge.to_step) + 34}, 715 ${yOf(edge.to_step) + 34}`} stroke="#ef4444" strokeWidth="2.7" strokeDasharray="6 4" fill="none" strokeLinecap="round" />)}
          </svg>

          {subprocesses.map(step => {
            const isFailure = step.diagnosis_status === 'failure';
            const isAffected = affectedStepOrders.has(step.order);
            const hasRisk = Boolean(step.potential_risks?.length);
            const preview = previewResults.find(item => item.stepId === step.id && item.status !== 'unchanged');
            const y = yOf(step.order);
            return (
              <div key={step.id}>
                {(isFailure || hasRisk) && (
                  <button onClick={() => openCurrentStep(step, preview)} className={clsx('absolute left-5 w-[210px] rounded-lg border px-2 py-1.5 text-left text-[11px] shadow-sm transition hover:-translate-y-0.5', isFailure ? 'border-red-300 bg-red-50 text-red-800' : 'border-sky-200 bg-sky-50 text-sky-800')} style={{ top: y }} title={step.evidence_source || step.potential_risks?.[0]?.reason || step.failure_reason}>
                    <div className="font-semibold">{isFailure ? '真实错误源' : '可能风险源'}</div>
                    <div className="mt-0.5 truncate">{isFailure ? (step.failure_label || step.failure_type) : (step.potential_issue_tags?.slice(0, 2).join('、') || step.potential_risks?.[0]?.label)}</div>
                    <div className="mt-0.5 truncate text-[10px] opacity-75">{compactText(step.evidence_source || step.potential_risks?.[0]?.reason || '', 34)}</div>
                  </button>
                )}

                <button onClick={() => openCurrentStep(step, preview)} className={clsx('absolute left-[330px] w-[190px] rounded-xl border-2 px-3 py-2 text-left shadow-sm transition hover:-translate-y-0.5', isFailure ? 'border-red-400 bg-red-50 text-red-800' : isAffected ? 'border-amber-400 bg-amber-50 text-amber-800' : hasRisk ? 'border-sky-300 bg-sky-50 text-sky-800' : 'border-slate-300 bg-white text-slate-800')} style={{ top: y }}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold">STEP {step.order}</span>
                    <span className={clsx('h-2.5 w-2.5 rounded-full', isFailure ? 'bg-red-500' : isAffected ? 'bg-amber-500' : hasRisk ? 'bg-sky-500' : 'bg-slate-300')} />
                  </div>
                  <div className="mt-1 truncate text-xs font-bold">{step.name}</div>
                  <div className="mt-1 truncate text-[10px] opacity-75">去向：{step.where_to_steps?.length ? `Step ${step.where_to_steps.join(', Step ')}` : '暂无下游'}</div>
                </button>

                {(isAffected || step.affected_steps?.length || isFailure) && (
                  <button onClick={() => openCurrentStep(step, preview)} className={clsx('absolute left-[715px] w-[140px] rounded-lg border px-2 py-1.5 text-left text-[11px] shadow-sm transition hover:-translate-y-0.5', isAffected ? 'border-amber-300 bg-amber-50 text-amber-800' : 'border-red-200 bg-red-50 text-red-700')} style={{ top: y }}>
                    <div className="font-semibold">{isAffected ? '被上游影响' : '影响下游'}</div>
                    <div className="mt-0.5 truncate">{step.affected_steps?.length ? `Step ${step.affected_steps.join(', ')}` : isAffected ? '来自上游红线' : '等待下游使用'}</div>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  void renderProvenanceView;
  void renderPropagationView;

  const BranchButton = ({ suggestion }: { suggestion?: TreeSuggestion }) => {
    const isActiveSuggestion =
      editingTarget?.type === 'suggestion' &&
      suggestion &&
      editingTarget.suggestionId === suggestion.id;
    const branchPreview = isActiveSuggestion
      ? previewResults.find(item => item.stepId === suggestion?.stepId && item.status !== 'unchanged')
      : undefined;
    const branchSummary = compactResult(
      branchPreview?.summary || suggestion?.summary || '等待子过程生成后提供建议结果方向',
      34
    );

    return (
    <button
      onClick={() => suggestion && openSuggestion(suggestion, branchPreview)}
      disabled={!suggestion}
      className={clsx(
        'min-h-[74px] rounded-lg border bg-white/95 px-3 py-2 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md disabled:opacity-40',
        isActiveSuggestion ? 'border-sky-300 bg-sky-50 shadow-sky-100' : 'border-slate-300 hover:border-slate-400'
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-slate-600">{suggestion?.title || '其他方向'}</span>
        <span className={clsx('w-2 h-2 rounded-full', isActiveSuggestion ? 'bg-sky-400' : 'bg-slate-300')} />
      </div>
      <p
        className="mt-2 overflow-hidden text-[11px] text-slate-500 leading-relaxed"
        style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}
        title={branchPreview?.fullResult || branchSummary}
      >
        {branchSummary}
      </p>
    </button>
    );
  };

  return (
    <div className="h-full bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
      <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between flex-shrink-0">
        <div>
          <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7h18M3 12h18M3 17h18" />
            </svg>
            目标-子过程树
            {subprocesses.length > 0 && (
              <span className="ml-1 text-xs bg-purple-100 text-purple-600 px-2 py-0.5 rounded-full">
                {subprocesses.length}
              </span>
            )}
          </h3>
          <p className="text-[11px] text-slate-400 mt-0.5">
            红色错误源来自真实日志/输出证据，橙色表示被传播影响；灰色为AI建议方向
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="flex items-center rounded-lg border border-slate-200 bg-slate-50 p-0.5">
            {([
              ['flow', '流程'],
              ['provenance', '证据来源'],
              ['propagation', '错误传播'],
            ] as [TreeViewMode, string][]).map(([mode, label]) => (
              <button
                key={mode}
                onClick={() => setTreeView(mode)}
                className={clsx(
                  'rounded px-2 py-1 text-[11px] transition',
                  treeView === mode ? 'bg-white font-medium text-slate-800 shadow-sm' : 'text-slate-500 hover:bg-white/70'
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center rounded-lg border border-slate-200 bg-slate-50 p-0.5">
            <button
              onClick={() => changeZoom(-0.08)}
              className="w-6 h-6 rounded text-xs text-slate-500 hover:bg-white hover:text-slate-700"
              title="缩小"
            >
              -
            </button>
            <button
              onClick={() => setZoom(0.92)}
              className="px-1.5 h-6 rounded text-[11px] text-slate-500 hover:bg-white hover:text-slate-700"
              title="重置缩放"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              onClick={() => changeZoom(0.08)}
              className="w-6 h-6 rounded text-xs text-slate-500 hover:bg-white hover:text-slate-700"
              title="放大"
            >
              +
            </button>
          </div>
          {(hasActivePreview || canUndoTreeChange) && (
            <button
              onClick={onUndoPreview}
              className="px-2 py-1 rounded border border-slate-200 bg-white text-[11px] text-slate-500 hover:bg-slate-50"
            >
              撤销更改
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto bg-slate-50/70 p-3">
        {subprocesses.length === 0 ? (
          <div className="h-full border border-dashed border-slate-200 rounded-lg flex items-center justify-center text-xs text-slate-400">
            输入问题后生成Goal与子过程树
          </div>
        ) : treeView === 'provenance' ? (
          renderVisualProvenanceView()
        ) : treeView === 'propagation' ? (
          renderVisualPropagationView()
        ) : (
          <div
            className="min-w-[760px] pb-2 transition-transform duration-150"
            style={{ transform: `scale(${zoom})`, transformOrigin: 'top center' }}
          >
            <div className="relative mx-auto w-[760px]">
              <svg className="pointer-events-none absolute inset-x-0 top-0 h-full w-full overflow-visible" aria-hidden="true">
                <path d="M380 94 C300 122 260 122 180 128" stroke="#b6b6b6" strokeWidth="3" fill="none" strokeLinecap="round" />
                <path d="M380 94 C460 122 500 122 580 128" stroke="#b6b6b6" strokeWidth="3" fill="none" strokeLinecap="round" />
                <path d="M380 94 L380 146" stroke="#cbd5e1" strokeWidth="3" fill="none" strokeLinecap="round" />
              </svg>

              <div className="relative z-10 grid grid-cols-[1fr_1.18fr_1fr] gap-4 items-center">
                <BranchButton suggestion={goalSuggestions[0]} />
                <button
                  className="min-h-[96px] text-left rounded-xl border-2 border-slate-300 bg-white px-4 py-3 shadow-sm transition-all hover:border-sky-400 hover:shadow-md"
                  title={goal}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold tracking-wide text-slate-800">GOAL</span>
                    <span className="w-2.5 h-2.5 rounded-full bg-sky-500 shadow-sm shadow-sky-200" />
                  </div>
                  <p className="mt-2 text-xs text-slate-600 leading-relaxed">{compactText(goal, 86)}</p>
                </button>
                <BranchButton suggestion={goalSuggestions[1]} />
              </div>
            </div>

            <div className="mx-auto h-10 w-px bg-slate-300" />

            <div className="relative space-y-5">
              {(dataflowEdges.length > 0 || propagationEdges.length > 0) && (
                <svg
                  className="pointer-events-none absolute left-0 top-0 z-0 h-full w-full overflow-visible"
                  aria-hidden="true"
                >
                  {dataflowEdges.map((edge) => {
                    const y1 = (edge.from_step - 1) * 145 + 44;
                    const y2 = (edge.to_step - 1) * 145 + 44;
                    return (
                      <path
                        key={`flow-${edge.from_step}-${edge.to_step}`}
                        d={`M 305 ${y1} C 160 ${y1}, 160 ${y2}, 305 ${y2}`}
                        stroke="#cbd5e1"
                        strokeWidth="2"
                        fill="none"
                        strokeLinecap="round"
                      />
                    );
                  })}
                  {propagationEdges.map((edge) => {
                    const y1 = (edge.from_step - 1) * 145 + 44;
                    const y2 = (edge.to_step - 1) * 145 + 44;
                    return (
                      <path
                        key={`error-${edge.from_step}-${edge.to_step}`}
                        d={`M 455 ${y1} C 650 ${y1}, 650 ${y2}, 455 ${y2}`}
                        stroke="#ef4444"
                        strokeWidth="2.5"
                        strokeDasharray="5 4"
                        fill="none"
                        strokeLinecap="round"
                      />
                    );
                  })}
                </svg>
              )}
              {subprocesses.map((step, index) => {
                const suggestions = suggestionsByStep[step.id] || [];
                const isSelected = selectedStepId === step.id;
                const preview = previewResults.find(item => item.stepId === step.id);
                const isPreviewChanged = preview?.status === 'changed';
                const isPreviewAffected = preview?.status === 'affected';
                const fullNodeTitle = preview && preview.status !== 'unchanged' ? preview.name : step.name;
                const displayName = compactText(fullNodeTitle, 16);
                const displayText = compactText(
                  preview && preview.status !== 'unchanged' ? preview.summary : getStepResultSummary(step),
                  22
                );
                const stepFailed = Boolean(isEvidenceFailure(step));
                const stepAffected = affectedStepOrders.has(step.order);
                const stepPotential = !stepFailed && !stepAffected && Boolean(step.potential_risks?.length);
                const outgoingToNext = propagationEdges.some(edge => edge.from_step === step.order && edge.to_step === step.order + 1);
                const alteredPath = isPreviewChanged || isPreviewAffected || outgoingToNext;
                const sourceText = (step.source_refs || []).slice(0, 2).join(', ') || 'user_query';
                const whereToText = (step.where_to_steps || []).length
                  ? `到 Step ${(step.where_to_steps || []).join(', Step ')}`
                  : '没有直接下游';
                const affectedText = (step.affected_steps || []).length
                  ? `影响 Step ${(step.affected_steps || []).join(', Step ')}`
                  : '';
                const diagnosticSummary = stepFailed
                  ? `${step.failure_label || '内容错误源'} · ${(step.evidence_source || `from ${sourceText}`).slice(0, 28)} · ${affectedText || whereToText}`
                  : stepAffected
                    ? `受上游错误影响 · ${whereToText}`
                    : stepPotential
                      ? `可能风险：${(step.potential_issue_tags || []).slice(0, 2).join('、') || step.potential_risks?.[0]?.label} · ${whereToText}`
                      : `${whereToText} · 来源 ${sourceText}`;

                return (
                  <div key={step.id} className="relative z-10 mx-auto w-[760px]">
                    <svg className="pointer-events-none absolute inset-x-0 top-0 h-[116px] w-full overflow-visible" aria-hidden="true">
                      <path d="M380 48 C306 80 260 80 180 74" stroke={alteredPath ? '#f59e0b' : '#b6b6b6'} strokeWidth="3" fill="none" strokeLinecap="round" />
                      <path d="M380 48 C454 80 500 80 580 74" stroke={alteredPath ? '#f59e0b' : '#b6b6b6'} strokeWidth="3" fill="none" strokeLinecap="round" />
                    </svg>

                    <div className="relative z-10 grid grid-cols-[1fr_1.18fr_1fr] gap-4 items-center">
                      <BranchButton suggestion={suggestions[0]} />

                      <div>
                        <button
                          onClick={() => openCurrentStep(step, preview)}
                          className={clsx(
                            'w-full min-h-[88px] rounded-xl border-2 bg-white px-3 py-2 text-left transition-all hover:-translate-y-0.5',
                              stepFailed ? 'border-red-500 bg-red-50 shadow-lg shadow-red-100' :
                                stepAffected ? 'border-amber-400 bg-amber-50 shadow-md shadow-amber-100' :
                                  stepPotential ? 'border-sky-300 bg-sky-50/80 shadow-md shadow-sky-100' :
                                isPreviewChanged ? 'border-sky-500 bg-sky-50 shadow-lg shadow-sky-100' :
                                  isPreviewAffected ? 'border-amber-400 bg-amber-50 shadow-md shadow-amber-100' :
                                isSelected ? 'border-sky-500 shadow-lg shadow-sky-100' :
                                  'border-slate-300 shadow-sm hover:border-sky-400 hover:shadow-md'
                          )}
                        >
                          <div className="flex min-w-0 items-center justify-between gap-2">
                            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-800" title={fullNodeTitle}>
                              STEP {index + 1}: {displayName}
                            </span>
                            <div className="flex shrink-0 items-center gap-1.5">
                              {stepFailed && (
                                <span className="rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700">
                                  错误源
                                </span>
                              )}
                              {!stepFailed && stepAffected && (
                                <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                                  受影响
                                </span>
                              )}
                              {stepPotential && (
                                <span className="rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-700">
                                  可能风险
                                </span>
                              )}
                              {preview && preview.status !== 'unchanged' && (
                                <span className={clsx(
                                  'rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                                  isPreviewChanged ? 'bg-sky-100 text-sky-700' : 'bg-amber-100 text-amber-700'
                                )}>
                                  {isPreviewChanged ? '试运行改动' : '试运行后续'}
                                </span>
                              )}
                              <span className={clsx(
                                'w-2.5 h-2.5 rounded-full',
                                stepFailed ? 'bg-red-500' : isPreviewAffected || stepAffected ? 'bg-amber-500' : stepPotential ? 'bg-sky-500' : 'bg-sky-500'
                              )} />
                            </div>
                          </div>
                          <p className={clsx(
                            'mt-2 text-[11px] leading-relaxed overflow-hidden',
                            stepFailed ? 'text-red-700' : stepAffected ? 'text-amber-800' : stepPotential ? 'text-sky-800' : isPreviewAffected ? 'text-amber-800' : isPreviewChanged ? 'text-sky-700' : 'text-slate-600'
                          )}
                            style={{ display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical' }}
                            title={preview?.fullResult || getStepFullResult(step)}
                          >
                            {displayText}
                          </p>
                          <div
                            className={clsx(
                              'mt-1 truncate text-[10px]',
                              stepFailed ? 'text-red-500' : stepAffected ? 'text-amber-600' : stepPotential ? 'text-sky-600' : 'text-slate-400'
                            )}
                            title={step.failure_reason || diagnosticSummary}
                          >
                            {diagnosticSummary}
                          </div>
                        </button>
                      </div>

                      <BranchButton suggestion={suggestions[1]} />
                    </div>
                    {index < subprocesses.length - 1 && (
                      <div className={clsx('mx-auto h-9 w-px', outgoingToNext ? 'bg-red-400' : alteredPath ? 'bg-amber-400' : 'bg-slate-300')} />
                    )}
                  </div>
                );
              })}
            </div>

            {previewFinalOutput && (
              <div className="mx-auto w-[760px]">
                <div className="mx-auto h-9 w-px bg-emerald-400" />
                <button
                  onClick={openFinalResult}
                  title={previewFinalOutput}
                  className="mx-auto block w-[300px] rounded-xl border-2 border-emerald-300 bg-emerald-50 px-4 py-3 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-emerald-400 hover:shadow-md"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-emerald-800">预测产生的结果</span>
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                  </div>
                  <p className="mt-2 text-[11px] text-emerald-700 leading-relaxed">{compactResult(previewFinalOutput, 36)}</p>
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {(editingTarget || resultDetail) && (
        <div className="border-t border-slate-200 bg-slate-50 p-3">
          <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-base font-bold text-red-600">{resultDetail?.title || editorTitle}</div>
                {editingTarget && selectedStep && (
                  <div className="text-[11px] text-slate-400 mt-0.5">同步步骤：{selectedStep.name}</div>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                {resultDetail && (
                  <button
                    onClick={() => setIsDetailExpanded(true)}
                    className="px-2 py-1 rounded border border-slate-200 bg-white text-[11px] text-slate-500 hover:bg-slate-50"
                  >
                    放大查看
                  </button>
                )}
                <button
                  onClick={closeEditor}
                  className="px-2 py-1 rounded text-[11px] text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                >
                  关闭
                </button>
              </div>
            </div>

            {resultDetail && (
              <pre className="mt-2 max-h-48 overflow-y-auto rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-[11px] leading-relaxed text-slate-600 whitespace-pre-wrap font-sans">
                {resultDetail.content}
              </pre>
            )}

            {editingTarget && (
              <>
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-[11px] text-slate-400">
                    同步修复 Prompt（含 System 角色 + User 输入模板，可人工修改），共 {draftPrompt.length} 字
                  </span>
                  <button
                    onClick={() => setIsDetailExpanded(true)}
                    className="px-2 py-0.5 rounded border border-slate-200 bg-white text-[11px] text-slate-500 hover:bg-slate-50"
                  >
                    放大编辑
                  </button>
                </div>
                <textarea
                  value={draftPrompt}
                  onChange={(event) => setDraftPrompt(event.target.value)}
                  rows={8}
                  className="mt-1 w-full rounded border border-slate-200 px-2 py-1.5 text-xs leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-red-300 font-mono"
                  style={{ minHeight: 140, maxHeight: 360 }}
                  placeholder="这里会同步修复建议生成的 System Prompt 与 User Prompt 输入模板；你可以人工修改后再试运行。"
                />
                <div className="mt-2 flex items-center justify-between gap-2">
                  <button
                    onClick={previewPrompt}
                    disabled={!draftPrompt.trim() || isPreviewing}
                    className="px-3 py-1.5 rounded bg-slate-800 text-white text-xs hover:bg-slate-700 disabled:opacity-40"
                  >
                    {isPreviewing ? '试运行中...' : '试运行'}
                  </button>
                  {canApplyCurrentPreview && (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={onUndoPreview}
                        className="px-3 py-1.5 rounded border border-slate-200 bg-white text-xs text-slate-500 hover:bg-slate-50"
                      >
                        撤销
                      </button>
                      <button
                        onClick={applyPrompt}
                        disabled={!draftPrompt.trim()}
                        className="px-3 py-1.5 rounded bg-red-500 text-white text-xs hover:bg-red-600 disabled:opacity-40"
                      >
                        采纳到右侧
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}

            {!editingTarget && resultDetail && (
              <div className="mt-2 flex justify-end">
                <button
                  onClick={onUndoPreview}
                  className="px-3 py-1.5 rounded border border-slate-200 bg-white text-xs text-slate-500 hover:bg-slate-50"
                >
                  撤销预览
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {isDetailExpanded && (resultDetail || editingTarget) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 px-6 py-8">
          <div className="flex max-h-full min-h-0 w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
              <div>
                <div className="text-2xl font-bold text-red-600">
                  {editingTarget ? `${editorTitle}（修复 Prompt 放大编辑）` : resultDetail?.title}
                </div>
                <div className="mt-1 text-sm font-semibold text-red-500">
                  {editingTarget ? '主要修改 User Prompt 输入模板；确认后点试运行 / 采纳' : '完整内容，可滚动查看'}
                </div>
              </div>
              <button
                onClick={() => setIsDetailExpanded(false)}
                className="rounded-lg px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-700"
              >
                关闭
              </button>
            </div>
            {editingTarget ? (
              <div className="flex flex-col gap-3 px-5 py-4">
                {resultDetail && (
                  <details className="rounded border border-slate-200 bg-slate-50">
                    <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-slate-600">
                      查看当前结果（{resultDetail.title}）
                    </summary>
                    <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap px-3 py-2 text-xs leading-6 text-slate-600 font-sans">
                      {resultDetail.content}
                    </pre>
                  </details>
                )}
                <textarea
                  value={draftPrompt}
                  onChange={(event) => setDraftPrompt(event.target.value)}
                  className="w-full rounded border border-slate-200 px-3 py-2 text-sm leading-7 font-mono resize-y focus:outline-none focus:ring-2 focus:ring-red-300"
                  style={{ minHeight: '50vh', maxHeight: '65vh' }}
                  placeholder="编辑 System Prompt..."
                  aria-label="编辑同步修复 Prompt"
                />
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-slate-400">共 {draftPrompt.length} 字符</span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={previewPrompt}
                      disabled={!draftPrompt.trim() || isPreviewing}
                      className="px-4 py-1.5 rounded bg-slate-800 text-white text-sm hover:bg-slate-700 disabled:opacity-40"
                    >
                      {isPreviewing ? '试运行中...' : '试运行'}
                    </button>
                    {canApplyCurrentPreview && (
                      <button
                        onClick={() => { applyPrompt(); setIsDetailExpanded(false); }}
                        disabled={!draftPrompt.trim()}
                        className="px-4 py-1.5 rounded bg-red-500 text-white text-sm hover:bg-red-600 disabled:opacity-40"
                      >
                        采纳到右侧
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              resultDetail && (
                renderExpandedDetailContent(resultDetail.content)
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default PromptTreePanel;
