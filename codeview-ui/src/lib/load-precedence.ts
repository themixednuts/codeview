export function hasNonEmptyArray<T>(value: T[] | null | undefined): value is T[] {
	return Array.isArray(value) && value.length > 0;
}

export function preferNonEmptyArray<T>(
	primary: T[] | null | undefined,
	secondary: T[] | null | undefined,
): T[] | null {
	if (hasNonEmptyArray(primary)) return primary;
	if (hasNonEmptyArray(secondary)) return secondary;
	return primary ?? secondary ?? null;
}
