// Music theory + procedural composer checks: ukulele shapes, roman numerals, deterministic seeded tunes, major
// day / parallel-minor night, every mood arranged, jingles in every key. Owner: client-fx-audio.

import { describe, expect, it } from "vitest";
import type { MusicMood } from "../Sfx";
import { JINGLE_IDS, buildJingles } from "./jingles";
import { ARRANGEMENTS, SONG_BARS, SONG_IDS, STEPS_PER_BAR, composeSongBook, composeTune, leadTonic, songForMood } from "./songs";
import { CHORDS, degreeSemitones, makeChord, mulberry32, noteToMidi, parseRoman, pc, triadDegrees, ukeVoicing } from "./theory";

const MOODS: ReadonlyArray<MusicMood> = ["off", "lobby", "day", "dusk", "night", "boss", "storm", "launch", "win", "lose"];

describe("theory", () => {
  it("parses note names", () => {
    expect(noteToMidi("C4")).toBe(60);
    expect(noteToMidi("F#5")).toBe(78);
    expect(noteToMidi("Bb3")).toBe(58);
    expect(() => noteToMidi("H2")).toThrow();
  });

  it("finds the standard open ukulele shapes", () => {
    for (const name of ["C", "Am", "F", "G", "Dm", "G7", "C7", "A7", "Bb"]) {
      const c = CHORDS[name]!;
      expect(ukeVoicing(c.root, c.tones), name).toEqual([...c.uke]);
    }
  });

  it("voicings always contain the root and the third, within first position", () => {
    for (let root = 0; root < 12; root++) {
      for (const q of ["maj", "min", "dom7", "min7"] as const) {
        const c = makeChord(root, q);
        const pcs = new Set(c.uke.map(pc));
        expect(pcs.has(pc(root)), c.name).toBe(true);
        expect(pcs.has(pc(root + c.tones[1]!)), c.name).toBe(true);
        for (const [i, n] of c.uke.entries()) expect(n - [67, 60, 64, 69][i]!).toBeLessThanOrEqual(5);
      }
    }
  });

  it("reads roman numerals in major and minor", () => {
    expect(parseRoman("vi", 0, "major").chord.name).toBe("Am");
    expect(parseRoman("IV", 7, "major").chord.name).toBe("C");
    expect(parseRoman("V7", 9, "minor").chord.name).toBe("E7");
    expect(parseRoman("VI", 9, "minor").chord.name).toBe("F");
    expect(parseRoman("i", 2, "minor").chord.name).toBe("Dm");
    expect(parseRoman("ii", 0, "major").degree).toBe(1);
    expect(() => parseRoman("X", 0, "major")).toThrow();
  });

  it("maps scale degrees across octaves and modes", () => {
    expect(degreeSemitones(0, "major")).toBe(0);
    expect(degreeSemitones(2, "major")).toBe(4);
    expect(degreeSemitones(2, "minor")).toBe(3);
    expect(degreeSemitones(7, "major")).toBe(12);
    expect(degreeSemitones(-1, "major")).toBe(-1);
    expect(degreeSemitones(6, "minor", true)).toBe(11);
    expect(triadDegrees(4)).toEqual([4, 6, 1]);
  });

  it("mulberry32 is deterministic", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 10; i++) expect(a()).toBe(b());
  });
});

describe("songs", () => {
  it("composes the same tune for the same seed", () => {
    expect(JSON.stringify(composeSongBook(4471).songs.day.steps)).toBe(JSON.stringify(composeSongBook(4471).songs.day.steps));
    expect(composeTune(9023)).toEqual(composeTune(9023));
  });

  it("different islands hum different tunes", () => {
    const tunes = new Set<string>();
    for (let seed = 1; seed <= 12; seed++) {
      const t = composeTune(seed * 7919);
      tunes.add(JSON.stringify([t.key, t.progA, t.progB, t.phraseA.map((n) => n.degree)]));
    }
    expect(tunes.size).toBeGreaterThan(8);
  });

  it("arranges every mood: 16 bars, sane registers", () => {
    for (const seed of [0, 1, 4471, 9023, 0xffffffff]) {
      const book = composeSongBook(seed);
      for (const id of SONG_IDS) {
        const song = book.songs[id];
        expect(song.length).toBe(SONG_BARS * STEPS_PER_BAR);
        expect(song.bars.length).toBe(SONG_BARS);
        expect(song.bpm).toBeGreaterThan(60);
        expect(song.bpm).toBeLessThan(150);
        let notes = 0;
        for (const step of song.steps) {
          for (const ev of step) {
            if (ev.kind === "xylo" || ev.kind === "pan" || ev.kind === "kazoo" || ev.kind === "pluck") {
              notes++;
              expect(ev.midi, `${id} ${ev.kind}`).toBeGreaterThanOrEqual(45);
              expect(ev.midi, `${id} ${ev.kind}`).toBeLessThanOrEqual(100);
            }
          }
        }
        expect(notes, id).toBeGreaterThan(10);
      }
    }
  });

  it("is major by day and the parallel minor at night", () => {
    for (const seed of [3, 77, 4471]) {
      const book = composeSongBook(seed);
      expect(book.songs.day.mode).toBe("major");
      expect(book.songs.night.mode).toBe("minor");
      expect(book.songs.boss.mode).toBe("minor");
      expect(book.songs.storm.mode).toBe("minor");
      // Bar 0 is the tonic chord: major third by day, minor third at night, same root.
      expect(book.songs.day.bars[0]!.tones[1]).toBe(4);
      expect(book.songs.night.bars[0]!.tones[1]).toBe(3);
      expect(book.songs.night.bars[0]!.root).toBe(book.songs.day.bars[0]!.root);
      expect(book.songs.boss.bpm).toBeGreaterThan(book.songs.night.bpm);
      expect(book.songs.storm.bpm).toBeGreaterThan(book.songs.boss.bpm);
    }
  });

  it("maps every music mood", () => {
    for (const mood of MOODS) {
      const id = songForMood(mood);
      if (mood === "off") expect(id).toBeNull();
      else expect(SONG_IDS).toContain(id);
    }
    for (const id of SONG_IDS) expect(ARRANGEMENTS[id]).toBeTruthy();
  });

  it("keeps the lead tonic in a comfortable register", () => {
    for (let key = 0; key < 12; key++) {
      expect(leadTonic(key)).toBeGreaterThanOrEqual(65);
      expect(leadTonic(key)).toBeLessThanOrEqual(76);
    }
  });

  it("builds both jingles in every key", () => {
    for (const key of [0, 2, 5, 7, 9]) {
      const j = buildJingles(key);
      for (const id of JINGLE_IDS) {
        expect(j[id].duration).toBeGreaterThan(1);
        expect(j[id].steps.some((s) => s.length > 0)).toBe(true);
      }
    }
  });
});
