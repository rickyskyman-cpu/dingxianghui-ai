export type Row = Record<string, any>;

export interface Db {
  purgeExpiredSessions(): Promise<void>;
  insertSession(tokenHash: string, userId: number, days: number): Promise<void>;
  userBySession(tokenHash: string): Promise<Row | null>;
  deleteSession(tokenHash: string): Promise<void>;
  overview(): Promise<{ alumni: number; demands: number; queries_today: number; successes: number; sponsors: number }>;
  bumpQuery(): Promise<void>;
  usersBrief(): Promise<Row[]>;
  demandsRecent(limit: number): Promise<Row[]>;
  approvedAlumni(): Promise<Row[]>;
  markSuccess(matchId: number, ok: boolean, at: string | null, demoOnly: boolean): Promise<boolean>;
  setSponsor(userId: number, on: boolean, demoOnly: boolean): Promise<string | null>;
  demoSnapshot(phone: string): Promise<Row | null>;
  applyDemoSnapshot(snapshot: Row): Promise<void>;
  demoUserByPhone(phone: string): Promise<Row | null>;
  findUserIdByPhone(phone: string): Promise<number | null>;
  insertUser(row: Row): Promise<Row>;
  userByPhone(phone: string): Promise<Row | null>;
  demandsByUser(userId: number): Promise<Row[]>;
  matchesByRequester(userId: number): Promise<Row[]>;
  updateProfile(userId: number, fields: Row): Promise<Row>;
  recentDemandCount(userId: number, sinceMs: number): Promise<number>;
  approvedUsers(): Promise<Row[]>;
  allDemands(): Promise<Row[]>;
  nextDemandId(): Promise<number>;
  insertDemand(row: Row): Promise<Row>;
  insertMatch(row: Row): Promise<Row>;
  demandById(id: number): Promise<Row | null>;
  updateIntent(demandId: number, targetId: number, userId: number, status: string, broker: number, pledge: string): Promise<boolean>;
  adminUsers(demoOnly: boolean): Promise<Row[]>;
  adminDemands(demoOnly: boolean, limit: number): Promise<Row[]>;
  adminMatches(demoOnly: boolean, limit: number): Promise<Row[]>;
  userById(id: number): Promise<Row | null>;
  setAudit(id: number, status: string, note: string): Promise<Row | null>;
}
