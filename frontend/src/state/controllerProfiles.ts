/**
 * Controller profiles — a comprehensive library of MIDI controllers.
 *
 * The SLIDE tab mirrors a profile's physical layout (knobs / faders / pads) so
 * the on-screen slot count matches the device, and both SLIDE and the DJ tab
 * auto-detect a connected controller by its reported MIDI name.
 *
 * SCOPE / honesty:
 *  - A profile describes a device's **physical layout** (how many knobs /
 *    faders / pads, in what grid) plus the name patterns to recognize it.
 *  - It does NOT hard-code per-control CC/note numbers — those vary per device,
 *    firmware, and user template and can't be verified blind. Real
 *    control→function binding is MIDI-learn (controllerMapStore), which works
 *    for ANY device, listed or not.
 *  - Layouts are family-accurate templates (e.g. a 2-ch DJ controller = EQ
 *    knobs + channel/crossfaders + 2×8 performance pads). They size the surface
 *    sensibly; learn makes the mapping exact.
 *
 * Coverage: the major + many niche vendors' full lines (Pioneer, Denon, Numark,
 * Hercules, Reloop, Rane, Native Instruments, Akai, Novation, Korg, Behringer,
 * Arturia, M-Audio, Nektar, Roland, ROLI, Ableton, Allen & Heath, DJ TechTools,
 * Keith McMillen, Teenage Engineering, …). Per-vendor FALLBACK entries catch
 * any unlisted model from a known maker, and the generic profiles catch the
 * rest. `detectProfile` scores by LONGEST matching pattern, and specific models
 * are ordered before vendor fallbacks, so a precise device name always wins.
 */

export type ControlKind = 'knob' | 'fader' | 'pad';

/** Broad device family — for grouping in the picker + smarter fallback. */
export type ControllerCategory = 'dj' | 'pad' | 'mixer' | 'keys' | 'generic';

export interface ControllerSection {
  id: string;
  kind: ControlKind;
  label: string;
  rows: number;
  cols: number;
}

export interface ControllerProfile {
  id: string;
  name: string;
  vendor?: string;
  category?: ControllerCategory;
  /** Lowercase substrings to match against a MIDI input's reported name. */
  match: string[];
  sections: ControllerSection[];
}

/* Section builders. */
const K = (rows: number, cols = 8, label = 'KNOBS'): ControllerSection => ({ id: 'knobs', kind: 'knob', label, rows, cols });
const F = (rows: number, cols = 8, label = 'FADERS'): ControllerSection => ({ id: 'faders', kind: 'fader', label, rows, cols });
const P = (rows: number, cols = 8, label = 'PADS'): ControllerSection => ({ id: 'pads', kind: 'pad', label, rows, cols });
const B = (rows: number, cols = 8, label = 'BUTTONS'): ControllerSection => ({ id: 'buttons', kind: 'pad', label, rows, cols });

/* Shared family-layout templates (read-only; referenced by many devices). */
const DJ2: ControllerSection[] = [K(1, 6, 'EQ/FILTER'), F(1, 3, 'CH+XFADER'), P(2, 8, 'PERF PADS')];
const DJ2_SMALL: ControllerSection[] = [K(1, 4, 'EQ'), F(1, 3, 'CH+XFADER'), P(2, 4, 'PERF PADS')];
const DJ4: ControllerSection[] = [K(2, 8, 'EQ/FILTER'), F(1, 5, 'CH+XFADER'), P(2, 8, 'PERF PADS')];
const DJ4_HE: ControllerSection[] = [K(2, 8, 'EQ/COLOR'), F(1, 5, 'CH+XFADER'), P(2, 8, 'PERF PADS')];
const DJMIX: ControllerSection[] = [K(2, 8, 'EQ/FX'), F(1, 5, 'CH+XFADER')];
const DJMIX2: ControllerSection[] = [K(2, 6, 'EQ/FILTER'), F(1, 3, 'CH+XFADER')];
const MEDIA: ControllerSection[] = [K(1, 4, 'BROWSE/LOOP'), P(2, 8, 'PERF PADS')];
const PAD44: ControllerSection[] = [K(1, 8, 'MACROS'), P(4, 4, 'PADS')];
const PAD44K: ControllerSection[] = [K(1, 4, 'KNOBS'), P(4, 4, 'PADS')];
const MPC: ControllerSection[] = [K(1, 4, 'Q-LINK'), P(4, 4, 'PADS')];
const MPC16Q: ControllerSection[] = [K(1, 8, 'Q-LINK'), P(4, 4, 'PADS')];
const GRID88: ControllerSection[] = [P(8, 8, 'GRID')];
const GRID98: ControllerSection[] = [F(1, 9, 'FADERS'), P(8, 8, 'CLIP GRID')];
const APC40: ControllerSection[] = [K(2, 8, 'DEVICE/TRACK'), F(1, 9, 'TRACK+MASTER'), P(5, 8, 'CLIP GRID')];
const PUSH: ControllerSection[] = [K(1, 8, 'ENCODERS'), P(8, 8, 'GRID')];
const MIX8: ControllerSection[] = [K(3, 8, 'KNOBS'), F(1, 8, 'FADERS'), B(2, 8, 'BUTTONS')];
const MCU: ControllerSection[] = [K(1, 8, 'ENCODERS'), F(1, 9, 'FADERS'), B(2, 8, 'BUTTONS')];
const MCU_MINI: ControllerSection[] = [K(1, 8, 'ENCODERS'), F(1, 1, 'FADER'), B(2, 8, 'BUTTONS')];
const NANO: ControllerSection[] = [K(1, 8, 'KNOBS'), F(1, 8, 'FADERS'), B(3, 8, 'S / M / R')];
const KEYS_MINI: ControllerSection[] = [K(1, 8, 'KNOBS'), P(2, 8, 'PADS')];
const KEYS_FULL: ControllerSection[] = [K(1, 8, 'KNOBS'), F(1, 9, 'FADERS'), P(2, 8, 'PADS')];
const KEYS_ENC: ControllerSection[] = [K(1, 8, 'ENCODERS')];
const BEATSTEP: ControllerSection[] = [K(2, 8, 'ENCODERS'), P(2, 8, 'PADS')];
const KEYSTEP: ControllerSection[] = [P(2, 8, 'PADS')];
const XONE: ControllerSection[] = [K(2, 6, 'EQ/FILTER'), F(1, 4, 'FADERS'), B(2, 8, 'MATRIX')];
const MF_TWISTER: ControllerSection[] = [K(4, 4, 'ENCODERS')];
const MF_3D: ControllerSection[] = [P(4, 4, 'ARCADE')];
const FCB: ControllerSection[] = [B(2, 5, 'FOOTSWITCHES')];

type Row = [id: string, name: string, vendor: string, category: ControllerCategory, match: string[], sections: ControllerSection[]];

// Specific models first (precise name tokens), then per-vendor fallbacks, then
// generics. detectProfile uses longest-match scoring with strict >, so the
// first profile to reach a given match length wins ⇒ specifics must precede
// fallbacks (they do).
const ROWS: Row[] = [
  /* ───────── GANTASMO (on-screen twin of the Quest XR MIDI surface; rendered by
     WorldsCollidePanel and shown first in the controller picker). match=[] so it
     never auto-detects a real device — it is picked manually / is the default. ───────── */
  ['gantasmo-worlds-collide', 'GANTASMO - Worlds Collide', 'GANTASMO', 'mixer', [], [F(1, 6, 'FADERS'), F(1, 1, 'CROSSFADE'), K(1, 8, 'KNOBS'), B(2, 6, 'BUTTONS')]],

  /* ───────── Pioneer DJ ───────── */
  ['pioneer-ddj-flx2', 'Pioneer DDJ-FLX2', 'Pioneer DJ', 'dj', ['ddj-flx2', 'flx2'], DJ2],
  ['pioneer-ddj-flx4', 'Pioneer DDJ-FLX4', 'Pioneer DJ', 'dj', ['ddj-flx4', 'flx4'], DJ2],
  ['pioneer-ddj-flx6', 'Pioneer DDJ-FLX6', 'Pioneer DJ', 'dj', ['ddj-flx6', 'flx6'], DJ4],
  ['pioneer-ddj-flx10', 'Pioneer DDJ-FLX10', 'Pioneer DJ', 'dj', ['ddj-flx10', 'flx10'], DJ4_HE],
  ['pioneer-ddj-200', 'Pioneer DDJ-200', 'Pioneer DJ', 'dj', ['ddj-200', 'ddj200'], DJ2_SMALL],
  ['pioneer-ddj-400', 'Pioneer DDJ-400', 'Pioneer DJ', 'dj', ['ddj-400', 'ddj400'], DJ2],
  ['pioneer-ddj-800', 'Pioneer DDJ-800', 'Pioneer DJ', 'dj', ['ddj-800', 'ddj800'], DJ4],
  ['pioneer-ddj-1000', 'Pioneer DDJ-1000', 'Pioneer DJ', 'dj', ['ddj-1000', 'ddj1000'], DJ4_HE],
  ['pioneer-ddj-rev1', 'Pioneer DDJ-REV1', 'Pioneer DJ', 'dj', ['ddj-rev1', 'rev1'], DJ2],
  ['pioneer-ddj-rev5', 'Pioneer DDJ-REV5', 'Pioneer DJ', 'dj', ['ddj-rev5', 'rev5'], DJ4],
  ['pioneer-ddj-rev7', 'Pioneer DDJ-REV7', 'Pioneer DJ', 'dj', ['ddj-rev7', 'rev7'], DJ4],
  ['pioneer-ddj-sb3', 'Pioneer DDJ-SB3', 'Pioneer DJ', 'dj', ['ddj-sb3', 'ddj-sb2', 'ddj-sb', 'ddjsb'], DJ2],
  ['pioneer-ddj-sr2', 'Pioneer DDJ-SR2', 'Pioneer DJ', 'dj', ['ddj-sr2', 'ddj-sr'], DJ2],
  ['pioneer-ddj-sx3', 'Pioneer DDJ-SX3', 'Pioneer DJ', 'dj', ['ddj-sx3', 'ddj-sx2', 'ddj-sx'], DJ4],
  ['pioneer-ddj-sz2', 'Pioneer DDJ-SZ2', 'Pioneer DJ', 'dj', ['ddj-sz2', 'ddj-sz'], DJ4],
  ['pioneer-ddj-rb', 'Pioneer DDJ-RB', 'Pioneer DJ', 'dj', ['ddj-rb'], DJ2],
  ['pioneer-ddj-rr', 'Pioneer DDJ-RR', 'Pioneer DJ', 'dj', ['ddj-rr'], DJ2],
  ['pioneer-ddj-rx', 'Pioneer DDJ-RX/RZ', 'Pioneer DJ', 'dj', ['ddj-rzx', 'ddj-rz', 'ddj-rx'], DJ4],
  ['pioneer-ddj-xp', 'Pioneer DDJ-XP1/XP2', 'Pioneer DJ', 'pad', ['ddj-xp1', 'ddj-xp2'], [P(4, 8, 'PERF PADS')]],
  ['pioneer-ddj-grv6', 'Pioneer DDJ-GRV6', 'Pioneer DJ', 'dj', ['ddj-grv6', 'grv6'], DJ4],
  ['pioneer-xdj-rx', 'Pioneer XDJ-RX2/RX3', 'Pioneer DJ', 'dj', ['xdj-rx3', 'xdj-rx2', 'xdj-rx'], DJ4_HE],
  ['pioneer-xdj-xz', 'Pioneer XDJ-XZ', 'Pioneer DJ', 'dj', ['xdj-xz'], DJ4_HE],
  ['pioneer-cdj', 'Pioneer CDJ / XDJ player', 'Pioneer DJ', 'dj', ['cdj-3000', 'cdj-2000', 'cdj', 'xdj-1000', 'xdj'], MEDIA],
  ['pioneer-djm-s', 'Pioneer DJM-S (battle mixer)', 'Pioneer DJ', 'mixer', ['djm-s11', 'djm-s9', 'djm-s7', 'djm-s'], [K(2, 4, 'EQ/FX'), F(1, 3, 'CH+XFADER'), P(2, 8, 'PERF PADS')]],
  ['pioneer-djm', 'Pioneer DJM mixer', 'Pioneer DJ', 'mixer', ['djm-900', 'djm-750', 'djm-450', 'djm-v10', 'djm-a9', 'djm'], DJMIX],
  ['pioneer-toraiz', 'Pioneer Toraiz SP-16/Squid', 'Pioneer DJ', 'pad', ['toraiz', 'squid'], [K(1, 8, 'KNOBS'), P(2, 8, 'STEPS')]],
  ['pioneer-fallback', 'Pioneer DJ (other)', 'Pioneer DJ', 'dj', ['ddj', 'pioneer'], DJ2],

  /* ───────── Denon DJ ───────── */
  ['denon-mc4000', 'Denon MC4000', 'Denon DJ', 'dj', ['mc4000'], DJ2],
  ['denon-mc6000', 'Denon MC6000', 'Denon DJ', 'dj', ['mc6000'], DJ4],
  ['denon-mc7000', 'Denon MC7000', 'Denon DJ', 'dj', ['mc7000'], DJ4],
  ['denon-mcx8000', 'Denon MCX8000', 'Denon DJ', 'dj', ['mcx8000'], DJ4],
  ['denon-prime', 'Denon Prime / SC Live', 'Denon DJ', 'dj', ['prime 4', 'prime 2', 'prime go', 'sc live', 'sc6000', 'sc5000'], DJ4_HE],
  ['denon-lc6000', 'Denon LC6000', 'Denon DJ', 'dj', ['lc6000'], MEDIA],
  ['denon-x1800', 'Denon X1800/X1850 mixer', 'Denon DJ', 'mixer', ['x1800', 'x1850'], DJMIX],
  ['denon-fallback', 'Denon DJ (other)', 'Denon DJ', 'dj', ['denon'], DJ2],

  /* ───────── Numark ───────── */
  ['numark-mixtrack-platinum', 'Numark Mixtrack Platinum', 'Numark', 'dj', ['mixtrack platinum', 'platinum fx'], DJ4],
  ['numark-mixtrack-pro', 'Numark Mixtrack Pro', 'Numark', 'dj', ['mixtrack pro', 'mixtrack 3', 'mixtrack'], DJ2],
  ['numark-party-mix', 'Numark Party Mix', 'Numark', 'dj', ['party mix', 'partymix'], DJ2_SMALL],
  ['numark-dj2go2', 'Numark DJ2GO2', 'Numark', 'dj', ['dj2go2', 'dj2go'], DJ2_SMALL],
  ['numark-ns6', 'Numark NS6/NS7', 'Numark', 'dj', ['ns6', 'ns7', 'ns4fx'], DJ4],
  ['numark-nv', 'Numark NV/NVII', 'Numark', 'dj', ['nvii', 'numark nv'], DJ4],
  ['numark-orbit', 'Numark Orbit', 'Numark', 'pad', ['orbit'], [P(4, 4, 'PADS')]],
  ['numark-fallback', 'Numark (other)', 'Numark', 'dj', ['numark'], DJ2],

  /* ───────── Hercules ───────── */
  ['hercules-inpulse-500', 'Hercules Inpulse 500', 'Hercules', 'dj', ['inpulse 500', 'inpulse500'], DJ4],
  ['hercules-inpulse-300', 'Hercules Inpulse 300', 'Hercules', 'dj', ['inpulse 300', 'inpulse300'], DJ2],
  ['hercules-inpulse-200', 'Hercules Inpulse 200', 'Hercules', 'dj', ['inpulse 200', 'inpulse200', 'inpulse'], DJ2_SMALL],
  ['hercules-t7', 'Hercules DJControl Inpulse T7', 'Hercules', 'dj', ['inpulse t7', 't7'], DJ4],
  ['hercules-starlight', 'Hercules DJControl Starlight', 'Hercules', 'dj', ['starlight'], DJ2_SMALL],
  ['hercules-fallback', 'Hercules DJControl (other)', 'Hercules', 'dj', ['djcontrol', 'hercules'], DJ2],

  /* ───────── Reloop ───────── */
  ['reloop-mixon', 'Reloop Mixon 4/8', 'Reloop', 'dj', ['mixon 8', 'mixon 4', 'mixon'], DJ4],
  ['reloop-beatmix', 'Reloop Beatmix', 'Reloop', 'dj', ['beatmix'], DJ2],
  ['reloop-beatpad', 'Reloop Beatpad', 'Reloop', 'dj', ['beatpad'], DJ2],
  ['reloop-ready', 'Reloop Ready/Buddy', 'Reloop', 'dj', ['reloop ready', 'reloop buddy'], DJ2],
  ['reloop-fallback', 'Reloop (other)', 'Reloop', 'dj', ['reloop'], DJ2],

  /* ───────── Rane ───────── */
  ['rane-one', 'Rane ONE', 'Rane', 'dj', ['rane one'], DJ4],
  ['rane-seventy', 'Rane Seventy / Seventy-Two', 'Rane', 'mixer', ['seventy-two', 'seventy two', 'rane seventy'], [K(2, 4, 'EQ/FX'), F(1, 3, 'CH+XFADER'), P(2, 8, 'PERF PADS')]],
  ['rane-twelve', 'Rane Twelve', 'Rane', 'dj', ['rane twelve'], MEDIA],
  ['rane-fallback', 'Rane (other)', 'Rane', 'dj', ['rane'], DJ4],

  /* ───────── Allen & Heath ───────── */
  ['ah-xone-k2', 'Allen & Heath Xone:K2/K1', 'Allen & Heath', 'mixer', ['xone:k2', 'xone k2', 'xone:k1', 'xone k1'], XONE],
  ['ah-xone-mixer', 'Allen & Heath Xone mixer', 'Allen & Heath', 'mixer', ['xone:96', 'xone:43', 'xone:db', 'xone:px5', 'xone'], DJMIX],

  /* ───────── Native Instruments — Traktor ───────── */
  ['ni-traktor-s2', 'Traktor Kontrol S2', 'Native Instruments', 'dj', ['kontrol s2', 's2 mk'], DJ2],
  ['ni-traktor-s3', 'Traktor Kontrol S3', 'Native Instruments', 'dj', ['kontrol s3', 's3 mk'], DJ4],
  ['ni-traktor-s4', 'Traktor Kontrol S4', 'Native Instruments', 'dj', ['kontrol s4', 's4 mk'], DJ4],
  ['ni-traktor-s5', 'Traktor Kontrol S5/S8', 'Native Instruments', 'dj', ['kontrol s5', 'kontrol s8'], DJ4],
  ['ni-traktor-z1', 'Traktor Kontrol Z1', 'Native Instruments', 'mixer', ['kontrol z1'], DJMIX2],
  ['ni-traktor-z2', 'Traktor Kontrol Z2', 'Native Instruments', 'mixer', ['kontrol z2'], DJMIX],
  ['ni-traktor-x1', 'Traktor Kontrol X1', 'Native Instruments', 'dj', ['kontrol x1'], [K(1, 8, 'FX/LOOP'), P(2, 8, 'PERF PADS')]],
  ['ni-traktor-f1', 'Traktor Kontrol F1', 'Native Instruments', 'pad', ['kontrol f1'], GRID98],
  ['ni-traktor-d2', 'Traktor Kontrol D2', 'Native Instruments', 'dj', ['kontrol d2'], MEDIA],

  /* ───────── Native Instruments — Maschine / Komplete ───────── */
  ['ni-maschine-mk3', 'NI Maschine MK3', 'Native Instruments', 'pad', ['maschine mk3', 'maschine studio', 'maschine+', 'maschine plus'], [K(1, 8, 'MACROS'), P(4, 4, 'PADS')]],
  ['ni-maschine-mikro', 'NI Maschine Mikro', 'Native Instruments', 'pad', ['maschine mikro'], [K(1, 1, 'ENCODER'), P(4, 4, 'PADS')]],
  ['ni-maschine-jam', 'NI Maschine Jam', 'Native Instruments', 'pad', ['maschine jam'], [F(1, 8, 'TOUCH'), P(8, 8, 'GRID')]],
  ['ni-maschine', 'NI Maschine', 'Native Instruments', 'pad', ['maschine'], PAD44],
  ['ni-komplete-kontrol', 'NI Komplete Kontrol', 'Native Instruments', 'keys', ['komplete kontrol', 'kontrol s88', 'kontrol s61', 'kontrol s49', 'kontrol a', 'kontrol m32'], KEYS_ENC],

  /* ───────── Akai ───────── */
  ['akai-midimix', 'AKAI MIDIMIX', 'Akai', 'mixer', ['midimix'], MIX8],
  ['akai-apc40-mk2', 'AKAI APC40 mkII', 'Akai', 'pad', ['apc40', 'apc 40'], APC40],
  ['akai-apc-mini-mk2', 'AKAI APC mini mk2', 'Akai', 'pad', ['apc mini mk2', 'apcmini mk2'], GRID98],
  ['akai-apc-mini', 'AKAI APC mini', 'Akai', 'pad', ['apc mini', 'apcmini'], GRID98],
  ['akai-apc-key25', 'AKAI APC Key 25', 'Akai', 'pad', ['apc key 25', 'apc key25'], [P(5, 8, 'CLIP GRID')]],
  ['akai-mpd218', 'AKAI MPD218', 'Akai', 'pad', ['mpd218', 'mpd 218'], [K(1, 6, 'KNOBS'), P(4, 4, 'PADS')]],
  ['akai-mpd226', 'AKAI MPD226/232', 'Akai', 'pad', ['mpd226', 'mpd232', 'mpd 226'], [K(1, 4, 'KNOBS'), F(1, 4, 'FADERS'), P(4, 4, 'PADS')]],
  ['akai-mpd', 'AKAI MPD', 'Akai', 'pad', ['mpd18', 'mpd24', 'mpd32', 'mpd'], PAD44K],
  ['akai-mpc', 'AKAI MPC (One/Live/X/Studio/Key)', 'Akai', 'pad', ['mpc one', 'mpc live', 'mpc x', 'mpc studio', 'mpc key', 'mpc touch', 'mpc renaissance', 'mpc'], MPC16Q],
  ['akai-force', 'AKAI Force', 'Akai', 'pad', ['akai force'], [K(1, 8, 'MACROS'), P(8, 8, 'GRID')]],
  ['akai-mpk-mini', 'AKAI MPK Mini', 'Akai', 'keys', ['mpk mini', 'mpkmini', 'mpk-mini'], KEYS_MINI],
  ['akai-mpk', 'AKAI MPK225/249/261', 'Akai', 'keys', ['mpk249', 'mpk261', 'mpk225', 'mpk'], KEYS_FULL],
  ['akai-advance', 'AKAI Advance', 'Akai', 'keys', ['advance 25', 'advance 49', 'advance 61', 'akai advance'], KEYS_MINI],
  ['akai-lpd8', 'AKAI LPD8', 'Akai', 'pad', ['lpd8'], [K(1, 8, 'KNOBS'), P(2, 4, 'PADS')]],
  ['akai-lpk25', 'AKAI LPK25', 'Akai', 'keys', ['lpk25'], KEYS_ENC],
  ['akai-fire', 'AKAI Fire (FL Studio)', 'Akai', 'pad', ['akai fire', 'fl studio fire'], [K(1, 4, 'KNOBS'), P(4, 16, 'STEP GRID')]],
  ['akai-fallback', 'AKAI (other)', 'Akai', 'pad', ['akai'], PAD44K],

  /* ───────── Novation ───────── */
  ['novation-launchpad-pro', 'Novation Launchpad Pro', 'Novation', 'pad', ['launchpad pro'], GRID88],
  ['novation-launchpad-x', 'Novation Launchpad X', 'Novation', 'pad', ['launchpad x'], GRID88],
  ['novation-launchpad-mini', 'Novation Launchpad Mini', 'Novation', 'pad', ['launchpad mini'], GRID88],
  ['novation-launchpad', 'Novation Launchpad', 'Novation', 'pad', ['launchpad mk', 'launchpad s', 'launchpad'], GRID88],
  ['novation-launchkey-mini', 'Novation Launchkey Mini', 'Novation', 'keys', ['launchkey mini'], KEYS_MINI],
  ['novation-launchkey', 'Novation Launchkey', 'Novation', 'keys', ['launchkey'], KEYS_FULL],
  ['novation-lcxl', 'Novation Launch Control XL', 'Novation', 'mixer', ['launch control xl', 'lcxl'], MIX8],
  ['novation-launchcontrol', 'Novation Launch Control', 'Novation', 'mixer', ['launch control'], [K(2, 8, 'KNOBS'), P(1, 8, 'PADS')]],
  ['novation-circuit', 'Novation Circuit / Tracks / Rhythm', 'Novation', 'pad', ['circuit tracks', 'circuit rhythm', 'circuit'], [K(1, 8, 'MACROS'), P(4, 8, 'GRID')]],
  ['novation-slmk3', 'Novation SL MkII/MkIII', 'Novation', 'keys', ['sl mkiii', 'sl mk3', 'sl mkii', 'sl mk2', 'remote sl'], KEYS_FULL],
  ['novation-impulse', 'Novation Impulse', 'Novation', 'keys', ['impulse 25', 'impulse 49', 'impulse 61', 'novation impulse'], KEYS_FULL],
  ['novation-fallback', 'Novation (other)', 'Novation', 'pad', ['novation'], PAD44],

  /* ───────── Korg ───────── */
  ['korg-nanokontrol2', 'Korg nanoKONTROL2', 'Korg', 'mixer', ['nanokontrol2', 'nanokontrol', 'nano kontrol'], NANO],
  ['korg-nanopad', 'Korg nanoPAD2', 'Korg', 'pad', ['nanopad'], [P(4, 4, 'PADS')]],
  ['korg-nanokey', 'Korg nanoKEY2/Studio', 'Korg', 'keys', ['nanokey'], KEYS_ENC],
  ['korg-padkontrol', 'Korg padKONTROL', 'Korg', 'pad', ['padkontrol'], [K(1, 2, 'KNOBS'), P(4, 4, 'PADS')]],
  ['korg-taktile', 'Korg taktile / TRITON taktile', 'Korg', 'keys', ['taktile'], KEYS_FULL],
  ['korg-microkey', 'Korg microKEY', 'Korg', 'keys', ['microkey'], KEYS_ENC],
  ['korg-kaoss', 'Korg Kaoss Pad / Kaossilator', 'Korg', 'pad', ['kaoss', 'kaossilator'], [P(4, 4, 'XY')]],
  ['korg-sq1', 'Korg SQ-1 / NTS-1', 'Korg', 'pad', ['sq-1', 'nts-1', 'volca', 'minilogue', 'monologue'], [K(1, 8, 'KNOBS'), P(2, 8, 'STEPS')]],
  ['korg-fallback', 'Korg (other)', 'Korg', 'keys', ['korg'], KEYS_MINI],

  /* ───────── Behringer ───────── */
  ['behringer-xtouch-mini', 'Behringer X-Touch Mini', 'Behringer', 'mixer', ['x-touch mini', 'xtouch mini', 'x touch mini'], MCU_MINI],
  ['behringer-xtouch-compact', 'Behringer X-Touch Compact', 'Behringer', 'mixer', ['x-touch compact', 'xtouch compact'], [K(1, 16, 'ENCODERS'), F(1, 9, 'FADERS'), B(2, 8, 'BUTTONS')]],
  ['behringer-xtouch', 'Behringer X-Touch', 'Behringer', 'mixer', ['x-touch', 'xtouch', 'x touch'], MCU],
  ['behringer-bcf2000', 'Behringer BCF2000', 'Behringer', 'mixer', ['bcf2000'], MCU],
  ['behringer-bcr2000', 'Behringer BCR2000', 'Behringer', 'mixer', ['bcr2000'], [K(4, 8, 'ENCODERS')]],
  ['behringer-cmd', 'Behringer CMD (Studio/Micro/MM-1/PL-1/DC-1)', 'Behringer', 'dj', ['cmd studio', 'cmd micro', 'cmd mm-1', 'cmd pl-1', 'cmd dc-1', 'cmd'], DJ4],
  ['behringer-motor', 'Behringer MOTÖR 49/61', 'Behringer', 'keys', ['motor 49', 'motor 61', 'motör'], KEYS_FULL],
  ['behringer-fcb1010', 'Behringer FCB1010', 'Behringer', 'generic', ['fcb1010'], FCB],
  ['behringer-fallback', 'Behringer (other)', 'Behringer', 'mixer', ['behringer'], MCU],

  /* ───────── Arturia ───────── */
  ['arturia-keylab-mk2', 'Arturia KeyLab mkII/mk3', 'Arturia', 'keys', ['keylab mkii', 'keylab mk2', 'keylab mk3', 'keylab 49', 'keylab 61', 'keylab 88'], KEYS_FULL],
  ['arturia-keylab-essential', 'Arturia KeyLab Essential', 'Arturia', 'keys', ['keylab essential', 'keylab'], KEYS_FULL],
  ['arturia-minilab', 'Arturia MiniLab', 'Arturia', 'keys', ['minilab 3', 'minilab mkii', 'minilab'], KEYS_MINI],
  ['arturia-microlab', 'Arturia MicroLab', 'Arturia', 'keys', ['microlab'], KEYS_ENC],
  ['arturia-beatstep-pro', 'Arturia BeatStep Pro', 'Arturia', 'pad', ['beatstep pro'], BEATSTEP],
  ['arturia-beatstep', 'Arturia BeatStep', 'Arturia', 'pad', ['beatstep'], [K(1, 16, 'ENCODERS'), P(2, 8, 'PADS')]],
  ['arturia-keystep-pro', 'Arturia KeyStep Pro', 'Arturia', 'keys', ['keystep pro'], KEYSTEP],
  ['arturia-keystep', 'Arturia KeyStep', 'Arturia', 'keys', ['keystep'], KEYSTEP],
  ['arturia-fallback', 'Arturia (other)', 'Arturia', 'keys', ['arturia'], KEYS_MINI],

  /* ───────── M-Audio ───────── */
  ['maudio-oxygen-pro', 'M-Audio Oxygen Pro', 'M-Audio', 'keys', ['oxygen pro'], KEYS_FULL],
  ['maudio-oxygen', 'M-Audio Oxygen', 'M-Audio', 'keys', ['oxygen'], KEYS_FULL],
  ['maudio-code', 'M-Audio Code 25/49/61', 'M-Audio', 'keys', ['m-audio code', 'code 25', 'code 49', 'code 61'], KEYS_FULL],
  ['maudio-axiom', 'M-Audio Axiom', 'M-Audio', 'keys', ['axiom'], KEYS_FULL],
  ['maudio-keystation', 'M-Audio Keystation', 'M-Audio', 'keys', ['keystation'], KEYS_ENC],
  ['maudio-trigger-finger', 'M-Audio Trigger Finger', 'M-Audio', 'pad', ['trigger finger'], PAD44],
  ['maudio-fallback', 'M-Audio (other)', 'M-Audio', 'keys', ['m-audio', 'm audio'], KEYS_MINI],

  /* ───────── Nektar ───────── */
  ['nektar-panorama', 'Nektar Panorama', 'Nektar', 'keys', ['panorama p1', 'panorama p4', 'panorama p6', 'panorama'], KEYS_FULL],
  ['nektar-impact', 'Nektar Impact LX/GX', 'Nektar', 'keys', ['impact lx', 'impact gx', 'nektar impact'], KEYS_FULL],
  ['nektar-fallback', 'Nektar (other)', 'Nektar', 'keys', ['nektar'], KEYS_MINI],

  /* ───────── Roland ───────── */
  ['roland-dj', 'Roland DJ-202/505/808', 'Roland', 'dj', ['dj-202', 'dj-505', 'dj-808'], DJ4],
  ['roland-a-pro', 'Roland A-PRO (300/500/800)', 'Roland', 'keys', ['a-300pro', 'a-500pro', 'a-800pro', 'a-pro'], KEYS_FULL],
  ['roland-a-88', 'Roland A-49 / A-88', 'Roland', 'keys', ['a-88', 'a-49'], KEYS_ENC],
  ['roland-mc', 'Roland MC-101/707', 'Roland', 'pad', ['mc-101', 'mc-707'], [K(1, 8, 'KNOBS'), P(2, 8, 'STEPS')]],
  ['roland-sp404', 'Roland SP-404', 'Roland', 'pad', ['sp-404', 'sp404'], [K(1, 2, 'KNOBS'), P(4, 4, 'PADS')]],
  ['roland-fallback', 'Roland (other)', 'Roland', 'keys', ['roland'], KEYS_FULL],

  /* ───────── ROLI ───────── */
  ['roli-seaboard', 'ROLI Seaboard', 'ROLI', 'keys', ['seaboard'], KEYS_ENC],
  ['roli-blocks', 'ROLI Blocks / LUMI', 'ROLI', 'pad', ['lightpad', 'lumi', 'roli block'], [P(5, 5, 'GRID')]],
  ['roli-fallback', 'ROLI (other)', 'ROLI', 'keys', ['roli'], KEYS_ENC],

  /* ───────── Ableton ───────── */
  ['ableton-push2', 'Ableton Push 2', 'Ableton', 'pad', ['push 2', 'ableton push 2'], PUSH],
  ['ableton-push3', 'Ableton Push 3', 'Ableton', 'pad', ['push 3', 'ableton push 3'], PUSH],
  ['ableton-push', 'Ableton Push', 'Ableton', 'pad', ['ableton push', 'push'], PUSH],

  /* ───────── DJ TechTools / Midi Fighter ───────── */
  ['djtt-twister', 'Midi Fighter Twister', 'DJ TechTools', 'mixer', ['midi fighter twister', 'mf twister', 'twister'], MF_TWISTER],
  ['djtt-3d', 'Midi Fighter 3D / Spectra', 'DJ TechTools', 'pad', ['midi fighter 3d', 'midi fighter spectra', 'midi fighter'], MF_3D],

  /* ───────── Keith McMillen ───────── */
  ['kmi-quneo', 'Keith McMillen QuNeo', 'Keith McMillen', 'pad', ['quneo'], [P(4, 4, 'PADS')]],
  ['kmi-qunexus', 'Keith McMillen QuNexus', 'Keith McMillen', 'keys', ['qunexus'], KEYS_ENC],
  ['kmi-softstep', 'Keith McMillen SoftStep', 'Keith McMillen', 'generic', ['softstep'], [B(2, 5, 'FOOTSWITCHES')]],
  ['kmi-kboard', 'Keith McMillen K-Board', 'Keith McMillen', 'keys', ['k-board', 'kboard'], KEYS_ENC],

  /* ───────── Teenage Engineering ───────── */
  ['te-opz', 'Teenage Engineering OP-Z', 'Teenage Engineering', 'pad', ['op-z', 'opz'], [P(2, 8, 'STEPS')]],
  ['te-op1', 'Teenage Engineering OP-1', 'Teenage Engineering', 'keys', ['op-1', 'op1'], KEYS_ENC],
  ['te-po', 'Teenage Engineering Pocket Operator', 'Teenage Engineering', 'pad', ['pocket operator'], [P(2, 8, 'STEPS')]],

  /* ───────── Polyend ───────── */
  ['polyend-tracker', 'Polyend Tracker / Play', 'Polyend', 'pad', ['polyend tracker', 'polyend play', 'polyend'], [P(4, 8, 'GRID')]],

  /* ───────── Intech / Monome / Faderfox / Livid (boutique) ───────── */
  ['intech-grid', 'Intech Studio Grid', 'Intech', 'mixer', ['intech', 'grid px', 'grid ef'], [K(4, 4, 'ENCODERS')]],
  ['monome-grid', 'Monome Grid', 'Monome', 'pad', ['monome'], GRID88],
  ['faderfox', 'Faderfox', 'Faderfox', 'mixer', ['faderfox'], [K(2, 8, 'ENCODERS'), F(1, 4, 'FADERS')]],
  ['livid', 'Livid (Base/CNTRL:R)', 'Livid', 'pad', ['livid'], PAD44],

  /* ───────── DAW / control surfaces (MCU-class, generic) ───────── */
  ['mcu-generic', 'Mackie Control / MCU', 'Mackie', 'mixer', ['mackie control', 'mcu pro', 'mackie'], MCU],
  ['icon-platform', 'iCON Platform / Qcon', 'iCON', 'mixer', ['platform m', 'platform nano', 'qcon', 'icon'], MCU],
  ['ssl-uf', 'SSL UF8 / UC1', 'SSL', 'mixer', ['ssl uf8', 'ssl uc1', 'uf8'], MCU],

  /* ───────── Audima (expressive motion) ───────── */
  // Six motion dimensions (Strike/Sway/Pulse/Glide/Press/Sculpt) read as
  // continuous controls, plus the 8 encoders and the performance pads. The dims
  // bind by learn (swayBus); this row only labels the physical surface.
  ['audima-sway', 'Audima Sway', 'Audima', 'generic', ['sway', 'audima'], [K(1, 6, '6 DIMENSIONS'), K(1, 8, 'ENCODERS'), P(2, 8, 'PERF PADS')]],

  /* ───────── Generic fallbacks (lowest priority) ───────── */
  ['generic-16', 'Generic 16-channel', 'Generic', 'generic', [], [K(2, 8, 'KNOBS'), F(1, 8, 'FADERS'), B(2, 8, 'BUTTONS')]],
  ['generic-8', 'Generic 8-channel', 'Generic', 'generic', [], [K(1, 8, 'KNOBS'), F(1, 8, 'FADERS')]],
];

export const CONTROLLER_PROFILES: ControllerProfile[] = ROWS.map(([id, name, vendor, category, match, sections]) => ({
  id, name, vendor, category, match, sections,
}));

/** The on-screen GANTASMO XR twin surface (see WorldsCollidePanel). */
export const GANTASMO_WORLDS_COLLIDE_ID = 'gantasmo-worlds-collide';

/** The Audima Sway expressive-motion controller — pinned second in the SLIDE
 *  picker (right below the GANTASMO twin) so the 6-dimension surface is one
 *  click away. Its dims bind by learn via swayBus. */
export const AUDIMA_SWAY_ID = 'audima-sway';

// Default to the on-screen GANTASMO surface so it is front-and-centre with no
// hardware connected. Auto-detect still switches to a real controller when one
// is connected.
export const DEFAULT_PROFILE_ID = GANTASMO_WORLDS_COLLIDE_ID;

/**
 * LEARNED profiles — built from a MIDI capture session (learnedProfilesStore).
 * MIDI gives no standard way to read a device's physical layout from firmware,
 * so for unlisted / custom rigs we BUILD the layout from what the device
 * actually sends when the user exercises each control. Those profiles register
 * here so profileById / allProfiles see them alongside the built-ins.
 */
let _learned: ControllerProfile[] = [];
export function setLearnedProfiles(list: ControllerProfile[]): void {
  _learned = list;
}

/** Built-in profiles + any learned ones. */
export function allProfiles(): ControllerProfile[] {
  return _learned.length ? [...CONTROLLER_PROFILES, ..._learned] : CONTROLLER_PROFILES;
}

export function profileById(id: string): ControllerProfile {
  return allProfiles().find((p) => p.id === id) ?? CONTROLLER_PROFILES[0];
}

/** Total physical controls a profile exposes. */
export function profileControlCount(p: ControllerProfile): number {
  return p.sections.reduce((n, s) => n + s.rows * s.cols, 0);
}

/** Count of a single kind across a profile (e.g. faders → one page size). */
export function profileKindCount(p: ControllerProfile, kind: ControlKind): number {
  return p.sections.filter((s) => s.kind === kind).reduce((n, s) => n + s.rows * s.cols, 0);
}

/**
 * Best-match a profile from one MIDI input name (case-insensitive). SCORED: the
 * LONGEST matching substring wins, so a specific model ("ddj-flx4") beats a
 * family token ("ddj" / "pioneer"). Specific models precede vendor fallbacks in
 * the table, so on a length tie the specific one wins. null when nothing matches.
 */
export function detectProfile(midiInputName: string | null | undefined): ControllerProfile | null {
  if (!midiInputName) return null;
  const name = midiInputName.toLowerCase();
  let best: ControllerProfile | null = null;
  let bestLen = 0;
  for (const p of CONTROLLER_PROFILES) {
    for (const m of p.match) {
      if (m && name.includes(m) && m.length > bestLen) {
        best = p;
        bestLen = m.length;
      }
    }
  }
  return best;
}

/**
 * Best-match across a LIST of connected input names (App enumerates several).
 * Highest-scoring profile over all names; null when nothing matches any name.
 */
export function detectProfileFromNames(names: Array<string | null | undefined>): ControllerProfile | null {
  let best: ControllerProfile | null = null;
  let bestLen = 0;
  for (const name of names) {
    if (!name) continue;
    const lower = name.toLowerCase();
    for (const p of CONTROLLER_PROFILES) {
      for (const m of p.match) {
        if (m && lower.includes(m) && m.length > bestLen) {
          best = p;
          bestLen = m.length;
        }
      }
    }
  }
  return best;
}
