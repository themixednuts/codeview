import { clsx, type ClassValue } from 'clsx';
import type { Attachment } from 'svelte/attachments';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

export type WithoutChild<T> = T extends { child?: unknown } ? Omit<T, 'child'> : T;
export type WithoutChildren<T> = T extends { children?: unknown } ? Omit<T, 'children'> : T;
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
export type WithElementRef<T, U extends EventTarget = HTMLElement> = T & { ref?: U | null };

export function refAttachment<T extends EventTarget>(
	setRef: (node: T | null) => void,
): Attachment<T> {
	return (node) => {
		setRef(node);
		return () => setRef(null);
	};
}
