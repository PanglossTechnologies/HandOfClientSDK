/**
 * Storage interface the host module talks to.
 *
 * Implement {@link Storage} / {@link StorageTx} to keep the data anywhere; `SqlStorage` (SQLite, PostgreSQL,
 * MySQL) is the ready-made one. All the rules (visibility, sharing, precedence) live in the host module, not
 * here: a storage is a dumb, transactional record keeper.
 */
export interface RequestRec {
  id: string;
  seq: number;
  userId: string;
  userName: string | null;
  userEmail: string | null;
  text: string;
  status: string;
  message: string | null;
  featureId: string | null;
  changeOf: string | null;
  mode: string;
  /** JSON text. */
  snapshot: string | null;
  buildId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FeatureRec {
  id: string;
  title: string;
  kind: string;
  path: string | null;
  slotId: string;
  mode: string;
  packageId: string;
  currentVersion: string;
  ownerUserId: string;
  requestId: string | null;
  createdAt: string;
}

export interface VersionRec {
  featureId: string;
  version: string;
  publishedAt: string;
  requestId: string | null;
  sha256: string;
  entry: string;
  seq: number;
}

/** `userId` null = everyone. */
export interface Assignment {
  userId: string | null;
  seq: number;
}

export interface UserState {
  pinnedVersion: string | null;
  disabled: boolean;
}

export type RequestUpdate = Partial<Pick<RequestRec, "status" | "message" | "featureId" | "buildId" | "updatedAt">>;
export type FeatureUpdate = Partial<Pick<FeatureRec, "currentVersion" | "slotId" | "mode">>;

/** One transaction. Obtained from {@link Storage.transaction}; committed when the callback resolves, rolled back when it throws. */
export interface StorageTx {
  /** A strictly increasing number (orders requests, versions and assignments). */
  nextSeq(): Promise<number>;
  /** Remember a webhook event id. False if it was already recorded. */
  recordEvent(eventId: string, receivedAt: string): Promise<boolean>;
  getSettings(): Promise<Record<string, any> | null>;
  saveSettings(settings: Record<string, any>): Promise<void>;

  insertRequest(r: RequestRec): Promise<void>;
  getRequest(requestId: string): Promise<RequestRec | null>;
  updateRequest(requestId: string, fields: RequestUpdate): Promise<void>;
  /** Newest first (by `seq`). `userId` null = everyone's. */
  listRequests(userId: string | null, statuses: readonly string[], limit: number, offset: number): Promise<{ rows: RequestRec[]; more: boolean }>;
  /** InProgress requests that never got a `buildId`. */
  listUnstartedBuilds(limit: number): Promise<RequestRec[]>;

  getFeature(featureId: string): Promise<FeatureRec | null>;
  insertFeature(f: FeatureRec): Promise<void>;
  updateFeature(featureId: string, fields: FeatureUpdate): Promise<void>;
  /** Features assigned to `userId` or to everyone, optionally only those whose path equals `path`. */
  listVisibleFeatures(userId: string, path?: string | null): Promise<FeatureRec[]>;
  getAssignments(featureIds: readonly string[]): Promise<Map<string, Assignment[]>>;
  getUserState(featureIds: readonly string[], userId: string): Promise<Map<string, UserState>>;
  /** Idempotent: an existing assignment is left untouched. */
  addAssignment(featureId: string, userId: string | null, seq: number): Promise<void>;
  removeAssignment(featureId: string, userId: string | null): Promise<void>;
  setPin(featureId: string, userId: string, version: string | null): Promise<void>;
  setDisabled(featureId: string, userId: string, disabled: boolean): Promise<void>;

  getVersion(featureId: string, version: string): Promise<VersionRec | null>;
  /** Newest first (by `seq`). */
  listVersions(featureId: string): Promise<VersionRec[]>;
  /** Insert, or replace the version with the same (feature, version). */
  upsertVersion(v: VersionRec): Promise<void>;
}

export interface Storage {
  /** Create / upgrade the schema. Idempotent and safe to call on every start. */
  migrate(): Promise<void>;
  /** A unit of work. `write` is true when it will change data. */
  transaction<T>(write: boolean, fn: (tx: StorageTx) => Promise<T>): Promise<T>;
}
