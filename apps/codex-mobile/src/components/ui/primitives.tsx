import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes } from "react";

type ButtonVariant = "default" | "outline" | "ghost" | "danger";

export function Button({ variant = "default", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const variants: Record<ButtonVariant, string> = {
    default: "bg-accent text-[#17200f] hover:bg-[#d0f989] disabled:bg-[#35412b] disabled:text-[#7a8870]",
    outline: "border border-border bg-panel text-text hover:bg-elevated disabled:opacity-45",
    ghost: "text-muted hover:bg-elevated hover:text-text disabled:opacity-45",
    danger: "border border-[#733b39] bg-[#351f1e] text-[#ffc3bd] hover:bg-[#4b2724] disabled:opacity-45",
  };
  return <button className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${variants[variant]} ${className}`} {...props} />;
}

export function Card({ className = "", ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={`rounded-2xl border border-border bg-panel shadow-soft ${className}`} {...props} />;
}

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`min-h-11 w-full rounded-xl border border-border bg-[#111613] px-3 text-sm text-text outline-none placeholder:text-[#758077] focus:border-accent focus:ring-2 focus:ring-accent/20 ${className}`} {...props} />;
}

export function Textarea({ className = "", ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`min-h-24 w-full resize-y rounded-xl border border-border bg-[#111613] px-3 py-3 text-sm text-text outline-none placeholder:text-[#758077] focus:border-accent focus:ring-2 focus:ring-accent/20 ${className}`} {...props} />;
}

export function Badge({ className = "", ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={`inline-flex items-center rounded-full border border-border bg-elevated px-2.5 py-1 text-xs font-medium text-muted ${className}`} {...props} />;
}
