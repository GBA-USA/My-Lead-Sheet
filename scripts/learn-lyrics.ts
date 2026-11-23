/**
 * Words the test songs sing: public-domain texts, so the syllable counter is tried on real English, and nonsense
 * lines, so the aligner is tried on words it has never seen. A hyphen marks a syllable break inside a word; none of
 * these texts has a hyphen of its own. `plainLine` gives the words as sung.
 */
export interface Lyric {
  title: string;
  source: string;
  lines: string[];
}

export const LYRICS: Record<string, Lyric> = {
  "amazing-grace": {
    title: "Amazing Grace",
    source: "public domain: John Newton, 1779",
    lines: [
      "A-maz-ing grace, how sweet the sound",
      "That saved a wretch like me",
      "I once was lost, but now am found",
      "Was blind, but now I see",
      "'Twas grace that taught my heart to fear",
      "And grace my fears re-lieved",
      "How pre-cious did that grace ap-pear",
      "The hour I first be-lieved",
    ],
  },
  "home-on-the-range": {
    title: "Home on the Range",
    source: "public domain: Brewster Higley, 1872",
    lines: [
      "Oh, give me a home where the buf-fa-lo roam",
      "Where the deer and the an-te-lope play",
      "Where sel-dom is heard a dis-cour-ag-ing word",
      "And the skies are not cloud-y all day",
      "Home, home on the range",
    ],
  },
  "oh-susanna": {
    title: "Oh! Susanna",
    source: "public domain: Stephen Foster, 1848",
    lines: [
      "I come from Al-a-bam-a with a ban-jo on my knee",
      "I'm go-ing to Lou-i-si-an-a, my true love for to see",
      "It rained all night the day I left, the weath-er it was dry",
      "The sun so hot I froze to death, Su-san-na, don't you cry",
      "Oh! Su-san-na, oh don't you cry for me",
      "For I come from Al-a-bam-a with a ban-jo on my knee",
    ],
  },
  "shall-we-gather": {
    title: "Shall We Gather at the River",
    source: "public domain: Robert Lowry, 1864",
    lines: [
      "Shall we gath-er at the riv-er",
      "Where bright an-gel feet have trod",
      "With its crys-tal tide for-ev-er",
      "Flow-ing by the throne of God",
      "Yes, we'll gath-er at the riv-er",
      "The beau-ti-ful, the beau-ti-ful riv-er",
      "Gath-er with the saints at the riv-er",
      "That flows by the throne of God",
      "On the mar-gin of the riv-er",
      "Wash-ing up its sil-ver spray",
      "We will walk and wor-ship ev-er",
      "All the hap-py gold-en day",
    ],
  },
  "twinkle": {
    title: "The Star",
    source: "public domain: Jane Taylor, 1806",
    lines: ["Twin-kle, twin-kle, lit-tle star", "How I won-der what you are", "Up a-bove the world so high", "Like a dia-mond in the sky"],
  },
  "row-your-boat": {
    title: "Row, Row, Row Your Boat",
    source: "public domain: traditional, printed 1852",
    lines: ["Row, row, row your boat", "Gent-ly down the stream", "Mer-ri-ly, mer-ri-ly, mer-ri-ly, mer-ri-ly", "Life is but a dream"],
  },
  "swing-low": {
    title: "Swing Low, Sweet Chariot",
    source: "public domain: Wallace Willis, before 1862",
    lines: ["Swing low, sweet char-i-ot", "Com-ing for to car-ry me home", "I looked o-ver Jor-dan, and what did I see", "A band of an-gels com-ing af-ter me"],
  },
  "holy-holy": {
    title: "Holy, Holy, Holy",
    source: "public domain: Reginald Heber, 1826",
    lines: ["Ho-ly, ho-ly, ho-ly! Lord God Al-might-y!", "Ear-ly in the morn-ing our song shall rise to thee"],
  },
  "nonsense-a": {
    title: "Zibberly",
    source: "nonsense: written for these test songs",
    lines: ["Zib-ber-ly the ton-na glows", "Mar-ro-wind and pid-dle-sky", "Quon-da-lay a fes-ter-moon", "Brill-o-ver the wum-ble-tide"],
  },
  "nonsense-b": {
    title: "Snorkledee",
    source: "nonsense: written for these test songs",
    lines: ["Snor-kle-dee and ram-ber-lin", "Tup-per-wick a lon-do-ree", "Fal-ly-ho the gran-ti-stone", "Pim-ber-ton a whis-sel-dow"],
  },
};

export const plainLine = (line: string) => line.replaceAll("-", "");
