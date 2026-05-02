import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';

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
}

export interface TreePreviewResult {
  stepId: string;
  name: string;
  status: 'unchanged' | 'changed' | 'affected';
  summary: string;
  fullResult?: string;
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

interface PromptTreePanelProps {
  goal: string;
  subprocesses: Subprocess[];
  selectedStepId: string | null;
  editingStepId: string | null;
  editedSystemPrompt: string;
  promptDrafts: Record<string, string>;
  previewResults: TreePreviewResult[];
  previewFinalOutput: string;
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

// 仅用于树节点小卡片的"显示"：必须截断，否则 UI 撑爆
function extractTreePromptForDisplay(text: string) {
  if (!text) return '';
  const markerIndex = text.indexOf(marker);
  if (markerIndex >= 0) {
    const afterMarker = text.slice(markerIndex + marker.length).trim();
    return afterMarker.split(/\n\s*\n/)[0].trim();
  }
  return compactText(text, 92);
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

// 兼容旧调用名称
const extractTreePrompt = extractTreePromptForDisplay;

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
  const suggestionsByStep = useMemo(() => {
    const result: Record<string, TreeSuggestion[]> = {};
    subprocesses.forEach((step, index) => {
      result[step.id] = buildStepSuggestions(step, index);
    });
    return result;
  }, [subprocesses]);

  const selectedStep = subprocesses.find(step => step.id === selectedStepId);
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

  const openCurrentStep = (step: Subprocess, preview?: TreePreviewResult) => {
    onSelectStep(step.id);
    setEditingTarget({ type: 'current', stepId: step.id });
    setDetailTarget({ type: 'current', stepId: step.id });
    setDraftPrompt(getCurrentPrompt(step));
    if (preview?.fullResult) {
      setResultDetail({ title: `${preview.name} 的完整试运行结果`, content: preview.fullResult });
    } else {
      setResultDetail({ title: `${step.name} 的完整结果`, content: getStepFullResult(step) });
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
        setResultDetail({ title: `${step.name} 的完整结果`, content: getStepFullResult(step) });
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
        isActiveSuggestion ? 'border-red-300 bg-red-50 shadow-red-100' : 'border-slate-300 hover:border-slate-400'
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-slate-600">{suggestion?.title || '其他方向'}</span>
        <span className={clsx('w-2 h-2 rounded-full', isActiveSuggestion ? 'bg-red-400' : 'bg-slate-300')} />
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
          <p className="text-[11px] text-slate-400 mt-0.5">红色为当前结果，灰色为AI建议方向</p>
        </div>
        <div className="flex items-center gap-1.5">
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
        ) : (
          <div
            className="min-w-[760px] pb-2 transition-transform duration-150"
            style={{ transform: `scale(${zoom})`, transformOrigin: 'top center' }}
          >
            <div className="relative mx-auto w-[760px]">
              <svg className="pointer-events-none absolute inset-x-0 top-0 h-full w-full overflow-visible" aria-hidden="true">
                <path d="M380 94 C300 122 260 122 180 128" stroke="#b6b6b6" strokeWidth="3" fill="none" strokeLinecap="round" />
                <path d="M380 94 C460 122 500 122 580 128" stroke="#b6b6b6" strokeWidth="3" fill="none" strokeLinecap="round" />
                <path d="M380 94 L380 146" stroke="#ff6b6b" strokeWidth="3" fill="none" strokeLinecap="round" />
              </svg>

              <div className="relative z-10 grid grid-cols-[1fr_1.18fr_1fr] gap-4 items-center">
                <BranchButton suggestion={goalSuggestions[0]} />
                <button
                  className="min-h-[96px] text-left rounded-xl border-2 border-red-300 bg-white px-4 py-3 shadow-sm transition-all hover:border-red-400 hover:shadow-md"
                  title={goal}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold tracking-wide text-slate-800">GOAL</span>
                    <span className="w-2.5 h-2.5 rounded-full bg-red-500 shadow-sm shadow-red-300" />
                  </div>
                  <p className="mt-2 text-xs text-slate-600 leading-relaxed">{compactText(goal, 86)}</p>
                </button>
                <BranchButton suggestion={goalSuggestions[1]} />
              </div>
            </div>

            <div className="mx-auto h-10 w-px bg-red-300" />

            <div className="space-y-5">
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
                const alteredPath = isPreviewChanged || isPreviewAffected;

                return (
                  <div key={step.id} className="relative mx-auto w-[760px]">
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
                            isPreviewChanged ? 'border-red-500 bg-red-50 shadow-lg shadow-red-100' :
                              isPreviewAffected ? 'border-amber-400 bg-amber-50 shadow-md shadow-amber-100' :
                                isSelected ? 'border-red-500 shadow-lg shadow-red-100' :
                                  'border-red-300 shadow-sm hover:border-red-400 hover:shadow-md'
                          )}
                        >
                          <div className="flex min-w-0 items-center justify-between gap-2">
                            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-800" title={fullNodeTitle}>
                              STEP {index + 1}: {displayName}
                            </span>
                            <div className="flex shrink-0 items-center gap-1.5">
                              {preview && preview.status !== 'unchanged' && (
                                <span className={clsx(
                                  'rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                                  isPreviewChanged ? 'bg-red-100 text-red-600' : 'bg-amber-100 text-amber-700'
                                )}>
                                  {isPreviewChanged ? '试运行改动' : '试运行后续'}
                                </span>
                              )}
                              <span className={clsx(
                                'w-2.5 h-2.5 rounded-full',
                                isPreviewAffected ? 'bg-amber-500' : 'bg-red-500'
                              )} />
                            </div>
                          </div>
                          <p className={clsx(
                            'mt-2 text-[11px] leading-relaxed overflow-hidden',
                            isPreviewAffected ? 'text-amber-800' : isPreviewChanged ? 'text-red-700' : 'text-slate-600'
                          )}
                            style={{ display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical' }}
                            title={preview?.fullResult || getStepFullResult(step)}
                          >
                            {displayText}
                          </p>
                        </button>
                      </div>

                      <BranchButton suggestion={suggestions[1]} />
                    </div>
                    {index < subprocesses.length - 1 && (
                      <div className={clsx('mx-auto h-9 w-px', alteredPath ? 'bg-amber-400' : 'bg-red-300')} />
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
                <div className="text-xs font-semibold text-slate-700">{resultDetail?.title || editorTitle}</div>
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
                    完整 System Prompt（可滚动 / 放大编辑），共 {draftPrompt.length} 字
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
          <div className="flex max-h-full w-full max-w-5xl flex-col rounded-xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
              <div>
                <div className="text-sm font-semibold text-slate-800">
                  {editingTarget ? `${editorTitle}（放大编辑）` : resultDetail?.title}
                </div>
                <div className="mt-0.5 text-[11px] text-slate-400">
                  {editingTarget ? '可直接修改 Prompt 后点试运行 / 采纳' : '完整内容，可滚动查看'}
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
                <pre className="max-h-[72vh] overflow-y-auto whitespace-pre-wrap px-5 py-4 text-sm leading-7 text-slate-700 font-sans">
                  {resultDetail.content}
                </pre>
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default PromptTreePanel;
