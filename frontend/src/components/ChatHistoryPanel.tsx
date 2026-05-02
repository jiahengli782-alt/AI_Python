import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';

export interface ConversationSnapshot {
  id: string;
  title: string;
  question: string;
  timestamp: number;
  chatMessages: any[];
  subprocesses: any[];
  modificationHistory: any[];
  treePromptDrafts: Record<string, string>;
  activeQuestion: string;
  /** 用户是否手动改过标题（改过就不让 AI 覆盖） */
  titleLocked?: boolean;
  /** AI 是否已经生成过标题（避免重复调用） */
  aiTitleGenerated?: boolean;
}

interface ChatHistoryPanelProps {
  conversations: ConversationSnapshot[];
  activeConversationId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, newTitle: string) => void;
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (seconds < 60) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (hours < 24) return `${hours} 小时前`;
  return new Date(timestamp).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

// 按今天/昨天/本周/更早分组
type GroupKey = '今天' | '昨天' | '本周' | '更早';
const GROUP_ORDER: GroupKey[] = ['今天', '昨天', '本周', '更早'];

function groupByDate(conversations: ConversationSnapshot[]): Record<GroupKey, ConversationSnapshot[]> {
  const result: Record<GroupKey, ConversationSnapshot[]> = {
    '今天': [],
    '昨天': [],
    '本周': [],
    '更早': [],
  };

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  // 本周：周一作为起点
  const dayOfWeek = now.getDay() === 0 ? 7 : now.getDay(); // 周日=7
  const startOfWeek = startOfToday - (dayOfWeek - 1) * 24 * 60 * 60 * 1000;

  for (const conv of conversations) {
    if (conv.timestamp >= startOfToday) {
      result['今天'].push(conv);
    } else if (conv.timestamp >= startOfYesterday) {
      result['昨天'].push(conv);
    } else if (conv.timestamp >= startOfWeek) {
      result['本周'].push(conv);
    } else {
      result['更早'].push(conv);
    }
  }
  return result;
}

export function ChatHistoryPanel({
  conversations,
  activeConversationId,
  onSelect,
  onDelete,
  onNew,
  onRename,
}: ChatHistoryPanelProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  // 先按搜索过滤，再按时间倒序，再分组
  const grouped = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = q
      ? conversations.filter(c =>
          (c.title || '').toLowerCase().includes(q) ||
          (c.question || '').toLowerCase().includes(q) ||
          (c.activeQuestion || '').toLowerCase().includes(q) ||
          (c.chatMessages || []).some((m: any) =>
            typeof m?.content === 'string' && m.content.toLowerCase().includes(q)
          )
        )
      : conversations;
    const sorted = [...filtered].sort((a, b) => b.timestamp - a.timestamp);
    return groupByDate(sorted);
  }, [conversations, searchQuery]);

  const totalFiltered = useMemo(
    () => GROUP_ORDER.reduce((sum, key) => sum + grouped[key].length, 0),
    [grouped]
  );

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  const startRename = (conv: ConversationSnapshot) => {
    setRenamingId(conv.id);
    setRenameDraft(conv.title || '');
  };

  const submitRename = () => {
    if (renamingId && renameDraft.trim()) {
      onRename(renamingId, renameDraft.trim());
    }
    setRenamingId(null);
    setRenameDraft('');
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameDraft('');
  };

  return (
    <div className="h-full bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
      {/* 标题栏 - 与其它面板统一 */}
      <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between flex-shrink-0">
        <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
          对话历史
          {conversations.length > 0 && (
            <span className="ml-1 text-xs bg-purple-100 text-purple-600 px-2 py-0.5 rounded-full">
              {conversations.length}
            </span>
          )}
        </h3>
        <button
          onClick={onNew}
          className="px-2.5 py-1 rounded-lg border border-purple-200 bg-purple-50 text-xs text-purple-600 hover:bg-purple-100 transition-colors flex items-center gap-1"
          title="新建对话"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
          </svg>
          新建
        </button>
      </div>

      {/* 搜索框 */}
      {conversations.length > 0 && (
        <div className="px-3 pt-2 pb-1 flex-shrink-0">
          <div className="relative">
            <svg className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索对话..."
              className="w-full pl-7 pr-7 py-1.5 text-xs rounded-lg border border-slate-200 bg-slate-50 focus:outline-none focus:ring-2 focus:ring-purple-300 focus:border-purple-300 focus:bg-white transition-colors"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                title="清空"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>
      )}

      {/* 列表 */}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 pt-1">
        {conversations.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-xs text-slate-400 py-6">
            <svg className="w-12 h-12 mb-2 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            <p>还没有对话记录</p>
            <p className="mt-1 text-[10px]">在右侧提问后会自动保存</p>
          </div>
        ) : totalFiltered === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-xs text-slate-400 py-6">
            <p>没有匹配"{searchQuery}"的对话</p>
          </div>
        ) : (
          <div className="space-y-3">
            {GROUP_ORDER.map((groupKey) => {
              const items = grouped[groupKey];
              if (items.length === 0) return null;
              return (
                <div key={groupKey}>
                  {/* 分组标题 */}
                  <div className="px-1 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                    {groupKey}
                  </div>
                  <div className="space-y-1">
                    {items.map((conv) => {
                      const isActive = conv.id === activeConversationId;
                      const messageCount = conv.chatMessages?.length || 0;
                      const stepCount = conv.subprocesses?.length || 0;
                      const modCount = conv.modificationHistory?.length || 0;
                      const isRenaming = renamingId === conv.id;

                      return (
                        <div
                          key={conv.id}
                          onClick={() => !isRenaming && onSelect(conv.id)}
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            startRename(conv);
                          }}
                          className={clsx(
                            'group rounded-lg border px-2.5 py-2 transition-all',
                            isRenaming ? 'cursor-text' : 'cursor-pointer',
                            isActive
                              ? 'border-purple-400 bg-purple-50 shadow-sm'
                              : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
                          )}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex-1 min-w-0">
                              {isRenaming ? (
                                <input
                                  ref={renameInputRef}
                                  type="text"
                                  value={renameDraft}
                                  onChange={(e) => setRenameDraft(e.target.value)}
                                  onClick={(e) => e.stopPropagation()}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') submitRename();
                                    if (e.key === 'Escape') cancelRename();
                                  }}
                                  onBlur={submitRename}
                                  className="w-full px-1 py-0.5 text-xs font-medium text-purple-700 bg-white border border-purple-300 rounded focus:outline-none focus:ring-1 focus:ring-purple-400"
                                />
                              ) : (
                                <div
                                  className={clsx(
                                    'text-xs font-medium truncate',
                                    isActive ? 'text-purple-700' : 'text-slate-700'
                                  )}
                                  title={`${conv.title}（双击重命名）`}
                                >
                                  {conv.title || '未命名会话'}
                                </div>
                              )}
                              <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-slate-400 flex-wrap">
                                <span>{formatRelativeTime(conv.timestamp)}</span>
                                {stepCount > 0 && (
                                  <>
                                    <span>·</span>
                                    <span>{stepCount}步</span>
                                  </>
                                )}
                                {modCount > 0 && (
                                  <>
                                    <span>·</span>
                                    <span>修改{modCount}次</span>
                                  </>
                                )}
                                {messageCount > 0 && (
                                  <>
                                    <span>·</span>
                                    <span>{messageCount}条</span>
                                  </>
                                )}
                              </div>
                            </div>
                            {!isRenaming && (
                              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    startRename(conv);
                                  }}
                                  className="p-1 rounded text-slate-400 hover:text-purple-600 hover:bg-purple-50"
                                  title="重命名"
                                >
                                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                  </svg>
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (window.confirm('确定删除这条对话记录？')) onDelete(conv.id);
                                  }}
                                  className="p-1 rounded text-slate-400 hover:text-red-500 hover:bg-red-50"
                                  title="删除"
                                >
                                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3" />
                                  </svg>
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default ChatHistoryPanel;
