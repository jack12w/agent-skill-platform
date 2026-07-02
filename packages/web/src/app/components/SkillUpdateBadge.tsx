'use client';

interface SkillUpdateBadgeProps {
  hasUpdate: boolean;
}

/**
 * 「有新版本」Badge — 绿色胶囊标签，与标题同行右对齐时使用。
 * 仅在 hasUpdate 为 true 时渲染。
 */
export default function SkillUpdateBadge({ hasUpdate }: SkillUpdateBadgeProps) {
  if (!hasUpdate) return null;

  return (
    <span
      className="inline-flex items-center text-[11px] font-semibold text-white rounded-full whitespace-nowrap flex-shrink-0 ml-2"
      style={{
        background: 'linear-gradient(135deg, #059669, #10b981)',
        padding: '1px 10px',
        boxShadow: '0 1px 4px rgba(16, 185, 129, 0.3)',
        lineHeight: 1.6,
      }}
    >
      有新版本
    </span>
  );
}
