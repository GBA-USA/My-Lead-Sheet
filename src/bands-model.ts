export type Role = "admin" | "member";
export type Member = { userId: string; name: string; role: Role };

export type BandSummary = { bandId: string; name: string; role: Role; members: number };

export type BandView = { bandId: string; name: string; role: Role; members: Member[]; scrollWithLeader: boolean };

export type BandPreview = { name: string; invitedBy: string; member: boolean };

/** The band's part of a gig pack: only what the whole band shares, never anyone's own songs or timing versions (PLAN.md 7.8). */
export type BandPack = { bandId: string; name: string; scrollWithLeader: boolean };
