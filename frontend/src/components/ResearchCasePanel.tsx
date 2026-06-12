import { useEffect, useMemo, useState } from 'react';
import type { UserSettings } from './SettingsModal';

interface ResearchCasePanelProps {
  settings: UserSettings;
  question: string;
  subprocesses: any[];
  traceDiagnosis?: any;
  replayHistory: any[];
  uploadedDocuments: any[];
  onClose?: () => void;
}

interface SavedCaseSummary {
  id: string;
  title: string;
  createdAt?: string;
  caseType?: string;
  question?: string;
  observed_failure_types?: string[];
  replayCount?: number;
  stepCount?: number;
  report?: string;
}

const failureLabels: Record<string, string> = {
  fact_error: '事实错误',
  unsupported_claim: '无证据断言',
  tool_misuse: '工具/API误用',
  retrieval_miss: '检索/证据缺失',
  planning_error: '规划错误',
  self_inconsistency: '前后不一致',
  constraint_violation: '约束违反',
  format_error: '格式错误',
  hallucination: '幻觉',
  invalid_retry: '无效重试',
  cost_latency_anomaly: '成本/延迟异常',
  memory_pollution: '记忆污染',
  context_omission: '上下文遗漏',
};

function downloadText(filename: string, text: string, type = 'text/markdown;charset=utf-8') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function safeFilename(title: string) {
  return (title || 'research-case').replace(/[\\/:*?"<>|]/g, '_').slice(0, 48);
}

function renderLocalCaseReport(item: SavedCaseSummary) {
  return [
    `# Research Failure Case: ${item.title}`,
    '',
    `- Case ID: \`${item.id}\``,
    `- Created At: ${item.createdAt || new Date().toISOString()}`,
    `- Type: ${item.caseType || 'local_demo'}`,
    `- Observed Failure Types: ${(item.observed_failure_types || []).join(', ') || 'none'}`,
    `- Step Count: ${item.stepCount || 0}`,
    `- Replay Count: ${item.replayCount || 0}`,
    '',
    '## Original Question',
    item.question || '无',
    '',
    '## Reproduction Notes',
    '这是前端本地生成的复现实验 case。后端研究接口不可用时也可以先导出报告；重启后端后再保存为完整后端 case。',
  ].join('\n');
}

function buildLocalDemoCases(): SavedCaseSummary[] {
  const now = new Date().toISOString();
  const cases: SavedCaseSummary[] = [
    {
      id: `local_demo_evidence_${Date.now()}`,
      title: 'Demo Case 1: 上线状态证据不足',
      createdAt: now,
      caseType: 'local_demo',
      question: '请根据服务目录确认云岚社区健康服务平台二期目前已正式上线的核心功能有哪些？',
      observed_failure_types: ['retrieval_miss', 'unsupported_claim'],
      replayCount: 1,
      stepCount: 4,
    },
    {
      id: `local_demo_api_${Date.now()}`,
      title: 'Demo Case 2: API 429 后继续生成结论',
      createdAt: now,
      caseType: 'local_demo',
      question: '根据最新接口日志总结今天失败最多的支付错误类型。',
      observed_failure_types: ['tool_misuse'],
      replayCount: 1,
      stepCount: 4,
    },
    {
      id: `local_demo_context_${Date.now()}`,
      title: 'Demo Case 3: 长文档上下文遗漏',
      createdAt: now,
      caseType: 'local_demo',
      question: '根据上传的活动方案，生成对外宣传文案，但不能出现价格承诺和未审批合作方名称。',
      observed_failure_types: ['context_omission', 'constraint_violation'],
      replayCount: 1,
      stepCount: 3,
    },
  ];
  return cases.map(item => ({ ...item, report: renderLocalCaseReport(item) }));
}

export function ResearchCasePanel({
  settings,
  question,
  subprocesses,
  traceDiagnosis,
  replayHistory,
  uploadedDocuments,
  onClose,
}: ResearchCasePanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [remoteCases, setRemoteCases] = useState<SavedCaseSummary[]>([]);
  const [localCases, setLocalCases] = useState<SavedCaseSummary[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [caseTitle, setCaseTitle] = useState('');
  const [notes, setNotes] = useState('');
  const baseUrl = settings.backendUrl || 'http://localhost:8000';

  const allCases = useMemo(() => [...localCases, ...remoteCases], [localCases, remoteCases]);

  const loadCases = async () => {
    try {
      const res = await fetch(`${baseUrl}/api/research/cases`);
      if (!res.ok) return;
      const data = await res.json();
      setRemoteCases(data.cases || []);
    } catch {
      // 不打断主流程；后端没重启时仍可用本地 demo。
    }
  };

  useEffect(() => {
    loadCases();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl]);

  const observedTypes = Array.from(new Set(
    subprocesses
      .map(step => step.failure_type)
      .filter(type => type && type !== 'none')
  ));

  const saveCurrentCase = async () => {
    if (!question && subprocesses.length === 0) {
      setMessage('请先运行一次问题，再保存研究 case。');
      return;
    }
    setIsBusy(true);
    setMessage('');
    try {
      const res = await fetch(`${baseUrl}/api/research/cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: caseTitle || `Case: ${question.slice(0, 22) || '当前会话'}`,
          objective: '保存当前 Agent 运行，用于复现 failure taxonomy、证据来源、错误传播和 replay 对比。',
          caseType: 'current_session',
          question,
          notes,
          tags: ['current-session', 'ui-saved'],
          expectedFailureTypes: observedTypes,
          subprocesses,
          traceDiagnosis,
          replayRecords: replayHistory,
          uploadedDocuments,
        }),
      });
      if (!res.ok) throw new Error(`保存失败 ${res.status}`);
      const data = await res.json();
      setMessage(`已保存：${data.case?.title || data.case?.id}`);
      setCaseTitle('');
      setNotes('');
      await loadCases();
    } catch (err: any) {
      setMessage(`保存失败：${err.message || '后端研究接口不可用，请重启后端后再试'}`);
    } finally {
      setIsBusy(false);
    }
  };

  const saveDemoCases = async () => {
    setIsBusy(true);
    setMessage('');
    try {
      const res = await fetch(`${baseUrl}/api/research/demo-cases`, { method: 'POST' });
      if (!res.ok) throw new Error(`生成 demo case 失败 ${res.status}`);
      const data = await res.json();
      setMessage(`已生成 ${data.saved || 0} 个后端复现实验 case`);
      await loadCases();
    } catch (err: any) {
      const demos = buildLocalDemoCases();
      setLocalCases(prev => [...demos, ...prev]);
      setMessage(`后端研究接口暂不可用，已在前端本地生成 3 个 demo case。原因：${err.message || '请求失败'}`);
    } finally {
      setIsBusy(false);
    }
  };

  const exportReport = async (caseId: string, title: string) => {
    const local = localCases.find(item => item.id === caseId);
    if (local) {
      downloadText(`${safeFilename(title)}.md`, local.report || renderLocalCaseReport(local));
      setMessage(`已导出本地报告：${title}`);
      return;
    }

    setIsBusy(true);
    setMessage('');
    try {
      const res = await fetch(`${baseUrl}/api/research/cases/${caseId}/report`);
      if (!res.ok) throw new Error(`导出失败 ${res.status}`);
      const text = await res.text();
      downloadText(`${safeFilename(title)}.md`, text);
      setMessage(`已导出报告：${safeFilename(title)}.md`);
    } catch (err: any) {
      setMessage(`导出失败：${err.message || '后端研究接口不可用'}`);
    } finally {
      setIsBusy(false);
    }
  };

  const exportTemplate = async () => {
    try {
      const res = await fetch(`${baseUrl}/api/research/template`);
      if (!res.ok) throw new Error(`模板接口失败 ${res.status}`);
      const data = await res.json();
      downloadText('failure-case-template.json', JSON.stringify(data, null, 2), 'application/json;charset=utf-8');
    } catch {
      const fallbackTemplate = {
        schemaVersion: 'research_case_v1',
        requiredFields: ['title', 'objective', 'question', 'input_artifacts', 'expected_failure_types', 'observed_failure_types', 'step_diagnosis', 'replay_records', 'fix_hypotheses'],
      };
      downloadText('failure-case-template.json', JSON.stringify(fallbackTemplate, null, 2), 'application/json;charset=utf-8');
      setMessage('后端模板接口不可用，已导出前端兜底模板。');
    }
  };

  return (
    <div className="bg-white p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-slate-800">研究级 Case 支持</div>
          <div className="text-[11px] text-slate-400">failure case 模板 / 诊断报告导出 / 复现实验结果</div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={exportTemplate}
            className="rounded border border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-500 hover:bg-slate-50"
          >
            模板
          </button>
          <button
            type="button"
            onClick={() => setCollapsed(prev => !prev)}
            className="rounded border border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-500 hover:bg-slate-50"
          >
            {collapsed ? '展开' : '折叠'}
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-500 hover:bg-slate-50"
            >
              关闭
            </button>
          )}
        </div>
      </div>

      {!collapsed && (
        <div className="space-y-2">
          <div className="grid gap-1.5 md:grid-cols-2">
            <input
              value={caseTitle}
              onChange={event => setCaseTitle(event.target.value)}
              placeholder="Case 标题（可选）"
              className="rounded border border-slate-200 px-2 py-1 text-[11px] outline-none focus:border-sky-300"
            />
            <input
              value={notes}
              onChange={event => setNotes(event.target.value)}
              placeholder="研究备注（可选）"
              className="rounded border border-slate-200 px-2 py-1 text-[11px] outline-none focus:border-sky-300"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={saveCurrentCase}
              disabled={isBusy}
              className="rounded bg-slate-800 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-slate-700 disabled:opacity-40"
            >
              保存当前为 Case
            </button>
            <button
              type="button"
              onClick={saveDemoCases}
              disabled={isBusy}
              className="rounded border border-sky-200 bg-sky-50 px-2.5 py-1 text-[11px] font-medium text-sky-700 hover:bg-sky-100 disabled:opacity-40"
            >
              生成 3 个复现实验 Case
            </button>
            <span className="rounded bg-slate-50 px-2 py-1 text-[10px] text-slate-500">
              当前失败类型：{observedTypes.map(type => failureLabels[type] || type).join('、') || '暂无'}
            </span>
          </div>
          {message && <div className="rounded bg-amber-50 px-2 py-1 text-[10px] text-amber-700">{message}</div>}

          <div className="max-h-[42vh] space-y-1.5 overflow-y-auto">
            {allCases.length === 0 ? (
              <div className="rounded border border-dashed border-slate-200 bg-slate-50 px-2 py-2 text-center text-[11px] text-slate-400">
                暂无保存的研究 case
              </div>
            ) : allCases.map(item => (
              <div key={item.id} className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-[11px]">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-slate-700" title={item.title}>{item.title}</div>
                    <div className="mt-0.5 truncate text-[10px] text-slate-400" title={item.question}>
                      {item.stepCount || 0} steps · {item.replayCount || 0} replay · {(item.observed_failure_types || []).map(type => failureLabels[type] || type).join('、') || '无明确失败'}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => exportReport(item.id, item.title)}
                    disabled={isBusy}
                    className="shrink-0 rounded bg-white px-2 py-1 text-[10px] text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100 disabled:opacity-40"
                  >
                    导出报告
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default ResearchCasePanel;
