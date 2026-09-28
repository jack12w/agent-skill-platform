'use client';

import { Fragment, type ReactNode } from 'react';

/**
 * RichText — 让**纯字符串文案**里能写超链接。
 *
 * 为什么需要它：`useTranslation` 的 `t()` 只认字符串（见 hooks/useTranslation.ts），
 * 而 locales 是按「一条 key = 一个字符串」组织的（plugins.page 那段注释写死了这点：
 * 数组会被渲染成 "a,b,c"）。但运营文案里经常要挂一个技能详情页链接
 * （如「RFQ 列表抓取…可衔接 [RFQ市场分析技能](url)」），
 * 于是引入一个**极小的标记语法**：`[显示文字](https://…)`。
 *
 * 安全红线（改动前必读）：
 *   ① 只放行 `https://skills.rehomi.com/skills/…` 这一条规则。其它任何 href
 *      —— 不管看起来多正常 —— 一律**当纯文本原样输出**，不渲染成 <a>。
 *      文案在 DB / locales 里会被多处复用，不能假设写它的人不会手滑。
 *   ② 因此**绝不能**用 `dangerouslySetInnerHTML`：标记语法会变成注入口子。
 *      这里只产出 React 节点数组，React 会自动转义文本节点。
 *   ③ 不匹配时输出的是 `m[0]`（带方括号原文），让写错的人一眼看见，而不是静默吞掉。
 *
 * 已知取舍：解析是同步的、非回溯的，不支持嵌套方括号。够用，别为它加复杂度。
 */

/** 放行规则：站内技能详情页。改这条等于放开了一个外链口子，要想清楚。 */
const HREF_ALLOWED = /^https:\/\/skills\.rehomi\.com\/skills\/[0-9a-zA-Z-]{1,64}$/;

const MARKER = /\[([^\]\n]{1,40})\]\((https?:\/\/[^\s)]{1,200})\)/g;

export interface RichSegment {
  text: string;
  href?: string;
}

/** 纯函数：字符串 → 片段数组。抽取出来是为了能脱离 React 单测。 */
export function parseRich(input: string): RichSegment[] {
  const out: RichSegment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  MARKER.lastIndex = 0; // 复用同一个正则实例时（模块级常量）必须归位，否则第二次调用会漏
  while ((m = MARKER.exec(input)) !== null) {
    if (m.index > last) out.push({ text: input.slice(last, m.index) });
    const [raw, label, href] = m;
    out.push(HREF_ALLOWED.test(href) ? { text: label, href } : { text: raw });
    last = m.index + raw.length;
  }
  if (last < input.length) out.push({ text: input.slice(last) });
  return out;
}

interface Props {
  text: string;
}

/** 链接的显示样式：品牌色 + 下划线。纯文字，不用图标。 */
const A_CLASS =
  'text-brand-600 underline underline-offset-2 decoration-brand-300 hover:text-brand-700 hover:decoration-brand-500 transition';

/**
 * 渲染成**片段平铺**（不额外包 span/p），这样调用方能直接把它塞进
 * 已有的 <li> / <p> 里，不改变外层布局。
 */
export default function RichText({ text }: Props): ReactNode {
  const segs = typeof text === 'string' ? parseRich(text) : [];
  return (
    <>
      {segs.map((s, i) =>
        s.href ? (
          <a key={i} href={s.href} target="_blank" rel="noopener noreferrer" className={A_CLASS}>
            {s.text}
          </a>
        ) : (
          <Fragment key={i}>{s.text}</Fragment>
        ),
      )}
    </>
  );
}
