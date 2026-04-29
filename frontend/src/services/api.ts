const API_BASE = 'http://localhost:8000/api';

export const api = {
  // 获取推理阶段列表
  async getStages() {
    const res = await fetch(`${API_BASE}/stages`);
    return res.json();
  },

  // 获取统计信息
  async getStats() {
    const res = await fetch(`${API_BASE}/stats`);
    return res.json();
  },

  // 提交问题进行推理
  async solve(question: string) {
    const res = await fetch(`${API_BASE}/solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question })
    });
    return res.json();
  },

  // 重跑当前会话
  async rerun() {
    const res = await fetch(`${API_BASE}/rerun`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    return res.json();
  },

  // 更新阶段Prompt
  async updateStage(stageId: string, data: { 
    name?: string; 
    description?: string; 
    systemPrompt?: string; 
    userPromptTemplate?: string 
  }) {
    const res = await fetch(`${API_BASE}/stages/${stageId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return res.json();
  },

  // 添加新阶段
  async addStage(data: {
    id: string;
    name: string;
    description: string;
    systemPrompt: string;
    userPromptTemplate: string;
    order: number;
  }) {
    const res = await fetch(`${API_BASE}/stages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return res.json();
  },

  // 删除阶段
  async deleteStage(stageId: string) {
    const res = await fetch(`${API_BASE}/stages/${stageId}`, {
      method: 'DELETE'
    });
    return res.json();
  },

  // 获取历史记录
  async getHistory(limit: number = 20) {
    const res = await fetch(`${API_BASE}/history?limit=${limit}`);
    return res.json();
  },

  // 获取当前会话
  async getSession() {
    const res = await fetch(`${API_BASE}/session`);
    return res.json();
  },

  // 重置统计
  async reset() {
    const res = await fetch(`${API_BASE}/reset`, {
      method: 'POST'
    });
    return res.json();
  }
};
