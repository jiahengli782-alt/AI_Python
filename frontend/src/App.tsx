import { useEffect, useState, useRef } from 'react';
import clsx from 'clsx';
import { ModificationFlow } from './components/ModificationFlow';
import { PromptTreePanel, type TreePreviewResult } from './components/PromptTreePanel';
import { ChatHistoryPanel, type ConversationSnapshot } from './components/ChatHistoryPanel';
import { SettingsModal, loadSettings, saveSettings, type UserSettings } from './components/SettingsModal';
import { AgentDiagnosisPanel, type AgentTraceDiagnosis, type AgentStageType, type AgentFailureType } from './components/AgentDiagnosisPanel';

const CONVERSATIONS_STORAGE_KEY = 'agent_conversations_v1';
const ACTIVE_CONVERSATION_STORAGE_KEY = 'agent_active_conversation_v1';

function generateConversationId(): string {
  return `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function loadConversationsFromStorage(): ConversationSnapshot[] {
  try {
    const raw = localStorage.getItem(CONVERSATIONS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // 反序列化时把 timestamp Date 还原回去
    return parsed.map((c: any) => ({
      ...c,
      chatMessages: (c.chatMessages || []).map((m: any) => ({
        ...m,
        timestamp: new Date(m.timestamp),
      })),
    }));
  } catch {
    return [];
  }
}

// 内嵌：消息全屏查看 modal，自带 3 个 tab 切换 + 复制
function ViewingMessageModal({ msg, onClose }: {
  msg: { id: string; role: 'user' | 'assistant'; content: string; fullContent?: string; allStagesContent?: string; timestamp: Date };
  onClose: () => void;
}) {
  // 准备 3 种视图的内容
  const summaryText = msg.content || '';
  const fullText = msg.fullContent || '';
  const allText = msg.allStagesContent || '';
  // 哪些 tab 有内容（去重 + 比 summary 更长才有意义）
  const hasFull = !!(fullText && fullText.length > summaryText.length && fullText !== summaryText);
  const hasAll = !!(allText && allText.length > summaryText.length && allText !== summaryText && allText !== fullText);

  // 默认显示哪个 tab：优先"全部步骤"，再是"完整原文"，再是"精简"
  type TabKey = 'summary' | 'full' | 'all';
  const defaultTab: TabKey =
    msg.role === 'assistant' && hasAll ? 'all' :
      msg.role === 'assistant' && hasFull ? 'full' :
        'summary';
  const [activeTab, setActiveTab] = useState<TabKey>(defaultTab);
  const [copied, setCopied] = useState(false);

  const currentText =
    activeTab === 'all' ? allText :
      activeTab === 'full' ? fullText :
        summaryText;

  const handleCopy = () => {
    navigator.clipboard?.writeText(currentText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const showTabs = hasFull || hasAll; // 只要有任一额外视图就展示 tab 区

  return (
    <div
      className="flex max-h-full w-full max-w-4xl flex-col rounded-xl border border-slate-200 bg-white shadow-2xl"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-3">
        <div>
          <div className="text-sm font-semibold text-slate-800 flex items-center gap-2">
            <span
              className={clsx(
                'inline-block px-2 py-0.5 rounded text-xs',
                msg.role === 'user' ? 'bg-purple-100 text-purple-700' : 'bg-slate-100 text-slate-700'
              )}
            >
              {msg.role === 'user' ? '用户' : 'AI 回复'}
            </span>
            完整消息内容
          </div>
          <div className="mt-0.5 text-[11px] text-slate-400">
            {msg.timestamp.toLocaleString('zh-CN')} · 当前显示 {currentText.length} 字
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleCopy}
            className="px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs text-slate-600 hover:bg-slate-50 flex items-center gap-1"
            title="复制当前显示的内容"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            {copied ? '已复制 ✓' : '复制'}
          </button>
          <button
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-700"
          >
            关闭
          </button>
        </div>
      </div>
      {showTabs && (
        <div className="flex items-center gap-1.5 border-b border-slate-100 px-5 py-2 bg-slate-50 flex-wrap">
          <button
            onClick={() => setActiveTab('summary')}
            className={clsx(
              'px-3 py-1 rounded text-xs font-medium transition-colors',
              activeTab === 'summary' ? 'bg-purple-100 text-purple-700' : 'text-slate-500 hover:bg-slate-100'
            )}
          >
            精简答案 ({summaryText.length} 字)
          </button>
          {hasFull && (
            <button
              onClick={() => setActiveTab('full')}
              className={clsx(
                'px-3 py-1 rounded text-xs font-medium transition-colors',
                activeTab === 'full' ? 'bg-purple-100 text-purple-700' : 'text-slate-500 hover:bg-slate-100'
              )}
            >
              最后一步原文 ({fullText.length} 字)
            </button>
          )}
          {hasAll && (
            <button
              onClick={() => setActiveTab('all')}
              className={clsx(
                'px-3 py-1 rounded text-xs font-medium transition-colors flex items-center gap-1',
                activeTab === 'all' ? 'bg-emerald-100 text-emerald-700' : 'text-slate-500 hover:bg-slate-100'
              )}
              title="所有推理步骤的完整输出，包含 AI 全部产出"
            >
              <span>📚</span>
              全部步骤输出 ({allText.length} 字)
            </button>
          )}
          <span className="ml-auto text-[10px] text-slate-400">
            {activeTab === 'all' ? '所有推理步骤的完整输出（推荐）' :
              activeTab === 'full' ? '最后一步未提取的完整模型输出' :
                '提取后的精简答案（与气泡显示一致）'}
          </span>
        </div>
      )}
      <pre className="max-h-[72vh] overflow-y-auto whitespace-pre-wrap break-words px-6 py-5 text-sm leading-7 text-slate-700 font-sans">
        {currentText}
      </pre>
    </div>
  );
}

function persistConversations(conversations: ConversationSnapshot[]) {
  try {
    localStorage.setItem(CONVERSATIONS_STORAGE_KEY, JSON.stringify(conversations));
  } catch (err) {
    console.warn('无法持久化对话历史:', err);
  }
}

// 调用后端用 AI 生成精简标题，失败就返回 null
async function generateAITitle(text: string, settings: UserSettings, maxLength = 14): Promise<string | null> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (settings.apiKey) headers['X-Ark-Api-Key'] = settings.apiKey;
    if (settings.model) headers['X-Ark-Model'] = settings.model;
    const res = await fetch(`${settings.backendUrl}/api/title/generate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text, max_length: maxLength }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.title || null;
  } catch {
    return null;
  }
}

interface Subprocess {
  id: string;
  name: string;
  description: string;
  input: string;
  output: string;
  timeMs: number;
  accuracy: number;
  riskLevel: 'high' | 'medium' | 'low';
  riskScore?: number;
  riskFactors?: string[];
  health: 'green' | 'yellow' | 'red';
  healthScore: number;
  healthIssues: string[];
  healthSuggestions?: string[];
  healthSignals?: Record<string, number>;
  metricBasis?: {
    mode?: 'expected' | 'measured';
    finalDelta?: number;
    outputDelta?: number;
    downstreamWeight?: number;
    outputQuality?: number;
    riskScore?: number;
  };
  stage?: AgentStageType;
  stage_label?: string;
  health_score?: number;
  risk_score?: number;
  impact_score?: number;
  latency_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  source_refs?: string[];
  where_to_steps?: number[];
  affected_steps?: number[];
  propagation_edges?: {
    from_step: number;
    to_step: number;
    failure_type?: AgentFailureType;
    reason?: string;
    source_excerpt?: string;
  }[];
  failure_type?: AgentFailureType;
  failure_label?: string;
  failure_confidence?: number;
  failure_reason?: string;
  diagnosis_status?: 'normal' | 'warning' | 'failure';
  observed_signals?: string[];
  evidence_source?: string;
  diagnosis_evidence?: string[];
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
  suggested_fix?: string[];
  order: number;
  systemPrompt?: string;
  userPrompt?: string;
  userPromptTemplate?: string;
  modified?: boolean;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** 最后一步未提取的原始输出（一般是 JSON） */
  fullContent?: string;
  /** 全部推理步骤的输出拼接（最完整的内容，用于查看 AI 全部产出） */
  allStagesContent?: string;
  timestamp: Date;
}

interface UploadedDocument {
  id: string;
  filename: string;
  size: number;
  charCount: number;
  chunkCount: number;
  preview?: string;
}

interface TreeEditSnapshot {
  editingStepId: string | null;
  editedOutput: string;
  editedSystemPrompt: string;
  editedUserTemplate: string;
  editedInput: string;
  selectedStepId: string | null;
  treePromptDrafts: Record<string, string>;
  subprocesses: Subprocess[];
}

function formatJsonToChinese(text: string): string {
  if (!text) return '';

  try {
    const json = JSON.parse(text);
    const processValue = (value: any, indent: number = 0): string[] => {
      const spaces = '  '.repeat(indent);
      const result: string[] = [];

      if (Array.isArray(value)) {
        if (value.length === 0) {
          result.push('（无）');
        } else {
          value.forEach((item, idx) => {
            if (typeof item === 'string') {
              result.push(`${spaces}${idx + 1}. ${item}`);
            } else if (typeof item === 'object' && item !== null) {
              result.push(`${spaces}${idx + 1}.`);
              result.push(...processValue(item, indent + 1));
            } else {
              result.push(`${spaces}${idx + 1}. ${item}`);
            }
          });
        }
      } else if (typeof value === 'object' && value !== null) {
        for (const [k, v] of Object.entries(value)) {
          const keyChinese = translateKey(k);
          if (typeof v === 'object' && v !== null) {
            result.push(`${spaces}${keyChinese}：`);
            result.push(...processValue(v, indent + 1));
          } else {
            result.push(`${spaces}${keyChinese}：${v}`);
          }
        }
      } else {
        result.push(`${spaces}${value}`);
      }

      return result;
    };

    return processValue(json).join('\n');
  } catch {
    return text;
  }
}

function HighlightedEvidenceText({
  text,
  evidence,
  active,
}: {
  text: string;
  evidence?: string;
  active?: boolean;
}) {
  if (!active || !evidence?.trim() || !text) return <>{text}</>;
  const cleanEvidence = evidence.replace(/\s+/g, ' ').trim();
  const candidates = [
    evidence.trim(),
    cleanEvidence,
    cleanEvidence.slice(0, 160),
    cleanEvidence.slice(0, 80),
  ].filter(item => item.length >= 12);

  for (const candidate of candidates) {
    const index = text.indexOf(candidate);
    if (index >= 0) {
      return (
        <>
          {text.slice(0, index)}
          <mark className="rounded bg-red-100 px-0.5 text-red-800 ring-1 ring-red-200">
            {text.slice(index, index + candidate.length)}
          </mark>
          {text.slice(index + candidate.length)}
        </>
      );
    }
  }
  return <>{text}</>;
}

function translateKey(key: string): string {
  const keyMap: Record<string, string> = {
    'result': '结果', 'output': '输出', 'answer': '答案', 'content': '内容',
    'data': '数据', 'info': '信息', 'status': '状态', 'message': '消息',
    'error': '错误', 'success': '成功', 'type': '类型', 'name': '名称',
    'value': '值', 'core': '核心', 'key_info': '关键信息',
    'problem_type': '问题类型', 'problem_type_detail': '问题类型详情',
    'steps': '步骤', 'dependencies': '依赖',
    'calculation': '计算', 'formula': '公式', 'process': '过程',
    'reasoning': '推理', 'explanation': '解释', 'verification': '验证',
    'is_correct': '是否正确', 'checked': '已检查',
    'code': '代码', 'language': '语言', 'function': '函数', 'class': '类',
    'principles': '原理', 'analysis': '分析', 'references': '参考',
    'approaches': '方法', 'selected': '选定', 'complexity': '复杂度',
    'inputs': '输入', 'outputs': '输出', 'constraints': '约束', 'functionality': '功能',
    'has_errors': '有错误', 'errors': '错误', 'warnings': '警告', 'improvements': '改进',
    'confidence': '置信度', 'issues': '问题', 'suggestions': '建议',
    'calculation_steps': '计算步骤', 'calculation_step': '计算步骤',
    'steps_detail': '步骤详情',
  };
  return keyMap[key] || key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

const riskColors = {
  high: { badge: 'bg-red-50 text-red-600 border-red-200', text: 'text-red-600', label: '高风险', bg: 'bg-red-500' },
  medium: { badge: 'bg-amber-50 text-amber-600 border-amber-200', text: 'text-amber-600', label: '中风险', bg: 'bg-amber-500' },
  low: { badge: 'bg-emerald-50 text-emerald-600 border-emerald-200', text: 'text-emerald-600', label: '低风险', bg: 'bg-emerald-500' }
};

export default function App() {
  const [question, setQuestion] = useState<string>('');
  const [subprocesses, setSubprocesses] = useState<Subprocess[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [editingStepId, setEditingStepId] = useState<string | null>(null);
  const [editedOutput, setEditedOutput] = useState<string>('');
  const [editedSystemPrompt, setEditedSystemPrompt] = useState<string>('');
  const [editedUserTemplate, setEditedUserTemplate] = useState<string>('');
  const [editedInput, setEditedInput] = useState<string>('');
  const [rerunFromStep, setRerunFromStep] = useState<number | null>(null);
  const [activeQuestion, setActiveQuestion] = useState<string>('');
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [treePromptDrafts, setTreePromptDrafts] = useState<Record<string, string>>({});
  const [treePreviewResults, setTreePreviewResults] = useState<TreePreviewResult[]>([]);
  const [treePreviewFinalOutput, setTreePreviewFinalOutput] = useState('');
  const [treeEditSnapshot, setTreeEditSnapshot] = useState<TreeEditSnapshot | null>(null);
  const [isTreePreviewing, setIsTreePreviewing] = useState(false);
  const [treeResetSignal, setTreeResetSignal] = useState(0);
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);
  const [traceDiagnosis, setTraceDiagnosis] = useState<AgentTraceDiagnosis | null>(null);
  const [uploadedDocuments, setUploadedDocuments] = useState<UploadedDocument[]>([]);
  const [isUploadingDocument, setIsUploadingDocument] = useState(false);
  const [isDraggingDocument, setIsDraggingDocument] = useState(false);
  const [modificationHistory, setModificationHistory] = useState<{
    round: number;
    modifiedStepIndex: number;
    stages: Subprocess[];
    traceDiagnosis?: AgentTraceDiagnosis | null;
    timestamp: number;
  }[]>([]);
  const [reasoningEffort, setReasoningEffort] = useState<'minimal' | 'low' | 'medium' | 'high'>('medium');
  // 对话历史：所有过去的会话
  const [conversations, setConversations] = useState<ConversationSnapshot[]>(() => loadConversationsFromStorage());
  const [activeConversationId, setActiveConversationId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(ACTIVE_CONVERSATION_STORAGE_KEY);
    } catch {
      return null;
    }
  });

  const chatEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const stepCardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const treeEditSnapshotRef = useRef<TreeEditSnapshot | null>(null);
  // 当前流式请求的 AbortController，切换/新建对话时用来中断
  const activeAbortControllerRef = useRef<AbortController | null>(null);
  // 全屏查看某条聊天消息的内容
  const [viewingMessage, setViewingMessage] = useState<ChatMessage | null>(null);
  // 用户设置（API Key / 模型 / 后端地址）
  const [settings, setSettings] = useState<UserSettings>(() => loadSettings());
  const [showSettings, setShowSettings] = useState(false);
  // 首次启动如果没填 API Key，自动弹设置面板
  useEffect(() => {
    if (!settings.apiKey) {
      setShowSettings(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 当前正在执行哪一步（基于 SSE stage_start 事件实时更新）
  const [currentRunningStepId, setCurrentRunningStepId] = useState<string | null>(null);
  const [currentRunningStepName, setCurrentRunningStepName] = useState<string>('');
  // 总步数 / 当前步序号（1-based）
  const [progressInfo, setProgressInfo] = useState<{ current: number; total: number } | null>(null);

  const abortActiveStream = () => {
    if (activeAbortControllerRef.current) {
      try { activeAbortControllerRef.current.abort(); } catch {}
      activeAbortControllerRef.current = null;
    }
  };

  const documentIdsForRun = () => uploadedDocuments.map(doc => doc.id);

  const uploadDocumentFiles = async (files: FileList | File[]) => {
    const items = Array.from(files).filter(file => file.size > 0);
    if (!items.length || isUploadingDocument) return;

    setIsUploadingDocument(true);
    setError(null);
    const baseUrl = settings.backendUrl || 'http://localhost:8000';

    try {
      const uploaded: UploadedDocument[] = [];
      for (const file of items) {
        const response = await fetch(`${baseUrl}/api/documents/upload`, {
          method: 'POST',
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
            'X-File-Name': encodeURIComponent(file.name),
            'X-File-Type': file.type || 'application/octet-stream',
          },
          body: file,
        });
        if (!response.ok) {
          let message = `上传失败: ${response.status}`;
          try {
            const data = await response.json();
            message = data.detail || message;
          } catch {}
          throw new Error(`${file.name}: ${message}`);
        }
        uploaded.push(await response.json());
      }
      setUploadedDocuments(prev => {
        const byId = new Map(prev.map(doc => [doc.id, doc]));
        uploaded.forEach(doc => byId.set(doc.id, doc));
        return Array.from(byId.values());
      });
    } catch (err: any) {
      setError(err.message || '文档上传失败');
    } finally {
      setIsUploadingDocument(false);
      setIsDraggingDocument(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const streamSolve = async (payload: {
    question: string;
    startStepIndex?: number;
    modifiedOutputs?: Record<string, string>;
    modifiedSteps?: Record<string, any>;
    baseStages?: Subprocess[];
    previewMode?: boolean;
    reasoningEffort?: string;
    documentIds?: string[];
  }) => {
    // 创建新 AbortController 并替换之前的（旧的会被 abort）
    abortActiveStream();
    const controller = new AbortController();
    activeAbortControllerRef.current = controller;
    const signal = controller.signal;

    const params = new URLSearchParams({ question: payload.question });

    if (payload.startStepIndex !== undefined) {
      params.set('startStepIndex', payload.startStepIndex.toString());
    }

    if (payload.modifiedOutputs && Object.keys(payload.modifiedOutputs).length > 0) {
      params.set('modifiedOutputs', JSON.stringify(payload.modifiedOutputs));
    }

    if (payload.modifiedSteps && Object.keys(payload.modifiedSteps).length > 0) {
      params.set('modifiedSteps', JSON.stringify(payload.modifiedSteps));
    }

    if (payload.baseStages?.length) {
      params.set('useSessionBase', '1');
    }

    if (payload.previewMode) {
      params.set('previewMode', '1');
    }

    if (payload.reasoningEffort) {
      params.set('reasoningEffort', payload.reasoningEffort);
    }

    if (payload.documentIds?.length) {
      params.set('documentIds', JSON.stringify(payload.documentIds));
    }

    // 注入 API Key / 模型到请求头
    const authHeaders: Record<string, string> = {};
    if (settings.apiKey) authHeaders['X-Ark-Api-Key'] = settings.apiKey;
    if (settings.model) authHeaders['X-Ark-Model'] = settings.model;
    const baseUrl = settings.backendUrl || 'http://localhost:8000';

    const postStream = () => fetch(`${baseUrl}/api/solve/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify(payload),
      signal,
    });

    if (payload.baseStages?.length) {
      return postStream();
    }

    // GET 请求无法用自定义 header（EventSource 不支持），把 key 作为 query param 传
    if (settings.apiKey) params.set('apiKey', settings.apiKey);
    if (settings.model) params.set('model', settings.model);
    const getUrl = `${baseUrl}/api/solve/stream?${params.toString()}`;

    try {
      const getResponse = await fetch(getUrl, { signal, headers: authHeaders });
      if (getResponse.status !== 414 && getResponse.status !== 431 && getResponse.status !== 405) {
        return getResponse;
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') throw err;
      // 如果短 GET 仍被浏览器或代理拒绝，再尝试 POST body。
    }

    return postStream();
  };

  const getEditableUserTemplate = (step: Subprocess) =>
    step.userPromptTemplate || step.userPrompt || '';

  const treePromptMarker = '【树状图摘要Prompt】';

  const mergeTreePromptIntoSystemPrompt = (systemPrompt: string, shortPrompt: string) => {
    const cleanedBase = (systemPrompt || '')
      .replace(/【树状图摘要Prompt】[\s\S]*?(?:\n\s*\n|$)/, '')
      .trim();

    return [
      treePromptMarker,
      shortPrompt.trim(),
      '',
      cleanedBase || '请严格执行该子过程目标，并输出可供后续步骤使用的结构化结果。',
    ].join('\n');
  };

  const mergeTreePromptIntoUserTemplate = (userTemplate: string, shortPrompt: string) => {
    const cleanedBase = (userTemplate || '')
      .replace(/【树状图摘要Prompt】[\s\S]*?(?:\n\s*\n|$)/, '')
      .trim();

    return [
      treePromptMarker,
      shortPrompt.trim(),
      '',
      cleanedBase || '问题：{question}\n\n已知：\n{previous_output}\n\n请根据摘要Prompt生成该子过程的结构化结果。',
    ].join('\n');
  };

  const formatApiErrorMessage = (message = '') => {
    if (/429|SetLimitExceeded|quota|limit/i.test(message)) {
      return '豆包 API 额度或限流已触发，请检查火山方舟账户额度/限额后再试。已停止后续步骤，避免把失败结果写入版本。';
    }
    return message || 'API 调用失败';
  };

  const compactForPreviewPayload = (text = '', maxLength = 1200) => {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean.length <= maxLength) return clean;
    return `${clean.slice(0, Math.floor(maxLength * 0.6))}\n...\n${clean.slice(-Math.floor(maxLength * 0.3))}`;
  };

  const buildPreviewBaseStages = (stages: Subprocess[]) =>
    stages.map(stage => ({
      ...stage,
      input: compactForPreviewPayload(stage.input, 700),
      output: compactForPreviewPayload(stage.output, 900),
      systemPrompt: compactForPreviewPayload(stage.systemPrompt || '', 1100),
      userPrompt: compactForPreviewPayload(stage.userPrompt || '', 700),
      userPromptTemplate: compactForPreviewPayload(stage.userPromptTemplate || '', 700),
    }));

  const extractSummaryText = (text: string) => {
    const raw = (text || '').trim();
    if (!raw) return '';

    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
      const meaningful = (value: string) => {
        const clean = value.replace(/\s+/g, ' ').trim();
        return clean.length >= 8 && !/^\d+[\.\)、)]?$/.test(clean);
      };
      const bestText = (items: string[]) =>
        items
          .map(item => item.replace(/\s+/g, ' ').trim())
          .filter(meaningful)
          .sort((a, b) => b.length - a.length)[0] || '';
      const findText = (value: any): string => {
        if (!value) return '';
        if (typeof value === 'string') return meaningful(value) ? value : '';
        if (Array.isArray(value)) return bestText(value.map(findText).filter(Boolean));
        if (typeof value === 'object') {
          const keys = ['summary', 'result', 'answer', 'final', 'conclusion', 'output', 'content', '核心', '结果', '答案'];
          for (const key of keys) {
            const found = findText(value[key]);
            if (found) return found;
          }
          return bestText(Object.values(value).map(findText).filter(Boolean));
        }
        return String(value);
      };
      const extracted = findText(parsed);
      if (extracted) return extracted;
    } catch {
      // 非JSON输出直接进入文本摘要。
    }

    return raw
      .replace(/```[\s\S]*?```/g, '')
      .replace(/[{}\[\]"`*_#>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  };

  const summarizeTreeNode = (text: string, maxLength = 32) => {
    const extracted = extractSummaryText(text)
      .replace(/[#*_`>]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const firstMeaningful = extracted
      .split(/[。；;.!?？\n]/)
      .map(item => item.replace(/^#+\s*/, '').trim())
      .find(item => item.length >= 8 && !/^\d+[\.\)、)]?$/.test(item));
    const clean = (firstMeaningful || extracted || '暂无可预览结果').trim();
    return clean.length > maxLength ? clean.slice(0, maxLength) : clean;
  };

  const readSSEComplete = async (reader: ReadableStreamDefaultReader) => {
    const decoder = new TextDecoder();
    let allData = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      allData += decoder.decode(value, { stream: true });
    }

    const eventBlocks = allData.split('\n\n');
    for (const block of eventBlocks) {
      const lines = block.split('\n');
      let eventType = '';
      let eventData = '';

      for (const line of lines) {
        if (line.startsWith('event:')) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          eventData = line.slice(5).trim();
        }
      }

      if (eventData) {
        const data = JSON.parse(eventData);
        if (eventType === 'api_error') {
          throw new Error(formatApiErrorMessage(data.error));
        }
        if (eventType === 'complete') {
          return data;
        }
      }
    }

    throw new Error('试运行没有返回完整结果');
  };

  const rememberTreeSnapshot = () => {
    if (treeEditSnapshotRef.current) return;
    const snapshot: TreeEditSnapshot = {
      editingStepId,
      editedOutput,
      editedSystemPrompt,
      editedUserTemplate,
      editedInput,
      selectedStepId,
      treePromptDrafts: { ...treePromptDrafts },
      subprocesses: subprocesses.map(step => ({ ...step })),
    };
    treeEditSnapshotRef.current = snapshot;
    setTreeEditSnapshot(snapshot);
  };

  const clearTreeSnapshot = () => {
    treeEditSnapshotRef.current = null;
    setTreeEditSnapshot(null);
  };

  const runTreePreview = async (stepId: string, prompt: string, source: 'current' | 'suggestion') => {
    const targetIndex = subprocesses.findIndex(step => step.id === stepId);
    if (targetIndex < 0) return;
    const userQuestion = activeQuestion || chatMessages.find(m => m.role === 'user')?.content;
    const targetStep = subprocesses[targetIndex];
    if (!userQuestion || !targetStep || isTreePreviewing) return;

    setError(null);
    setIsTreePreviewing(true);

    try {
      const previewSystemPrompt = mergeTreePromptIntoSystemPrompt(
        editingStepId === stepId ? editedSystemPrompt : (targetStep.systemPrompt || ''),
        source === 'suggestion' ? `试运行AI建议方向：${prompt}` : prompt
      );
      const previewUserTemplate = mergeTreePromptIntoUserTemplate(
        editingStepId === stepId ? editedUserTemplate : getEditableUserTemplate(targetStep),
        source === 'suggestion' ? `试运行AI建议方向：${prompt}` : prompt
      );

      const response = await streamSolve({
        question: userQuestion,
        startStepIndex: targetIndex,
        modifiedSteps: {
          [targetStep.id]: {
            systemPrompt: previewSystemPrompt,
            userPromptTemplate: previewUserTemplate,
          },
        },
        baseStages: buildPreviewBaseStages(subprocesses),
        previewMode: true,
        documentIds: documentIdsForRun(),
      });

      if (!response.ok) throw new Error(`试运行失败: ${response.status}`);
      const reader = response.body?.getReader();
      if (!reader) throw new Error('无法读取试运行响应');

      const data = await readSSEComplete(reader);
      const returnedStages: Subprocess[] = data.stages || [];
      const previewStages: Subprocess[] =
        returnedStages.length >= subprocesses.length
          ? [...subprocesses.slice(0, targetIndex), ...returnedStages.slice(targetIndex)]
          : [...subprocesses.slice(0, targetIndex), ...returnedStages];

      rememberTreeSnapshot();
      setTreePreviewResults(subprocesses.map((step, index): TreePreviewResult => {
        const previewStage = previewStages[index] || step;

        if (index < targetIndex) {
          return {
            stepId: step.id,
            name: step.name,
            status: 'unchanged',
            summary: summarizeTreeNode(step.output || step.description, 18),
            fullResult: formatJsonToChinese(step.output || step.description || ''),
          };
        }

        const fullResult = formatJsonToChinese(previewStage.output || previewStage.description || prompt);
        return {
          stepId: step.id,
          name: previewStage.name || step.name,
          status: index === targetIndex ? 'changed' : 'affected',
          summary: summarizeTreeNode(previewStage.output || previewStage.description || prompt, 20),
          fullResult,
        };
      }));
      setTreePreviewFinalOutput(formatJsonToChinese(data.finalOutputFull || data.finalOutput || previewStages[previewStages.length - 1]?.output || ''));
      setSelectedStepId(targetStep.id);
      setTreePromptDrafts(prev => ({ ...prev, [targetStep.id]: prompt }));
    } catch (err: any) {
      console.error('树状图试运行失败:', err);
      setError(err.message || '树状图试运行失败');
    } finally {
      setIsTreePreviewing(false);
    }
  };

  const undoTreePreview = () => {
    const snapshot = treeEditSnapshotRef.current || treeEditSnapshot;
    setTreePreviewResults([]);
    setTreePreviewFinalOutput('');
    if (snapshot) {
      setSubprocesses(snapshot.subprocesses.map(step => ({ ...step })));
      setEditingStepId(snapshot.editingStepId);
      setEditedOutput(snapshot.editedOutput);
      setEditedSystemPrompt(snapshot.editedSystemPrompt);
      setEditedUserTemplate(snapshot.editedUserTemplate);
      setEditedInput(snapshot.editedInput);
      setSelectedStepId(snapshot.selectedStepId);
      setTreePromptDrafts({ ...snapshot.treePromptDrafts });
      clearTreeSnapshot();
    }
    setTreeResetSignal(prev => prev + 1);
  };

  const applyTreePrompt = (stepId: string, prompt: string, source: 'current' | 'suggestion') => {
    const step = subprocesses.find(item => item.id === stepId);
    if (!step) return;

    rememberTreeSnapshot();
    setSelectedStepId(stepId);
    setTreePromptDrafts(prev => ({ ...prev, [stepId]: prompt }));
    setEditingStepId(stepId);
    setEditedOutput(step.output || '');
    setEditedInput(step.input || '');
    const promptForAdoption = source === 'suggestion' ? `采纳AI建议方向：${prompt}` : prompt;
    setEditedUserTemplate(mergeTreePromptIntoUserTemplate(
      editingStepId === stepId ? editedUserTemplate : getEditableUserTemplate(step),
      promptForAdoption
    ));
    setEditedSystemPrompt(mergeTreePromptIntoSystemPrompt(
      editingStepId === stepId ? editedSystemPrompt : (step.systemPrompt || ''),
      promptForAdoption
    ));
  };

  const getCommitBaseStep = (step: Subprocess) =>
    treeEditSnapshotRef.current?.subprocesses.find(item => item.id === step.id) || step;

  const hasEditChanges = (step: Subprocess) => {
    const baseStep = getCommitBaseStep(step);
    return editedSystemPrompt !== (baseStep.systemPrompt || '') ||
      editedUserTemplate !== getEditableUserTemplate(baseStep) ||
      editedInput !== (baseStep.input || '') ||
      editedOutput !== (baseStep.output || '');
  };

  const buildMetricTitle = (step: Subprocess) => {
    const basis = step.metricBasis;
    const signals = step.healthSignals || {};
    const lines = [
      basis?.mode === 'measured'
        ? '【影响度·实测】基于上一版与当前版的最终答案文本差异计算'
        : '【影响度·预测】首次运行无对照，基于风险/链路位置/健康度的结构化估计',
      `健康度：${step.healthScore ?? 80}/100（基于真实输出长度、相似度、JSON 解析、重复度等信号）`,
      `风险度：${step.riskScore ?? '--'}（基于规划级别 + 链路位置 + 关键词命中）`,
    ];
    if (signals.length !== undefined) lines.push(`  · 实际输出：${signals.length} 字符`);
    if (signals.timeMs !== undefined) lines.push(`  · 实际耗时：${(signals.timeMs / 1000).toFixed(2)}s`);
    if (signals.inputOutputSimilarity !== undefined) lines.push(`  · 输入输出相似度：${(signals.inputOutputSimilarity * 100).toFixed(1)}%`);
    if (basis?.finalDelta !== undefined) lines.push(`实测·最终答案变化：${Math.round(basis.finalDelta * 100)}%`);
    if (basis?.outputDelta !== undefined) lines.push(`实测·本步输出变化：${Math.round(basis.outputDelta * 100)}%`);
    if (step.healthIssues && step.healthIssues.length > 0) {
      lines.push('', '⚠ 发现问题：');
      step.healthIssues.forEach(issue => lines.push(`  · ${issue}`));
    }
    return lines.join('\n');
  };

  const healthTextColor: Record<Subprocess['health'], string> = {
    green: 'text-emerald-600',
    yellow: 'text-amber-600',
    red: 'text-red-600',
  };

  // 解析用户消息中的修改指令
  const parseModificationCommand = (message: string): { stepIndex: number; field: string; value: string } | null => {
    // 匹配模式: "修改/调整/把 第X步/步骤X 的 输出/Prompt/输入 改成/为 ..."
    const patterns = [
      /(?:修改|调整|把)(?:第|步骤)?(\d+)(?:步|步骤)的?(输出|Prompt|输入|system|user)改成?(?:为|:|：)([\s\S]+)/,
      /(?:第|步骤)?(\d+)(?:步|步骤)的?(输出|Prompt|输入|system|user)(?:改成|改为|改成|:|：)([\s\S]+)/,
    ];

    for (const pattern of patterns) {
      const match = message.match(pattern);
      if (match) {
        const stepIndex = parseInt(match[1]) - 1; // 转为0-indexed
        let field = match[2];
        const value = match[3].trim();

        // 映射字段名
        if (field === 'Prompt' || field === 'prompt' || field === 'system') {
          field = 'systemPrompt';
        } else if (field === 'user') {
          field = 'userPromptTemplate';
        } else if (field === '输入') {
          field = 'input';
        } else if (field === '输出') {
          field = 'output';
        }

        return { stepIndex, field, value };
      }
    }
    return null;
  };

  // 处理修改指令
  const handleModificationCommand = (command: string): boolean => {
    const mod = parseModificationCommand(command);
    if (mod && mod.stepIndex >= 0 && mod.stepIndex < subprocesses.length) {
      const step = subprocesses[mod.stepIndex];

      openEdit(step);

      // 根据字段设置对应的编辑值
      switch (mod.field) {
        case 'systemPrompt':
          setEditedSystemPrompt(mod.value);
          break;
        case 'userPromptTemplate':
          setEditedUserTemplate(mod.value);
          break;
        case 'input':
          setEditedInput(mod.value);
          break;
        case 'output':
          setEditedOutput(mod.value);
          break;
      }

      return true;
    }
    return false;
  };

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  // ============== 对话历史持久化 ==============
  // 把当前所有可见状态打包成一个 conversation snapshot
  const buildCurrentSnapshot = (id: string, title: string): ConversationSnapshot => {
    // 优先使用既有 conversation 的 title（保持稳定），否则用第一条用户消息
    const existing = conversations.find(c => c.id === id);
    const firstUserMsg = chatMessages.find(m => m.role === 'user')?.content;
    const finalTitle = existing?.title || title || firstUserMsg || activeQuestion || '未命名会话';
    return {
      id,
      title: finalTitle.length > 60 ? finalTitle.slice(0, 60) + '...' : finalTitle,
      question: activeQuestion,
      timestamp: Date.now(),
      chatMessages: chatMessages.map(m => ({ ...m, timestamp: m.timestamp })),
      subprocesses: subprocesses.map(s => ({ ...s })),
      traceDiagnosis,
      modificationHistory: modificationHistory.map(h => ({ ...h, stages: h.stages.map(s => ({ ...s })) })),
      treePromptDrafts: { ...treePromptDrafts },
      activeQuestion,
      uploadedDocuments: uploadedDocuments.map(doc => ({ ...doc })),
    };
  };

  // 自动保存当前会话到列表（如果有内容）
  const saveCurrentToHistory = (overrideId?: string) => {
    if (chatMessages.length === 0 && subprocesses.length === 0) return; // 空会话不存
    const id = overrideId || activeConversationId || generateConversationId();
    const snapshot = buildCurrentSnapshot(id, '');
    setConversations(prev => {
      const filtered = prev.filter(c => c.id !== id);
      const next = [snapshot, ...filtered];
      persistConversations(next);
      return next;
    });
    if (!activeConversationId) {
      setActiveConversationId(id);
      try { localStorage.setItem(ACTIVE_CONVERSATION_STORAGE_KEY, id); } catch {}
    }

    // 异步生成 AI 标题（仅当 conversation 还没被 AI 生成过 / 用户没手动改过 标题）
    const firstUserMsg = chatMessages.find(m => m.role === 'user')?.content;
    const existing = conversations.find(c => c.id === id);
    const needsAITitle =
      firstUserMsg &&
      firstUserMsg.length > 14 &&
      !existing?.titleLocked && // 用户改过名字就不再覆盖
      !existing?.aiTitleGenerated; // 已经生成过就不再调
    if (needsAITitle) {
      generateAITitle(firstUserMsg, settings).then(aiTitle => {
        if (!aiTitle) return;
        setConversations(prev => {
          const next = prev.map(c =>
            c.id === id
              ? { ...c, title: aiTitle, aiTitleGenerated: true }
              : c
          );
          persistConversations(next);
          return next;
        });
      });
    }
  };

  // 重命名对话
  const renameConversation = (id: string, newTitle: string) => {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    setConversations(prev => {
      const next = prev.map(c =>
        c.id === id ? { ...c, title: trimmed, titleLocked: true } : c
      );
      persistConversations(next);
      return next;
    });
  };

  // 每次 chatMessages / subprocesses / modificationHistory 变化时，防抖式自动保存
  useEffect(() => {
    if (chatMessages.length === 0 && subprocesses.length === 0) return;
    const t = setTimeout(() => saveCurrentToHistory(), 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMessages, subprocesses, traceDiagnosis, modificationHistory, treePromptDrafts, uploadedDocuments]);

  // 加载某条历史对话
  const loadConversation = (id: string) => {
    const conv = conversations.find(c => c.id === id);
    if (!conv) return;
    // 先取消进行中的流式请求，避免数据写到错误的会话
    abortActiveStream();
    setIsLoading(false);
    // 先把当前状态保存（如果还没保存）
    if (activeConversationId && activeConversationId !== id) {
      saveCurrentToHistory(activeConversationId);
    }
    setActiveConversationId(id);
    try { localStorage.setItem(ACTIVE_CONVERSATION_STORAGE_KEY, id); } catch {}
    setChatMessages(conv.chatMessages || []);
    setSubprocesses(conv.subprocesses || []);
    setTraceDiagnosis(conv.traceDiagnosis || null);
    setModificationHistory(conv.modificationHistory || []);
    setTreePromptDrafts(conv.treePromptDrafts || {});
    setUploadedDocuments(conv.uploadedDocuments || []);
    setActiveQuestion(conv.activeQuestion || conv.question || '');
    // 清理编辑/试运行临时状态
    setEditingStepId(null);
    setSelectedStepId(null);
    setExpandedStepId(null);
    setTreePreviewResults([]);
    setTreePreviewFinalOutput('');
    clearTreeSnapshot();
    setTreeResetSignal(prev => prev + 1);
    setError(null);
  };

  // 删除某条历史
  const deleteConversation = (id: string) => {
    setConversations(prev => {
      const next = prev.filter(c => c.id !== id);
      persistConversations(next);
      return next;
    });
    if (activeConversationId === id) {
      abortActiveStream();
      setIsLoading(false);
      setActiveConversationId(null);
      try { localStorage.removeItem(ACTIVE_CONVERSATION_STORAGE_KEY); } catch {}
      // 清空当前界面
      setChatMessages([]);
      setSubprocesses([]);
      setTraceDiagnosis(null);
      setModificationHistory([]);
      setTreePromptDrafts({});
      setUploadedDocuments([]);
      setActiveQuestion('');
      setEditingStepId(null);
      setSelectedStepId(null);
    }
  };

  // 开新对话（保存当前 + 清空）
  const startNewConversation = () => {
    abortActiveStream();
    setIsLoading(false);
    if (chatMessages.length > 0 || subprocesses.length > 0) {
      saveCurrentToHistory(activeConversationId || undefined);
    }
    const newId = generateConversationId();
    setActiveConversationId(newId);
    try { localStorage.setItem(ACTIVE_CONVERSATION_STORAGE_KEY, newId); } catch {}
    setChatMessages([]);
    setSubprocesses([]);
    setTraceDiagnosis(null);
    setModificationHistory([]);
    setTreePromptDrafts({});
    setUploadedDocuments([]);
    setActiveQuestion('');
    setEditingStepId(null);
    setSelectedStepId(null);
    setExpandedStepId(null);
    setTreePreviewResults([]);
    setTreePreviewFinalOutput('');
    clearTreeSnapshot();
    setTreeResetSignal(prev => prev + 1);
    setError(null);
  };

  useEffect(() => {
    if (!selectedStepId) return;
    stepCardRefs.current[selectedStepId]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [selectedStepId]);

  const parseSSEResponse = async (reader: ReadableStreamDefaultReader, modifiedStepIndex: number | null = null) => {
    const decoder = new TextDecoder();
    let buffer = '';
    let finalOutput = '';
    let totalSteps = 0;

    // 处理一个完整的 SSE 事件块
    const dispatchBlock = (block: string) => {
      const lines = block.split('\n');
      let eventType = '';
      let eventData = '';
      for (const line of lines) {
        if (line.startsWith('event:')) eventType = line.slice(6).trim();
        else if (line.startsWith('data:')) eventData = line.slice(5).trim();
      }
      if (!eventData) return;

      let data: any;
      try {
        data = JSON.parse(eventData);
      } catch {
        console.error('解析事件数据失败:', eventData.slice(0, 200));
        return;
      }

      if (eventType === 'api_error') {
        throw new Error(formatApiErrorMessage(data.error));
      }

      // 规划完成 → 知道总步数和初步骨架
      if (eventType === 'plan_complete' && Array.isArray(data.subprocesses)) {
        totalSteps = data.subprocesses.length;
        setProgressInfo({ current: 0, total: totalSteps });
        // 初始化骨架（让 UI 立即显示有几步要跑）
        setSubprocesses(prev => {
          if (prev.length > 0 && modifiedStepIndex !== null) return prev; // 重算时保留前几步
          return data.subprocesses.map((s: any, idx: number) => ({
            id: s.id,
            name: s.name,
            description: '',
            input: '',
            output: '',
            timeMs: 0,
            accuracy: 0,
            riskLevel: s.risk_level || 'medium',
            riskScore: s.riskScore,
            health: 'green' as const,
            healthScore: 0,
            healthIssues: [],
            order: idx + 1,
            systemPrompt: s.systemPrompt || '',
            userPrompt: s.userPrompt || '',
          }));
        });
        return;
      }

      // 阶段开始 → 实时显示"正在跑哪一步"
      if (eventType === 'stage_start') {
        setCurrentRunningStepId(data.stageId || null);
        setCurrentRunningStepName(data.name || '');
        setProgressInfo({ current: data.order || 0, total: totalSteps || data.order || 0 });
        return;
      }

      // 阶段完成 → 流式更新该步骤的真实数据
      if (eventType === 'stage_complete' && data.stage) {
        setSubprocesses(prev => {
          const idx = prev.findIndex(s => s.id === data.stage.id);
          if (idx >= 0) {
            const newList = [...prev];
            newList[idx] = data.stage;
            return newList;
          }
          return [...prev, data.stage];
        });
        setCurrentRunningStepId(null);
        return;
      }

      // 全部完成
      if (eventType === 'complete' && data.stages && typeof data.finalOutput === 'string') {
        finalOutput = data.finalOutput;
        const fullOutput: string =
          (typeof data.finalOutputFull === 'string' && data.finalOutputFull.trim())
            ? data.finalOutputFull
            : '';
        const allStagesOutput: string =
          (typeof data.allStagesOutput === 'string' && data.allStagesOutput.trim())
            ? data.allStagesOutput
            : '';
        const completedStages: Subprocess[] =
          modifiedStepIndex !== null && data.stages.length < subprocesses.length
            ? [...subprocesses.slice(0, modifiedStepIndex), ...data.stages]
            : data.stages;

        setSubprocesses(completedStages);
        setTraceDiagnosis(data.traceDiagnosis || data.trace_diagnosis || null);
        setCurrentRunningStepId(null);
        setCurrentRunningStepName('');
        setProgressInfo(null);

        setChatMessages(prev => [...prev, {
          id: Date.now().toString(),
          role: 'assistant',
          content: finalOutput,
          fullContent: fullOutput || finalOutput,
          allStagesContent: allStagesOutput,
          timestamp: new Date(),
        }]);

        setModificationHistory(prev => [...prev, {
          round: prev.length + 1,
          modifiedStepIndex: modifiedStepIndex ?? -1,
          stages: completedStages,
          traceDiagnosis: data.traceDiagnosis || data.trace_diagnosis || null,
          timestamp: Date.now(),
        }]);
      }
    };

    // 真正的流式：边读边分块解析
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        // 兜底：处理 buffer 里残留的最后一块
        if (buffer.trim()) {
          for (const block of buffer.split('\n\n')) {
            if (block.trim()) dispatchBlock(block);
          }
        }
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      // 按 SSE 协议，事件以 \n\n 分隔
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (block.trim()) dispatchBlock(block);
      }
    }
  };

  const executeSolve = async () => {
    if (!question.trim() || isLoading) return;

    const userQuestion = question.trim();
    const activeDocumentIds = documentIdsForRun();
    const documentLabel = uploadedDocuments.length
      ? `\n\n已附带文档：${uploadedDocuments.map(doc => doc.filename).join('、')}`
      : '';

    // 检查是否是修改指令
    if (subprocesses.length > 0 && handleModificationCommand(userQuestion)) {
      setQuestion('');
      setChatMessages(prev => [...prev, {
        id: Date.now().toString(),
        role: 'user',
        content: userQuestion,
        timestamp: new Date()
      }, {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: '已识别修改指令，请在左侧检查对应步骤，确认后点击"确认提交"',
        timestamp: new Date()
      }]);
      return;
    }

    setChatMessages(prev => [...prev, {
      id: Date.now().toString(),
      role: 'user',
      content: userQuestion + documentLabel,
      timestamp: new Date()
    }]);

    setQuestion('');
    setActiveQuestion(userQuestion);
    setIsLoading(true);
    setError(null);
    setSubprocesses([]);
    setTraceDiagnosis(null);
    setEditingStepId(null);
    setSelectedStepId(null);
    setRerunFromStep(null);
    setModificationHistory([]);
    setTreePromptDrafts({});
    setTreePreviewResults([]);
    setTreePreviewFinalOutput('');
    clearTreeSnapshot();
    setTreeResetSignal(prev => prev + 1);

    try {
      const response = await streamSolve({ question: userQuestion, reasoningEffort, documentIds: activeDocumentIds });
      if (!response.ok) throw new Error(`请求失败: ${response.status}`);

      const reader = response.body?.getReader();
      if (!reader) throw new Error('无法读取响应');

      await parseSSEResponse(reader);
    } catch (err: any) {
      // 清理进度状态
      setCurrentRunningStepId(null);
      setCurrentRunningStepName('');
      setProgressInfo(null);
      // 用户主动中断（切换/新建对话），不算错误
      if (err?.name === 'AbortError') {
        console.log('流式请求已被用户取消');
        return;
      }
      console.error('提交失败:', err);
      setError(err.message || '提交失败');
      setChatMessages(prev => [...prev, {
        id: Date.now().toString(),
        role: 'assistant',
        content: `抱歉，发生了错误：${err.message}`,
        timestamp: new Date()
      }]);
    } finally {
      setIsLoading(false);
    }
  };

  const confirmStepModification = async (stepIndex: number) => {
    const userQuestion = activeQuestion || chatMessages.find(m => m.role === 'user')?.content;
    const commitBaseStages = treeEditSnapshotRef.current?.subprocesses || subprocesses;
    const targetStep = commitBaseStages[stepIndex] || subprocesses[stepIndex];
    if (!userQuestion || !targetStep || isLoading) return;

    setIsLoading(true);
    setError(null);
    setRerunFromStep(stepIndex);

    try {
      const modifiedOutputs: Record<string, string> = {};
      if (editedOutput !== (targetStep.output || '')) {
        modifiedOutputs[targetStep.id] = editedOutput;
      }

      // 传递修改后的步骤配置
      const modifiedSteps: Record<string, any> = {};
      const originalTemplate = getEditableUserTemplate(targetStep);
      if (editedSystemPrompt !== (targetStep.systemPrompt || '')) {
        modifiedSteps[targetStep.id] = modifiedSteps[targetStep.id] || {};
        modifiedSteps[targetStep.id].systemPrompt = editedSystemPrompt;
      }
      if (editedUserTemplate !== originalTemplate) {
        modifiedSteps[targetStep.id] = modifiedSteps[targetStep.id] || {};
        modifiedSteps[targetStep.id].userPromptTemplate = editedUserTemplate;
      }
      if (editedInput !== (targetStep.input || '')) {
        modifiedSteps[targetStep.id] = modifiedSteps[targetStep.id] || {};
        modifiedSteps[targetStep.id].input = editedInput;
      }

      const response = await streamSolve({
        question: userQuestion,
        startStepIndex: stepIndex,
        modifiedOutputs,
        modifiedSteps,
        baseStages: commitBaseStages,
        documentIds: documentIdsForRun(),
      });
      if (!response.ok) throw new Error(`请求失败: ${response.status}`);

      const reader = response.body?.getReader();
      if (!reader) throw new Error('无法读取响应');

      await parseSSEResponse(reader, stepIndex);

      setTreePromptDrafts({});
      setTreePreviewResults([]);
      setTreePreviewFinalOutput('');
      clearTreeSnapshot();
      setTreeResetSignal(prev => prev + 1);
      setEditingStepId(null);
      setEditedOutput('');
      setEditedSystemPrompt('');
      setEditedUserTemplate('');
      setEditedInput('');
    } catch (err: any) {
      // 清理进度状态
      setCurrentRunningStepId(null);
      setCurrentRunningStepName('');
      setProgressInfo(null);
      if (err?.name === 'AbortError') {
        console.log('重算已被取消');
        return;
      }
      console.error('确认提交失败:', err);
      setError(err.message || '确认提交失败');
    } finally {
      setIsLoading(false);
      setRerunFromStep(null);
    }
  };

  const openEdit = (step: Subprocess) => {
    setSelectedStepId(step.id);
    setEditingStepId(step.id);
    setEditedOutput(step.output || '');
    setEditedSystemPrompt(step.systemPrompt || '');
    setEditedUserTemplate(getEditableUserTemplate(step));
    setEditedInput(step.input || '');
  };

  const handleSelectFromFlow = (roundIndex: number) => {
    if (roundIndex < 0 || roundIndex >= modificationHistory.length) return;
    const record = modificationHistory[roundIndex];
    // 将该round的stages加载到subprocesses显示
    setSubprocesses(record.stages);
    setTraceDiagnosis(record.traceDiagnosis || null);
    setSelectedStepId(null);
    setTreePromptDrafts({});
    setTreePreviewResults([]);
    setTreePreviewFinalOutput('');
    clearTreeSnapshot();
    setTreeResetSignal(prev => prev + 1);
  };

  const cancelEdit = () => {
    setEditingStepId(null);
    setEditedOutput('');
    setEditedSystemPrompt('');
    setEditedUserTemplate('');
    setEditedInput('');
  };

  const expandedStep = expandedStepId
    ? subprocesses.find(step => step.id === expandedStepId) || null
    : null;
  const expandedStepIsEditing = expandedStep?.id === editingStepId;
  const expandedSystemPrompt = expandedStepIsEditing ? editedSystemPrompt : (expandedStep?.systemPrompt || '');
  const expandedUserTemplate = expandedStepIsEditing ? editedUserTemplate : (expandedStep ? getEditableUserTemplate(expandedStep) : '');
  const expandedInput = expandedStepIsEditing ? editedInput : (expandedStep?.input || '');
  const expandedOutput = expandedStepIsEditing ? editedOutput : (expandedStep?.output || '');

  return (
    <div className="h-screen flex flex-col bg-gradient-to-br from-slate-50 to-sky-50">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 shadow-sm px-6 py-3 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-purple-500 to-sky-600 flex items-center justify-center">
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
            </div>
            <h1 className="text-base font-bold text-slate-800">AI Agent 动态推理</h1>
          </div>
          <div className="flex items-center gap-1.5">
            {/* API Key 状态指示 */}
            <button
              onClick={() => setShowSettings(true)}
              className={clsx(
                'px-2.5 py-1 rounded-lg border text-xs font-medium flex items-center gap-1.5 transition-colors',
                settings.apiKey
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                  : 'border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100 animate-pulse'
              )}
              title={settings.apiKey ? `已配置 API Key · 模型 ${settings.model}` : '尚未填写 API Key，点击设置'}
            >
              <span className={clsx(
                'w-1.5 h-1.5 rounded-full',
                settings.apiKey ? 'bg-emerald-500' : 'bg-amber-500'
              )} />
              {settings.apiKey ? 'Key 已配置' : '请填 API Key'}
            </button>
            <button
              onClick={() => setShowSettings(true)}
              className="p-1.5 rounded-lg text-slate-500 hover:text-purple-600 hover:bg-purple-50 transition-colors"
              title="设置"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
            <button
              onClick={startNewConversation}
              className="px-3 py-1.5 text-xs text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
            >
              新对话
            </button>
          </div>
        </div>
      </header>

      {error && (
        <div className="mx-4 mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
          {error}
        </div>
      )}

      {/* Main Content - 4 面板 grid 布局，统一 gap-3 间距，去掉 border 分隔 */}
      <div className="flex-1 flex overflow-hidden">
        {/* 左侧工作区：2 列 4 面板，统一间距 */}
        <div className="flex-1 flex bg-slate-100 overflow-hidden gap-3 p-3">
          {/* 左列：目标树 + 对话历史 */}
          <div className="w-1/3 flex flex-col gap-3">
            <div className="flex-[2] min-h-0">
              <PromptTreePanel
                goal={activeQuestion || chatMessages.find(m => m.role === 'user')?.content || '等待输入目标'}
                subprocesses={subprocesses}
                selectedStepId={selectedStepId}
                editingStepId={editingStepId}
                editedSystemPrompt={editedSystemPrompt}
                promptDrafts={treePromptDrafts}
                previewResults={treePreviewResults}
                previewFinalOutput={treePreviewFinalOutput}
                traceDiagnosis={traceDiagnosis}
                canUndoTreeChange={Boolean(treeEditSnapshot)}
                isPreviewing={isTreePreviewing}
                resetSignal={treeResetSignal}
                onSelectStep={setSelectedStepId}
                onApplyPrompt={applyTreePrompt}
                onPreviewPrompt={runTreePreview}
                onUndoPreview={undoTreePreview}
              />
            </div>
            <div className="flex-1 min-h-0">
              <ChatHistoryPanel
                conversations={conversations}
                activeConversationId={activeConversationId}
                onSelect={loadConversation}
                onDelete={deleteConversation}
                onNew={startNewConversation}
                onRename={renameConversation}
              />
            </div>
          </div>

          {/* 右列：决策子过程 + 修改历史 */}
          <div className="flex-1 flex flex-col gap-3 min-w-0">
            {/* 决策子过程卡片区 */}
            <div className="flex-[2] min-h-0">
              <div className="h-full bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col overflow-hidden">
              {/* 标题栏 */}
              <div className="px-4 py-3 border-b border-slate-200 flex-shrink-0">
                <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                  </svg>
                  决策子过程
                  {subprocesses.length > 0 && (
                    <span className="ml-2 text-xs bg-purple-100 text-purple-600 px-2 py-0.5 rounded-full">
                      {subprocesses.length}
                    </span>
                  )}
                </h3>
              </div>

              {/* 显眼的加载/重算 banner */}
              {isLoading && (
                <div className={clsx(
                  'flex-shrink-0 px-4 py-3 border-b flex items-center gap-3',
                  rerunFromStep !== null
                    ? 'bg-gradient-to-r from-amber-50 via-orange-50 to-amber-50 border-amber-200'
                    : 'bg-gradient-to-r from-purple-50 via-indigo-50 to-purple-50 border-purple-200'
                )}>
                  {/* 转圈 */}
                  <div className={clsx(
                    'w-7 h-7 rounded-full border-[3px] border-t-transparent animate-spin flex-shrink-0',
                    rerunFromStep !== null ? 'border-amber-500' : 'border-purple-500'
                  )} />
                  <div className="flex-1 min-w-0">
                    <div className={clsx(
                      'text-sm font-semibold flex items-center gap-2',
                      rerunFromStep !== null ? 'text-amber-700' : 'text-purple-700'
                    )}>
                      {rerunFromStep !== null ? '🔄 正在重算' : '⚡ 正在推理'}
                      {progressInfo && progressInfo.total > 0 && (
                        <span className={clsx(
                          'text-xs px-2 py-0.5 rounded-full',
                          rerunFromStep !== null ? 'bg-amber-100 text-amber-700' : 'bg-purple-100 text-purple-700'
                        )}>
                          {progressInfo.current}/{progressInfo.total}
                        </span>
                      )}
                    </div>
                    <div className={clsx(
                      'text-xs mt-0.5 truncate',
                      rerunFromStep !== null ? 'text-amber-600' : 'text-purple-600'
                    )}>
                      {currentRunningStepName
                        ? `当前：${currentRunningStepName}`
                        : (rerunFromStep !== null ? '准备从所选步骤开始重新推理...' : '正在规划推理步骤...')}
                    </div>
                    {/* 进度条 */}
                    {progressInfo && progressInfo.total > 0 && (
                      <div className={clsx(
                        'mt-1.5 h-1 w-full rounded-full overflow-hidden',
                        rerunFromStep !== null ? 'bg-amber-100' : 'bg-purple-100'
                      )}>
                        <div
                          className={clsx(
                            'h-full transition-all duration-500 ease-out',
                            rerunFromStep !== null ? 'bg-amber-500' : 'bg-purple-500'
                          )}
                          style={{ width: `${Math.min(100, (progressInfo.current / Math.max(progressInfo.total, 1)) * 100)}%` }}
                        />
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* 卡片区域（可滚动） */}
              <div className="flex-1 overflow-y-auto p-4">
                {subprocesses.length === 0 && !isLoading && (
                  <div className="text-center py-8 text-slate-400 text-sm">
                    <svg className="w-12 h-12 mx-auto mb-3 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                    </svg>
                    <p>暂无推理步骤</p>
                    <p className="text-xs mt-1">在右侧输入问题开始</p>
                  </div>
                )}

                {isLoading && subprocesses.length === 0 && (
                  <div className="text-center py-8">
                    <div className="w-10 h-10 mx-auto mb-3 border-3 border-purple-500 border-t-transparent rounded-full animate-spin" />
                    <p className="text-sm text-slate-400">推理中...</p>
                  </div>
                )}

                {/* 决策子过程小卡片网格 */}
                {subprocesses.length > 0 && (
                  <AgentDiagnosisPanel
                    steps={subprocesses}
                    traceDiagnosis={traceDiagnosis}
                  />
                )}

                <div className="grid grid-cols-2 gap-3">
                  {subprocesses.map((sub, idx) => {
                    const risk = riskColors[sub.riskLevel] || riskColors.medium;
                    const isEditing = editingStepId === sub.id;
                    const isSelected = selectedStepId === sub.id;
                    const isEditable = true;
                    const isDirty = isEditing && hasEditChanges(sub);
                    const metricTitle = buildMetricTitle(sub);
                    const isRerunning = isLoading && rerunFromStep !== null && idx >= rerunFromStep;
                    // 是否是当前正在执行的那一步（基于 SSE stage_start 实时更新）
                    const isCurrentlyRunning = currentRunningStepId === sub.id;
                    // 待重算（属于重算范围但还没轮到的）
                    const isPendingRerun = isRerunning && !isCurrentlyRunning && currentRunningStepId !== null;

                    return (
                      <div
                        key={sub.id}
                        ref={(node) => { stepCardRefs.current[sub.id] = node; }}
                        onClick={() => setSelectedStepId(sub.id)}
                        className={clsx(
                          'rounded-lg border-2 transition-all flex flex-col cursor-pointer relative',
                          isCurrentlyRunning ? 'border-purple-500 bg-gradient-to-br from-purple-50 to-indigo-50 shadow-xl shadow-purple-200 ring-2 ring-purple-300/40 animate-pulse' :
                            isPendingRerun ? 'border-amber-300 bg-amber-50/50 opacity-70' :
                              isEditing ? 'border-purple-400 bg-purple-50 shadow-lg' :
                                isSelected ? 'border-red-400 bg-red-50 shadow-md shadow-red-100' :
                                  'border-slate-200 bg-white hover:border-slate-300'
                        )}
                      >
                        {/* 当前执行步骤的角标 */}
                        {isCurrentlyRunning && (
                          <div className="absolute -top-1.5 -right-1.5 z-10 flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-500 text-white text-[10px] font-bold shadow-md">
                            <span className="w-1.5 h-1.5 bg-white rounded-full animate-ping" />
                            执行中
                          </div>
                        )}
                        {isPendingRerun && (
                          <div className="absolute -top-1.5 -right-1.5 z-10 px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[10px] font-medium border border-amber-300">
                            待重算
                          </div>
                        )}
                        {/* 卡片头部 */}
                        <div className="px-3 py-2 flex items-center justify-between flex-shrink-0">
                          <div className="flex items-center gap-2">
                            <span className={clsx('w-5 h-5 rounded flex items-center justify-center text-white text-xs font-bold', risk.bg)}>
                              {idx + 1}
                            </span>
                            <span className="text-xs font-medium text-slate-700">{sub.name}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className={clsx('px-1.5 py-0.5 rounded-full text-xs font-medium border', risk.badge)}>
                              {risk.label}
                            </span>
                            {sub.modified && (
                              <span className="px-1.5 py-0.5 rounded-full text-xs font-medium bg-sky-50 text-sky-600 border border-sky-100">
                                已提交
                              </span>
                            )}
                            {isDirty && (
                              <span className="px-1.5 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-700 border border-purple-200">
                                待提交
                              </span>
                            )}
                            {isEditable && (
                              <>
                                <button
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setExpandedStepId(sub.id);
                                  }}
                                  className="px-1.5 py-0.5 rounded border border-slate-200 bg-white text-[11px] text-slate-500 hover:bg-slate-50 hover:text-slate-700"
                                  title="放大查看"
                                >
                                  查看
                                </button>
                                <button
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    isEditing ? cancelEdit() : openEdit(sub);
                                  }}
                                  className="p-0.5 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-600"
                                  title={isEditing ? "取消编辑" : "编辑"}
                                >
                                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                  </svg>
                                </button>
                              </>
                            )}
                          </div>
                        </div>

                        {/* 指标 - 显示真实数据 + 数据来源徽章 */}
                        <div className="px-3 pb-2 flex flex-col gap-1 flex-shrink-0">
                          <div className="flex items-center gap-3 text-xs text-slate-400 flex-wrap" title={metricTitle}>
                            <span className="flex items-center gap-1">
                              影响度: <span className={clsx('font-semibold', risk.text)}>{(sub.accuracy * 100).toFixed(0)}%</span>
                              <span
                                className={clsx(
                                  'text-[9px] px-1 py-0.5 rounded font-medium border',
                                  sub.metricBasis?.mode === 'measured'
                                    ? 'bg-emerald-50 text-emerald-600 border-emerald-200'
                                    : 'bg-slate-100 text-slate-500 border-slate-200'
                                )}
                                title={
                                  sub.metricBasis?.mode === 'measured'
                                    ? '实测：基于上一版与当前版的最终答案差异计算'
                                    : '预测：首次运行时基于风险/位置/健康度的结构化估算'
                                }
                              >
                                {sub.metricBasis?.mode === 'measured' ? '实测' : '预测'}
                              </span>
                            </span>
                            <span>健康: <span className={clsx('font-semibold', healthTextColor[sub.health] || 'text-slate-500')}>{sub.healthScore || 80}</span></span>
                            <span>风险: <span className={clsx('font-semibold', risk.text)}>{sub.riskScore ?? '--'}</span></span>
                            {isRerunning && (
                              <span className="text-purple-500 font-medium flex items-center gap-1">
                                <span className="w-1.5 h-1.5 bg-purple-500 rounded-full animate-pulse" />
                                重算中
                              </span>
                            )}
                          </div>
                          {/* 真实可观测信号 - 数字直接来自运行时 */}
                          {sub.healthSignals && (
                            <div className="flex items-center gap-2.5 text-[10px] text-slate-400">
                              <span title="实际输出字符数">📝 {sub.healthSignals.length ?? 0}字</span>
                              <span title="实际 API 调用耗时">⏱ {((sub.healthSignals.timeMs ?? 0) / 1000).toFixed(1)}s</span>
                              <span title="输入与输出文本相似度（bigram Jaccard）">↔ {((sub.healthSignals.inputOutputSimilarity ?? 0) * 100).toFixed(0)}%</span>
                            </div>
                          )}
                        </div>

                        {/* 内容区域（可滚动） */}
                        <div className="px-3 pb-2 flex-1 min-h-0 overflow-y-auto">
                          {/* 编辑模式 */}
                          {isEditing ? (
                            <div className="space-y-2 border-t border-purple-100 pt-2">
                              <div>
                                <label className="text-xs font-medium text-purple-600">System Prompt</label>
                                <textarea
                                  value={editedSystemPrompt}
                                  onChange={(e) => setEditedSystemPrompt(e.target.value)}
                                  rows={2}
                                  className="w-full px-2 py-1 rounded border border-purple-200 text-xs resize-none focus:outline-none focus:ring-1 focus:ring-purple-500"
                                />
                              </div>
                              <div>
                                <label className="text-xs font-medium text-purple-600">User Template</label>
                                <textarea
                                  value={editedUserTemplate}
                                  onChange={(e) => setEditedUserTemplate(e.target.value)}
                                  rows={2}
                                  className="w-full px-2 py-1 rounded border border-purple-200 text-xs resize-none focus:outline-none focus:ring-1 focus:ring-purple-500"
                                />
                              </div>
                              <div>
                                <label className="text-xs font-medium text-purple-600">Input</label>
                                <textarea
                                  value={editedInput}
                                  onChange={(e) => setEditedInput(e.target.value)}
                                  rows={1}
                                  className="w-full px-2 py-1 rounded border border-purple-200 text-xs resize-none focus:outline-none focus:ring-1 focus:ring-purple-500"
                                />
                              </div>
                              <div>
                                <label className="text-xs font-medium text-purple-600">Output</label>
                                <textarea
                                  value={editedOutput}
                                  onChange={(e) => setEditedOutput(e.target.value)}
                                  rows={2}
                                  className="w-full px-2 py-1 rounded border border-purple-200 text-xs resize-none focus:outline-none focus:ring-1 focus:ring-purple-500"
                                />
                              </div>
                              <div className="flex items-center gap-2 pt-1">
                                <button
                                  onClick={() => confirmStepModification(idx)}
                                  disabled={isLoading || !hasEditChanges(sub)}
                                  className="px-3 py-1 bg-purple-500 text-white rounded text-xs hover:bg-purple-600 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                  确认提交
                                </button>
                                <button
                                  onClick={cancelEdit}
                                  className="px-3 py-1 bg-slate-200 text-slate-600 rounded text-xs hover:bg-slate-300"
                                >
                                  取消
                                </button>
                              </div>
                              <div className="text-[11px] text-purple-500">
                                提交后将固定当前规划，并从第{idx + 1}步开始重算后续结果
                              </div>
                            </div>
                          ) : (
                            /* 默认显示模式 - 只显示输入和输出（可滚动） */
                            <div className="space-y-1 text-xs">
                              {sub.input && (
                                <div className="border-t border-slate-100 pt-1">
                                  <div className="text-slate-400 mb-0.5">输入:</div>
                                  <div className="text-slate-600 bg-slate-50 rounded p-1.5 max-h-20 overflow-y-auto">
                                    {sub.input}
                                  </div>
                                </div>
                              )}
                              {sub.output && (
                                <div>
                                  <div className="text-slate-400 mb-0.5">输出:</div>
                                  <div className="text-slate-600 bg-slate-50 rounded p-1.5 max-h-24 overflow-y-auto">
                                    <pre className="whitespace-pre-wrap font-sans">
                                      <HighlightedEvidenceText
                                        text={formatJsonToChinese(sub.output)}
                                        evidence={sub.evidence_source}
                                        active={sub.diagnosis_status === 'failure'}
                                      />
                                    </pre>
                                  </div>
                                </div>
                              )}
                              {sub.systemPrompt && (
                                <div>
                                  <div className="text-slate-400 mb-0.5">System Prompt:</div>
                                  <div className="text-slate-600 bg-slate-50 rounded p-1.5 max-h-16 overflow-y-auto">
                                    {sub.systemPrompt}
                                  </div>
                                </div>
                              )}
                              {sub.metricBasis?.mode === 'measured' && (
                                <div className="text-[11px] text-sky-600 bg-sky-50 rounded p-1.5">
                                  实测影响：最终答案变化 {Math.round((sub.metricBasis.finalDelta || 0) * 100)}%，本步输出变化 {Math.round((sub.metricBasis.outputDelta || 0) * 100)}%
                                </div>
                              )}
                              <div className={clsx(
                                'text-[11px] rounded p-1.5',
                                sub.diagnosis_status === 'failure' && sub.affected_steps?.length
                                  ? 'text-red-700 bg-red-50 border border-red-100'
                                  : 'text-slate-500 bg-slate-50'
                              )}>
                                到哪里去：{sub.where_to_steps?.length ? `Step ${sub.where_to_steps.join(', Step ')}` : '没有直接下游步骤'}
                              </div>
                              {sub.diagnosis_status === 'failure' && (
                                <div className="text-[11px] text-red-700 bg-red-50 border border-red-100 rounded p-1.5">
                                  <div className="font-semibold">可能错误源：{sub.failure_label || sub.failure_type}</div>
                                  {sub.evidence_source && (
                                    <div className="mt-0.5 line-clamp-2">文字源头：{sub.evidence_source}</div>
                                  )}
                                  {sub.affected_steps?.length ? (
                                    <div className="mt-0.5">影响到：Step {sub.affected_steps.join(', Step ')}</div>
                                  ) : null}
                                  {sub.where_to_steps?.length ? (
                                    <div className="mt-0.5">到哪里去：Step {sub.where_to_steps.join(', Step ')}</div>
                                  ) : null}
                                </div>
                              )}
                              {sub.diagnosis_status === 'warning' && (
                                <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-100 rounded p-1.5">
                                  性能/上下文提示：{sub.failure_label || sub.failure_type}
                                  {sub.evidence_source ? ` · ${sub.evidence_source}` : ''}
                                </div>
                              )}
                              {sub.diagnosis_status !== 'failure' && sub.potential_risks?.length ? (
                                <div className="text-[11px] text-sky-700 bg-sky-50 border border-sky-100 rounded p-1.5">
                                  <div className="font-semibold">可能风险：{sub.potential_issue_tags?.slice(0, 2).join('、') || sub.potential_risks[0].label}</div>
                                  <div className="mt-0.5 line-clamp-2">{sub.potential_risks[0].reason}</div>
                                </div>
                              ) : null}
                              {sub.healthIssues?.length > 0 && (
                                <div className="text-[11px] text-amber-600 bg-amber-50 rounded p-1.5">
                                  {sub.healthIssues[0]}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

            {/* 修改历史 - 与上面统一为 rounded-xl + 一致标题栏 */}
            <div className="flex-1 min-h-0">
              <div className="h-full bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
                <div className="px-4 py-3 border-b border-slate-200 flex-shrink-0">
                  <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
                    </svg>
                    修改历史
                    {modificationHistory.length > 0 && (
                      <span className="ml-1 text-xs bg-purple-100 text-purple-600 px-2 py-0.5 rounded-full">
                        {modificationHistory.length}次
                      </span>
                    )}
                  </h3>
                </div>
                <div className="flex-1 min-h-0">
                  <ModificationFlow
                    modificationHistory={modificationHistory}
                    onSelectPoint={handleSelectFromFlow}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 右侧对话框区域 */}
        <div className="w-96 bg-white border-l border-slate-200 flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between flex-shrink-0">
            <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
              </svg>
              对话
              {chatMessages.length > 0 && (
                <span className="ml-1 text-xs bg-purple-100 text-purple-600 px-2 py-0.5 rounded-full">
                  {chatMessages.length}
                </span>
              )}
            </h3>
          </div>

          {/* 消息列表 */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {chatMessages.length === 0 && (
              <div className="text-center py-8">
                <p className="text-sm text-slate-400">开始对话吧！</p>
              </div>
            )}

            {chatMessages.map((msg) => {
              // 助手消息：用户希望看到完整内容（包含未提取的原文 + 所有步骤输出）
              // 用户消息：超 100 字也提供展开（方便回看长问题）
              const displayLen = (msg.content || '').length;
              // 比较所有可用版本，取最长的作为"完整字数"
              const candidateLens = [
                displayLen,
                (msg.fullContent || '').length,
                (msg.allStagesContent || '').length,
              ];
              const fullLen = Math.max(...candidateLens);
              const hasMoreContent = fullLen > displayLen + 20;
              const showExpandButton = msg.role === 'assistant' || displayLen > 100;
              return (
                <div key={msg.id} className={clsx('flex', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
                  <div
                    className={clsx(
                      'max-w-[90%] rounded-2xl px-4 py-3',
                      msg.role === 'user'
                        ? 'bg-purple-500 text-white rounded-br-sm'
                        : 'bg-slate-100 text-slate-700 rounded-bl-sm'
                    )}
                  >
                    <div className="text-sm whitespace-pre-wrap break-words max-h-none overflow-visible">
                      {msg.content}
                    </div>
                    <div className={clsx('flex items-center justify-between gap-2 mt-2 pt-1.5 border-t', msg.role === 'user' ? 'text-purple-200 border-white/20' : 'text-slate-400 border-slate-200')}>
                      <span className="text-xs">
                        {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px]">
                          {hasMoreContent ? `${displayLen}/${fullLen} 字` : `${displayLen} 字`}
                        </span>
                        {showExpandButton && (
                          <button
                            onClick={() => setViewingMessage(msg)}
                            className={clsx(
                              'px-2 py-0.5 rounded text-[10px] font-medium border transition-colors flex items-center gap-1',
                              msg.role === 'user'
                                ? 'bg-white/20 text-white border-white/30 hover:bg-white/30'
                                : 'bg-white text-slate-600 border-slate-300 hover:bg-purple-50 hover:text-purple-600 hover:border-purple-300'
                            )}
                            title={hasMoreContent ? '查看包含全部步骤输出的完整视图（推荐，可看 AI 全部产出）' : '在弹窗中查看完整内容（支持复制）'}
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                            </svg>
                            {hasMoreContent ? '查看全部输出' : '展开查看'}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}

            {isLoading && (
              <div className="flex justify-start">
                <div className={clsx(
                  'rounded-2xl rounded-bl-sm px-4 py-3 max-w-[90%]',
                  rerunFromStep !== null
                    ? 'bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200'
                    : 'bg-gradient-to-r from-purple-50 to-indigo-50 border border-purple-200'
                )}>
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1">
                      <div className={clsx(
                        'w-2 h-2 rounded-full animate-bounce',
                        rerunFromStep !== null ? 'bg-amber-500' : 'bg-purple-500'
                      )} style={{ animationDelay: '0ms' }} />
                      <div className={clsx(
                        'w-2 h-2 rounded-full animate-bounce',
                        rerunFromStep !== null ? 'bg-amber-500' : 'bg-purple-500'
                      )} style={{ animationDelay: '150ms' }} />
                      <div className={clsx(
                        'w-2 h-2 rounded-full animate-bounce',
                        rerunFromStep !== null ? 'bg-amber-500' : 'bg-purple-500'
                      )} style={{ animationDelay: '300ms' }} />
                    </div>
                    <div className="text-xs">
                      <div className={clsx(
                        'font-semibold',
                        rerunFromStep !== null ? 'text-amber-700' : 'text-purple-700'
                      )}>
                        {rerunFromStep !== null ? '🔄 重算中' : '⚡ 推理中'}
                        {progressInfo && progressInfo.total > 0 && (
                          <span className="ml-1.5 font-normal">
                            （{progressInfo.current}/{progressInfo.total}）
                          </span>
                        )}
                      </div>
                      {currentRunningStepName && (
                        <div className={clsx(
                          'mt-0.5 truncate',
                          rerunFromStep !== null ? 'text-amber-600' : 'text-purple-600'
                        )}>
                          {currentRunningStepName}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div ref={chatEndRef} />
          </div>

          {/* 思考程度选择器 */}
          <div className="px-4 pt-3 pb-1 border-t border-slate-100 bg-slate-50">
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500 flex-shrink-0">思考程度</span>
              <div className="flex gap-1 flex-1">
                {(['minimal', 'low', 'medium', 'high'] as const).map((level) => {
                  const labels = { minimal: '关闭', low: '低', medium: '中', high: '高' };
                  const colors = {
                    minimal: reasoningEffort === level ? 'bg-slate-500 text-white' : 'bg-white text-slate-500 border border-slate-300',
                    low: reasoningEffort === level ? 'bg-blue-400 text-white' : 'bg-white text-slate-500 border border-slate-300',
                    medium: reasoningEffort === level ? 'bg-purple-500 text-white' : 'bg-white text-slate-500 border border-slate-300',
                    high: reasoningEffort === level ? 'bg-orange-500 text-white' : 'bg-white text-slate-500 border border-slate-300',
                  };
                  return (
                    <button
                      key={level}
                      type="button"
                      onClick={() => setReasoningEffort(level)}
                      className={`flex-1 py-1 rounded-lg text-xs font-medium transition-colors ${colors[level]}`}
                    >
                      {labels[level]}
                    </button>
                  );
                })}
              </div>
            </div>
            <p className="text-[10px] text-slate-400 mt-1">
              {reasoningEffort === 'minimal' && '不启用思考，最快响应'}
              {reasoningEffort === 'low' && '轻度思考，速度与质量平衡'}
              {reasoningEffort === 'medium' && '中等思考，适合大多数问题'}
              {reasoningEffort === 'high' && '深度思考，复杂问题推荐，耗时较长'}
            </p>
          </div>

          {/* 输入框 */}
          <div className="px-4 pb-4 bg-slate-50">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDraggingDocument(true);
              }}
              onDragLeave={() => setIsDraggingDocument(false)}
              onDrop={(e) => {
                e.preventDefault();
                uploadDocumentFiles(e.dataTransfer.files);
              }}
              className={clsx(
                'mb-2 rounded-xl border border-dashed px-3 py-2 transition-colors',
                isDraggingDocument ? 'border-sky-400 bg-sky-50' : 'border-slate-200 bg-white'
              )}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".txt,.md,.markdown,.csv,.json,.log,.docx,.pdf"
                className="hidden"
                onChange={(e) => e.target.files && uploadDocumentFiles(e.target.files)}
              />
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isUploadingDocument}
                  className="flex items-center gap-2 rounded-lg px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                >
                  <svg className="h-4 w-4 text-sky-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01.88-7.9A5 5 0 0117.9 9H18a3 3 0 010 6h-1m-5-5v10m0-10l-3 3m3-3l3 3" />
                  </svg>
                  {isUploadingDocument ? '正在解析文档...' : '拖入文档或点击上传'}
                </button>
                <span className="text-[10px] text-slate-400">txt/md/csv/docx；PDF 需后端安装 pypdf</span>
              </div>
              {uploadedDocuments.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {uploadedDocuments.map(doc => (
                    <span
                      key={doc.id}
                      className="inline-flex max-w-full items-center gap-1 rounded-full border border-sky-100 bg-sky-50 px-2 py-1 text-[11px] text-sky-700"
                      title={doc.preview}
                    >
                      <span className="max-w-[190px] truncate">{doc.filename}</span>
                      <span className="text-sky-400">{doc.chunkCount}片段</span>
                      <button
                        type="button"
                        onClick={() => setUploadedDocuments(prev => prev.filter(item => item.id !== doc.id))}
                        className="ml-0.5 rounded-full px-1 text-sky-500 hover:bg-white hover:text-red-500"
                        title="移除该文档"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
            <form onSubmit={(e) => { e.preventDefault(); executeSolve(); }} className="flex gap-2">
              <textarea
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    executeSolve();
                  }
                }}
                placeholder="输入问题，或拖入文档后询问：分析这份文档哪里可能出错..."
                rows={2}
                disabled={isLoading}
                className="flex-1 px-4 py-2 rounded-xl bg-white border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 disabled:opacity-50 resize-none"
              />
              <button
                type="submit"
                disabled={isLoading || !question.trim()}
                className={clsx(
                  'px-4 py-2 rounded-xl text-white transition-colors flex-shrink-0',
                  isLoading || !question.trim() ? 'bg-slate-300 cursor-not-allowed' : 'bg-purple-500 hover:bg-purple-600'
                )}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                </svg>
              </button>
            </form>
          </div>
        </div>
      </div>

      {expandedStep && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 px-6 py-8">
          <div className="flex max-h-full w-full max-w-6xl flex-col rounded-xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-3">
              <div>
                <div className="text-sm font-semibold text-slate-800">
                  STEP {expandedStep.order || subprocesses.findIndex(step => step.id === expandedStep.id) + 1}: {expandedStep.name}
                </div>
                <div className="mt-0.5 text-[11px] text-slate-400">决策子过程完整内容，可滚动查看</div>
              </div>
              <button
                onClick={() => setExpandedStepId(null)}
                className="rounded-lg px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-700"
              >
                关闭
              </button>
            </div>
            <div className="grid max-h-[76vh] grid-cols-2 gap-4 overflow-y-auto p-5 text-sm">
              <section className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="mb-2 text-xs font-semibold text-slate-500">Input</div>
                <pre className="whitespace-pre-wrap font-sans leading-6 text-slate-700">{expandedInput || '（无）'}</pre>
              </section>
              {expandedStep?.diagnosis_status && expandedStep.diagnosis_status !== 'normal' && (
                <section className={clsx(
                  'rounded-lg border p-3',
                  expandedStep.diagnosis_status === 'failure'
                    ? 'border-red-200 bg-red-50'
                    : 'border-amber-200 bg-amber-50'
                )}>
                  <div className={clsx(
                    'mb-2 text-xs font-semibold',
                    expandedStep.diagnosis_status === 'failure' ? 'text-red-700' : 'text-amber-700'
                  )}>
                    {expandedStep.diagnosis_status === 'failure' ? '可能错误源' : '性能/上下文提示'}
                  </div>
                  <div className="space-y-2 text-sm leading-6 text-slate-700">
                    <div>类型：{expandedStep.failure_label || expandedStep.failure_type}</div>
                    {expandedStep.evidence_source && (
                      <div>文字源头：{expandedStep.evidence_source}</div>
                    )}
                    {expandedStep.failure_reason && (
                      <div>原因：{expandedStep.failure_reason}</div>
                    )}
                    {expandedStep.affected_steps?.length ? (
                      <div>真实影响到：Step {expandedStep.affected_steps.join(', Step ')}</div>
                    ) : null}
                    <div>
                      到哪里去：{expandedStep.where_to_steps?.length ? `Step ${expandedStep.where_to_steps.join(', Step ')}` : '没有直接下游步骤'}
                    </div>
                  </div>
                </section>
              )}
              {expandedStep?.potential_risks?.length ? (
                <section className="rounded-lg border border-sky-200 bg-sky-50 p-3">
                  <div className="mb-2 text-xs font-semibold text-sky-700">可能出现的推理风险</div>
                  <div className="space-y-2 text-sm leading-6 text-slate-700">
                    {expandedStep.potential_risks.map((risk, idx) => (
                      <div key={idx} className="rounded-md bg-white/70 p-2 ring-1 ring-sky-100">
                        <div className="font-semibold text-sky-800">
                          {risk.label || risk.failure_type} · {Math.round((risk.confidence || 0) * 100)}%
                        </div>
                        {risk.reason && <div className="mt-1">原因：{risk.reason}</div>}
                        {risk.source_excerpt && <div className="mt-1">来源：{risk.source_excerpt}</div>}
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}
              <section className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="mb-2 text-xs font-semibold text-slate-500">Output</div>
                <pre className="whitespace-pre-wrap font-sans leading-6 text-slate-700">
                  <HighlightedEvidenceText
                    text={formatJsonToChinese(expandedOutput) || '（无）'}
                    evidence={expandedStep?.evidence_source}
                    active={expandedStep?.diagnosis_status === 'failure'}
                  />
                </pre>
              </section>
              <section className="rounded-lg border border-purple-100 bg-purple-50/60 p-3">
                <div className="mb-2 text-xs font-semibold text-purple-600">System Prompt</div>
                <pre className="whitespace-pre-wrap font-sans leading-6 text-slate-700">{expandedSystemPrompt || '（无）'}</pre>
              </section>
              <section className="rounded-lg border border-purple-100 bg-purple-50/60 p-3">
                <div className="mb-2 text-xs font-semibold text-purple-600">User Template</div>
                <pre className="whitespace-pre-wrap font-sans leading-6 text-slate-700">{expandedUserTemplate || '（无）'}</pre>
              </section>
            </div>
          </div>
        </div>
      )}

      {/* 聊天消息全屏查看 */}
      {viewingMessage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 px-6 py-8"
          onClick={() => setViewingMessage(null)}
        >
          <ViewingMessageModal
            msg={viewingMessage}
            onClose={() => setViewingMessage(null)}
          />
        </div>
      )}

      {/* 设置面板 */}
      <SettingsModal
        open={showSettings}
        initialSettings={settings}
        onClose={() => setShowSettings(false)}
        onSave={(newSettings) => {
          setSettings(newSettings);
          saveSettings(newSettings);
        }}
      />
    </div>
  );
}
