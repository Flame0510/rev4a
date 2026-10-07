/** Types for the CommonJS image-revision rule shared by bin/rev4a.js and lib/agent-versions.ts. */

export type RevisionStatus = 'missing' | 'current' | 'outdated';

export interface RevisionImage {
  id: string;
  tags: string[];
}

export function pinnedRevision(entry: { imageRevision?: unknown } | undefined, env?: Record<string, string | undefined>): string | null;
export function registryTag(version: string, pin: string | null): string;
export function revisionRef(repository: string, version: string, sha: string): string;
export function isRevisionTag(tag: string): boolean;
export function localImageRevision(repository: string, version: string, images: RevisionImage[], pin?: string | null): string | null;
export function identityRevision(imageId: string): string;
export function revisionStatus(repository: string, version: string, images: RevisionImage[], pin: string | null): RevisionStatus;
export function identityTagFor(repository: string, image: { id: string; tags: string[]; version: string | null }): string | null;
export function newBuildAvailable(repository: string, version: string, images: RevisionImage[], pin: string | null, containerImageId: string): boolean;
