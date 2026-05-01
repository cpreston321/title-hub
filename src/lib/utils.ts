import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Live input transformer for slug fields. Lowercases, swaps any run of
 * non-[a-z0-9-] characters for a single hyphen, and strips a leading hyphen
 * so users can keep typing without their cursor stalling. Trailing hyphens
 * are intentionally preserved during typing — strip them at submit time with
 * `.replace(/-+$/, '')`.
 */
export function toKebabCase(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
}
