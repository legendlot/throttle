'use client';
import { SectionTitle } from './SectionTitle.js';

// Pit Control card: #13161e, 1px border, radius 18. `title` + `action` render the standard header row
// (Tomorrow title left, 12/600 text action right). `hero` = the 22px/24px padding of Pipeline-style
// cards; `hover` = the 2px lift + border-hover of stat cards. `as` lets a whole card be an <a>/<button>.
export function Card({
  title, action, onAction, actionHref, hero = false, hover = false, padding,
  as: Tag = 'section', className, style, children, ...rest
}) {
  return (
    <Tag
      className={[hover ? 'ig-card-hover' : '', className || ''].join(' ').trim() || undefined}
      style={{
        display: 'block', background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 'var(--r-card)', padding: padding || (hero ? '22px 24px' : '18px 20px'),
        color: 'var(--text-1)', minWidth: 0,
        ...style,
      }}
      {...rest}
    >
      {title != null && (
        <SectionTitle action={action} onAction={onAction} actionHref={actionHref}>{title}</SectionTitle>
      )}
      {children}
    </Tag>
  );
}

export default Card;
