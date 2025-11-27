// Set the tempo
Tone.Transport.bpm.value = 85;

// --- Master Effects Chain (Simplified & Clean) ---
// Removed the heavy underwater filters.
// Added a light PingPongDelay and Reverb for a spacious, metallic atmosphere.
const masterReverb = new Tone.Reverb({ decay: 4, wet: 0.3 }).toDestination();
const masterDelay = new Tone.PingPongDelay({
  delayTime: "8n",
  feedback: 0.2,
  wet: 0.2,
}).connect(masterReverb);

// --- Instrument 1: Metallic Bass (The "Fing") ---
// Changed to FMSynth for a hollow, metallic thud.
// Volume reduced significantly.
const metallicBass = new Tone.FMSynth({
  harmonicity: 1.5,
  modulationIndex: 10,
  oscillator: { type: "sine" },
  modulation: { type: "sine" },
  envelope: { attack: 0.005, decay: 0.3, sustain: 1, release: 0.2 },
  modulationEnvelope: { attack: 0.001, decay: 0.2, sustain: 0, release: 0.1 },
  volume: -12,
}).connect(masterReverb);

// --- Instrument 2: Glassy/Bell Lead (The "Ping") ---
// Changed to FMSynth voices to create a "slim", glass-like bell sound.
// Very low volume, short percussive decay.
const glassLead = new Tone.PolySynth(Tone.FMSynth, {
  harmonicity: 3.01, // Non-integer harmonicity creates the metallic/bell tone
  modulationIndex: 3,
  oscillator: { type: "sine" },
  envelope: { attack: 0.01, decay: 0.2, sustain: 0, release: 1 },
  modulationEnvelope: { attack: 0.01, decay: 0.2, sustain: 0, release: 0.2 },
  volume: -10,
}).connect(masterDelay);

// --- Instrument 3: Tiny Metal Clicks (The "Ting") ---
// Using MetalSynth for high-pitched, thin metallic artifacts.
const tingSynth = new Tone.MetalSynth({
  frequency: 200,
  envelope: { attack: 0.001, decay: 0.05, release: 0.01 }, // Very short "ting"
  harmonicity: 5.1,
  modulationIndex: 32,
  resonance: 4000,
  octaves: 1.5,
  volume: -30,
}).connect(masterReverb);

// --- Sequencing ---

// 1. The Bass Rhythm Loop
const bassLoop = new Tone.Sequence(
  (time, note) => {
    if (note) {
      metallicBass.triggerAttackRelease(note, "16n", time);
    }
  },
  [
    ["C2", null],
    "C2",
    [null, "G2"],
    null,
    ["F2", null],
    "F2",
    [null, "G1"],
    null,
  ],
  "4n"
).start(0);

// 2. The Glassy Melody Loop
const melodyChords = [
  ["C5", "E5", "G5", "B5"],
  ["A4", "C5", "E5", "G5"],
  ["F4", "A4", "C5", "E5"],
  ["G4", "B4", "D5", "F5"],
];

let chordIndex = 0;
const melodyLoop = new Tone.Loop((time) => {
  const currentChord = melodyChords[chordIndex % melodyChords.length];

  // Arpeggiated very quickly for a "strum" effect
  glassLead.triggerAttackRelease(currentChord[0], "8n", time);
  glassLead.triggerAttackRelease(currentChord[1], "8n", time + 0.1);
  glassLead.triggerAttackRelease(currentChord[2], "8n", time + 0.2);
  glassLead.triggerAttackRelease(currentChord[3], "8n", time + 0.3);

  chordIndex++;
}, "1m").start(0);

// 3. Random Metallic Tings
const bubbleLoop = new Tone.Loop((time) => {
  if (Math.random() > 0.5) {
    // Trigger a short, high metallic click
    tingSynth.triggerAttackRelease("32n", time + Math.random() * 0.5);
  }
}, "4n").start(0);
