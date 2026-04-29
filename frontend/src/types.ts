// 类型定义

export interface Subprocess {
  id: string;
  name: string;
  skill: string;
  description: string;
  input: string;
  output: string;
  systemPrompt: string;
  userPrompt: string;
  timeMs: number;
  avgTimeMs: number;
  accuracy: number;        // 影响度：对最终结果的影响程度
  riskLevel: 'high' | 'medium' | 'low';  // 风险等级
  riskScore?: number;
  riskFactors?: string[];
  health: 'green' | 'yellow' | 'red';
  healthScore?: number;
  healthIssues?: string[];
  healthSuggestions?: string[];
  order: number;
  reasoning?: string;      // 为什么需要这个步骤
  userPromptTemplate?: string;
  metricBasis?: Record<string, number | string>;
  modified?: boolean;
}

export type Stage = Subprocess;

export interface PromptConfig {
  stage: string;
  name?: string;
  description?: string;
  systemPrompt: string;
  userPromptTemplate: string;
}

export interface SolveResponse {
  executionId: string;
  timestamp: string;
  question: string;
  stages: Subprocess[];
  finalAnswer: string;
}

export interface StageStats {
  stage: string;
  name: string;
  avgTimeMs: number;
  totalRuns: number;
  accuracy: number;        // 累积的影响度
  health: 'green' | 'yellow' | 'red';
}

export interface StatsResponse {
  stats: StageStats[];
}

export interface Skill {
  name: string;
  description: string;
  systemPrompt: string;
  userPromptTemplate: string;
}

export interface SkillsResponse {
  skills: Skill[];
}

export interface PlanSubprocess {
  id: string;
  name: string;
  skill: string;
  riskLevel: 'high' | 'medium' | 'low';
  reasoning: string;
}

export interface PlanEvent {
  subprocesses: PlanSubprocess[];
}

export interface RerunResponse {
  message: string;
  stats: StageStats[];
  stages?: Subprocess[];
  timestamp: string;
}

export interface HistoryItem {
  id: string;
  timestamp: string;
  question: string;
  stages: Subprocess[];
  finalAnswer: string;
}

export interface HistoryResponse {
  history: HistoryItem[];
}
