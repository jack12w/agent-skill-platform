'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  onClose: () => void;
  children: React.ReactNode;
  /**
   * 纵向对齐。center（默认）适合支付/确认类短弹窗；
   * top 适合表单类长弹窗（顶部对齐，超高时向下滚动而不是被裁掉）。
   */
  align?: 'center' | 'top';
  /** 遮罩底色类，默认 bg-black/50 */
  backdrop?: string;
  /** 是否允许点遮罩关闭，默认允许 */
  closeOnBackdrop?: boolean;
  /** 是否允许 Esc 关闭，默认允许 */
  closeOnEsc?: boolean;
  /** 标题元素 id，用于 aria-labelledby */
  labelledBy?: string;
}

/**
 * 通用弹窗容器 —— 必须走 Portal 挂到 document.body。
 *
 * 为什么不能用 `fixed inset-0 z-50` 直接写在页面里：
 * 根布局 `app/layout.tsx` 的 `<main>` 带 `relative z-[1]`，它创建了一个**层叠
 * 上下文**；而 `<NavBar>`（`sticky z-10`）是它的**兄弟**。凡是渲染在 main 内部
 * 的弹窗，无论 z-index 写多大，都只在与 main 同一个上下文里比较，整体被封顶在
 * z-index: 1 —— 永远压不过 z-index: 10 的顶栏（典型表现：弹窗遮罩盖不住顶栏）。
 *
 * 挂到 body 下之后，弹窗与 NavBar 在同一个（根）层叠上下文里比较，
 * z-[100] > z-10，稳定在最上层。新增弹窗请一律使用本组件。
 */
export default function Modal({
  onClose,
  children,
  align = 'center',
  backdrop = 'bg-black/50',
  closeOnBackdrop = true,
  closeOnEsc = true,
  labelledBy,
}: Props) {
  const [mounted, setMounted] = useState(false);
  // 只有「按下点就在遮罩上、抬起也在遮罩上」才算关闭，
  // 避免在弹窗内选中文字拖到遮罩上松开时被误关。
  const downOnOverlay = useRef(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!closeOnEsc) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, closeOnEsc]);

  useEffect(() => {
    // 锁背景滚动（记下原值：hub 布局的 body overflow:hidden 来自样式表，
    // 此处 inline 原值为空串，还原后样式表规则继续生效）
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  if (!mounted) return null;

  const alignCls =
    align === 'top' ? 'items-start justify-center p-4' : 'items-center justify-center px-4';

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      className={`fixed inset-0 z-[100] flex overflow-y-auto overscroll-contain ${backdrop} ${alignCls}`}
      onMouseDown={(e) => {
        downOnOverlay.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (closeOnBackdrop && downOnOverlay.current && e.target === e.currentTarget) onClose();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
