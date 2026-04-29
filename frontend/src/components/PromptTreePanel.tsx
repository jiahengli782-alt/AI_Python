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

interface PromptTreePanelProps {
  goal: string;
  subprocesses: Subprocess[];
  selectedStepId: string | null;
  editingStepId: string | null;
  editedSystemPrompt: string;
  promptDrafts: Record<string, string>;
  previewResults: TreePreviewResult[];
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
  if (!clean) return '等待生成子过程后显示摘要 Prompt';
  return clean.length > maxLength ? `${clean.slice(0, maxLength)}...` : clean;
}

function extractTreePrompt(text: string) {
  if (!text) return '';
  const markerIndex = text.indexOf(marker);
  if (markerIndex >= 0) {
    const afterMarker = text.slice(markerIndex + marker.length).trim();
    return afterMarker.split(/\n\s*\n/)[0].trim();
  }
  return compactText(text, 92);
}

function buildStepSuggestions(step: Subprocess, index: number): TreeSuggestion[] {
  const base = step.name || `步骤${index + 1}`;
  return [
    {
      id: `${step.id}-verify`,
      stepId: step.id,
      title: '验证分支',
      summary: `补充 ${base} 的反例、边界条件和可靠性检查`,
      prompt: `在“${base}”中加入验证分支：检查关键假设、反例、边界条件，并明确哪些结论需要降低置信度。`,
    },
    {
      id: `${step.id}-evidence`,
      stepId: step.id,
      title: '依据分支',
      summary: `让 ${base} 显式列出证据、约束和可追溯依据`,
      prompt: `在“${base}”中加入依据分支：先列出输入证据和约束，再基于证据生成结论，避免跳步推理。`,
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
  isPreviewing,
  resetSignal,
  onSelectStep,
  onApplyPrompt,
  onPreviewPrompt,
  onUndoPreview,
}: PromptTreePanelProps) {
  const [editingTarget, setEditingTarget] = useState<EditingTarget | null>(null);
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
  const goalSuggestions: TreeSuggestion[] = firstStep ? [
    {
      id: `${firstStep.id}-goal-user`,
      stepId: firstStep.id,
      title: '用户目标方向',
      summary: '优先澄清用户、场景、成功标准，再展开推理',
      prompt: `在“${firstStep.name}”中优先澄清目标用户、使用场景、成功标准和限制条件，再决定后续推理路径。`,
    },
    {
      id: `${firstStep.id}-goal-constraint`,
      stepId: firstStep.id,
      title: '约束校准方向',
      summary: '先列出约束、风险和不可做事项，减少方向漂移',
      prompt: `在“${firstStep.name}”中先列出硬性约束、潜在风险和不应采用的方向，再输出可执行的子过程目标。`,
    },
  ] : [];

  const changeZoom = (delta: number) => {
    setZoom(prev => Math.max(0.68, Math.min(1.35, Number((prev + delta).toFixed(2)))));
  };

  const getCurrentPrompt = (step: Subprocess) => {
    if (editingStepId === step.id && editedSystemPrompt) return extractTreePrompt(editedSystemPrompt);
    if (promptDrafts[step.id]) return promptDrafts[step.id];
    return extractTreePrompt(step.systemPrompt || step.description || step.input);
  };

  const openCurrentStep = (step: Subprocess) => {
    onSelectStep(step.id);
    setEditingTarget({ type: 'current', stepId: step.id });
    setDraftPrompt(getCurrentPrompt(step));
  };

  const openSuggestion = (suggestion: TreeSuggestion) => {
    onSelectStep(suggestion.stepId);
    setEditingTarget({ type: 'suggestion', stepId: suggestion.stepId, suggestionId: suggestion.id });
    setDraftPrompt(suggestion.prompt);
  };

  const closeEditor = () => {
    setEditingTarget(null);
    setDraftPrompt('');
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

  const editorTitle = (() => {
    if (!editingTarget) return '';
    const step = subprocesses.find(item => item.id === editingTarget.stepId);
    if (!step) return '';
    return editingTarget.type === 'current' ? `${step.name} 的摘要 Prompt` : `${step.name} 的建议方向`;
  })();

  const BranchButton = ({ suggestion }: { suggestion?: TreeSuggestion }) => {
    const isActiveSuggestion =
      editingTarget?.type === 'suggestion' &&
      suggestion &&
      editingTarget.suggestionId === suggestion.id;

    return (
    <button
      onClick={() => suggestion && openSuggestion(suggestion)}
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
      <p className="mt-2 text-[11px] text-slate-500 leading-relaxed">{suggestion?.summary || '等待子过程生成后提供建议分支'}</p>
    </button>
    );
  };

  return (
    <div className="h-full bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
      <div className="px-3 py-2 border-b border-slate-100 flex items-center justify-between">
        <div>
          <h3 className="text-xs font-semibold text-slate-700">目标-子过程树</h3>
          <p className="text-[11px] text-slate-400 mt-0.5">红色为当前流程，灰色为AI建议方向</p>
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
          {previewResults.length > 0 && (
            <button
              onClick={onUndoPreview}
              className="px-2 py-1 rounded border border-slate-200 bg-white text-[11px] text-slate-500 hover:bg-slate-50"
            >
              撤销预览
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
                const currentPrompt = getCurrentPrompt(step);
                const preview = previewResults.find(item => item.stepId === step.id);
                const isPreviewChanged = preview?.status === 'changed';
                const isPreviewAffected = preview?.status === 'affected';
                const displayName = preview && preview.status !== 'unchanged' ? preview.name : step.name;
                const displayText = preview && preview.status !== 'unchanged' ? preview.summary : currentPrompt;
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
                          onClick={() => openCurrentStep(step)}
                          className={clsx(
                            'w-full min-h-[106px] rounded-xl border-2 bg-white px-3 py-2 text-left transition-all hover:-translate-y-0.5',
                            isPreviewChanged ? 'border-red-500 bg-red-50 shadow-lg shadow-red-100' :
                              isPreviewAffected ? 'border-amber-400 bg-amber-50 shadow-md shadow-amber-100' :
                                isSelected ? 'border-red-500 shadow-lg shadow-red-100' :
                                  'border-red-300 shadow-sm hover:border-red-400 hover:shadow-md'
                          )}
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-semibold text-slate-800">STEP {index + 1}: {displayName}</span>
                            <div className="flex items-center gap-1.5">
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
                            'mt-2 text-[11px] leading-relaxed',
                            isPreviewAffected ? 'text-amber-800' : isPreviewChanged ? 'text-red-700' : 'text-slate-600'
                          )}>
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
          </div>
        )}
      </div>

      {editingTarget && (
        <div className="border-t border-slate-200 bg-slate-50 p-3">
          <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-xs font-semibold text-slate-700">{editorTitle}</div>
                {selectedStep && (
                  <div className="text-[11px] text-slate-400 mt-0.5">同步步骤：{selectedStep.name}</div>
                )}
              </div>
              <button
                onClick={closeEditor}
                className="px-2 py-1 rounded text-[11px] text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                关闭
              </button>
            </div>
            <textarea
              value={draftPrompt}
              onChange={(event) => setDraftPrompt(event.target.value)}
              rows={4}
              className="mt-2 w-full rounded border border-slate-200 px-2 py-1.5 text-xs resize-none focus:outline-none focus:ring-2 focus:ring-red-300"
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <button
                onClick={previewPrompt}
                disabled={!draftPrompt.trim() || isPreviewing}
                className="px-3 py-1.5 rounded bg-slate-800 text-white text-xs hover:bg-slate-700 disabled:opacity-40"
              >
                {isPreviewing ? '试运行中...' : '试运行'}
              </button>
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
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default PromptTreePanel;
