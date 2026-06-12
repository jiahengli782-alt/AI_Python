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

export interface ProvenanceNode {
  id: string;
  type: 'question' | 'previous_step' | 'step' | 'downstream_step' | 'prompt' | 'document' | 'tool' | 'log' | 'memory' | string;
  label: string;
  detail?: string;
  status?: 'normal' | 'warning' | 'failure' | string;
}

export interface ProvenanceEdge {
  source: string;
  target: string;
  relation: string;
  status?: 'normal' | 'warning' | 'failure' | string;
  evidence?: string;
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
  evidence_strength_basis?: string[];
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
  provenance_nodes?: ProvenanceNode[];
  provenance_edges?: ProvenanceEdge[];
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
  currentQuestion?: string;
  onSyncFixToTree?: (stepId: string, prompt: string) => void;
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

const block = (title: string, value?: string, max = 900) => {
  const clean = (value || '').trim();
  return clean ? `【${title}】\n${compactLine(clean, max)}` : '';
};

const extractContentFocus = (step: DiagnosisStep, currentQuestion?: string) => {
  const source = [
    currentQuestion,
    step.input,
    step.output,
    step.evidence_source,
    ...(step.diagnosis_evidence || []),
    ...(step.potential_risks || []).map(risk => risk.source_excerpt || risk.reason || ''),
  ].filter(Boolean).join('\n');
  const snippets = source
    .split(/[\n。！？!?；;]+/)
    .map(item => item.replace(/\s+/g, ' ').trim())
    .filter(item => item.length >= 8)
    .filter(item => !/when|where|why|how/i.test(item))
    .slice(0, 5);
  return snippets.length ? snippets : [compactLine(source, 220)].filter(Boolean);
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

const hasAnyText = (text: string | undefined, terms: string[]) =>
  terms.some(term => (text || '').includes(term));

const buildOutputContract = (step: DiagnosisStep, labels: string[]) => {
  const joined = `${labels.join(' ')} ${step.failure_type || ''} ${step.failure_label || ''} ${step.failure_reason || ''}`;
  if (hasAnyText(joined, ['检索', '证据', '来源', '无证据', '引用'])) {
    return [
      'matched_evidence：列出可支持结论的原文证据，每条必须包含 source、snippet、supports',
      'missing_evidence：列出仍缺少的证据；没有证据时写“证据不足”',
      'conclusion：只基于 matched_evidence 输出本步骤结论',
      'next_step_input：后续步骤必须继承的证据和结论',
    ];
  }
  if (hasAnyText(joined, ['约束', '验证', '检查', '标准'])) {
    return [
      'checks：逐条列出用户原文中的显式约束、业务对象、状态判断和验收标准',
      'evidence：每条检查对应的原文/日志/上游依据',
      'pass：true/false，不能用模糊词代替',
      'failed_reason：未通过时写清楚缺什么输入',
      'next_step_input：只传递已验证通过的信息',
    ];
  }
  if (hasAnyText(joined, ['上下文', '遗漏', '自相矛盾', '前后'])) {
    return [
      'carried_over：从前序步骤必须继承的实体/状态/约束',
      'current_decision：本步骤对这些信息的处理结果',
      'dropped_items：如果丢弃任何项，必须说明过滤理由',
      'consistency_check：说明是否与前序结论一致',
      'next_step_input：后续必须使用的完整清单',
    ];
  }
  if (hasAnyText(joined, ['格式', 'JSON', 'schema', '字段'])) {
    return [
      '严格输出可解析 JSON',
      '包含 result、evidence、missing、next_step_input 四个字段',
      '不要输出 Markdown 包裹或额外解释',
    ];
  }
  return [
    'result：本步骤直接可用的修复后结果',
    'evidence：支持 result 的证据或上游依据',
    'uncertainty：不能确认的内容和原因',
    'next_step_input：后续步骤必须继承的信息',
  ];
};

const buildStageSystemRules = (step: DiagnosisStep, labels: string[]) => {
  const stage = step.stage || 'unknown';
  const labelText = labels.length ? labels.join('、') : labelOf(step);
  const common = [
    `角色：你只负责 Step ${step.order}「${step.name}」这一环节。`,
    `本次修复目标：${labelText}。`,
    '禁止输出“建议如何修改 Prompt”的说明，必须直接产出本步骤结果。',
    '所有事实、状态、数字、日志定位和文档结论都必须来自输入证据；没有证据就写“证据不足”。',
  ];
  if (stage === 'planner') {
    return [
      ...common,
      '规划时必须把用户问题拆成可验证检查点，每个检查点写清需要什么证据、交给哪个后续步骤使用。',
      '如果原文涉及引用、文档、日志定位、状态判断、数量或时间，必须分别列为独立检查点。',
      '输出必须包含 next_step_input，供后续步骤直接使用。',
    ];
  }
  if (stage === 'retriever') {
    return [
      ...common,
      '检索/证据步骤只负责找证据和判断证据是否覆盖问题，不允许提前生成最终结论。',
      '必须优先匹配用户问题中的实体、状态、时间、功能、错误码、文档片段。',
      '输出必须区分 matched_evidence 和 missing_evidence。',
    ];
  }
  if (stage === 'generator' || stage === 'summarizer') {
    return [
      ...common,
      '生成结论时只能使用输入中的 matched_evidence、上游结构化结果和用户问题。',
      '每个事实 claim 后必须说明依据；没有依据的内容放入 uncertainty，不要写进结论。',
      '不要丢弃前序步骤传来的实体、约束、状态和时间信息。',
    ];
  }
  if (stage === 'verifier') {
    return [
      ...common,
      '验证时必须逐条核验用户约束、上游结论和证据是否一致。',
      '每个检查项必须输出 pass=true/false、证据、失败原因。',
      '发现证据缺失、前后矛盾或格式不符时，必须明确标出 failed_reason。',
    ];
  }
  if (stage === 'tool_call') {
    return [
      ...common,
      '工具/API 步骤必须先校验工具名称、参数、endpoint、错误码和返回结构。',
      '工具失败时停止编造业务结论，只输出错误边界、可重试条件和 next_step_input。',
      '工具结果进入后续步骤前必须转成结构化字段。',
    ];
  }
  return [
    ...common,
    '请优先保留用户硬约束、证据来源、关键实体、状态、时间和后续必须继承的信息。',
    '输出必须结构化，能被后续步骤直接消费。',
  ];
};

const buildUserPromptRewrite = (
  step: DiagnosisStep,
  fixes: { category: string; text: string }[],
  currentQuestion?: string,
) => {
  const labels = [
    step.failure_label,
    step.failure_type,
    ...(step.potential_issue_tags || []),
    ...(step.potential_risks || []).map(risk => risk.label || risk.failure_type),
  ].filter(Boolean).join('、');
  const sourceText = step.evidence_source || step.diagnosis_evidence?.join('\n') || step.output || step.input || '';
  const contentFocus = extractContentFocus(step, currentQuestion);
  const refinedPrompt = [
    `请重新执行 Step ${step.order}「${step.name}」，只围绕下面这些原文焦点补强，不要把诊断维度当成用户任务：`,
    ...contentFocus.map((item, index) => `${index + 1}. ${item}`),
    '输出时必须保留和这些原文焦点直接相关的实体、状态、数量、时间、证据来源和上游结论；如果缺少依据，明确写“证据不足”。',
  ];
  const naturalFix = (() => {
    if (/context_omission|上下文|遗漏|过长|继承/.test(labels + sourceText)) {
      return [
        '这一步的问题更像是上游信息没有被完整带入。请先回看下面的上游输出和原文焦点，把其中已经出现的关键实体、状态、数量、时间、约束和证据来源原样带入本步骤，再继续生成结果。',
        '如果某个关键信息在上游已经出现，不要再回答“信息不足”；只有在上游和原始问题里都没有依据时，才写“证据不足”。',
        '生成结果时请明确说明哪些信息被继承使用，哪些信息仍然缺失，最后给出能直接交给下一步使用的简洁结论。',
      ];
    }
    if (/retrieval_miss|证据|检索|来源|引用/.test(labels + sourceText)) {
      return [
        '这一步的问题更像是证据不足或证据方向没有覆盖原问题。请根据原始问题和上游输入，先明确要找的对象、状态、时间、功能名、错误码或关键结论，再围绕这些内容补充证据。',
        '不要泛泛总结资料；每个事实性结论都必须说明来自哪段输入、哪份文档、哪条日志或哪个上游输出。如果找不到能支撑结论的依据，请直接写“证据不足”，不要补造结论。',
        '生成结果时请把“已找到的证据”和“仍缺少的证据”分开说清楚。',
      ];
    }
    if (/tool_misuse|API|工具|调用|日志|错误码|SetLimitExceeded|429/i.test(labels + sourceText)) {
      return [
        '这一步的问题来自工具、API 或日志错误。请先定位错误码、接口名、请求参数和错误消息，再判断是否能继续推理。',
        '如果 API/工具调用已经失败，不要继续生成业务结论；请只说明失败边界、可能原因、是否可重试，以及下一步应该补充或修正什么输入。',
        '如果日志中有明确错误文本，请优先引用该错误文本作为依据。',
      ];
    }
    if (/unsupported_claim|fact_error|幻觉|事实|无证据|状态|上线/.test(labels + sourceText)) {
      return [
        '这一步的问题更像是结论没有被证据支撑，或事实/状态判断可能写得过满。请重新检查本步骤中的每个事实性结论，只保留能从原始问题、上游输出、文档片段或日志文本中找到依据的内容。',
        '对于没有依据的结论，不要写成确定事实；请改写为“不确定”或“证据不足”。对于有依据的结论，请在句子里自然说明依据来自哪里。',
        '尤其注意数字、时间、状态、是否上线、是否完成、功能是否具备这类结论，必须逐项核对来源。',
      ];
    }
    if (/planning_error|规划|检查项|约束/.test(labels + sourceText)) {
      return [
        '这一步的问题更像是任务拆解不够贴合原问题。请重新围绕原始问题中的对象、目标、限制条件、需要核对的资料和最终交付要求来规划。',
        '不要只写泛泛步骤；每个子任务都要说明它要核对什么原文内容、需要什么证据，以及它的结果会交给后面哪类步骤使用。',
        '如果原问题里有必须满足的条件，请把这些条件保留下来，避免后续步骤默认已经覆盖。',
      ];
    }
    return [
      '请根据下面的原始问题、上游输出和错误触发文本重新执行这一步。不要只根据当前短摘要继续推理。',
      '生成时优先保留原文中的关键对象、约束、证据来源和上游结论；遇到没有依据的内容，请明确写“证据不足”。',
      '最后输出一段能被后续步骤直接使用的结果。',
    ];
  })();
  const usefulFixes = fixes
    .map(fix => cleanFixText(fix.text))
    .filter(Boolean)
    .slice(0, 3);
  return [
    `请重新执行 Step ${step.order}「${step.name}」。下面是根据当前真实错误原因生成的修复版自然语言 Prompt：`,
    '',
    ...refinedPrompt,
    '',
    ...naturalFix,
    '',
    usefulFixes.length ? '可以参考这些具体修复方向，但不要把它们原样当成回答内容：' : '',
    ...usefulFixes.map((item, index) => `${index + 1}. ${item}`),
    '',
    block('原始问题', currentQuestion, 1400),
    block('本步骤当前输入或上游传入内容', step.input, 1400),
    block('本步骤上一版输出', step.output, 1400),
    step.failure_reason ? block('为什么需要改这一处', step.failure_reason, 1200) : '',
    step.evidence_source ? block('优先核对的原文/日志/证据片段', step.evidence_source, 900) : '',
    '',
    '请直接给出修复后的本步骤结果，不要解释你如何修改 Prompt。',
  ].filter(Boolean);
};

const buildFixPreviewPrompt = (
  step: DiagnosisStep,
  _fixes: { category: string; text: string }[],
  labels: string[],
  currentQuestion?: string,
) => {
  const clean = (value?: string) => (value || '').replace(/\s+/g, ' ').trim();
  const question = clean(currentQuestion);
  const isOriginalQuestion = (value?: string) => {
    const text = clean(value);
    if (!text || !question) return false;
    const head = question.slice(0, 42);
    return text === question || (head.length >= 12 && text.includes(head));
  };

  const splitSentences = (value?: string) =>
    clean(value)
      .split(/(?<=[。！？!?；;])|\n+/)
      .map(clean)
      .filter(item => item.length >= 8)
      .filter(item => !isOriginalQuestion(item))
      .filter(item => !/^API调用失败/.test(item));

  const shortNatural = (value?: string, max = 360) => {
    const text = clean(value);
    if (!text) return '';
    if (text.length <= max) return text;
    const sentence = splitSentences(text).find(item => item.length <= max);
    if (sentence) return sentence;
    const cut = text.slice(0, max);
    const lastBreak = Math.max(
      cut.lastIndexOf('。'),
      cut.lastIndexOf('；'),
      cut.lastIndexOf('，'),
      cut.lastIndexOf(';'),
      cut.lastIndexOf(',')
    );
    return cut.slice(0, lastBreak > 80 ? lastBreak : max).trim();
  };

  const pickStepTarget = () => {
    const candidates = [
      step.input,
      step.output,
      step.evidence_source,
      step.failure_reason,
      step.potential_risks?.[0]?.source_excerpt,
      step.potential_risks?.[0]?.reason,
      step.name,
    ];
    for (const candidate of candidates) {
      const sentence = splitSentences(candidate).find(item => item.length >= 8);
      if (sentence) return shortNatural(sentence, 320);
      const cleaned = clean(candidate);
      if (cleaned && !isOriginalQuestion(cleaned)) return shortNatural(cleaned, 320);
    }
    return step.name;
  };

  const extractMissing = () => {
    const text = clean([
      step.failure_reason,
      step.evidence_source,
      step.potential_risks?.[0]?.reason_summary,
      step.potential_risks?.[0]?.reason,
      step.potential_risks?.[0]?.source_excerpt,
    ].filter(Boolean).join(' '));
    const patterns = [
      /缺少[：:]?\s*([^。；\n]{2,160})/,
      /(?:丢失|遗漏|没有带入|未保留|未覆盖)(?:了|的)?[“"']?([^。；\n]{2,160})/,
      /(?:调用错|误用|调用失败|错误码|接口失败)[：: ]?([^。；\n]{2,160})/,
      /(?:约束|限制|要求)(?:不足|不够|缺少|未覆盖)[：: ]?([^。；\n]{2,160})/,
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) return shortNatural(match[1], 220);
    }
    return '';
  };

  const previousEvidence = shortNatural(
    step.evidence_source ||
    step.diagnosis_evidence?.join('\n') ||
    step.potential_risks?.[0]?.source_excerpt ||
    '',
    420
  );
  const typeText = `${labels.join(' ')} ${step.failure_type || ''} ${step.failure_label || ''} ${step.failure_reason || ''} ${step.potential_risks?.[0]?.failure_type || ''}`;
  const target = pickStepTarget();
  const missing = extractMissing();

  const instruction = (() => {
    if (/context_omission|上下文|遗漏|丢失|继承/.test(typeText)) {
      return missing
        ? `执行“${step.name}”时，先继续保留上游已经得到的关键信息：${missing}。不要把这些已有信息误判为缺失；如果需要筛选，请说明筛选依据，再基于“${target}”继续推理。`
        : `执行“${step.name}”时，先完整继承上游输出里的关键对象、状态、约束和证据。不要只看当前摘要；如果某个信息没有被继续使用，请说明为什么舍弃，再基于“${target}”继续推理。`;
    }
    if (/retrieval_miss|证据|检索|来源|引用|无证据/.test(typeText)) {
      return missing
        ? `执行“${step.name}”时，先补齐能支持“${missing}”的具体证据来源。找不到来源就写“证据不足”，不要把推测写成结论。`
        : `执行“${step.name}”时，先围绕“${target}”补具体证据来源。每个事实结论都要能对应到上游输出、文档片段、日志或工具结果；找不到就写“证据不足”。`;
    }
    if (/tool_misuse|API|工具|调用|日志|错误码|SetLimitExceeded|429/i.test(typeText)) {
      return `执行“${step.name}”时，先核对工具/API 的接口、参数和返回错误。若日志里已经出现“${shortNatural(step.evidence_source || target, 220)}”，不要继续生成业务结论，只说明调用失败边界、需要重试或需要补充的输入。`;
    }
    if (/constraint_violation|约束|限制|必须|不能|不要/.test(typeText)) {
      return missing
        ? `执行“${step.name}”时，把“${missing}”写成必须遵守的硬约束。输出前逐条检查这些约束，不满足就改写或标记为证据不足。`
        : `执行“${step.name}”时，把“${target}”里的限制条件转成明确检查项。输出前逐条核对，不满足就不要放行。`;
    }
    if (/unsupported_claim|fact_error|hallucination|事实|幻觉|状态|上线/.test(typeText)) {
      return `执行“${step.name}”时，只把有来源支持的内容写成确定结论。围绕“${target}”逐条核对来源；数字、时间、状态、是否完成、是否上线这类判断没有证据就写“证据不足”。`;
    }
    if (/planning_error|规划|检查项/.test(typeText)) {
      return `执行“${step.name}”时，把下一步推理目标拆清楚：围绕“${target}”列出要核对的对象、需要的证据、限制条件和交给后续步骤使用的结果，不要只写泛泛计划。`;
    }
    return `执行“${step.name}”时，围绕“${target}”补上缺失信息和必要限制。没有来源支持的内容写“证据不足”，不要扩展无关任务。`;
  })();

  return [
    instruction,
    previousEvidence ? `需要重点核对的错误源头：${previousEvidence}` : '',
  ].filter(Boolean).join('\n');
};

void buildOutputContract;
void buildStageSystemRules;
void buildUserPromptRewrite;

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

export function AgentDiagnosisPanel({ steps, traceDiagnosis, currentQuestion, onSyncFixToTree }: AgentDiagnosisPanelProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('when');
  const [detailModal, setDetailModal] = useState<{ title: string; content: string } | null>(null);
  const orderedSteps = useMemo(() => [...steps].sort((a, b) => (a.order || 0) - (b.order || 0)), [steps]);
  const contentFailures = orderedSteps.filter(isContentFailure);
  const weakWarnings = orderedSteps.filter(isSoftHint);
  const potentialRiskSteps = orderedSteps.filter(step => step.potential_risks?.length);
  const isFailureSourceStep = (step: DiagnosisStep) =>
    isContentFailure(step) &&
    !contentFailures.some(prev =>
      (prev.order || 0) < (step.order || 0) &&
      (prev.affected_steps || []).includes(step.order)
    );
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
    const isSource = isFailureSourceStep(step);
    const rawItems = Array.from(new Set([
      ...(isSource ? (step.suggested_fix || []) : []),
    ].filter(Boolean)));
    const labels = Array.from(new Set([
      ...(isSource ? [labelOf(step)] : []),
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
            {contentFailures.length > 0 && potentialRiskSteps.length > 0 && (
              <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-700">
                除了红色真实错误源，下面这些步骤还存在可预防的潜在推理风险。
              </div>
            )}
            {potentialRiskSteps.map(step => (
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
                  为什么错：{shortStepWhy(step)}
                  {step.failure_reason && step.failure_reason.length > 42 && (
                    <button
                      type="button"
                      onClick={() => setDetailModal({
                        title: `Step ${step.order}: ${labelOf(step)}`,
                        content: [
                          `错误类型：${labelOf(step)}`,
                          `置信度：${normalizePercent(step.failure_confidence)}%`,
                          '',
                          `为什么错：${shortStepWhy(step)}`,
                          '',
                          `证据强度依据：`,
                          ...(step.evidence_strength_basis?.length ? step.evidence_strength_basis : ['暂无']),
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
                  <div className="flex flex-wrap items-center gap-1.5">
                    {group.labels.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                      {group.labels.slice(0, 3).map(label => (
                        <span key={label} className={clsx('rounded-full px-2 py-0.5 text-[11px] font-medium ring-1', group.palette.chip)}>
                          {label}
                        </span>
                      ))}
                      </div>
                    )}
                    {onSyncFixToTree && (
                      <button
                        type="button"
                        onClick={() => onSyncFixToTree(group.step.id, buildFixPreviewPrompt(group.step, group.fixes, group.labels, currentQuestion))}
                        className="rounded-md bg-slate-900 px-2 py-1 text-[11px] font-medium text-white hover:bg-slate-700 disabled:opacity-40"
                        title="把这些修复建议同步到左侧树状图的指定 Step Prompt 弹窗，可人工修改后再点试运行"
                      >
                        同步到左树编辑
                      </button>
                    )}
                  </div>
                </div>
                <div className="mt-2 rounded-md bg-white/70 px-2 py-1.5 text-[11px] font-medium text-slate-600 ring-1 ring-slate-100">
                  错误源头：建议改 Step {group.step.order}
                  {group.step.affected_steps?.length
                    ? `，该错误会继续影响 Step ${group.step.affected_steps.join('、Step ')}`
                    : group.step.where_to_steps?.length
                      ? `，它的输出会进入 Step ${group.step.where_to_steps.join('、Step ')}`
                      : '，这是当前可定位到的直接错误位置'}
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
                没有明确内容错误源头，因此暂不生成自动修复建议。可以继续观察输出，或手动选择某个 step 做反事实试运行。
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
