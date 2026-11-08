/** Whether an untrusted value is one plain filename of at most 255 UTF-8 bytes. */
export function isSafeSkillPromoteName(name: unknown): name is string;
export const SKILL_PROMOTE_MAX_FILE_BYTES: number;
export const SKILL_PROMOTE_MAX_EXTRA_FILES: number;
