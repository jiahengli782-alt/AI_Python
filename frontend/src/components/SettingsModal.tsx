import { useState } from 'react';
import clsx from 'clsx';

export interface UserSettings {
  /** 用户的火山方舟 API Key */
  apiKey: string;
  /** 模型 ID（接入点 ep-xxx 或模型名 doubao-xxx） */
  model: string;
  /** 后端服务地址，方便部署到不同环境 */
  backendUrl: string;
}

export const DEFAULT_SETTINGS: UserSettings = {
  apiKey: '',
  model: 'doubao-seed-1-6-251015',
  backendUrl: 'http://localhost:8000',
};

const SETTINGS_STORAGE_KEY = 'agent_user_settings_v1';

export function loadSettings(): UserSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    return {
      apiKey: parsed.apiKey || '',
      model: parsed.model || DEFAULT_SETTINGS.model,
      backendUrl: (parsed.backendUrl || DEFAULT_SETTINGS.backendUrl).replace(/\/+$/, ''),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: UserSettings) {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
      ...settings,
      backendUrl: (settings.backendUrl || '').replace(/\/+$/, ''),
    }));
  } catch (err) {
    console.warn('设置保存失败:', err);
  }
}

interface SettingsModalProps {
  open: boolean;
  initialSettings: UserSettings;
  onClose: () => void;
  onSave: (settings: UserSettings) => void;
}

type TestStatus = 'idle' | 'testing' | 'ok' | 'auth_failed' | 'model_invalid' | 'quota_exceeded' | 'network_error' | 'unknown';

export function SettingsModal({ open, initialSettings, onClose, onSave }: SettingsModalProps) {
  const [draft, setDraft] = useState<UserSettings>(initialSettings);
  const [showApiKey, setShowApiKey] = useState(false);
  const [testStatus, setTestStatus] = useState<TestStatus>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [testReply, setTestReply] = useState('');

  if (!open) return null;

  const handleTest = async () => {
    setTestStatus('testing');
    setTestMessage('');
    setTestReply('');
    try {
      const url = (draft.backendUrl || DEFAULT_SETTINGS.backendUrl).replace(/\/+$/, '');
      const res = await fetch(`${url}/api/test-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: draft.apiKey, model: draft.model }),
      });
      if (!res.ok) {
        setTestStatus('unknown');
        setTestMessage(`测试请求失败：HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      setTestStatus(data.status || 'unknown');
      setTestMessage(data.message || '');
      if (data.sample_reply) setTestReply(data.sample_reply);
    } catch (err: any) {
      setTestStatus('network_error');
      setTestMessage(`无法连接后端 ${draft.backendUrl}：${err?.message || err}`);
    }
  };

  const handleSave = () => {
    onSave({
      ...draft,
      backendUrl: (draft.backendUrl || DEFAULT_SETTINGS.backendUrl).replace(/\/+$/, ''),
    });
    onClose();
  };

  const handleReset = () => {
    if (window.confirm('确定要清空 API Key 和所有设置？')) {
      setDraft(DEFAULT_SETTINGS);
    }
  };

  // 状态颜色映射
  const statusStyles: Record<TestStatus, { bg: string; text: string; icon: string }> = {
    idle: { bg: '', text: '', icon: '' },
    testing: { bg: 'bg-blue-50 border-blue-200', text: 'text-blue-700', icon: '⏳' },
    ok: { bg: 'bg-emerald-50 border-emerald-200', text: 'text-emerald-700', icon: '✅' },
    auth_failed: { bg: 'bg-red-50 border-red-200', text: 'text-red-700', icon: '🔐' },
    model_invalid: { bg: 'bg-amber-50 border-amber-200', text: 'text-amber-700', icon: '⚠️' },
    quota_exceeded: { bg: 'bg-orange-50 border-orange-200', text: 'text-orange-700', icon: '📉' },
    network_error: { bg: 'bg-red-50 border-red-200', text: 'text-red-700', icon: '🌐' },
    unknown: { bg: 'bg-slate-50 border-slate-200', text: 'text-slate-700', icon: '❔' },
  };
  const status = statusStyles[testStatus];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 px-6 py-8"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-xl border border-slate-200 bg-white shadow-2xl flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-3 flex-shrink-0">
          <div>
            <div className="text-sm font-semibold text-slate-800 flex items-center gap-2">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              设置
            </div>
            <div className="mt-0.5 text-[11px] text-slate-400">
              所有设置只保存在你的浏览器，不会被上传到任何地方
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-700"
          >
            关闭
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4 space-y-5">
          {/* API Key */}
          <div>
            <label className="text-xs font-semibold text-slate-700 flex items-center gap-1">
              火山方舟 API Key
              <span className="text-red-500">*</span>
            </label>
            <p className="mt-0.5 text-[11px] text-slate-400">
              在 <a
                href="https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey"
                target="_blank"
                rel="noopener noreferrer"
                className="text-purple-600 hover:underline"
              >火山方舟控制台</a> 创建。形如 <code className="text-purple-600 bg-purple-50 px-1 rounded">ark-xxx-xxx-...</code> 或 32 位 UUID
            </p>
            <div className="mt-1.5 relative">
              <input
                type={showApiKey ? 'text' : 'password'}
                value={draft.apiKey}
                onChange={(e) => { setDraft({ ...draft, apiKey: e.target.value.trim() }); setTestStatus('idle'); }}
                placeholder="ark-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx-xxxxx"
                className="w-full px-3 py-2 pr-20 rounded-lg border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-purple-300 focus:border-purple-300"
              />
              <button
                type="button"
                onClick={() => setShowApiKey(!showApiKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-slate-600 px-2 py-1 rounded hover:bg-slate-100"
              >
                {showApiKey ? '隐藏' : '显示'}
              </button>
            </div>
          </div>

          {/* 模型 ID */}
          <div>
            <label className="text-xs font-semibold text-slate-700">模型 ID / 接入点</label>
            <p className="mt-0.5 text-[11px] text-slate-400">
              填模型名（如 <code className="text-slate-600 bg-slate-100 px-1 rounded">doubao-seed-1-6-251015</code>）或自建接入点 ID（<code className="text-slate-600 bg-slate-100 px-1 rounded">ep-xxx</code>）
            </p>
            <input
              type="text"
              value={draft.model}
              onChange={(e) => { setDraft({ ...draft, model: e.target.value.trim() }); setTestStatus('idle'); }}
              placeholder="doubao-seed-1-6-251015"
              className="mt-1.5 w-full px-3 py-2 rounded-lg border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-purple-300 focus:border-purple-300"
            />
          </div>

          {/* 后端地址 */}
          <div>
            <label className="text-xs font-semibold text-slate-700">后端服务地址</label>
            <p className="mt-0.5 text-[11px] text-slate-400">
              本地运行就用 <code className="text-slate-600 bg-slate-100 px-1 rounded">http://localhost:8000</code>；如果部署了远程后端，填它的公网地址
            </p>
            <input
              type="text"
              value={draft.backendUrl}
              onChange={(e) => { setDraft({ ...draft, backendUrl: e.target.value.trim() }); setTestStatus('idle'); }}
              placeholder="http://localhost:8000"
              className="mt-1.5 w-full px-3 py-2 rounded-lg border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-purple-300 focus:border-purple-300"
            />
          </div>

          {/* 测试连通性按钮 */}
          <div>
            <button
              onClick={handleTest}
              disabled={!draft.apiKey || testStatus === 'testing'}
              className="px-4 py-2 rounded-lg bg-slate-800 text-white text-xs font-medium hover:bg-slate-700 disabled:bg-slate-300 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {testStatus === 'testing' ? (
                <>
                  <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  测试中...
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" />
                  </svg>
                  测试连通性
                </>
              )}
            </button>
            {testStatus !== 'idle' && testStatus !== 'testing' && (
              <div className={clsx('mt-2.5 px-3 py-2 rounded-lg border text-xs flex items-start gap-2', status.bg, status.text)}>
                <span className="text-base leading-none">{status.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="font-medium">{testMessage}</div>
                  {testReply && (
                    <div className="mt-1 text-[11px] opacity-70 break-all">
                      模型回复："{testReply}"
                    </div>
                  )}
                  {testStatus === 'auth_failed' && (
                    <div className="mt-1 text-[11px] opacity-80">
                      去 <a href="https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey" target="_blank" rel="noopener noreferrer" className="underline">控制台</a> 重新生成 Key，并确认勾选了对应模型/接入点的授权
                    </div>
                  )}
                  {testStatus === 'model_invalid' && (
                    <div className="mt-1 text-[11px] opacity-80">
                      去 <a href="https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement" target="_blank" rel="noopener noreferrer" className="underline">开通管理</a> 检查这个模型是否已开通
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* 安全提示 */}
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-[11px] text-amber-700">
            <div className="font-semibold mb-0.5">🔒 隐私说明</div>
            <ul className="list-disc list-inside space-y-0.5 opacity-90">
              <li>API Key 只存在你浏览器的 localStorage，不会发送给除火山方舟外的任何服务</li>
              <li>每次请求时，前端会把 Key 通过 <code className="bg-amber-100 px-1 rounded">X-Ark-Api-Key</code> header 传给后端，后端转发给火山方舟</li>
              <li>清除浏览器数据 / 点下方"清空设置"会立即丢弃 Key</li>
            </ul>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-slate-200 px-5 py-3 flex-shrink-0 bg-slate-50">
          <button
            onClick={handleReset}
            className="px-3 py-1.5 rounded-lg text-xs text-slate-500 hover:text-red-600 hover:bg-red-50"
          >
            清空设置
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-1.5 rounded-lg border border-slate-300 bg-white text-xs text-slate-600 hover:bg-slate-50"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-1.5 rounded-lg bg-purple-500 text-white text-xs font-medium hover:bg-purple-600"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default SettingsModal;
