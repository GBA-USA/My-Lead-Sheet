import { useEffect, useId, useState, type ReactNode } from "react";
import {
  SETLIST_SORTS,
  SONG_SORTS,
  parseTags,
  setlistTags,
  visibleSetlists,
  visibleSongs,
  type BandLibrary,
  type BandSetlist,
  type BandSong,
  type CopiedSong,
  type SetlistSort,
  type SongContent,
  type SongSort,
} from "./band-library-model";
import type { BandView } from "./bands-model";
import { matchingSongs } from "./search";
import type { ShareChoice } from "./share-rule";
import { api } from "./sign-in-methods";
import { addOwnSong, loadLibrary, songByRef } from "./storage";
import type { Setlist, Song } from "./types";
import "./band-library.css";

export type LibraryTab = "setlists" | "songs";

type Props = { band: BandView; me: string; tab: LibraryTab; busy: boolean; run: (work: () => Promise<void>) => void; notify: (text: string) => void };

type Picked = { kind: "song"; song: Song } | { kind: "setlist"; setlist: Setlist };
type Mode = { name: "list" } | { name: "pick" } | { name: "ask"; picked: Picked } | { name: "edit"; setlist: BandSetlist };

const CHOICES: Record<ShareChoice, { label: string; line: string }> = {
  private: { label: "Private", line: "They can use it, but can't pass it on." },
  public: { label: "Public", line: "They can pass it on." },
};

const content = ({ ref: _ref, id: _id, copy: _copy, ...song }: Song): SongContent => song;
const titleOf = (song: BandSong | undefined) => song?.song.title ?? "A song no longer in the band";
const lockFor = (item: { sharedAs: ShareChoice }) =>
  item.sharedAs === "private" ? (
    <span role="img" aria-label="Private" className="band-library-lock">
      🔒
    </span>
  ) : null;

function LabeledInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <>
      <label className="account-field" htmlFor={id}>
        {label}
      </label>
      <input id={id} className="account-input" autoComplete="off" value={value} onChange={(event) => onChange(event.target.value)} />
    </>
  );
}

function SortPicker<T extends string>({ label, className, sorts, value, onChange }: { label: string; className: string; sorts: Record<T, string>; value: T; onChange: (value: T) => void }) {
  return (
    <select className={`account-input ${className}`} aria-label={label} value={value} onChange={(event) => onChange(event.target.value as T)}>
      {(Object.keys(sorts) as T[]).map((key) => (
        <option key={key} value={key}>
          {sorts[key]}
        </option>
      ))}
    </select>
  );
}

function ShareQuestion({ what, band, busy, onShare, onCancel }: { what: string; band: string; busy: boolean; onShare: (choice: ShareChoice) => void; onCancel: () => void }) {
  const [choice, setChoice] = useState<ShareChoice | null>(null);
  return (
    <div className="band-library-share">
      <p className="codes-words">
        Share {what} <small>with {band}</small>
      </p>
      <div className="band-library-choices">
        {(Object.keys(CHOICES) as ShareChoice[]).map((key) => (
          <div key={key}>
            <button type="button" className="band-library-choice" aria-pressed={choice === key} onClick={() => setChoice(key)}>
              {CHOICES[key].label}
            </button>
            <small>{CHOICES[key].line}</small>
          </div>
        ))}
      </div>
      <p className="account-note">The band gets a copy. Your later changes won't change it.</p>
      <div className="account-row">
        <button type="button" className="account-primary" disabled={busy || choice === null} onClick={() => choice && onShare(choice)}>
          Share
        </button>
        <button type="button" className="account-link" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function SetlistEditor({
  setlist,
  songs,
  busy,
  onSave,
  onCancel,
}: {
  setlist: BandSetlist;
  songs: BandSong[];
  busy: boolean;
  onSave: (fields: Pick<BandSetlist, "name" | "songIds" | "tags">) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(setlist.name);
  const [tags, setTags] = useState(setlist.tags.join(", "));
  const [songIds, setSongIds] = useState(setlist.songIds);
  const byId = new Map(songs.map((item) => [item.songId, item]));
  const move = (from: number, to: number) => {
    const next = [...songIds];
    next.splice(to, 0, ...next.splice(from, 1));
    setSongIds(next);
  };
  const addable = songs.filter((item) => !songIds.includes(item.songId));
  return (
    <form
      className="account-form band-library-edit"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ name: name.trim(), songIds, tags: parseTags(tags) });
      }}
    >
      <LabeledInput label="Setlist name" value={name} onChange={setName} />
      <LabeledInput label="Tags, with commas" value={tags} onChange={setTags} />
      <ol className="friends-list">
        {songIds.map((id, index) => (
          <li key={id}>
            <span>{titleOf(byId.get(id))}</span>
            <span className="friends-actions">
              <button type="button" className="account-link" disabled={index === 0} onClick={() => move(index, index - 1)}>
                Move up
              </button>
              <button type="button" className="account-link" disabled={index === songIds.length - 1} onClick={() => move(index, index + 1)}>
                Move down
              </button>
              <button type="button" className="account-link" onClick={() => setSongIds(songIds.filter((other) => other !== id))}>
                Remove
              </button>
            </span>
          </li>
        ))}
      </ol>
      {addable.length > 0 ? (
        <select className="account-input" aria-label="Add a band song" value="" onChange={(event) => setSongIds([...songIds, event.target.value])}>
          <option value="">Add a band song…</option>
          {addable.map((item) => (
            <option key={item.songId} value={item.songId}>
              {item.song.title}
            </option>
          ))}
        </select>
      ) : null}
      <div className="account-row">
        <button type="submit" className="account-primary" disabled={busy || !name.trim()}>
          Save
        </button>
        <button type="button" className="account-link" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function BandLibraryTab({ band, me, tab, busy, run, notify }: Props) {
  const [library, setLibrary] = useState<BandLibrary | null>(null);
  const [mode, setMode] = useState<Mode>({ name: "list" });
  const [query, setQuery] = useState("");
  const [songSort, setSongSort] = useState<SongSort>("title");
  const [setlistSort, setSetlistSort] = useState<SetlistSort>("newest");
  const [mine, setMine] = useState(false);
  const [tag, setTag] = useState<string | null>(null);
  const [myLibrary, setMyLibrary] = useState(() => loadLibrary());

  const reload = () => api<BandLibrary>("/api/bands/library", { bandId: band.bandId }).then(setLibrary);

  useEffect(() => {
    setMode({ name: "list" });
    setQuery("");
    run(reload);
  }, [band.bandId, tab]);

  const back = () => {
    setQuery("");
    setMode({ name: "list" });
  };

  /** Each work step reloads the band library after, so a refused or stale edit still shows what the band has now. */
  const act = (work: () => Promise<void>) =>
    run(async () => {
      try {
        await work();
      } finally {
        back();
        await reload();
      }
    });

  const shareSong = async (song: Song, choice: ShareChoice) =>
    api<BandSong>("/api/bands/library/share-song", { bandId: band.bandId, song: content(song), choice, localId: song.id, copyId: song.copy?.id });

  const share = (picked: Picked, choice: ShareChoice) =>
    act(async () => {
      if (picked.kind === "song") {
        await shareSong(picked.song, choice);
        return notify(`Shared ${picked.song.title} as ${CHOICES[choice].label}.`);
      }
      const inBand = new Map(library?.songs.filter((item) => item.sharedBy === me && item.localId !== null).map((item) => [item.localId, item.songId]));
      const songIds: string[] = [];
      for (const ref of picked.setlist.songRefs) {
        const song = songByRef(myLibrary.songs, ref);
        if (!song) continue;
        if (!inBand.has(song.id)) inBand.set(song.id, (await shareSong(song, choice)).songId);
        songIds.push(inBand.get(song.id)!);
      }
      await api<BandSetlist>("/api/bands/library/share-setlist", { bandId: band.bandId, name: picked.setlist.name, songIds, tags: [], choice, localId: picked.setlist.id });
      notify(`Shared ${picked.setlist.name} as ${CHOICES[choice].label}.`);
    });

  const addToMySongs = (item: BandSong) =>
    act(async () => {
      const copied = await api<CopiedSong>("/api/bands/library/copy-song", { bandId: band.bandId, songId: item.songId });
      notify(addOwnSong({ ...copied.song, copy: copied.copy }) === null ? `This phone couldn't add ${item.song.title}.` : `Added ${item.song.title} to My Songs.`);
    });

  const saveSetlist = (setlist: BandSetlist, fields: Pick<BandSetlist, "name" | "songIds" | "tags">) =>
    act(async () => {
      await api<BandSetlist>("/api/bands/library/edit-setlist", { bandId: band.bandId, setlistId: setlist.setlistId, base: setlist.rev, ...fields });
      notify(`Saved ${fields.name}.`);
    });

  if (!library) return <p className="account-note">Loading…</p>;

  if (mode.name === "ask") {
    const what = mode.picked.kind === "song" ? mode.picked.song.title : mode.picked.setlist.name;
    return <ShareQuestion what={what} band={band.name} busy={busy} onShare={(choice) => share(mode.picked, choice)} onCancel={back} />;
  }

  if (mode.name === "edit") {
    return <SetlistEditor setlist={mode.setlist} songs={library.songs} busy={busy} onSave={(fields) => saveSetlist(mode.setlist, fields)} onCancel={back} />;
  }

  if (mode.name === "pick") {
    const pickRow = (key: string, label: ReactNode, blocked: boolean, picked: Picked) => (
      <li key={key}>
        <button type="button" className="band-library-pick-row" disabled={blocked} onClick={() => setMode({ name: "ask", picked })}>
          {label}
        </button>
      </li>
    );
    const unsendable = (song: Song | undefined) => song?.copy?.canSendOn === false;
    return (
      <div className="account-form band-library-pick">
        {tab === "songs" ? <LabeledInput label="Find a song" value={query} onChange={setQuery} /> : null}
        <ul className="friends-list">
          {tab === "songs"
            ? matchingSongs(myLibrary.songs, query).map((song) =>
                pickRow(
                  song.ref,
                  <>
                    {song.title}
                    <small>{unsendable(song) ? "Shared with you privately" : song.artist}</small>
                  </>,
                  unsendable(song),
                  { kind: "song", song },
                ),
              )
            : myLibrary.setlists.map((setlist) => {
                const blocked = setlist.songRefs.some((ref) => unsendable(songByRef(myLibrary.songs, ref)));
                return pickRow(
                  String(setlist.id),
                  <>
                    {setlist.name}
                    <small>{blocked ? "Has a song shared with you privately" : `${setlist.songRefs.length} songs`}</small>
                  </>,
                  blocked,
                  { kind: "setlist", setlist },
                );
              })}
        </ul>
        <button type="button" className="account-link" onClick={back}>
          Cancel
        </button>
      </div>
    );
  }

  const openPicker = () => {
    setMyLibrary(loadLibrary());
    setQuery("");
    setMode({ name: "pick" });
  };
  const byline = (item: BandSong | BandSetlist, extra = "") => (
    <small>
      {extra}Shared by {item.sharedByName}
      {item.sharedAs === "private" ? " · Private" : ""}
    </small>
  );

  if (tab === "songs") {
    const shown = visibleSongs(band.bandId, library.songs, query, songSort);
    return (
      <>
        <button type="button" className="account-primary" onClick={openPicker}>
          + Share a song
        </button>
        {library.songs.length === 0 ? (
          <p className="account-note band-library-songs-empty">No songs yet. Share one from My Songs.</p>
        ) : (
          <>
            <div className="band-library-tools">
              <LabeledInput label="Search band songs" value={query} onChange={setQuery} />
              <SortPicker label="Sort songs" className="band-library-sort" sorts={SONG_SORTS} value={songSort} onChange={setSongSort} />
            </div>
            <ul className="friends-list band-library-songs">
              {shown.map((item) => (
                <li key={item.songId}>
                  <span>
                    <span className="band-library-name">{item.song.title}</span>
                    {byline(item, `${item.song.artist} · `)}
                  </span>
                  <span className="friends-actions">
                    {lockFor(item)}
                    <button type="button" className="account-secondary" disabled={busy} onClick={() => addToMySongs(item)}>
                      Add to My Songs
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            {shown.length === 0 ? <p className="account-note">No band songs match.</p> : null}
          </>
        )}
      </>
    );
  }

  const tags = setlistTags(library.setlists);
  const shown = visibleSetlists(library.setlists, { mine, tag }, me, setlistSort);
  const songsById = new Map(library.songs.map((item) => [item.songId, item]));
  return (
    <>
      <button type="button" className="account-primary" onClick={openPicker}>
        + Share a setlist
      </button>
      {library.setlists.length === 0 ? (
        <p className="account-note">No setlists yet. Share one from your Setlists.</p>
      ) : (
        <>
          <div className="band-library-tools">
            <div className="band-library-chips">
              {[["Mine", mine, () => setMine(!mine)] as const, ...tags.map((name) => [name, tag === name, () => setTag(tag === name ? null : name)] as const)].map(([label, on, toggle]) => (
                <button key={label} type="button" className="band-library-chip" aria-pressed={on} onClick={toggle}>
                  {label}
                </button>
              ))}
            </div>
            <SortPicker label="Sort setlists" className="band-library-setlist-sort" sorts={SETLIST_SORTS} value={setlistSort} onChange={setSetlistSort} />
          </div>
          <ul className="friends-list band-library-setlists">
            {shown.map((item) => (
              <li key={item.setlistId}>
                <span>
                  <span className="band-library-name">{item.name}</span>
                  {byline(item, `${item.songIds.length} songs · `)}
                  <small>{item.songIds.map((id) => titleOf(songsById.get(id))).join(", ")}</small>
                </span>
                <span className="friends-actions">
                  {lockFor(item)}
                  {band.role === "admin" || item.sharedBy === me ? (
                    <button type="button" className="account-secondary" disabled={busy} onClick={() => setMode({ name: "edit", setlist: item })}>
                      Edit
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
          {shown.length === 0 ? <p className="account-note">No setlists match.</p> : null}
        </>
      )}
    </>
  );
}

export const LIBRARY_MESSAGES: Record<string, string> = {
  changed: "Someone in the band changed it first. This is the latest; make your change again.",
  private_copy: "This was shared with you privately.",
  private_ancestor: "This was shared with you privately.",
  choice_required: "Pick Private or Public first.",
  "not-yours": "Only the person who shared it, or an admin, can change it.",
  "not-a-band-song": "A band setlist can only hold band songs.",
};
