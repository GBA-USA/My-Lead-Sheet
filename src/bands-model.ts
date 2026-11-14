export type Role = "admin" | "member";
export type Member = { userId: string; name: string; role: Role };

/** One row of the Bands list. */
export type BandSummary = { bandId: string; name: string; role: Role; members: number };

/** A band as one of its members sees it, from `POST /api/bands/open` and every change an admin makes. */
export type BandView = { bandId: string; name: string; role: Role; members: Member[]; scrollWithLeader: boolean };

/** What a band code shows before Join: the band's name and the admin who made the code. */
export type BandPreview = { name: string; invitedBy: string; member: boolean };

/** The band's part of a gig pack: only what the whole band shares, never anyone's own songs or timing versions (PLAN.md 7.8). */
export type BandPack = { bandId: string; name: string; scrollWithLeader: boolean };
