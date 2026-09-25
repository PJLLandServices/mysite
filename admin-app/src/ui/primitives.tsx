import { useEffect, useRef } from "react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

export function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

/* ── Button ─────────────────────────────────────────────────────────
   Three intents, one shape. Primary is the single committing action on
   a screen; secondary is everything else; ghost is for row-level and
   toolbar actions that shouldn't compete. 44px min height everywhere —
   this gets used in a truck with gloves on. */
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "md" | "sm";
};

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded-[var(--radius-control)] font-semibold " +
  "transition-colors disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap";

const BUTTON_VARIANTS: Record<NonNullable<ButtonProps["variant"]>, string> = {
  primary: "bg-accent-500 text-white hover:bg-accent-600 active:bg-accent-700",
  secondary: "bg-surface text-brand-700 border border-line-strong hover:border-brand-600 hover:text-brand-800",
  ghost: "bg-transparent text-ink-muted hover:bg-brand-50 hover:text-brand-700",
  danger: "bg-surface text-danger-500 border border-danger-500/40 hover:bg-danger-50 hover:border-danger-500"
};

export function Button({ variant = "secondary", size = "md", className, ...rest }: ButtonProps) {
  const sizing = size === "sm" ? "min-h-9 px-3 text-[13px]" : "min-h-11 px-4 text-sm";
  return <button className={cx(BUTTON_BASE, BUTTON_VARIANTS[variant], sizing, className)} {...rest} />;
}

/* ── Card ───────────────────────────────────────────────────────── */
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <section
      className={cx("bg-surface border border-line rounded-[var(--radius-card)] shadow-[0_1px_2px_rgba(15,31,20,0.04)]", className)}
    >
      {children}
    </section>
  );
}

export function CardHeader({ title, meta, actions }: { title: string; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-line">
      <div className="min-w-0">
        <h2 className="text-[17px] font-bold uppercase tracking-[0.06em] text-brand-700">{title}</h2>
        {meta ? <p className="text-[13px] text-ink-muted mt-0.5">{meta}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2 shrink-0">{actions}</div> : null}
    </header>
  );
}

/* ── Status pill ────────────────────────────────────────────────────
   One vocabulary for every state in the product, so "active" looks the
   same on a project, a work order and an invoice. */
export type Tone = "neutral" | "progress" | "good" | "warn" | "danger";

const TONES: Record<Tone, string> = {
  neutral: "bg-canvas text-ink-muted border-line-strong",
  progress: "bg-info-50 text-info-600 border-info-600/25",
  good: "bg-brand-100 text-brand-700 border-brand-600/25",
  warn: "bg-warn-50 text-warn-600 border-warn-600/25",
  danger: "bg-danger-50 text-danger-700 border-danger-500/30"
};

export function StatusPill({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full border px-2.5 py-0.5",
        "font-display text-[12px] font-semibold uppercase tracking-[0.06em]",
        TONES[tone]
      )}
    >
      {children}
    </span>
  );
}

/* ── Inputs ─────────────────────────────────────────────────────── */
const FIELD_BASE =
  "w-full min-h-11 rounded-[var(--radius-control)] border border-line-strong bg-surface px-3 " +
  "text-[15px] text-ink placeholder:text-ink-muted/70 focus:border-brand-600 focus:outline-none " +
  "focus:ring-2 focus:ring-brand-600/20 disabled:bg-canvas disabled:text-ink-muted";

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(FIELD_BASE, className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(FIELD_BASE, "pr-8", className)} {...rest}>
      {children}
    </select>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="block font-display text-[12px] font-semibold uppercase tracking-[0.07em] text-ink-muted mb-1">
        {label}
      </span>
      {children}
      {hint ? <span className="block text-[12px] text-ink-muted mt-1">{hint}</span> : null}
    </label>
  );
}

/* ── Stat ───────────────────────────────────────────────────────────
   A figure that answers a question at a glance. Used in overview
   headers so the numbers are readable without opening anything.

   Given an `onClick`, a stat becomes the way INTO the section it
   summarises — the number you're looking at is the thing you want to
   open, so it shouldn't make you go hunting for a tab afterwards. */
export function Stat({
  label,
  value,
  tone,
  progress,
  onClick,
  hint
}: {
  label: string;
  value: ReactNode;
  tone?: "default" | "money" | "muted";
  /** 0–1. Renders a progress bar under the figure. */
  progress?: number;
  onClick?: () => void;
  hint?: string;
}) {
  const body = (
    <>
      <span className="block font-display text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
        {label}
      </span>
      <span
        className={cx(
          "block font-display text-[22px] font-bold leading-tight truncate",
          tone === "money" ? "text-brand-700" : tone === "muted" ? "text-ink-muted" : "text-ink"
        )}
      >
        {value}
      </span>
      {typeof progress === "number" ? (
        <span className="mt-1.5 block h-1.5 rounded-full bg-canvas overflow-hidden">
          <span
            className={cx("block h-full rounded-full", progress >= 1 ? "bg-brand-500" : "bg-accent-500")}
            style={{ width: `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%` }}
          />
        </span>
      ) : null}
      {hint ? <span className="mt-0.5 block text-[12px] text-ink-muted truncate">{hint}</span> : null}
    </>
  );

  if (!onClick) return <div className="min-w-0">{body}</div>;

  return (
    <button
      type="button"
      onClick={onClick}
      className="min-w-0 text-left rounded-[var(--radius-control)] -m-1.5 p-1.5 transition-colors hover:bg-brand-50 focus-visible:bg-brand-50"
    >
      {body}
    </button>
  );
}

/* ── Confirm dialog ─────────────────────────────────────────────────
   The CRM spent a whole PR replacing every native alert/confirm/prompt
   with pjlDialog; this app must not quietly reintroduce them. It cannot
   use pjlDialog itself — that lives with the CRM's own stylesheet — so
   this is the same idea in the app's own vocabulary.

   The behaviours are the ones the Help Centre had to learn the hard way
   on 2026-09-23: Escape closes it, focus moves INTO it and returns to
   whatever opened it, the backdrop is clickable to cancel, and the
   whole thing sits above everything else on the page. */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive,
  onConfirm,
  onCancel
}: {
  open: boolean;
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    // Remember who opened it, so closing puts the keyboard back where it
    // was rather than at the top of the document.
    openerRef.current = document.activeElement;
    const panel = panelRef.current;
    // The confirming action takes focus, but Escape and Cancel are always
    // one key away — a destructive default that is also the focused
    // button is how people confirm things they meant to read first.
    const first = panel?.querySelector<HTMLElement>("[data-autofocus]") || panel;
    first?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onCancel(); return; }
      if (e.key !== "Tab" || !panel) return;
      const focusables = panel.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
      if (!focusables.length) return;
      const firstEl = focusables[0];
      const lastEl = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      const opener = openerRef.current as HTMLElement | null;
      // Only if it is still on the page and still focusable — a row that
      // was just deleted is neither.
      if (opener && document.contains(opener) && typeof opener.focus === "function") opener.focus();
    };
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-brand-950/50"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="w-full max-w-[460px] rounded-[var(--radius-card)] bg-surface shadow-xl outline-none"
      >
        <div className="px-5 pt-5">
          <h2 className="font-display text-[19px] font-bold leading-tight text-ink">{title}</h2>
          {body ? <div className="mt-2 text-[15px] leading-relaxed text-ink-muted">{body}</div> : null}
        </div>
        <div className="flex flex-wrap justify-end gap-2 px-5 py-4">
          <Button onClick={onCancel} data-autofocus>
            {cancelLabel}
          </Button>
          <Button variant={destructive ? "danger" : "primary"} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ── Empty / loading / error states ─────────────────────────────── */
export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="text-center px-6 py-12">
      <p className="font-display text-[17px] font-semibold text-ink">{title}</p>
      {body ? <p className="text-sm text-ink-muted mt-1 max-w-prose mx-auto">{body}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function LoadingRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="p-4 space-y-3" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-14 rounded-[var(--radius-control)] bg-canvas animate-pulse" />
      ))}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="m-4 rounded-[var(--radius-control)] border border-danger-500/30 bg-danger-50 px-4 py-3 text-sm text-danger-700">
      {children}
    </p>
  );
}
