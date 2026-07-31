"use client";

import { Icon } from "../ui/Icon";

interface WelcomeScreenProps {
  connected: boolean | null;
  onSuggestionClick: (text: string) => void;
}

const suggestions = [
  "总结这段内容并列出三个行动项",
  "帮我把想法整理成一份清晰的方案",
  "检查下面文字中可能存在的事实问题",
];

export function WelcomeScreen({ connected, onSuggestionClick }: WelcomeScreenProps) {
  return (
    <section className="welcome">
      <div className="local-badge">LOCAL · PRIVATE</div>
      <h1>
        你的资料，
        <br />
        只在你的Mac上思考。
      </h1>
      <p>
        开源、本地优先的 Mac 助手。对话与资料问答都在本机完成，不经过云端，也无需账号。
      </p>
      <div className="suggestions">
        {suggestions.map((s) => (
          <button key={s} onClick={() => onSuggestionClick(s)}>
            {s}
            <span>
              <Icon name="arrow-up-right" />
            </span>
          </button>
        ))}
      </div>
      {connected === false && (
        <div className="offline-guide">
          <div>
            <span className="offline-icon">
              <Icon name="alert" />
            </span>
            <div>
              <strong>本地模型还没有启动</strong>
              <p>首次使用需要安装TurboFieldfare和Gemma 4；完成后只需一条命令即可启动。</p>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
