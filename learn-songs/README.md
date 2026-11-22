# learn-songs: your own recordings, scored on your machine

Everything in this folder except this file is gitignored. Recordings, sidecars and charts stay on your computer. Nothing here is committed and no check in CI reads it.

`npm run check:learn-local` scores each WAV here against the sidecar beside it and prints the scorecard. It never fails the build. With no WAVs it prints `skip  no songs in learn-songs/`.

## What to put here

For a song called `rehearsal-take-1`:

- `rehearsal-take-1.wav`: the recording. Mono or stereo (stereo is mixed to one channel), any sample rate, 16, 24 or 32-bit PCM or 32-bit float. Convert an MP3 or M4A on a computer with any tool, for example `ffmpeg -i take.m4a take.wav`.
- `rehearsal-take-1.json`: the sidecar, what you know about the recording. Every field below is required. The lane names any field that is missing and skips the song.
- `rehearsal-take-1.song.json` (optional): your chart in the library's shape, for `--rechart`.

## The sidecar

Times are seconds from the start of the WAV. Bars count from 0, and `toBar` is the first bar after the section.

```json
{
  "license": "my own recording",
  "durationSec": 61.2,
  "bpm": 90,
  "downbeats": [2.0, 4.667, 7.333, 10.0],
  "changes": [
    { "at": 2.0, "chord": "C" },
    { "at": 7.333, "chord": "G7" },
    { "at": 10.0, "chord": "N.C." }
  ],
  "sections": [
    { "fromBar": 0, "toBar": 4, "label": "INTRO", "group": "A" },
    { "fromBar": 4, "toBar": 12, "label": "VERSE", "group": "B" }
  ],
  "anchors": []
}
```

- `downbeats`: the time of beat 1 of every bar. The scorecard takes the bar length from the first two and `bpm`.
- `changes`: every time the chord changes, `N.C.` where none sounds.
- `sections`: label is one of `INTRO`, `VERSE`, `PRE-CHORUS`, `CHORUS`, `BRIDGE`, `SOLO`, `INSTRUMENTAL`, `OUTRO`. Sections that repeat share a `group` letter.
- `anchors`: `chordAnchors` of your chart, or `[]`. `--rechart` works them out from the chart itself.
- Keep the track's license line in `license` if it is not your own.

## The re-chart test

`npm run check:learn-local -- --rechart` takes `<name>.song.json`, `{ "title": "...", "body": [ { "heading": "VERSE 1", "lines": [ { "chords": "C       G", "lyrics": "words as sung" } ] } ] }`, and drops its chord lines. Then L8 lays the sidecar's changes over the words at their heard times, and the lane prints how many chords land on the same syllable, within one syllable and within one word of where your chart has them. Write the chart out in full, every repeat included, so that its chords in reading order follow the sidecar's `changes`. A held chord counts once.

Until L8 lands, `--rechart` prints `skip  <file>: --rechart waits for L8`.
