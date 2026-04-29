import { create } from 'zustand';
import type { Stage, StageStats, PromptConfig, HistoryItem } from '../types';

interface AppState {
  // 当前解题结果
  currentResult: Stage[] | null;
  currentQuestion: string;
  executionId: string | null;
  isLoading: boolean;
  
  // 统计信息
  stats: StageStats[];
  
  // Prompt配置
  prompts: PromptConfig[];
  
  // 历史记录
  history: HistoryItem[];
  
  // 选中的阶段（用于查看详情）
  selectedStage: string | null;
  
  // 是否显示Prompt编辑模态框
  showPromptEditor: boolean;
  editingPrompt: PromptConfig | null;
  
  // Actions
  setCurrentResult: (result: Stage[], question: string, executionId: string) => void;
  setLoading: (loading: boolean) => void;
  setStats: (stats: StageStats[]) => void;
  setPrompts: (prompts: PromptConfig[]) => void;
  setHistory: (history: HistoryItem[]) => void;
  selectStage: (stageId: string | null) => void;
  openPromptEditor: (prompt: PromptConfig) => void;
  closePromptEditor: () => void;
  updatePromptInList: (prompt: PromptConfig) => void;
  reset: () => void;
}

export const useStore = create<AppState>((set) => ({
  // 初始状态
  currentResult: null,
  currentQuestion: '',
  executionId: null,
  isLoading: false,
  stats: [],
  prompts: [],
  history: [],
  selectedStage: null,
  showPromptEditor: false,
  editingPrompt: null,
  
  // Actions
  setCurrentResult: (result, question, executionId) =>
    set({ currentResult: result, currentQuestion: question, executionId }),
  
  setLoading: (loading) => set({ isLoading: loading }),
  
  setStats: (stats) => set({ stats }),
  
  setPrompts: (prompts) => set({ prompts }),
  
  setHistory: (history) => set({ history }),
  
  selectStage: (stageId) => set({ selectedStage: stageId }),
  
  openPromptEditor: (prompt) => set({ showPromptEditor: true, editingPrompt: prompt }),
  
  closePromptEditor: () => set({ showPromptEditor: false, editingPrompt: null }),
  
  updatePromptInList: (prompt) =>
    set((state) => ({
      prompts: state.prompts.map((p) =>
        p.stage === prompt.stage ? prompt : p
      ),
    })),
  
  reset: () =>
    set({
      currentResult: null,
      currentQuestion: '',
      executionId: null,
      isLoading: false,
      selectedStage: null,
    }),
}));
