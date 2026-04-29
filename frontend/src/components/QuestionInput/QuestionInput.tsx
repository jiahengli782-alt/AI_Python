import React, { memo, useState } from 'react';
import clsx from 'clsx';

interface QuestionInputProps {
  onSubmit: (question: string) => void;
  isLoading: boolean;
}

const EXAMPLE_QUESTIONS = [
  '小明有5个苹果，吃了2个，又买了3个，现在有几个？',
  '小红有10本书，给了小明3本，又买了5本，还剩几本？',
  '计算：25 + 17 - 8 × 2 = ?',
];

export const QuestionInput: React.FC<QuestionInputProps> = memo(({ onSubmit, isLoading }) => {
  const [question, setQuestion] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (question.trim() && !isLoading) {
      onSubmit(question.trim());
    }
  };

  const handleExample = (example: string) => {
    setQuestion(example);
  };

  return (
    <div className="bg-slate-800/50 backdrop-blur border border-slate-700 rounded-xl p-6">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="question" className="block text-sm font-medium text-slate-300 mb-2">
            输入数学问题
          </label>
          <textarea
            id="question"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="例如：小明有5个苹果，吃了2个，又买了3个，现在有几个？"
            disabled={isLoading}
            rows={3}
            className={clsx(
              'w-full px-4 py-3 rounded-lg',
              'bg-slate-900/50 border border-slate-700',
              'text-slate-100 placeholder-slate-500',
              'focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              'transition-all duration-200 resize-none'
            )}
          />
        </div>

        <div className="flex items-center justify-between">
          <div className="flex flex-wrap gap-2">
            {EXAMPLE_QUESTIONS.map((example, index) => (
              <button
                key={index}
                type="button"
                onClick={() => handleExample(example)}
                disabled={isLoading}
                className={clsx(
                  'text-xs px-2.5 py-1 rounded-md',
                  'bg-slate-700/50 text-slate-400',
                  'hover:bg-slate-700 hover:text-slate-300',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                  'transition-colors duration-200'
                )}
              >
                示例{index + 1}
              </button>
            ))}
          </div>

          <button
            type="submit"
            disabled={!question.trim() || isLoading}
            className={clsx(
              'flex items-center gap-2 px-5 py-2.5 rounded-lg font-medium',
              'bg-primary-600 hover:bg-primary-500',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              'transition-all duration-200',
              'shadow-lg shadow-primary-500/20'
            )}
          >
            {isLoading ? (
              <>
                <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                <span>分析中...</span>
              </>
            ) : (
              <>
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                <span>开始分析</span>
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
});

QuestionInput.displayName = 'QuestionInput';
