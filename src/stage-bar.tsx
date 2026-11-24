import { useCallback, useEffect, useReducer, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { bandSong, type BandPlay } from "./band-setlist-view";
import type { GigPack } from "./gig-pack";
import type { GigPosition } from "./gig-position";
import { position, type GigState, type Refusal, type SongKey, type UserId } from "./gig-state";
import { mayTakeOver, type LeaderHeard, type LiveGig, type OpBody } from "./gig-live.js";
import { useEscape } from "./hooks";
import { bandLiveHref, type Route } from "./route";
import { songByRef } from "./storage";
import type { Library, Song } from "./types";
import "./stage.css";

/** The set a stage route runs: how many songs, which one is up and its song, and how to move. `caption` is the bar's own words on `#/live`. A gig's set also names its songs, for the leader's Next and Edit order. */
export type StageSet = { count: number; index: number; song: Song | undefined; go: (index: number) => void; caption: string | null; titles?: Record<SongKey, string> };

/**
 * The set behind each stage route, or null when the route has none to run: a setlist not in the library, a band setlist
 * this phone has not opened, or a gig with no pack on this phone. An empty setlist is a set with no songs. The gig view
 * itself has no song up; the gig-mode sheet has the one at the position.
 */
export function stageSetOf(route: Route, library: Library, play: BandPlay, pack: GigPack | null | undefined, position: GigPosition): StageSet | null {
  if (route.name === "live") {
    const setlist = library.setlists.find((set) => set.id === route.setlistId);
    if (!setlist) return null;
    const count = setlist.songRefs.length;
    const index = Math.min(Math.max(route.index, 0), Math.max(count - 1, 0));
    const song = count > 0 ? songByRef(library.songs, setlist.songRefs[index]) : undefined;
    return { count, index, song, go: (next) => (window.location.hash = `#/live/${route.setlistId}/${next}`), caption: `${setlist.name} · ${index + 1}/${count}` };
  }
  if (route.name === "band-live") {
    if (!play.setlist) return null;
    const count = play.setlist.songIds.length;
    return { count, index: play.index, song: play.song, go: (next) => (window.location.hash = bandLiveHref(route.bandId, route.setlistId, next)), caption: `${play.setlist.name} · ${play.index + 1}/${count}` };
  }
  if (route.name === "gig" && pack) {
    const item = route.index === null ? undefined : pack.songs[position.index];
    const titles = Object.fromEntries(pack.songs.map((each) => [each.songId, each.song.title]));
    return { count: pack.songs.length, index: position.index, song: item && bandSong(route.bandId, item.songId, item.song), go: position.goTo, caption: null, titles };
  }
  return null;
}

/**
 * The stage bar at the bottom of the screen: Prev and Next at the stage touch size, with the Scroll pill between them on
 * a sheet. Prev and Next are for whoever may move the set; a member's bar keeps only Scroll.
 */
export function StageBar({ set, canMove, scroll }: { set: StageSet; canMove: boolean; scroll?: { on: boolean; toggle: () => void } }) {
  return (
    <nav className="live-nav" aria-label="Set">
      {canMove ? (
        <button type="button" className="stage-step" aria-label="Previous song" disabled={set.index <= 0} onClick={() => set.go(set.index - 1)}>
          Prev
        </button>
      ) : (
        <span />
      )}
      <div className="stage-middle">
        {scroll ? (
          <button type="button" className={scroll.on ? "scroll-pill is-on" : "scroll-pill"} aria-pressed={scroll.on} onClick={scroll.toggle}>
            Scroll: {scroll.on ? "On" : "Off"}
          </button>
        ) : null}
        {set.caption ? <span className="live-count">{set.caption}</span> : null}
      </div>
      {canMove ? (
        <button type="button" className="stage-step" aria-label="Next song" disabled={set.index >= set.count - 1} onClick={() => set.go(set.index + 1)}>
          Next
        </button>
      ) : (
        <span />
      )}
    </nav>
  );
}

// ---------------------------------------------------------------- the gig's stage (PLAN.md 8.2 steps 11-16, 8.3)

/** A change that moves the band needs a half-second hold (PLAN.md 8.3 rule 1). The ring's CSS animation runs this long too. */
const HOLD_MS = 500;
/** Undo is offered this long after a band move, and only until the move lands, since a landed move can't be undone. */
const UNDO_MS = 5_000;
const NOTE_MS = 2_500;
/** check:scroll counts a gap over 50 ms as a stall: a hiccup, not the phone's frame rate, so it never counts here. */
const STALL_MS = 50;
const SLOW_FRAME_MS = 20;
const FRAMES_KEPT = 30;
const FRAMES_NEEDED = 20;

const HOLD_HINT = "Hold to move the band";
const UNLOCK_HINT = "Hold to unlock";
const NOT_REACHING = "Your phone isn't reaching anyone";
const LOW_POWER = "Turn off Low Power Mode for tight timing";

/** What the leader reads when the gig refuses a change. */
const MESSAGES: Record<Refusal, string> = {
  ended: "The gig has ended",
  repeat: "Already sent",
  "stale-epoch": "You're not leading now",
  "not-allowed": "You're not leading now",
  "same-target": "Already there",
  "unknown-song": "That song isn't in tonight's set",
  "changes-songs": "That order adds or drops a song",
  "not-running": "The click isn't running",
  "song-pending": "The next song is on its way",
  "scroll-off": "Scroll with the leader is off",
  "too-late": "Too late to undo",
  "not-on-lineup": "They're not on tonight's lineup",
  "offer-expired": "That offer ran out",
};

export type StageMenu = { handOff: boolean; changeBackup: boolean; takeLead: boolean };

/** The ••• items PLAN.md 6 gives each role: the leader hands off; the leader and the admin pick the backup; the admin, or the backup once the leader dropped, takes the lead. */
export function stageMenu(state: GigState, me: UserId, heard: LeaderHeard): StageMenu {
  const leads = state.leader === me;
  return { handOff: leads, changeBackup: leads || me === state.admin, takeLead: mayTakeOver(state, me, heard) };
}

const latest = <T,>(steps: { value: T }[]): T => steps[steps.length - 1].value;
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
/** "VERSE 1 (bass walk: Am - D)" and "CHORUS — repeat" are "VERSE 1" and "CHORUS" on a chip. */
const chipLabel = (heading: string) => heading.split(/\s+[(—–]/)[0].trim() || heading;

/** Where a pending move lands, as its chip says: the beat of the grid the band would be on then, or "Now" with no click. */
function landingWords(state: GigState): string {
  const last = state.last!;
  const beat = position({ ...state, ...last.before }, last.at).beat;
  return beat ? `On ${beat.beat + 1} ▸` : "Now";
}

/** Puts section `index` of the chart on screen at the top of the sheet. False while that chart isn't drawn yet. */
function turnTo(index: number): boolean {
  const sheet = document.getElementById("sheet-scroll");
  const chart = document.getElementById("chord-section");
  if (!sheet || !chart) return false;
  const section = chart.querySelectorAll<HTMLElement>(".chart-section")[index];
  if (section) sheet.scrollTop += section.getBoundingClientRect().top - sheet.getBoundingClientRect().top;
  return true;
}

type HoldState = { startedAt: number | null; armed: boolean };
type Held = HoldState & { fire: () => void };
type Note = { words: string; until: number };
type Panel = "menu" | "hand-off" | "backup" | "order" | null;

/** The controls a phone in a live gig holds: the leader's whole stage, or for anyone else the Scroll bar with the ••• its role allows. */
export type GigStage = { session: LiveGig; me: UserId; names: Record<UserId, string> };

type BarProps = { set: StageSet; canMove: boolean; scroll?: { on: boolean; toggle: () => void }; bpm: number | null; song: Song | null };

/**
 * The bar App mounts on a stage route. Outside a live gig it is `StageBar`, unchanged. In one, the phone that leads gets
 * the stage: hold Prev and Next, Count in, Stop, − and +, section chips, Edit order, Stage lock and •••, with a chip that
 * names where each change lands and Undo until it does. Every change goes to the gig as an op; what the bar shows is read
 * back from the gig state, so the bar never works out a bar line of its own.
 */
export function GigStageBar({ gig, ...bar }: BarProps & { gig: GigStage | null }) {
  const state = gig?.session.view().state;
  if (!gig || !state) return <StageBar set={bar.set} canMove={bar.canMove} scroll={bar.scroll} />;
  return <InGig key={`${gig.me}/${state.gigId}`} gig={gig} {...bar} />;
}

function InGig({ gig, set, canMove, scroll, bpm, song }: BarProps & { gig: GigStage }) {
  const { session, me, names } = gig;
  const view = session.view();
  const state = view.state!;
  const leading = view.leading && state.leader === me && state.status === "live";
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [lowPower, setLowPower] = useState(false);
  const [holding, setHolding] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [draft, setDraft] = useState<SongKey[] | null>(null);
  const holds = useRef(new Map<string, Held>());
  const note = useRef<Note | null>(null);
  const moved = useRef<{ opId: string; until: number } | null>(null);
  const landing = useRef<{ opId: string; ms: number } | null>(null);

  const say = (words: string) => {
    note.current = { words, until: performance.now() + NOTE_MS };
    redraw();
  };
  const close = useCallback(() => {
    setPanel(null);
    setDraft(null);
  }, []);
  useEscape(close);

  // One frame loop for the stage: it fires a hold that has lasted, measures the frame rate, turns the chart when the band's
  // section lands, and redraws only when the chip, Undo or a note comes or goes.
  useEffect(() => {
    let raf = 0;
    let last = -1;
    let shown = "";
    let turned = "";
    const gaps: number[] = [];
    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      if (last >= 0 && t - last <= STALL_MS) {
        gaps.push(t - last);
        if (gaps.length > FRAMES_KEPT) gaps.shift();
      }
      last = t;
      setLowPower(gaps.length >= FRAMES_NEEDED && median(gaps) > SLOW_FRAME_MS);
      for (const held of holds.current.values()) {
        if (!held.armed || held.startedAt === null || t - held.startedAt < HOLD_MS) continue;
        held.armed = false;
        held.fire();
      }
      const s = session.view().state;
      const band = session.bandNow();
      if (!s || band === null) return;
      const where = position(s, band);
      const at = `${where.song.key}|${where.section}`;
      if (at !== turned && (where.section === null || where.scroll !== null || turnTo(where.section))) turned = at;
      const now = performance.now();
      if (note.current && now >= note.current.until) note.current = null;
      const pending = s.last && band < s.last.at ? s.last.opId : "";
      const undo = pending && moved.current?.opId === pending && now < moved.current.until ? "undo" : "";
      const key = `${pending}|${undo}|${note.current?.words ?? ""}`;
      if (key !== shown) {
        shown = key;
        redraw();
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [session]);

  /** Sends one change to the gig and reads the answer back: a refusal becomes the leader's note, and a new band move opens its Undo. */
  function send(body: OpBody): boolean {
    const before = session.view().state?.last?.opId;
    const out = session.tap(body);
    if (!out.ok) {
      // Done on an order left as it was closes the list with nothing to say.
      if (body.kind === "reorder" && out.refused === "same-target") return true;
      say(MESSAGES[out.refused]);
      return false;
    }
    const last = out.state.last;
    if (last && last.opId !== before) moved.current = { opId: last.opId, until: performance.now() + UNDO_MS };
    return true;
  }

  /** A control that acts only after a half-second hold. Its `HoldState` lives in `holds`, which the frame loop reads; a release before then is a tap, and taps say how to move the band. */
  function hold(id: string, fire: () => void, extra: { hint?: string; disabled?: boolean; label?: string; className?: string; attrs?: Record<string, string> } = {}) {
    const end = (released: boolean) => {
      const held = holds.current.get(id);
      holds.current.delete(id);
      setHolding((current) => (current === id ? null : current));
      if (released && held?.armed) say(extra.hint ?? HOLD_HINT);
    };
    return {
      type: "button" as const,
      className: `stage-btn stage-hold${holding === id ? " is-holding" : ""}${extra.className ? ` ${extra.className}` : ""}`,
      disabled: extra.disabled,
      "aria-label": extra.label,
      ...extra.attrs,
      onPointerDown(event: PointerEvent<HTMLButtonElement>) {
        if (event.button !== 0) return;
        holds.current.set(id, { startedAt: performance.now(), armed: true, fire });
        setHolding(id);
      },
      onPointerUp: () => end(true),
      onPointerLeave: () => end(false),
      onPointerCancel: () => end(false),
      onContextMenu: (event: { preventDefault(): void }) => event.preventDefault(),
    };
  }

  const fresh = () => session.view().state;
  const order = latest(state.order);
  const upNext = latest(state.current);
  const nextAt = order.indexOf(upNext);
  const titleOf = (key: SongKey) => set.titles?.[key] ?? "Song";
  const nameOf = (id: UserId) => names[id] ?? "A bandmate";
  const grid = latest(state.click);
  const band = session.bandNow();
  const where = band === null ? null : position(state, band);
  const pending = !!state.last && band !== null && band < state.last.at;
  const undoable = pending && moved.current?.opId === state.last!.opId && performance.now() < moved.current.until;
  if (pending && landing.current?.opId !== state.last!.opId) landing.current = { opId: state.last!.opId, ms: Math.max(0, state.last!.at - band!) };
  const words = note.current?.words ?? (leading && !view.signal ? NOT_REACHING : lowPower ? LOW_POWER : null);
  const roles = stageMenu(state, me, view.heard);

  const goBy = (step: 1 | -1) => () => {
    const s = fresh();
    if (!s) return;
    const keys = latest(s.order);
    const to = keys[keys.indexOf(latest(s.current)) + step];
    if (to) send({ kind: "goTo", key: to });
  };
  const retempo = (step: 1 | -1) => () => {
    const pendingGrid = fresh() && latest(fresh()!.click);
    if (pendingGrid) send({ kind: "tempo", bpm: pendingGrid.bpm + step });
    else say(MESSAGES["not-running"]);
  };
  const countIn = () => {
    const tempo = (fresh() && latest(fresh()!.click))?.bpm ?? bpm;
    if (tempo) send({ kind: "countIn", bpm: tempo, beatsPerBar: parseInt(song?.timeSignature ?? "", 10) || 4, bars: 1, version: null, rate: 1 });
  };

  const menuItems = (
    <div className="stage-panel" data-stage-menu="">
      {roles.handOff ? (
        <button type="button" className="stage-btn" data-stage="hand-off" onClick={() => setPanel("hand-off")}>
          Hand off
        </button>
      ) : null}
      {roles.changeBackup ? (
        <button type="button" className="stage-btn" data-stage="change-backup" onClick={() => setPanel("backup")}>
          Change backup{state.backup ? ` · ${nameOf(state.backup)}` : ""}
        </button>
      ) : null}
      {roles.takeLead ? <button {...hold("take-lead", () => send({ kind: "takeOver" }) && close(), { attrs: { "data-stage": "take-lead" } })}>Hold to take the lead</button> : null}
      <button type="button" className="stage-btn" data-stage="cancel" onClick={close}>
        Close
      </button>
    </div>
  );
  const others = state.lineup.filter((id) => id !== state.leader);
  const panels: Record<Exclude<Panel, null>, ReactNode> = {
    menu: menuItems,
    "hand-off": (
      <div className="stage-panel" data-stage-panel="hand-off">
        <p className="stage-panel-title">Hold a name to hand them the lead</p>
        {others.map((id) => (
          <button key={id} {...hold(`to-${id}`, () => send({ kind: "handOff", to: id }) && (say(`Asked ${nameOf(id)} to lead`), close()), { attrs: { "data-stage-to": id } })}>
            {nameOf(id)}
          </button>
        ))}
        <button type="button" className="stage-btn" data-stage="cancel" onClick={close}>
          Close
        </button>
      </div>
    ),
    backup: (
      <div className="stage-panel" data-stage-panel="backup">
        <p className="stage-panel-title">Backup leader tonight</p>
        {[...others, null].map((id) => (
          <button key={id ?? "none"} type="button" className="stage-btn" data-stage-backup={id ?? ""} aria-pressed={state.backup === id} onClick={() => (state.backup === id || send({ kind: "setBackup", userId: id })) && close()}>
            {id ? nameOf(id) : "No backup"}
          </button>
        ))}
        <button type="button" className="stage-btn" data-stage="cancel" onClick={close}>
          Close
        </button>
      </div>
    ),
    order: (
      <div className="stage-panel" data-stage-order="">
        <p className="stage-panel-title">Tonight's order · nothing changes until Done</p>
        <ol className="stage-order">
          {(draft ?? []).map((key, i, list) => {
            const move = (to: number) => setDraft((rows) => (rows ? rows.map((each, j) => (j === i ? rows[to] : j === to ? key : each)) : rows));
            return (
              <li key={key} data-song={key} className={key === where?.song.key ? "is-now" : undefined}>
                <span className="stage-order-title">{titleOf(key)}</span>
                {key === where?.song.key ? <span className="stage-order-now">Now</span> : null}
                <button type="button" className="stage-btn" data-stage-move="up" aria-label={`Move ${titleOf(key)} up`} disabled={i === 0} onClick={() => move(i - 1)}>
                  ▲
                </button>
                <button type="button" className="stage-btn" data-stage-move="down" aria-label={`Move ${titleOf(key)} down`} disabled={i === list.length - 1} onClick={() => move(i + 1)}>
                  ▼
                </button>
              </li>
            );
          })}
        </ol>
        <div className="stage-panel-actions">
          <button type="button" className="stage-btn" data-stage="cancel" onClick={close}>
            Close
          </button>
          <button type="button" className="stage-btn is-primary" data-stage="done" onClick={() => draft && (send({ kind: "reorder", order: draft }), close())}>
            Done
          </button>
        </div>
      </div>
    ),
  };

  const noteLine = words ? (
    <p className="stage-note" role="status" data-stage-note="">
      {words}
    </p>
  ) : null;

  if (!leading) {
    const any = roles.handOff || roles.changeBackup || roles.takeLead;
    return (
      <>
        {any || words ? (
          <div className="stage-roles">
            {panel ? panels[panel] : null}
            <div className="stage-roles-row">
              {noteLine}
              {any ? (
                <button type="button" className="stage-btn" data-stage="more" aria-label="More gig controls" onClick={() => setPanel((open) => (open ? null : "menu"))}>
                  •••
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        <StageBar set={set} canMove={canMove} scroll={scroll} />
      </>
    );
  }

  const chip = pending ? (
    <span key={state.last!.opId} className="stage-chip" data-stage-chip="" style={{ "--stage-land": `${landing.current!.ms}ms` } as CSSProperties}>
      {landingWords(state)}
    </span>
  ) : null;
  const prev = (
    <button {...hold("prev", goBy(-1), { disabled: nextAt <= 0, label: "Previous song", attrs: { "data-stage": "prev" } })}>◀ Prev</button>
  );
  const next = (
    <button {...hold("next", goBy(1), { disabled: nextAt >= order.length - 1, label: nextAt >= order.length - 1 ? undefined : `Next song: ${titleOf(order[nextAt + 1])}`, className: "stage-next", attrs: { "data-stage": "next" } })}>
      {nextAt >= order.length - 1 ? "Last song" : `Next: ${titleOf(order[nextAt + 1])} ▶`}
    </button>
  );
  const clickControls = (
    <>
      <button {...hold("count-in", countIn, { disabled: !(grid?.bpm ?? bpm), attrs: { "data-stage": "count-in" } })}>Count in</button>
      <button {...hold("stop", () => send({ kind: "stop" }), { attrs: { "data-stage": "stop" } })}>Stop</button>
    </>
  );

  // The chip, Undo and the unlock hold get a row of their own while they show, so Next always has the width for its title.
  // It sits at the top of the bar, so nothing a thumb is reaching for moves when it comes or goes.
  const status =
    locked || pending ? (
      <div className="stage-row stage-now">
        {chip}
        {undoable && !locked ? (
          <button type="button" className="stage-btn" data-stage="undo" onClick={() => send({ kind: "undo", target: state.last!.opId })}>
            Undo
          </button>
        ) : null}
        {locked ? <button {...hold("unlock", () => setLocked(false), { hint: UNLOCK_HINT, attrs: { "data-stage": "unlock" } })}>Hold to unlock</button> : null}
      </div>
    ) : null;

  return (
    <nav className="stage-bar" data-stage-bar="" aria-label="Stage" style={{ "--stage-hold": `${HOLD_MS}ms` } as CSSProperties}>
      {panel && !locked ? panels[panel] : null}
      {status}
      {locked ? noteLine : (
        <div className="stage-row stage-tools">
          <div className="stage-tools-note">{noteLine}</div>
          <button type="button" className="stage-btn" data-stage="edit-order" onClick={() => (setDraft(latest(state.order)), setPanel("order"))}>
            Order
          </button>
          <button type="button" className="stage-btn" data-stage="lock" aria-label="Stage lock" onClick={() => (close(), setLocked(true))}>
            Lock
          </button>
          <button type="button" className="stage-btn" data-stage="more" aria-label="More gig controls" onClick={() => setPanel((open) => (open ? null : "menu"))}>
            •••
          </button>
        </div>
      )}
      {locked || !song?.body.length ? null : (
        <div className="stage-sections" role="group" aria-label="Sections">
          {song.body.map((section, i) => (
            <button key={i} {...hold(`section-${i}`, () => send({ kind: "section", index: i }), { className: "stage-section", attrs: { "data-stage": "section", "data-index": String(i), "aria-pressed": String(where?.section === i) } })}>
              {chipLabel(section.heading)}
            </button>
          ))}
        </div>
      )}
      <div className="stage-row stage-click">
        {clickControls}
        {locked ? null : (
          <>
            <button {...hold("slower", retempo(-1), { disabled: !grid, label: "Slower", attrs: { "data-stage": "slower" } })}>−</button>
            <span className="stage-bpm" aria-label="Beats per minute">
              <span data-stage-bpm="">{grid?.bpm ?? bpm ?? "–"}</span> bpm
            </span>
            <button {...hold("faster", retempo(1), { disabled: !grid, label: "Faster", attrs: { "data-stage": "faster" } })}>+</button>
          </>
        )}
      </div>
      <div className="stage-row stage-move">
        {prev}
        {next}
      </div>
    </nav>
  );
}
