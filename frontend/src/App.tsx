import { useEffect, useState, useRef } from 'react';
import clsx from 'clsx';
import { ModificationFlow } from './components/ModificationFlow';
import { PromptTreePanel, type TreePreviewResult } from './components/PromptTreePanel';

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
  timestamp: Date;
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
  const [modificationHistory, setModificationHistory] = useState<{
    round: number;
    modifiedStepIndex: number;
    stages: Subprocess[];
    timestamp: number;
  }[]>([]);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const stepCardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const treeEditSnapshotRef = useRef<TreeEditSnapshot | null>(null);

  const streamSolve = async (payload: {
    question: string;
    startStepIndex?: number;
    modifiedOutputs?: Record<string, string>;
    modifiedSteps?: Record<string, any>;
    baseStages?: Subprocess[];
    previewMode?: boolean;
  }) => {
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

    const postStream = () => fetch('http://localhost:8000/api/solve/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (payload.baseStages?.length) {
      return postStream();
    }

    const getUrl = `http://localhost:8000/api/solve/stream?${params.toString()}`;

    try {
      const getResponse = await fetch(getUrl);
      if (getResponse.status !== 414 && getResponse.status !== 431 && getResponse.status !== 405) {
        return getResponse;
      }
    } catch {
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

  const summarizeForPreview = (text: string, maxLength = 80) => {
    const clean = (text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return '暂无可预览结果';
    return clean.length > maxLength ? `${clean.slice(0, maxLength)}...` : clean;
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
    const lines = [
      basis?.mode === 'measured' ? '影响度：基于上一版与当前版的最终答案差异' : '影响度：基于风险、链路位置和输出健康度估计',
      `风险度：${step.riskScore ?? Math.round((step.accuracy || 0) * 100)}`,
      `健康度：${step.healthScore ?? 80}`,
    ];
    if (basis?.finalDelta !== undefined) lines.push(`最终答案变化：${Math.round(basis.finalDelta * 100)}%`);
    if (basis?.outputDelta !== undefined) lines.push(`本步输出变化：${Math.round(basis.outputDelta * 100)}%`);
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

  useEffect(() => {
    if (!selectedStepId) return;
    stepCardRefs.current[selectedStepId]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [selectedStepId]);

  const parseSSEResponse = async (reader: ReadableStreamDefaultReader, modifiedStepIndex: number | null = null) => {
    const decoder = new TextDecoder();
    let finalOutput = '';
    let allData = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      allData += decoder.decode(value, { stream: true });
    }

    // 解析所有事件
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
      
      if (!eventData) continue;
      
      try {
        const data = JSON.parse(eventData);

        if (eventType === 'api_error') {
          throw new Error(formatApiErrorMessage(data.error));
        }

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
        }

        if (eventType === 'complete' && data.stages && typeof data.finalOutput === 'string') {
          finalOutput = data.finalOutput;
          const completedStages: Subprocess[] =
            modifiedStepIndex !== null && data.stages.length < subprocesses.length
              ? [...subprocesses.slice(0, modifiedStepIndex), ...data.stages]
              : data.stages;

          setSubprocesses(completedStages);

          setChatMessages(prev => [...prev, {
            id: Date.now().toString(),
            role: 'assistant',
            content: finalOutput,
            timestamp: new Date()
          }]);

          // 记录Prompt历史
          setModificationHistory(prev => [...prev, {
            round: prev.length + 1,
            modifiedStepIndex: modifiedStepIndex ?? -1,
            stages: completedStages,
            timestamp: Date.now(),
          }]);
          return;
        }
      } catch (err) {
        if (eventType === 'api_error') {
          throw err;
        }
        console.error('解析事件数据失败:', err);
      }
    }
  };

  const executeSolve = async () => {
    if (!question.trim() || isLoading) return;

    const userQuestion = question.trim();

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
      content: userQuestion,
      timestamp: new Date()
    }]);

    setQuestion('');
    setActiveQuestion(userQuestion);
    setIsLoading(true);
    setError(null);
    setSubprocesses([]);
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
      const response = await streamSolve({ question: userQuestion });
      if (!response.ok) throw new Error(`请求失败: ${response.status}`);

      const reader = response.body?.getReader();
      if (!reader) throw new Error('无法读取响应');

      await parseSSEResponse(reader);
    } catch (err: any) {
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

  const clearChat = () => {
    setChatMessages([]);
    setSubprocesses([]);
    setEditingStepId(null);
    setSelectedStepId(null);
    setExpandedStepId(null);
    setModificationHistory([]);
    setActiveQuestion('');
    setTreePromptDrafts({});
    setTreePreviewResults([]);
    setTreePreviewFinalOutput('');
    clearTreeSnapshot();
    setTreeResetSignal(prev => prev + 1);
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
          <button
            onClick={clearChat}
            className="px-3 py-1.5 text-xs text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
          >
            新对话
          </button>
        </div>
      </header>

      {error && (
        <div className="mx-4 mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
          {error}
        </div>
      )}

      {/* Main Content - 新布局：左侧（右上卡片+左下占位）+ 右侧对话 */}
      <div className="flex-1 flex overflow-hidden">
        {/* 左侧区域 - 其他功能（左边）+ 决策子过程（右边） */}
        <div className="flex-1 flex bg-slate-100 overflow-hidden">
          {/* 左边：其他功能区域 - 上下布局 */}
          <div className="w-1/3 flex flex-col">
            {/* 上部分：目标-子过程树 */}
            <div className="flex-[2] border-r border-slate-200 bg-slate-50 p-4 min-h-0">
              <PromptTreePanel
                goal={activeQuestion || chatMessages.find(m => m.role === 'user')?.content || '等待输入目标'}
                subprocesses={subprocesses}
                selectedStepId={selectedStepId}
                editingStepId={editingStepId}
                editedSystemPrompt={editedSystemPrompt}
                promptDrafts={treePromptDrafts}
                previewResults={treePreviewResults}
                previewFinalOutput={treePreviewFinalOutput}
                canUndoTreeChange={Boolean(treeEditSnapshot)}
                isPreviewing={isTreePreviewing}
                resetSignal={treeResetSignal}
                onSelectStep={setSelectedStepId}
                onApplyPrompt={applyTreePrompt}
                onPreviewPrompt={runTreePreview}
                onUndoPreview={undoTreePreview}
              />
            </div>
            {/* 下部分：保留空白扩展区 */}
            <div className="flex-1 border-t border-r border-slate-200 bg-slate-50 p-4 min-h-0">
              <div className="h-full border-2 border-dashed border-slate-300 rounded-lg bg-white/40" />
            </div>
          </div>

          {/* 右边：决策子过程 - 上下布局 */}
          <div className="flex-1 flex flex-col">
            {/* 上部分：决策子过程卡片区域 */}
            <div className="flex-[2] overflow-hidden p-4">
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
                <div className="grid grid-cols-2 gap-3">
                  {subprocesses.map((sub, idx) => {
                    const risk = riskColors[sub.riskLevel] || riskColors.medium;
                    const isEditing = editingStepId === sub.id;
                    const isSelected = selectedStepId === sub.id;
                    const isEditable = true;
                    const isDirty = isEditing && hasEditChanges(sub);
                    const metricTitle = buildMetricTitle(sub);
                    const isRerunning = isLoading && rerunFromStep !== null && idx >= rerunFromStep;

                    return (
                      <div
                        key={sub.id}
                        ref={(node) => { stepCardRefs.current[sub.id] = node; }}
                        onClick={() => setSelectedStepId(sub.id)}
                        className={clsx(
                          'rounded-lg border transition-all flex flex-col cursor-pointer',
                          isEditing ? 'border-purple-400 bg-purple-50 shadow-lg' :
                            isSelected ? 'border-red-400 bg-red-50 shadow-md shadow-red-100' :
                              'border-slate-200 bg-white hover:border-slate-300'
                        )}
                      >
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

                        {/* 指标 */}
                        <div className="px-3 pb-2 flex items-center gap-3 text-xs text-slate-400 flex-shrink-0" title={metricTitle}>
                          <span>影响度: <span className={clsx('font-semibold', risk.text)}>{(sub.accuracy * 100).toFixed(0)}%</span></span>
                          <span>健康: <span className={clsx('font-semibold', healthTextColor[sub.health] || 'text-slate-500')}>{sub.healthScore || 80}</span></span>
                          <span>风险: <span className={clsx('font-semibold', risk.text)}>{sub.riskScore ?? '--'}</span></span>
                          {isRerunning && <span className="text-purple-500 font-medium">重算中</span>}
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
                                    <pre className="whitespace-pre-wrap font-sans">{formatJsonToChinese(sub.output)}</pre>
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

          {/* 右边下部分：修改历史折线图 */}
          <div className="flex-1 border-t border-slate-200 bg-slate-50 p-2">
            <div className="h-full bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden flex flex-col">
              <div className="px-3 py-2 border-b border-slate-200 flex-shrink-0">
                <h3 className="text-xs font-semibold text-slate-700 flex items-center gap-2">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
                  </svg>
                  修改历史
                  {modificationHistory.length > 0 && (
                    <span className="ml-1 text-xs bg-purple-100 text-purple-600 px-1.5 py-0.5 rounded-full">
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
          <div className="px-4 py-3 border-b border-slate-100 bg-slate-50">
            <h3 className="text-sm font-semibold text-slate-700">对话</h3>
          </div>

          {/* 消息列表 */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {chatMessages.length === 0 && (
              <div className="text-center py-8">
                <p className="text-sm text-slate-400">开始对话吧！</p>
              </div>
            )}

            {chatMessages.map((msg) => (
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
                  <div className={clsx('text-xs mt-1', msg.role === 'user' ? 'text-purple-200' : 'text-slate-400')}>
                    {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
              </div>
            ))}

            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-slate-100 rounded-2xl rounded-bl-sm px-4 py-3">
                  <div className="flex items-center gap-1">
                    <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                    <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                </div>
              </div>
            )}

            <div ref={chatEndRef} />
          </div>

          {/* 输入框 */}
          <div className="p-4 border-t border-slate-100 bg-slate-50">
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
                placeholder="输入问题，或：修改第1步输出为..."
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
              <section className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="mb-2 text-xs font-semibold text-slate-500">Output</div>
                <pre className="whitespace-pre-wrap font-sans leading-6 text-slate-700">{formatJsonToChinese(expandedOutput) || '（无）'}</pre>
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
    </div>
  );
}
