import { useMemo, useState } from 'react';
import clsx from 'clsx';

export type AgentStageType =
  | 'planner'
  | 'retriever'
  | 'tool_call'
  | 'generator'
  | 'verifier'
  | 'retry'
  | 'memory_update'
  | 'summarizer'
  | 'unknown';

export type AgentFailureType =
  | 'none'
  | 'fact_error'
  | 'unsupported_claim'
  | 'tool_misuse'
  | 'retrieval_miss'
  | 'planning_error'
  | 'self_inconsistency'
  | 'constraint_violation'
  | 'format_error'
  | 'hallucination'
  | 'invalid_retry'
  | 'cost_latency_anomaly'
  | 'memory_pollution'
  | 'context_omission'
  | 'unknown';

export interface PropagationEdge {
  from_step: number;
  to_step: number;
  failure_type?: AgentFailureType;
  reason?: string;
  source_excerpt?: string;
}

export interface AgentTraceDiagnosis {
  overall_status: 'success' | 'partial_failure' | 'failure';
  main_failure_type: AgentFailureType;
  main_failure_label?: string;
  failure_stage?: number | null;
  summary: string;
  suggested_fixes: string[];
  propagation_edges?: PropagationEdge[];
}

export interface DiagnosisStep {
  id: string;
  name: string;
  order: number;
  output?: string;
  input?: string;
  stage?: AgentStageType;
  stage_label?: string;
  healthScore?: number;
  health_score?: number;
  riskScore?: number;
  risk_score?: number;
  accuracy?: number;
  impact_score?: number;
  timeMs?: number;
  latency_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  source_refs?: string[];
  where_to_steps?: number[];
  affected_steps?: number[];
  propagation_edges?: PropagationEdge[];
  failure_type?: AgentFailureType;
  failure_label?: string;
  failure_confidence?: number;
  failure_reason_summary?: string;
  failure_reason?: string;
  likely_causes?: string[];
  exclusion_checked?: string[];
  related_stage?: string;
  source_refs_used?: string[];
  diagnosis_status?: 'normal' | 'warning' | 'failure';
  observed_signals?: string[];
  evidence_source?: string;
  diagnosis_evidence?: string[];
  potential_risks?: {
    failure_type: AgentFailureType;
    subtype?: string;
    label?: string;
    confidence?: number;
    reason_summary?: string;
    reason?: string;
    source_excerpt?: string;
    matched_signals?: string[];
    suggested_fix?: string;
    suggested_fixes?: string[];
    severity?: 'low' | 'medium' | 'high';
  }[];
  potential_issue_tags?: string[];
  suggested_fix?: string[];
}

interface AgentDiagnosisPanelProps {
  steps: DiagnosisStep[];
  traceDiagnosis?: AgentTraceDiagnosis | null;
}

const stageLabels: Record<string, string> = {
  planner: '规划',
  retriever: '证据/检索',
  tool_call: '工具',
  generator: '生成',
  verifier: '验证',
  retry: '重试',
  memory_update: '记忆',
  summarizer: '总结',
  unknown: '未知',
};

const failureLabels: Record<string, string> = {
  none: '未观察到失败',
  fact_error: '事实错误',
  unsupported_claim: '无证据断言',
  tool_misuse: '工具/API失败',
  retrieval_miss: '证据缺失',
  planning_error: '规划不完整',
  self_inconsistency: '步骤间自相矛盾',
  constraint_violation: '验证未通过',
  format_error: '格式不符',
  hallucination: '缺少证据支撑',
  invalid_retry: '无效重试',
  cost_latency_anomaly: '成本/延迟偏高',
  memory_pollution: '记忆污染',
  context_omission: '上下文过长风险',
  unknown: '未知问题',
};

const tabs = [
  { key: 'when', label: 'When 什么时候错' },
  { key: 'where', label: 'Where 从哪到哪' },
  { key: 'how', label: 'Why/How 为什么错' },
  { key: 'auto', label: '修复建议' },
] as const;

type TabKey = typeof tabs[number]['key'];

const normalizePercent = (value?: number) => {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  return Math.round(value <= 1 ? value * 100 : value);
};

const failureOf = (step: DiagnosisStep): AgentFailureType => step.failure_type || 'none';
const isContentFailure = (step: DiagnosisStep) => step.diagnosis_status === 'failure';
const isSoftHint = (step: DiagnosisStep) => step.diagnosis_status === 'warning';
const stageOf = (step: DiagnosisStep) => step.stage_label || stageLabels[step.stage || 'unknown'] || '未知';
const labelOf = (step: DiagnosisStep) => step.failure_label || failureLabels[failureOf(step)] || failureOf(step);

const stepPalettes = [
  { card: 'border-sky-200 bg-sky-50/60', chip: 'bg-sky-100 text-sky-700 ring-sky-200', item: 'bg-white/80 ring-sky-100' },
  { card: 'border-emerald-200 bg-emerald-50/60', chip: 'bg-emerald-100 text-emerald-700 ring-emerald-200', item: 'bg-white/80 ring-emerald-100' },
  { card: 'border-violet-200 bg-violet-50/60', chip: 'bg-violet-100 text-violet-700 ring-violet-200', item: 'bg-white/80 ring-violet-100' },
  { card: 'border-amber-200 bg-amber-50/60', chip: 'bg-amber-100 text-amber-700 ring-amber-200', item: 'bg-white/80 ring-amber-100' },
  { card: 'border-rose-200 bg-rose-50/50', chip: 'bg-rose-100 text-rose-700 ring-rose-200', item: 'bg-white/80 ring-rose-100' },
];

const compactLine = (text = '', max = 118) => {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
};

const fixCategoryOf = (fix: string) => {
  if (/System Prompt/i.test(fix)) return 'System Prompt';
  if (/User Template/i.test(fix)) return 'User Template';
  if (/输出格式|格式/i.test(fix)) return '输出格式';
  if (/后续|下一步|最终回答|确认提交/i.test(fix)) return '后续约束';
  return '其他调整';
};

const cleanFixText = (fix: string) =>
  fix.replace(/^(System Prompt|User Template|输出格式|后续约束|确认提交前|最终回答)[:：]\s*/i, '').trim();

const shortWhy = (reason = '', label = '可能有问题') => {
  const clean = reason.replace(/\s+/g, ' ').trim();
  const afterColon = clean.match(/(?:为什么可能错|完整原因|原因|因此|所以)[：:]\s*(.+)$/);
  if (afterColon?.[1]) return compactLine(afterColon[1], 42);
  const missing = clean.match(/(?:没有看到|缺少|缺失)[“"]([^”"]+)[”"]/);
  if (missing?.[1]) return `缺少${missing[1]}`;
  const outputIssue = clean.match(/当前输出[“"][^”"]+[”"]里没有看到[“"]([^”"]+)[”"]/);
  if (outputIssue?.[1]) return `输出没有包含${outputIssue[1]}`;
  const direction = clean.match(/资料方向不完整|不能直接支撑本步结论|没有绑定文件片段|不能直接支撑|漏检|漏掉关键依据/);
  if (direction?.[0]) return direction[0];
  return compactLine(clean || label, 42);
};

type PotentialRisk = NonNullable<DiagnosisStep['potential_risks']>[number];

const shortPotentialWhy = (risk: PotentialRisk) =>
  compactLine(risk.reason_summary || shortWhy(risk.reason || '', risk.label || risk.failure_type), 54);

const shortStepWhy = (step: DiagnosisStep) =>
  compactLine(step.failure_reason_summary || shortWhy(step.failure_reason || '', labelOf(step)), 58);

const buildRiskDetail = (risk: PotentialRisk) => [
  `错误类型：${risk.label || risk.failure_type}`,
  risk.subtype ? `细分类：${risk.subtype}` : '',
  `置信度：${normalizePercent(risk.confidence)}%`,
  '',
  `短原因：${shortPotentialWhy(risk)}`,
  '',
  `完整错误内容与信息：`,
  risk.reason || '无完整原因',
  '',
  `触发这条判断的原文：`,
  risk.source_excerpt || '无',
  '',
  `匹配到的问题/日志信号：`,
  ...(risk.matched_signals?.length ? risk.matched_signals : ['暂无']),
  '',
  `修复建议：`,
  ...(risk.suggested_fixes?.length ? risk.suggested_fixes : risk.suggested_fix ? [risk.suggested_fix] : ['暂无']),
].filter(Boolean).join('\n');

const mergeFixItems = (items: string[]) => {
  const groups = new Map<string, string[]>();
  items.forEach(item => {
    const category = fixCategoryOf(item);
    const value = cleanFixText(item);
    if (!value) return;
    groups.set(category, [...(groups.get(category) || []), value]);
  });
  return Array.from(groups.entries()).map(([category, values]) => ({
    category,
    text: Array.from(new Set(values)).join('；'),
  })).slice(0, 4);
};

const buildFallbackDiagnosis = (steps: DiagnosisStep[]): AgentTraceDiagnosis => {
  const failures = steps.filter(isContentFailure).sort((a, b) => (a.order || 0) - (b.order || 0));
  if (!failures.length) {
    return {
      overall_status: 'success',
      main_failure_type: 'none',
      failure_stage: null,
      summary: '没有检测到明确内容错误源。成本/延迟/上下文只作为性能/上下文提示，不会画红色传播链。',
      suggested_fixes: [],
      propagation_edges: [],
    };
  }
  const first = failures[0];
  return {
    overall_status: 'failure',
    main_failure_type: failureOf(first),
    main_failure_label: labelOf(first),
    failure_stage: first.order,
    summary: `最早内容错误源出现在 Step ${first.order}：${first.failure_reason || '该步骤出现可观测异常。'}`,
    suggested_fixes: first.suggested_fix || [],
    propagation_edges: failures.flatMap(step => step.propagation_edges || []),
  };
};

const statusMeta = {
  success: { label: 'No Content Failure', badge: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
  partial_failure: { label: 'Performance/Context Hints', badge: 'border-amber-200 bg-amber-50 text-amber-700' },
  failure: { label: 'Failure Observed', badge: 'border-red-200 bg-red-50 text-red-700' },
};

export function AgentDiagnosisPanel({ steps, traceDiagnosis }: AgentDiagnosisPanelProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('when');
  const [detailModal, setDetailModal] = useState<{ title: string; content: string } | null>(null);
  const orderedSteps = useMemo(() => [...steps].sort((a, b) => (a.order || 0) - (b.order || 0)), [steps]);
  const contentFailures = orderedSteps.filter(isContentFailure);
  const weakWarnings = orderedSteps.filter(isSoftHint);
  const potentialRiskSteps = orderedSteps.filter(step => step.potential_risks?.length);
  const diagnosis = traceDiagnosis || buildFallbackDiagnosis(orderedSteps);
  const firstFailure = contentFailures[0] || null;
  const status = statusMeta[firstFailure ? 'failure' : weakWarnings.length ? 'partial_failure' : 'success'];
  const propagationEdges = [
    ...(diagnosis.propagation_edges || []),
    ...contentFailures.flatMap(step => step.propagation_edges || []),
  ].filter((edge, index, arr) =>
    arr.findIndex(item => item.from_step === edge.from_step && item.to_step === edge.to_step) === index
  );
  const fixGroups = orderedSteps.map((step, index) => {
    const rawItems = Array.from(new Set([
      ...(isContentFailure(step) ? (step.suggested_fix || []) : []),
      ...(step.potential_risks || []).flatMap(risk => risk.suggested_fixes || (risk.suggested_fix ? [risk.suggested_fix] : [])),
      ...(isSoftHint(step) ? (step.suggested_fix || []) : []),
    ].filter(Boolean)));
    const labels = Array.from(new Set([
      ...(isContentFailure(step) ? [labelOf(step)] : []),
      ...(step.potential_issue_tags || []),
      ...(isSoftHint(step) ? [labelOf(step)] : []),
    ].filter(Boolean)));
    return { step, fixes: mergeFixItems(rawItems), labels, palette: stepPalettes[index % stepPalettes.length] };
  }).filter(group => group.fixes.length > 0);

  if (!steps.length) return null;

  return (
    <div className="mb-4 rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-slate-800">Agent Failure Diagnosis</div>
            <div className="mt-1 max-w-3xl text-xs leading-5 text-slate-500">
              {firstFailure ? diagnosis.summary : potentialRiskSteps.length
                ? `未发现明确内容错误源；但根据问题/文档/日志特征，${potentialRiskSteps.length} 个步骤存在潜在推理风险。`
                : '未发现明确内容错误源；成本/延迟类问题只作为性能/上下文提示显示。'}
            </div>
          </div>
          <div className={clsx('rounded-full border px-3 py-1 text-xs font-semibold', status.badge)}>
            {status.label}
          </div>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-4">
          <div className="rounded-lg bg-slate-50 px-3 py-2">
            <div className="text-slate-400">When 最早内容错误</div>
            <div className="mt-1 font-semibold text-slate-700">
              {firstFailure ? `Step ${firstFailure.order} · ${stageOf(firstFailure)}` : '未观察到明确内容错误'}
            </div>
          </div>
          <div className="rounded-lg bg-slate-50 px-3 py-2">
            <div className="text-slate-400">Where 实际传播线</div>
            <div className="mt-1 font-semibold text-slate-700">
              {propagationEdges.length ? `${propagationEdges.length} 条` : '暂无内容错误传播'}
            </div>
          </div>
          <div className="rounded-lg bg-slate-50 px-3 py-2">
            <div className="text-slate-400">性能/上下文提示</div>
            <div className="mt-1 font-semibold text-slate-700">{weakWarnings.length} 个</div>
          </div>
          <div className="rounded-lg bg-slate-50 px-3 py-2">
            <div className="text-slate-400">可能推理风险</div>
            <div className="mt-1 font-semibold text-slate-700">{potentialRiskSteps.length} 个步骤</div>
          </div>
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-slate-100 px-3 py-2">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={clsx(
              'shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
              activeTab === tab.key ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-500 hover:bg-slate-100'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="max-h-96 overflow-y-auto p-4">
        {activeTab === 'when' && (
          <div className="space-y-2">
            {orderedSteps.map(step => {
              const failed = isContentFailure(step);
              const warning = isSoftHint(step);
              const potential = !failed && Boolean(step.potential_risks?.length);
              return (
                <div
                  key={step.id}
                  className={clsx(
                    'rounded-lg border px-3 py-2',
                    failed ? 'border-red-200 bg-red-50/70' :
                      warning ? 'border-amber-200 bg-amber-50/60' :
                        potential ? 'border-sky-200 bg-sky-50/70' :
                        'border-slate-200 bg-slate-50'
                  )}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-slate-800">
                        Step {step.order}: {step.name}
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        {stageOf(step)} · {failed ? labelOf(step) : warning ? labelOf(step) : potential ? `可能风险：${step.potential_issue_tags?.slice(0, 2).join('、') || step.potential_risks?.[0]?.label}` : '未观察到失败'}
                      </div>
                    </div>
                    <span className={clsx(
                      'rounded-full px-2 py-0.5 text-[11px] font-medium',
                      failed ? 'bg-red-100 text-red-700' :
                        warning ? 'bg-amber-100 text-amber-700' :
                          potential ? 'bg-sky-100 text-sky-700' :
                          'bg-emerald-100 text-emerald-700'
                    )}>
                      {failed ? `证据强度 ${normalizePercent(step.failure_confidence)}%` : warning ? '性能提示' : potential ? '可能风险' : 'OK'}
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-slate-500 sm:grid-cols-4">
                    <span>健康 {normalizePercent(step.healthScore ?? step.health_score)}</span>
                    <span>风险 {normalizePercent(step.riskScore ?? step.risk_score)}</span>
                    <span>影响 {normalizePercent(step.accuracy ?? step.impact_score)}</span>
                    <span>耗时 {Math.round(step.timeMs ?? step.latency_ms ?? 0)} ms</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {activeTab === 'where' && (
          <div className="space-y-3">
            {!contentFailures.length && (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                没有明确内容错误源，因此不画红色错误传播链。成本/延迟类性能提示不会标红。
              </div>
            )}
            {orderedSteps.map(step => {
              const failed = isContentFailure(step);
              const warning = isSoftHint(step);
              const potential = !failed && Boolean(step.potential_risks?.length);
              return (
                <div key={step.id} className={clsx(
                  'rounded-lg border p-3 text-xs',
                  failed ? 'border-red-200 bg-red-50/60' :
                    warning ? 'border-amber-200 bg-amber-50/50' :
                      potential ? 'border-sky-200 bg-sky-50/60' :
                      'border-slate-200 bg-slate-50'
                )}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-semibold text-slate-800">Step {step.order}: {step.name}</div>
                    <div className={clsx(
                      'rounded-full px-2 py-0.5',
                      failed ? 'bg-red-100 text-red-700' :
                        warning ? 'bg-amber-100 text-amber-700' :
                          potential ? 'bg-sky-100 text-sky-700' :
                          'bg-white text-slate-500 ring-1 ring-slate-200'
                    )}>
                      {failed ? '内容错误源' : warning ? '性能/上下文提示' : potential ? '可能推理风险' : '普通数据流'}
                    </div>
                  </div>
                  <div className="mt-2 grid gap-2 md:grid-cols-3">
                    <div>
                      <div className="mb-1 font-medium text-slate-500">从哪里来</div>
                      {(step.source_refs?.length ? step.source_refs : ['user_query']).map(ref => (
                        <span key={ref} className="mr-1 mt-1 inline-flex rounded bg-white px-2 py-0.5 text-slate-600 ring-1 ring-slate-200">{ref}</span>
                      ))}
                    </div>
                    <div>
                      <div className="mb-1 font-medium text-slate-500">真实到哪里去</div>
                      {(step.where_to_steps?.length ? step.where_to_steps : []).map(item => (
                        <span
                          key={item}
                          className={clsx(
                            'mr-1 mt-1 inline-flex rounded px-2 py-0.5 ring-1',
                            failed && step.affected_steps?.includes(item)
                              ? 'bg-red-50 text-red-700 ring-red-200'
                              : 'bg-white text-slate-600 ring-slate-200'
                          )}
                        >
                          Step {item}
                        </span>
                      ))}
                      {!step.where_to_steps?.length && <span className="text-slate-400">没有直接下游步骤</span>}
                      {failed && step.affected_steps?.length ? (
                        <div className="mt-1 text-red-600">红色表示该错误会真实传到这些步骤。</div>
                      ) : null}
                    </div>
                    <div>
                      <div className="mb-1 font-medium text-slate-500">文字源头</div>
                      <span className="text-slate-600">
                        {step.evidence_source || step.potential_risks?.[0]?.source_excerpt || (step.observed_signals || []).join(', ') || '无硬错误信号'}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {activeTab === 'how' && (
          <div className="space-y-3">
            {!contentFailures.length && (
              potentialRiskSteps.length ? (
                <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-700">
                  未观察到真实错误，但下面这些步骤根据问题/文档/日志特征更容易出现推理错误。
                </div>
              ) : (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                  这次运行没有足够证据判断“为什么错”。系统不会仅凭健康度、风险度、成本或延迟强行诊断。
                </div>
              )
            )}
            {!contentFailures.length && potentialRiskSteps.map(step => (
              <div key={step.id} className="rounded-lg border border-sky-200 bg-white p-3">
                <div className="font-semibold text-slate-800">Step {step.order}: 可能出现 {step.potential_issue_tags?.slice(0, 2).join('、')}</div>
                <div className="mt-2 space-y-2">
                  {(step.potential_risks || []).map((risk, idx) => (
                    <div key={idx} className="rounded-md bg-sky-50 p-2 text-xs leading-5 text-slate-700">
                      <div className="font-semibold text-sky-800">{risk.label || risk.failure_type} · 置信 {normalizePercent(risk.confidence)}%</div>
                      <div className="mt-1">
                        为什么可能错：{shortPotentialWhy(risk)}
                        <button
                          type="button"
                          onClick={() => setDetailModal({
                            title: `Step ${step.order}: ${risk.label || risk.failure_type}`,
                            content: buildRiskDetail(risk)
                          })}
                          className="ml-2 rounded px-1.5 py-0.5 text-[11px] font-medium text-sky-700 hover:bg-white"
                        >
                          查看全部
                        </button>
                      </div>
                      {risk.source_excerpt && <div>触发文本：{compactLine(risk.source_excerpt, 72)}</div>}
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {contentFailures.map(step => (
              <div key={step.id} className="rounded-lg border border-red-200 bg-white p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-semibold text-slate-800">
                    Step {step.order}: {labelOf(step)}
                  </div>
                  <div className="text-xs text-slate-500">证据强度 {normalizePercent(step.failure_confidence)}%</div>
                </div>
                <p className="mt-2 text-xs leading-5 text-slate-600">
                  {shortStepWhy(step)}
                  {step.failure_reason && step.failure_reason.length > 42 && (
                    <button
                      type="button"
                      onClick={() => setDetailModal({
                        title: `Step ${step.order}: ${labelOf(step)}`,
                        content: [
                          `错误类型：${labelOf(step)}`,
                          `置信度：${normalizePercent(step.failure_confidence)}%`,
                          '',
                          `短原因：${shortStepWhy(step)}`,
                          '',
                          `完整错误内容与信息：`,
                          step.failure_reason || '无',
                          '',
                          `触发这条判断的原文：`,
                          (step.diagnosis_evidence || []).join('\n') || '无',
                          '',
                          `可能原因：`,
                          ...(step.likely_causes?.length ? step.likely_causes : ['暂无']),
                          '',
                          `已排除/区分：`,
                          ...(step.exclusion_checked?.length ? step.exclusion_checked : ['暂无']),
                        ].join('\n')
                      })}
                      className="ml-2 rounded px-1.5 py-0.5 text-[11px] font-medium text-red-700 hover:bg-red-50"
                    >
                      查看全部
                    </button>
                  )}
                </p>
                <div className="mt-2">
                  <div className="text-[11px] font-semibold text-slate-400">触发这条判断的原文</div>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-slate-600">
                    {(step.diagnosis_evidence || []).map((item, idx) => <li key={idx}>{item}</li>)}
                  </ul>
                </div>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'auto' && (
          <div className="space-y-3">
            {fixGroups.length ? fixGroups.map(group => (
              <div key={group.step.id} className={clsx('rounded-lg border p-3 shadow-sm', group.palette.card)}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-semibold text-slate-800">
                    Step {group.step.order}: {group.step.name}
                  </div>
                  {group.labels.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {group.labels.slice(0, 3).map(label => (
                        <span key={label} className={clsx('rounded-full px-2 py-0.5 text-[11px] font-medium ring-1', group.palette.chip)}>
                          {label}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="mt-2 space-y-2">
                  {group.fixes.map((fix) => (
                    <div key={fix.category} className={clsx('rounded-md px-3 py-2 text-xs leading-5 text-slate-700 ring-1', group.palette.item)}>
                      <span className="font-semibold text-slate-600">{fix.category}： </span>{fix.text}
                    </div>
                  ))}
                </div>
              </div>
            )) : (
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                没有明确内容错误证据，因此暂不建议修改 Prompt。可以继续观察输出，或手动选择某个 step 做反事实试运行。
              </div>
            )}
            {weakWarnings.length > 0 && contentFailures.length === 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                已发现 {weakWarnings.length} 个成本/延迟/上下文提示，但它们不是内容错误源，因此不生成红色传播链。
              </div>
            )}
          </div>
        )}
      </div>
      {detailModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 px-6 py-8">
          <div className="flex max-h-full w-full max-w-3xl flex-col rounded-xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
              <div className="text-sm font-semibold text-slate-800">{detailModal.title}</div>
              <button
                type="button"
                onClick={() => setDetailModal(null)}
                className="rounded-lg px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-700"
              >
                关闭
              </button>
            </div>
            <pre className="max-h-[70vh] overflow-y-auto whitespace-pre-wrap p-5 font-sans text-sm leading-6 text-slate-700">
              {detailModal.content}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
