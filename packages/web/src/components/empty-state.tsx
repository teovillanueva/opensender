import type { ComponentType, ReactNode } from "react";

/**
 * Resend-style empty state: a large bordered panel with a centered icon tile,
 * a heading, supporting copy, and optional call-to-action buttons.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-[420px] flex-col items-center justify-center rounded-xl border bg-card/30 px-6 py-12 text-center">
      <div className="mb-5 flex size-16 items-center justify-center rounded-2xl border bg-gradient-to-b from-white/[0.06] to-transparent shadow-sm">
        <Icon className="size-7 text-muted-foreground" />
      </div>
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {description && (
        <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">{description}</p>
      )}
      {children && (
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">{children}</div>
      )}
    </div>
  );
}
